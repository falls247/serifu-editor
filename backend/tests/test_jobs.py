from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from app.engine import EngineCandidate, EngineError, EngineResult, MockSam3Engine, Sam3Engine
from app.image_cache import ImageCache
from app.jobs import ApiException, CandidateRecord, Job, JobManager
from app.mask_codec import encode_mask
from app.schemas import InferRequest
from app.settings import Settings


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "model_path": Path("/unused/sam3.pt"),
        "ui_origins": frozenset(),
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _points_request() -> InferRequest:
    return InferRequest(
        imageId="00000000-0000-0000-0000-000000000001",
        requestId="page-a:1",
        mode="points",
        points=[{"x": 1, "y": 1, "positive": True}],
    )


def _candidate(mask: np.ndarray) -> EngineCandidate:
    return EngineCandidate(score=0.9, mask=encode_mask(mask))


def test_model_path_change_rejected_during_model_operation(tmp_path: Path) -> None:
    config = _settings(model_settings_file=tmp_path / "settings.json")
    engine = MockSam3Engine(config)
    manager = JobManager(config, engine, ImageCache(ttl_seconds=600, max_bytes=1024))

    async def run() -> None:
        async with manager._gpu_lock:
            with pytest.raises(ApiException) as error:
                await manager.set_model_path("/models/new.pt")
            assert error.value.code == "MODEL_BUSY"
            assert error.value.status == 409
        assert engine.settings.model_path == config.model_path
        assert not config.model_settings_file.exists()

    asyncio.run(run())


