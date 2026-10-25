import json
from pathlib import Path

import pytest

from app.settings import Settings


def test_saved_idle_priority_and_partial_updates(tmp_path, monkeypatch):
    file = tmp_path / "settings.json"
    monkeypatch.setenv("SAM3_SETTINGS_FILE", str(file))
    monkeypatch.delenv("SAM3_MODEL_IDLE_SECONDS", raising=False)
    assert Settings.from_env().model_idle_seconds == 900
    monkeypatch.setenv("SAM3_MODEL_IDLE_SECONDS", "125")
    assert Settings.from_env().model_idle_seconds == 125
    file.write_text(json.dumps({"modelPath": "/old", "modelIdleSeconds": 0}))
    assert Settings.from_env().model_idle_seconds == 125
    config = Settings.from_env()
    config.save_settings(model_idle_seconds=60)
    config.save_model_path(Path("/new"))
    assert json.loads(file.read_text()) == {"modelPath": "/new", "modelIdleSeconds": 60}
    monkeypatch.setenv("SAM3_MODEL_IDLE_SECONDS", "invalid")
    restored = Settings.from_env()
    assert restored.model_path == Path("/new")
    assert restored.model_idle_seconds == 60


def test_atomic_save_failure_keeps_file(tmp_path, monkeypatch):
    config = Settings(model_path=Path("/old"), ui_origins=frozenset(), model_settings_file=tmp_path / "settings.json")
    config.save_model_path(Path("/old"))
    def fail(*args):
        raise OSError("cannot replace")
    monkeypatch.setattr(Path, "replace", fail)
    with pytest.raises(OSError):
        config.save_settings(model_idle_seconds=60)
    assert json.loads(config.model_settings_file.read_text()) == {"modelPath": "/old"}
    assert list(tmp_path.iterdir()) == [config.model_settings_file]
