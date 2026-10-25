from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import threading

import numpy as np
import pytest

from app.engine import EngineError, EngineResult, Sam3Engine
from app.settings import Settings


class FakeOutOfMemory(RuntimeError):
    pass


class FakeCuda:
    OutOfMemoryError = FakeOutOfMemory

    def __init__(self) -> None:
        self.empty_cache_calls = 0

    @staticmethod
    def is_available() -> bool:
        return True

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


class FakeTorch:
    def __init__(self) -> None:
        self.cuda = FakeCuda()


def _settings() -> Settings:
    return Settings(model_path=Path("/unused"), ui_origins=frozenset())


@pytest.mark.parametrize("mode", ["text", "points", "refine"])
@pytest.mark.parametrize("device", [
    "cpu",
    pytest.param("cuda", marks=[
        pytest.mark.gpu,
        pytest.mark.skipif(os.getenv("SAM3_RUN_GPU_TESTS") != "1", reason="explicit GPU opt-in required"),
    ]),
])
def test_reload_infers_on_another_thread_with_mixed_dtype(monkeypatch, mode, device):
    torch = pytest.importorskip("torch")
    engine = Sam3Engine(_settings())

    class InferenceTorch(FakeTorch):
        bfloat16 = torch.bfloat16
        inference_mode = staticmethod(torch.inference_mode)
        clear_autocast_cache = staticmethod(torch.clear_autocast_cache)

        @staticmethod
        def autocast(*, device_type, dtype):
            assert device_type == "cuda"
            # Exercise real PyTorch mixed-dtype operations without requiring
            # CUDA for the default regression suite.
            return torch.autocast(device_type=device, dtype=dtype)

    class MixedDtypeModel:
        def __init__(self):
            self.linear = torch.nn.Linear(3, 3, device=device).eval()
            self.fail = False

        def forward(self):
            # SAM3's fused MLP emits BF16 before a layer with FP32 weights.
            value = self.linear(torch.ones(1, 3, dtype=torch.bfloat16, device=device))
            assert value.dtype == torch.bfloat16
            assert not torch.is_grad_enabled()
            if self.fail:
                raise RuntimeError("inference failed after mixed-dtype operation")

        def set_image(self, image):
            self.forward()
            return {}

        def set_text_prompt(self, *, state, prompt):
            self.forward()
            return state

        def predict_inst(self, **kwargs):
            self.forward()
            if mode == "refine":
                np.testing.assert_array_equal(kwargs["box"], [0, 0, 2, 2])
            return np.ones((1, 2, 2), dtype=np.uint8), np.array([0.9]), None

    def load():
        engine._torch = InferenceTorch()
        engine._model = engine._processor = MixedDtypeModel()
        engine.model_loaded = True

    monkeypatch.setattr(engine, "load", load)

    def infer():
        assert not torch.is_autocast_enabled(device)
        try:
            return engine.infer(
                image=np.zeros((2, 2, 3), dtype=np.uint8),
                mode=mode,
                prompt="circle" if mode == "text" else None,
                threshold=0,
                points=[{"x": 1.0, "y": 1.0, "positive": True}],
                refine_bbox={"x": 0, "y": 0, "width": 2, "height": 2},
            )
        finally:
            assert not torch.is_autocast_enabled(device)
            assert torch.is_grad_enabled()

    with ThreadPoolExecutor(max_workers=1) as loader, ThreadPoolExecutor(max_workers=1) as worker:
        assert loader.submit(threading.get_ident).result() != worker.submit(threading.get_ident).result()
        try:
            for _ in range(2):
                loader.submit(engine.load).result()
                result = worker.submit(infer).result()
                assert len(result.candidates) == (0 if mode == "text" else 1)
                engine._model.fail = True
                with pytest.raises(EngineError, match="SAM3 inference failed"):
                    worker.submit(infer).result()
                engine._model.fail = False
                assert worker.submit(infer).result() == result
                loader.submit(engine.unload).result()
        finally:
            loader.submit(engine.unload).result()


def test_unload_releases_cast_cache_before_cuda_cache():
    engine = Sam3Engine(_settings())
    torch = FakeTorch()
    operations = []
    torch.clear_autocast_cache = lambda: operations.append("cast")
    torch.cuda.empty_cache = lambda: operations.append("cuda")
    engine._torch = torch
    engine._model = object()
    engine._processor = object()
    engine.model_loaded = True
    engine.unload()
    assert engine._model is engine._processor is None
    assert not engine.model_loaded
    assert engine.status == "unloaded"
    assert operations == ["cast", "cuda"]


def test_inference_failure_logs_traceback_but_returns_generic_error(monkeypatch, caplog):
    engine = Sam3Engine(_settings())
    engine._torch = FakeTorch()
    engine.model_loaded = True

    def infer_once(**_kwargs):
        raise RuntimeError("diagnostic runtime detail")

    monkeypatch.setattr(engine, "_infer_once", infer_once)
    with pytest.raises(EngineError) as captured:
        engine.infer(
            image=np.zeros((3, 4, 3), dtype=np.uint8),
            mode="points",
            prompt=None,
            threshold=0.5,
            points=[{"x": 1.0, "y": 1.0, "positive": True}],
            refine_bbox=None,
        )
    assert captured.value.code == "INFERENCE_FAILED"
    assert captured.value.retryable is True
    assert "diagnostic runtime detail" not in captured.value.message
    record = next(record for record in caplog.records if "SAM3 inference failed" in record.message)
    assert record.exc_info[0] is RuntimeError
    assert "mode=points image=4x3 points=1 thread=" in record.message
    assert "diagnostic runtime detail" in caplog.text


def test_cuda_oom_retries_once_and_clears_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = Sam3Engine(_settings())
    engine._torch = FakeTorch()
    engine.model_loaded = True
    attempts = 0

    def infer_once(**_kwargs: object) -> EngineResult:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise FakeOutOfMemory("CUDA out of memory")
        return EngineResult(())

    monkeypatch.setattr(engine, "_infer_once", infer_once)
    result = engine.infer(
        image=np.zeros((2, 2, 3), dtype=np.uint8),
        mode="points",
        prompt=None,
        threshold=0.5,
        points=[],
        refine_bbox=None,
    )
    assert result.candidates == ()
    assert attempts == 2
    assert engine._torch.cuda.empty_cache_calls == 1


def test_second_cuda_oom_returns_retryable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = Sam3Engine(_settings())
    engine._torch = FakeTorch()
    engine.model_loaded = True
    attempts = 0

    def infer_once(**_kwargs: object) -> EngineResult:
        nonlocal attempts
        attempts += 1
        raise FakeOutOfMemory("CUDA out of memory")

    monkeypatch.setattr(engine, "_infer_once", infer_once)
    with pytest.raises(EngineError) as captured:
        engine.infer(
            image=np.zeros((2, 2, 3), dtype=np.uint8),
            mode="text",
            prompt="cat",
            threshold=0.5,
            points=[],
            refine_bbox=None,
        )
    assert captured.value.code == "GPU_OOM"
    assert captured.value.retryable is True
    assert attempts == 2
    assert engine._torch.cuda.empty_cache_calls == 1

