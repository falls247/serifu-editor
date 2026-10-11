from __future__ import annotations

import base64
import hashlib
import io
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.engine import EngineError, MockSam3Engine, Sam3Engine
from app.image_cache import ImageCache
from app.main import create_app
from app.mask_codec import decode_mask
from app.settings import Settings

ORIGIN = "http://localhost:5173"
BASE_URL = "http://127.0.0.1:8765"


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "model_path": Path("/unused/sam3.pt"),
        "ui_origins": frozenset({ORIGIN, "http://127.0.0.1:5173"}),
        "inference_timeout_seconds": 3.0,
        "maintenance_interval_seconds": 1,
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _png() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (32, 24), "white").save(output, format="PNG")
    return output.getvalue()


def _upload(client: TestClient, data: bytes | None = None) -> dict[str, object]:
    response = client.post(
        "/api/sam3/images",
        files={"file": ("original.png", data or _png(), "image/png")},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _wait_job(client: TestClient, job_id: str) -> dict[str, object]:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(f"/api/sam3/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in {"ready", "failed", "cancelled", "superseded"}:
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_api_upload_text_points_refine_and_delete() -> None:
    engine = MockSam3Engine(_settings())
    app = create_app(_settings(), engine=engine)
    with TestClient(app, base_url=BASE_URL) as client:
        health = client.get("/api/sam3/health").json()
        assert health["status"] == "ready"
        uploaded = _upload(client)
        assert (uploaded["width"], uploaded["height"]) == (32, 24)
        assert uploaded["expiresAt"].endswith("Z")

        accepted = client.post(
            "/api/sam3/infer",
            json={
                "imageId": uploaded["imageId"],
                "requestId": "page-one:1",
                "mode": "text",
                "prompt": "  face  ",
            },
            headers={"Origin": ORIGIN},
        )
        assert accepted.status_code == 202, accepted.text
        assert accepted.json()["status"] == "queued"
        text_job = _wait_job(client, accepted.json()["jobId"])
        assert text_job["status"] == "ready"
        candidate = text_job["candidates"][0]
        assert set(candidate) == {"candidateId", "score", "bbox", "mask"}
        payload = candidate["mask"]
        mask_bytes = base64.b64decode(payload["dataBase64"], validate=True)
        assert len(mask_bytes) == payload["byteLength"]
        assert hashlib.sha256(mask_bytes).hexdigest() == payload["sha256"]
        decoded = decode_mask(
            payload["codec"],
            mask_bytes,
            candidate["bbox"]["width"],
            candidate["bbox"]["height"],
        )
        assert decoded.any()

        refine = client.post(
            "/api/sam3/infer",
            json={
                "imageId": uploaded["imageId"],
                "requestId": "page-one:2",
                "mode": "refine",
                "candidateId": candidate["candidateId"],
                "points": [{"x": 8, "y": 8, "positive": True}],
            },
            headers={"Origin": ORIGIN},
        )
        assert refine.status_code == 202, refine.text
        refined_job = _wait_job(client, refine.json()["jobId"])
        assert refined_job["status"] == "ready"
        assert refined_job["candidates"][0]["candidateId"] == candidate["candidateId"]

        deleted = client.delete(
            f"/api/sam3/images/{uploaded['imageId']}", headers={"Origin": ORIGIN}
        )
        assert deleted.json() == {"deleted": True}
        expired = client.post(
            "/api/sam3/infer",
            json={
                "imageId": uploaded["imageId"],
                "requestId": "page-one:3",
                "mode": "points",
                "points": [{"x": 8, "y": 8, "positive": True}],
            },
            headers={"Origin": ORIGIN},
        )
        assert expired.status_code == 410
        assert expired.json()["error"]["code"] == "IMAGE_EXPIRED"


def test_api_rejects_host_origin_invalid_points_and_large_upload() -> None:
    config = _settings(max_upload_bytes=64)
    app = create_app(config, engine=MockSam3Engine(config))
    with TestClient(app, base_url=BASE_URL) as client:
        wrong_host = TestClient(app, base_url="http://localhost:8765")
        response = wrong_host.get("/api/sam3/health")
        assert response.status_code == 421
        assert response.json()["error"]["code"] == "INVALID_HOST"

        wrong_origin = client.post(
            "/api/sam3/images",
            files={"file": ("a.png", _png(), "image/png")},
            headers={"Origin": "http://attacker.example"},
        )
        assert wrong_origin.status_code == 403
        assert wrong_origin.json()["error"]["code"] == "INVALID_ORIGIN"

        missing_origin = client.delete(
            "/api/sam3/images/not-a-real-id", headers={"Origin": ""}
        )
        assert missing_origin.status_code == 403
        assert missing_origin.json()["error"]["code"] == "ORIGIN_REQUIRED"

        too_large = client.post(
            "/api/sam3/images",
            files={"file": ("a.png", _png(), "image/png")},
            headers={"Origin": ORIGIN},
        )
        assert too_large.status_code == 413
        assert too_large.json()["error"]["code"] == "INVALID_IMAGE"


def test_duplicate_upload_is_deduplicated() -> None:
    config = _settings()
    app = create_app(config, engine=MockSam3Engine(config))
    with TestClient(app, base_url=BASE_URL) as client:
        first = _upload(client)
        second = _upload(client)
        assert first["imageId"] == second["imageId"]


def test_upload_body_cap_is_checked_before_multipart_parsing() -> None:
    config = _settings(max_upload_bytes=64)
    app = create_app(config, engine=MockSam3Engine(config))
    with TestClient(app, base_url=BASE_URL) as client:
        response = client.post(
            "/api/sam3/images",
            content=b"x" * (2 * 1024 * 1024),
            headers={"Origin": ORIGIN, "Content-Type": "application/octet-stream"},
        )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "INVALID_IMAGE"


def test_loopback_host_allowlist_tracks_configured_api_port() -> None:
    config = _settings(api_port=8877)
    app = create_app(config, engine=MockSam3Engine(config))
    with TestClient(app, base_url="http://127.0.0.1:8877") as client:
        assert client.get("/api/sam3/health").status_code == 200
    wrong_port = TestClient(app, base_url=BASE_URL).get("/api/sam3/health")
    assert wrong_port.status_code == 421
    assert wrong_port.json()["error"]["code"] == "INVALID_HOST"


def test_health_exposes_local_model_load_error() -> None:
    config = _settings(model_path=Path("/definitely/missing/sam3.pt"))
    engine = Sam3Engine(config)
    with pytest.raises(EngineError):
        engine.load()
    app = create_app(config, engine=engine)
    response = TestClient(app, base_url=BASE_URL).get("/api/sam3/health")
    assert response.status_code == 200
    assert response.json()["status"] == "error"
    assert response.json()["error"] == {
        "code": "MODEL_NOT_FOUND",
        "message": "SAM3 checkpoint is missing. Set SAM3_MODEL_PATH to an existing sam3.pt.",
        "retryable": False,
    }

