from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from pathlib import Path

import numpy as np
import pytest

from app.engine import EngineCandidate, EngineResult, MockSam3Engine, Sam3Engine
from app.image_cache import ImageCache
from app.jobs import CandidateRecord, Job, JobManager
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
