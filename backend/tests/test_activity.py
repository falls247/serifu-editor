import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import jobs
from app.engine import MockSam3Engine
from app.image_cache import ImageCache
from app.jobs import JobManager
from app.main import create_app
from app.schemas import ActivityRequest
from app.settings import Settings


def setup(tmp_path):
    config = Settings(model_path=Path("/unused"), ui_origins=frozenset({"http://localhost:5173"}), model_settings_file=tmp_path / "settings.json")
    engine = MockSam3Engine(config)
    manager = JobManager(config, engine, ImageCache(ttl_seconds=600, max_bytes=1024))
    return config, engine, manager


def activity(manager, now, session="tab-a", sequence=1, elapsed=0, **overrides):
    return ActivityRequest(**(dict(sessionId=session, sequence=sequence, epoch=manager.activity_epoch, window=int(now // 10), elapsedSeconds=elapsed) | overrides))


def test_monotonic_deadline_tabs_stale_notifications_and_unloaded_activity(tmp_path, monkeypatch):
    async def run():
        _, engine, manager = setup(tmp_path)
        clock = [1000.]
        monkeypatch.setattr(jobs, "time", SimpleNamespace(monotonic=lambda: clock[0]))
        engine.load()
        manager._last_model_ready = clock[0]
        clock[0] += 899
        # Health reads never move the deadline.
        assert manager.idle_state()["idleRemainingSeconds"] == 1
        assert not manager._idle_expired()
        notice = activity(manager, clock[0], elapsed=4)
        assert manager.record_activity(notice)
        assert manager.idle_state()["idleElapsedSeconds"] == 4
        clock[0] += 100
        assert manager.record_activity(activity(manager, clock[0], session="tab-b"))
        clock[0] += 899
        assert not manager._idle_expired()
        assert not manager.record_activity(notice)
        assert not manager.record_activity(activity(manager, clock[0], epoch="deadbeef"))
        clock[0] += 1
        assert manager._idle_expired()
        await manager.unload_if_idle()
        assert not engine.model_loaded
        assert manager.record_activity(activity(manager, clock[0], sequence=2))
        assert not engine.model_loaded, "editing must never load a model"
    asyncio.run(run())


def test_gpu_lock_rechecks_new_activity_settings_and_pending_work(tmp_path, monkeypatch):
    async def run():
        _, engine, manager = setup(tmp_path)
        clock = [2000.]
        monkeypatch.setattr(jobs, "time", SimpleNamespace(monotonic=lambda: clock[0]))
        engine.load()
        manager._last_model_ready = 0
        await manager._gpu_lock.acquire()
        pending = asyncio.create_task(manager.unload_if_idle())
        await asyncio.sleep(0)
        manager.record_activity(activity(manager, clock[0]))
        manager._gpu_lock.release()
        await pending
        assert engine.model_loaded
        clock[0] += 900
        manager._pending.put_nowait(None)
        await manager.unload_if_idle()
        assert engine.model_loaded
        manager._pending.get_nowait()
        manager._active = object()
        assert manager.idle_state()["idleReleaseDeferred"]
        await manager.unload_if_idle()
        assert engine.model_loaded
        manager._active = None
        await manager.update_settings(model_idle_seconds=14400)
        assert manager._last_activity == clock[0]
        assert not manager._idle_expired()
        assert engine.model_loaded
        assert manager.load_count == 0
    asyncio.run(run())


def test_settings_save_failure_keeps_runtime_revision(tmp_path, monkeypatch):
    async def run():
        config, engine, manager = setup(tmp_path)
        def fail(*args, **kwargs): raise OSError("disk full")
        monkeypatch.setattr(Settings, "save_settings", fail)
        with pytest.raises(jobs.ApiException):
            await manager.update_settings(model_idle_seconds=60)
        assert manager.settings == config
        assert engine.settings == config
        assert manager.settings_revision == 0
        assert manager._last_activity is None
    asyncio.run(run())


def test_api_idle_partial_settings_security_validation_and_activity(tmp_path):
    config, engine, _ = setup(tmp_path)
    with TestClient(create_app(config, engine=engine), base_url="http://127.0.0.1:8765") as client:
        headers = {"Origin": "http://localhost:5173"}
        before = client.get("/api/sam3/health").json()
        for value in [None, True, "60", 0, 59, 61, 14460, 60.5]:
            assert client.post("/api/sam3/settings", json={"modelIdleSeconds": value}, headers=headers).status_code == 422
        assert client.post("/api/sam3/settings", json={}, headers=headers).status_code == 422
        for value in [60, 14400]:
            response = client.post("/api/sam3/settings", json={"modelIdleSeconds": value}, headers=headers)
            assert response.status_code == 200
            saved = response.json()
            assert saved["modelIdleSeconds"] == value
            assert saved["modelPath"] == before["modelPath"]
        after = client.get("/api/sam3/health").json()
        assert after["modelGeneration"] == before["modelGeneration"]
        assert after["loadCount"] == before["loadCount"]
        assert after["settingsRevision"] == 2
        payload = dict(sessionId="tab-a", sequence=1, epoch=after["activityEpoch"], window=after["activityWindow"], elapsedSeconds=1)
        assert client.post("/api/sam3/activity", json=payload).status_code == 403
        assert client.post("/api/sam3/activity", json=payload, headers={"Origin": "https://example.com"}).status_code == 403
        assert client.post("/api/sam3/activity", json=payload, headers=headers).json() == {"accepted": True}
        assert client.post("/api/sam3/activity", json=payload, headers=headers).json() == {"accepted": False}
        for changes in [dict(elapsedSeconds=-1), dict(elapsedSeconds=11), dict(sequence=True), dict(sessionId=""), dict(text="private")]:
            assert client.post("/api/sam3/activity", json=payload | changes, headers=headers).status_code == 422
        assert client.post("/api/sam3/activity", content=b" " * 1025, headers=headers).status_code == 413