def test_inference_rejected_while_model_path_is_saving(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = _settings(model_settings_file=tmp_path / "settings.json")
    engine = MockSam3Engine(config)
    manager = JobManager(config, engine, ImageCache(ttl_seconds=600, max_bytes=1024))
    saving = threading.Event()
    release = threading.Event()
    original_save = Settings.save_model_path

    def slow_save(settings: Settings, path: Path) -> None:
        saving.set()
        assert release.wait(3)
        original_save(settings, path)

    monkeypatch.setattr(Settings, "save_model_path", slow_save)

    async def run() -> None:
        task = asyncio.create_task(manager.set_model_path("/models/new.pt"))
        try:
            assert await asyncio.to_thread(saving.wait, 3)
            with pytest.raises(ApiException) as error:
                manager.submit(_points_request())
            assert error.value.code == "MODEL_BUSY"
        finally:
            release.set()
            await task
        assert not manager._updating_model_path
        assert engine.settings.model_path == Path("/models/new.pt")

    asyncio.run(run())


def test_serialization_enforces_decoded_memory_and_response_caps() -> None:
    cache = ImageCache(ttl_seconds=600, max_bytes=1024)
    image_id = "00000000-0000-0000-0000-000000000001"
    manager = JobManager(
        _settings(max_candidate_pixels=2, max_response_bytes=330), object(), cache
    )
    job = Job("job", _points_request(), image_id, "page-a", 1)
    large = np.ones((4, 4), dtype=np.uint8)
    small = np.ones((1, 1), dtype=np.uint8)
    candidates, warnings = manager._serialize_result(
        job,
        EngineResult((_candidate(large), _candidate(small), _candidate(small))),
        time.monotonic() + 600,
    )
    assert len(candidates) == 1
    assert candidates[0]["bbox"] == {"x": 0, "y": 0, "width": 1, "height": 1}
    assert warnings == ["CANDIDATE_MEMORY_LIMIT", "RESPONSE_SIZE_LIMIT"]


def test_refine_keeps_candidate_identity_and_updates_bbox() -> None:
    settings = _settings()
    manager = JobManager(settings, object(), ImageCache(ttl_seconds=600, max_bytes=1024))
    candidate_id = "00000000-0000-0000-0000-000000000002"
    image_id = "00000000-0000-0000-0000-000000000001"
    old_bbox = {"x": 0, "y": 0, "width": 4, "height": 4}
    manager.candidates[candidate_id] = CandidateRecord(
        candidate_id, image_id, old_bbox, time.monotonic() + 600
    )
    request = InferRequest(
        imageId=image_id,
        requestId="page-a:2",
        mode="refine",
        candidateId=candidate_id,
        points=[{"x": 3, "y": 4, "positive": True}],
    )
    job = Job("job", request, image_id, "page-a", 2, refine_bbox=old_bbox)
    mask = np.zeros((10, 10), dtype=np.uint8)
    mask[3:7, 5:8] = 1
    candidates, warnings = manager._serialize_result(
        job,
        EngineResult((_candidate(mask),)),
        time.monotonic() + 600,
    )
    assert warnings == []
    assert len(candidates) == 1
    assert candidates[0]["candidateId"] == candidate_id
    assert candidates[0]["bbox"] == {"x": 5, "y": 3, "width": 3, "height": 4}
    assert manager.candidates[candidate_id].bbox == candidates[0]["bbox"]


def test_idle_unload_and_request_reload() -> None:
    async def exercise() -> None:
        settings = _settings(model_idle_seconds=1, maintenance_interval_seconds=0.05)
        engine = MockSam3Engine(settings)
        cache = ImageCache(ttl_seconds=600, max_bytes=1024)
        manager = JobManager(settings, engine, cache)
        await manager.start()
        try:
            deadline = time.monotonic() + 2
            while engine.model_loaded and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            assert not engine.model_loaded

            cached, _ = cache.add(np.zeros((8, 8, 3), dtype=np.uint8))
            request = _points_request().model_copy(update={"imageId": cached.image_id})
            job = manager.submit(request)
            deadline = time.monotonic() + 2
            while job.status not in manager._terminal_states() and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            assert job.status == "ready"
            assert engine.model_loaded
        finally:
            await manager.stop()

    asyncio.run(exercise())


def test_injected_cuda_oom_retries_through_job_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeCudaOOM(RuntimeError):
        pass

    class FakeCuda:
        OutOfMemoryError = FakeCudaOOM

        def __init__(self) -> None:
            self.empty_cache_calls = 0

        @staticmethod
        def is_available() -> bool:
            return True

        def empty_cache(self) -> None:
            self.empty_cache_calls += 1

    settings = _settings()
    engine = Sam3Engine(settings)
    engine.model_loaded = True
    engine._torch = SimpleNamespace(cuda=FakeCuda())
    predictor = SimpleNamespace(
        _features={"stale": object()}, _is_image_set=True, _is_batch=True
    )
    engine._model = SimpleNamespace(inst_interactive_predictor=predictor)
    engine._processor = object()
    attempts = 0

    def infer_once(**_kwargs: object) -> EngineResult:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise FakeCudaOOM("CUDA out of memory")
        return EngineResult((_candidate(np.ones((1, 1), dtype=np.uint8)),))

    monkeypatch.setattr(engine, "_infer_once", infer_once)

    async def exercise() -> None:
        cache = ImageCache(ttl_seconds=600, max_bytes=1024)
        cached, _ = cache.add(np.zeros((8, 8, 3), dtype=np.uint8))
        manager = JobManager(settings, engine, cache)
        await manager.start()
        try:
            request = _points_request().model_copy(update={"imageId": cached.image_id})
            job = manager.submit(request)
            deadline = time.monotonic() + 3
            while job.status not in manager._terminal_states() and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            assert job.status == "ready"
            assert attempts == 2
            assert engine._torch.cuda.empty_cache_calls == 1
            assert predictor._features is None
            assert predictor._is_image_set is False
            assert predictor._is_batch is False
        finally:
            await manager.stop()

    asyncio.run(exercise())


def test_idle_unload_cannot_overlap_new_inference() -> None:
    class BlockingUnloadEngine(MockSam3Engine):
        def __init__(self, settings: Settings) -> None:
            super().__init__(settings)
            self.unload_started = threading.Event()
            self.release_unload = threading.Event()
            self.guard = threading.Lock()
            self.active_operations = 0
            self.max_active_operations = 0
            self.events: list[str] = []

        def _begin(self, name: str) -> None:
            with self.guard:
                self.active_operations += 1
                self.max_active_operations = max(
                    self.max_active_operations, self.active_operations
                )
                self.events.append(f"{name}-start")

        def _end(self, name: str) -> None:
            with self.guard:
                self.events.append(f"{name}-end")
                self.active_operations -= 1

        def load(self) -> None:
            self._begin("load")
            try:
                self.model_loaded = True
                self.status = "ready"
            finally:
                self._end("load")

        def unload(self) -> None:
            self._begin("unload")
            self.unload_started.set()
            try:
                if not self.release_unload.wait(timeout=3):
                    raise TimeoutError("test did not release idle unload")
                self.model_loaded = False
                self.status = "unloaded"
            finally:
                self._end("unload")

        def infer(self, **kwargs: object) -> EngineResult:
            self._begin("infer")
            try:
                if not self.model_loaded:
                    raise AssertionError("inference ran while the model was unloaded")
                return super().infer(**kwargs)  # type: ignore[arg-type]
            finally:
                self._end("infer")

    async def exercise() -> None:
        settings = _settings(model_idle_seconds=1, maintenance_interval_seconds=0.05)
        engine = BlockingUnloadEngine(settings)
        cache = ImageCache(ttl_seconds=600, max_bytes=1024)
        manager = JobManager(settings, engine, cache)
        await manager.start()
        try:
            assert manager._startup_load_task is not None
            await manager._startup_load_task
            manager._last_inference_finished = time.monotonic() - 2
            manager._last_model_ready = time.monotonic() - 2
            deadline = time.monotonic() + 2
            while not engine.unload_started.is_set() and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            assert engine.unload_started.is_set()

            cached, _ = cache.add(np.zeros((8, 8, 3), dtype=np.uint8))
            request = _points_request().model_copy(update={"imageId": cached.image_id})
            job = manager.submit(request)
            await asyncio.sleep(0.05)
            assert "infer-start" not in engine.events
            engine.release_unload.set()

            deadline = time.monotonic() + 2
            while job.status not in manager._terminal_states() and time.monotonic() < deadline:
                await asyncio.sleep(0.01)
            assert job.status == "ready"
            assert engine.max_active_operations == 1
            unload_end = engine.events.index("unload-end")
            load_start = engine.events.index("load-start", unload_end + 1)
            infer_start = engine.events.index("infer-start", load_start + 1)
            assert unload_end < load_start < infer_start
        finally:
            engine.release_unload.set()
            await manager.stop()

    asyncio.run(exercise())


@pytest.mark.parametrize("supersede", [False, True])
def test_cancelled_reload_keeps_model_for_next_page(supersede: bool) -> None:
    class SlowReloadEngine(MockSam3Engine):
        def __init__(self, settings: Settings) -> None:
            super().__init__(settings)
            self.model_loaded = False
            self.loads = 0
            self.started = threading.Event()
            self.release = threading.Event()
            self.inferences = 0

        def load(self) -> None:
            self.loads += 1
            if self.loads > 1:
                self.status = "loading"
                self.started.set()
                assert self.release.wait(3)
            super().load()

        def infer(self, **kwargs: object) -> EngineResult:
            self.inferences += 1
            return super().infer(**kwargs)  # type: ignore[arg-type]

    async def until(predicate: Any) -> None:
        deadline = time.monotonic() + 3
        while not predicate():
            assert time.monotonic() < deadline, "job state transition timed out"
            await asyncio.sleep(0.005)

    async def exercise() -> None:
        settings = _settings(model_idle_seconds=600, maintenance_interval_seconds=0.01)
        engine = SlowReloadEngine(settings)
        cache = ImageCache(ttl_seconds=600, max_bytes=1024)
        manager = JobManager(settings, engine, cache)
        await manager.start()
        try:
            await manager._startup_load_task
            manager._last_model_ready = manager._last_inference_finished = time.monotonic() - 601
            await until(lambda: not engine.model_loaded)
            cached, _ = cache.add(np.zeros((8, 8, 3), dtype=np.uint8))
            request = _points_request().model_copy(update={"imageId": cached.image_id})
            first = manager.submit(request)
            await until(engine.started.is_set)
            if supersede:
                pending = manager.submit(request.model_copy(update={"requestId": "page-b:1"}))
                assert first.status == "superseded"
                manager.cancel(pending.job_id)
            else:
                manager.cancel(first.job_id)
            finished_after = time.monotonic()
            engine.release.set()
            await until(lambda: manager._active is None)
            assert manager._last_model_ready >= finished_after
            assert manager._last_inference_finished < finished_after
            await asyncio.sleep(0.04)
            assert engine.model_loaded
            assert engine.inferences == 0
            next_job = manager.submit(request.model_copy(update={"requestId": "page-c:1"}))
            await until(lambda: next_job.status in manager._terminal_states())
            assert next_job.status == "ready"
            assert engine.loads == 2
            assert engine.inferences == 1
        finally:
            engine.release.set()
            await manager.stop()

    asyncio.run(exercise())


def test_failed_shared_load_can_be_retried_by_next_request() -> None:
    class RetryEngine(MockSam3Engine):
        def __init__(self, settings: Settings) -> None:
            super().__init__(settings)
            self.model_loaded = False
            self.loads = 0

        def load(self) -> None:
            self.loads += 1
            if self.loads == 1:
                raise EngineError("MODEL_LOAD_FAILED", "temporary model load failure", retryable=True)
            super().load()

    async def exercise() -> None:
        settings = _settings()
        engine = RetryEngine(settings)
        cache = ImageCache(ttl_seconds=600, max_bytes=1024)
        manager = JobManager(settings, engine, cache)
        cached, _ = cache.add(np.zeros((8, 8, 3), dtype=np.uint8))
        request = _points_request().model_copy(update={"imageId": cached.image_id})
        failed = manager.submit(request)
        await manager._run(failed)
        assert failed.status == "failed"
        assert manager._last_model_ready is None
        assert not manager.model_loading
        retried = manager.submit(request.model_copy(update={"requestId": "page-a:2"}))
        await manager._run(retried)
        assert retried.status == "ready"
        assert manager.load_count == engine.loads == 2
        assert manager._last_model_ready is not None

    asyncio.run(exercise())


def test_cancelled_load_waiter_holds_gpu_lock_until_thread_finishes() -> None:
    class BlockingEngine(MockSam3Engine):
        def __init__(self, settings: Settings) -> None:
            super().__init__(settings)
            self.model_loaded = False
            self.started = threading.Event()
            self.release = threading.Event()

        def load(self) -> None:
            self.started.set()
            assert self.release.wait(3)
            super().load()

    async def exercise() -> None:
        settings = _settings()
        engine = BlockingEngine(settings)
        manager = JobManager(settings, engine, ImageCache(ttl_seconds=600, max_bytes=1024))
        task = asyncio.create_task(manager._load_startup_model())
        try:
            deadline = time.monotonic() + 3
            while not engine.started.is_set():
                assert time.monotonic() < deadline
                await asyncio.sleep(0.005)
            task.cancel()
            await asyncio.sleep(0.01)
            assert manager._gpu_lock.locked()
            assert not task.done()
            engine.release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not manager._gpu_lock.locked()
            assert engine.model_loaded
            assert manager._last_model_ready is not None
        finally:
            engine.release.set()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())
