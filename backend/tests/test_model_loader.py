import gc
import weakref

import pytest

torch = pytest.importorskip("torch")
from app import model_loader as loader


class Tiny(torch.nn.Module):
    def __init__(self, device="cpu"):
        super().__init__()
        self.first = torch.nn.Linear(3, 3, bias=False, device=device)
        self.second = torch.nn.Linear(3, 3, bias=False, device=device)
        self.second.weight = self.first.weight
        self.register_buffer("fixed", torch.tensor([7.], device=device))
        self.register_buffer("fixed_alias", self.fixed)
        self.register_buffer("scratch", torch.ones(2), persistent=False)


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("meta", [False, True])
def test_mmap_assign_preserves_values_buffers_aliases(tmp_path, monkeypatch, legacy, meta):
    original = Tiny()
    path = tmp_path / "tiny.pt"
    torch.save({"model": {"detector." + key: value for key, value in original.state_dict().items()}}, path, _use_new_zipfile_serialization=not legacy)
    monkeypatch.setattr(loader, "build_structure", lambda: Tiny("meta" if meta else "cpu"))
    calls, real_load = [], torch.load
    def observed(*args, **kwargs):
        calls.append((args, kwargs))
        return real_load(*args, **kwargs)
    monkeypatch.setattr(torch, "load", observed)
    timings = {}
    loaded = loader.load_model(str(path), timings=timings, device="cpu")
    assert loaded.first.weight is loaded.second.weight
    assert torch.equal(loaded.first.weight, original.first.weight)
    assert torch.equal(loaded.fixed, original.fixed)
    assert loaded.fixed is loaded.fixed_alias
    assert torch.equal(loaded.scratch, original.scratch)
    assert not loaded.training
    assert calls[0][0] == (str(path),)
    assert calls[0][1] == dict(map_location="cpu", weights_only=True, mmap=not legacy)
    assert set(timings) == {name + "Seconds" for name in ("checkpoint", "structure", "assignment", "transfer")}


@pytest.mark.parametrize("problem", ["missing", "extra", "shape", "oom", "meta-buffer"])
def test_incompatible_checkpoint_or_transfer_fails_once_and_releases(tmp_path, monkeypatch, problem):
    original = Tiny()
    state = {"detector." + key: value for key, value in original.state_dict().items()}
    if problem == "missing": state.pop("detector.fixed")
    if problem == "extra": state["detector.unexpected"] = torch.ones(1)
    if problem == "shape": state["detector.first.weight"] = torch.ones(5)
    path = tmp_path / "bad.pt"
    torch.save(state, path)
    references = []
    def build():
        model = Tiny()
        if problem == "oom":
            def fail(*args, **kwargs): raise torch.cuda.OutOfMemoryError("test")
            model.to = fail
        if problem == "meta-buffer": model.scratch = torch.ones(2, device="meta")
        references.append(weakref.ref(model))
        return model
    monkeypatch.setattr(loader, "build_structure", build)
    with pytest.raises(RuntimeError):
        loader.load_model(str(path), timings={}, device="cpu")
    gc.collect()
    assert len(references) == 1
    assert references[0]() is None


def test_tracker_key_mapping_shares_storage():
    tensor = torch.ones(2)
    result = loader.checkpoint_state({"tracker.weight": tensor, "unrelated": tensor})
    assert list(result) == ["inst_interactive_predictor.model.weight"]
    assert next(iter(result.values())) is tensor


def test_assignment_preserves_original_builder_dtype(tmp_path, monkeypatch):
    source = Tiny().double()
    path = tmp_path / "double.pt"
    torch.save({"detector." + key: value for key, value in source.state_dict().items()}, path)
    monkeypatch.setattr(loader, "build_structure", Tiny)
    model = loader.load_model(str(path), timings={}, device="cpu")
    assert model.first.weight.dtype == torch.float32
    assert model.fixed.dtype == torch.float32
    assert torch.equal(model.first.weight, source.first.weight.float())
