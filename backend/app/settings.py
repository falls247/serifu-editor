from __future__ import annotations

import os
import math
from dataclasses import dataclass
from pathlib import Path


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _float_env(name: str, default: float, *, minimum: float = 0.1) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not math.isfinite(value) or value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _port_env(name: str, default: int) -> int:
    value = _int_env(name, default)
    if value > 65535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    model_path: Path
    ui_origins: frozenset[str]
    api_port: int = 8765
    max_upload_bytes: int = 30 * 1024 * 1024
    max_image_pixels: int = 40_000_000
    max_image_dimension: int = 30_000
    image_cache_bytes: int = 512 * 1024 * 1024
    image_ttl_seconds: int = 600
    job_ttl_seconds: int = 900
    max_jobs: int = 128
    max_prompt_length: int = 500
    max_points: int = 128
    max_candidates: int = 32
    max_response_bytes: int = 16 * 1024 * 1024
    max_candidate_pixels: int = 128 * 1024 * 1024
    inference_timeout_seconds: float = 180.0
    model_idle_seconds: int = 600
    maintenance_interval_seconds: int = 10
    mock_mode: bool = False

    def __post_init__(self) -> None:
        if not 1 <= self.api_port <= 65535:
            raise ValueError("api_port must be between 1 and 65535")

    @classmethod
    def from_env(cls) -> Settings:
        origins = os.getenv(
            "UI_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        )
        parsed_origins = frozenset(
            origin.strip().rstrip("/") for origin in origins.split(",") if origin.strip()
        )
        return cls(
            model_path=Path(
                os.getenv("SAM3_MODEL_PATH", "~/dev/models/vision/sam3.pt")
            ).expanduser(),
            ui_origins=parsed_origins,
            api_port=_port_env("SAM3_API_PORT", 8765),
            max_upload_bytes=_int_env(
                "SAM3_MAX_UPLOAD_BYTES", 30 * 1024 * 1024
            ),
            max_image_pixels=_int_env("SAM3_MAX_IMAGE_PIXELS", 40_000_000),
            max_image_dimension=_int_env("SAM3_MAX_IMAGE_DIMENSION", 30_000),
            image_cache_bytes=_int_env(
                "SAM3_IMAGE_CACHE_BYTES", 512 * 1024 * 1024
            ),
            image_ttl_seconds=_int_env("SAM3_IMAGE_TTL_SECONDS", 600),
            job_ttl_seconds=_int_env("SAM3_JOB_TTL_SECONDS", 900),
            max_jobs=_int_env("SAM3_MAX_JOBS", 128),
            max_prompt_length=_int_env("SAM3_MAX_PROMPT_LENGTH", 500),
            max_points=_int_env("SAM3_MAX_POINTS", 128),
            max_candidates=_int_env("SAM3_MAX_CANDIDATES", 32),
            max_response_bytes=_int_env(
                "SAM3_MAX_RESPONSE_BYTES", 16 * 1024 * 1024
            ),
            max_candidate_pixels=_int_env(
                "SAM3_MAX_CANDIDATE_PIXELS", 128 * 1024 * 1024
            ),
            inference_timeout_seconds=_float_env(
                "SAM3_INFERENCE_TIMEOUT_SECONDS", 180.0
            ),
            model_idle_seconds=_int_env("SAM3_MODEL_IDLE_SECONDS", 600),
            maintenance_interval_seconds=_int_env(
                "SAM3_MAINTENANCE_INTERVAL_SECONDS", 10
            ),
            mock_mode=os.getenv("SAM3_MOCK", "0").strip().lower()
            in {"1", "true", "yes"},
        )

