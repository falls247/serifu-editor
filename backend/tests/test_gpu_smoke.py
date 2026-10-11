from __future__ import annotations

import os

import numpy as np
import pytest

from app.engine import Sam3Engine
from app.settings import Settings


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
