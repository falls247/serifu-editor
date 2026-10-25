from __future__ import annotations

from pathlib import Path

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

