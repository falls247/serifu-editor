from __future__ import annotations

import os
import asyncio
import json
import time
from dataclasses import replace

import numpy as np
import pytest

from app.engine import Sam3Engine
from app.image_cache import ImageCache
from app.jobs import JobManager
from app.schemas import InferRequest
from app.settings import Settings


@pytest.mark.gpu
@pytest.mark.skipif(os.getenv("SAM3_RUN_GPU_TESTS") != "1", reason="explicit real-GPU lifecycle opt-in required")
def test_real_cancelled_reload_reused_by_next_image() -> None:
    async def exercise() -> None:
        settings = replace(Settings.from_env(), model_idle_seconds=1, maintenance_interval_seconds=0.02)
        if not settings.model_path.is_file():
            pytest.skip("SAM3_MODEL_PATH does not point to an existing checkpoint")
        engine = Sam3Engine(settings)
        cache = ImageCache(ttl_seconds=600, max_bytes=1024 * 1024)
        manager = JobManager(settings, engine, cache)

        async def until(predicate, timeout=240):
            deadline = time.monotonic() + timeout
            while not predicate():
                assert time.monotonic() < deadline, "real GPU lifecycle timed out"
                await asyncio.sleep(0.01)

        await manager.start()
        try:
            await manager._startup_load_task
            first_seconds = manager.last_load_seconds
            first_timings = dict(engine.load_timings)
            manager._last_model_ready = manager._last_inference_finished = time.monotonic() - 2
            await until(lambda: not engine.model_loaded)
            image = np.zeros((256, 256, 3), dtype=np.uint8)
            image[64:192, 64:192] = 255
            cached, _ = cache.add(image)
            request = InferRequest(imageId=cached.image_id, requestId="gpu-page-a:1", mode="points", threshold=0,
                                   points=[{"x": 128, "y": 128, "positive": True}])
            cancelled = manager.submit(request)
            await until(lambda: manager.model_loading)
            manager.cancel(cancelled.job_id)
            await until(lambda: manager._active is None)
            assert cancelled.status == "cancelled"
            assert engine.model_loaded
            await asyncio.sleep(0.1)
            assert engine.model_loaded, "cancelled reload was immediately unloaded"
            next_job = manager.submit(request.model_copy(update={"requestId": "gpu-page-b:1"}))
            await until(lambda: next_job.status in manager._terminal_states())
            assert next_job.status == "ready", next_job.error
            assert next_job.candidates
            assert manager.load_count == 2
            print(json.dumps({"initialLoadSeconds": first_seconds, "initialTimings": first_timings,
                              "reloadSeconds": manager.last_load_seconds, "reloadTimings": engine.load_timings,
                              "loadCountIncludingStartup": manager.load_count, "nextImageStatus": next_job.status,
                              "nextImageCandidates": len(next_job.candidates)}, ensure_ascii=False), flush=True)
        finally:
            await manager.stop()

    asyncio.run(exercise())


@pytest.mark.gpu
@pytest.mark.skipif(
    os.getenv("SAM3_RUN_GPU_TESTS") != "1",
    reason="set SAM3_RUN_GPU_TESTS=1 to load the local multi-gigabyte checkpoint",
)
def test_real_model_text_points_and_refine_smoke() -> None:
    settings = Settings.from_env()
    if not settings.model_path.is_file():
        pytest.skip("SAM3_MODEL_PATH does not point to an existing checkpoint")

    engine = Sam3Engine(settings)
    image = np.zeros((288, 288, 3), dtype=np.uint8)
    yy, xx = np.ogrid[:288, :288]
    image[(xx - 144) ** 2 + (yy - 144) ** 2 < 55**2] = 255
    try:
        engine.load()
        text_result = engine.infer(
            image=image,
            mode="text",
            prompt="white circle",
            threshold=0.5,
            points=[],
            refine_bbox=None,
        )
        assert len(text_result.candidates) <= settings.max_candidates
        for candidate in text_result.candidates:
            assert candidate.mask.bbox["width"] <= image.shape[1]
            assert candidate.mask.bbox["height"] <= image.shape[0]
            assert len(candidate.mask.data) == candidate.mask.byte_length

        points_result = engine.infer(
            image=image,
            mode="points",
            prompt=None,
            threshold=0.0,
            points=[
                {"x": 144.0, "y": 144.0, "positive": True},
                {"x": 8.0, "y": 8.0, "positive": False},
            ],
            refine_bbox=None,
        )
        assert points_result.candidates
        selected = points_result.candidates[0]
        refined = engine.infer(
            image=image,
            mode="refine",
            prompt=None,
            threshold=1.0,
            points=[{"x": 144.0, "y": 144.0, "positive": True}],
            refine_bbox=selected.mask.bbox,
        )
        assert len(refined.candidates) == 1
        assert refined.candidates[0].score >= 0.0
    finally:
        engine.unload()
