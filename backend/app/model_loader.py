"""Application-owned adapter for SAM3 0570b3a; never patches installed packages."""
from __future__ import annotations

import logging
import resource
import sys
import time
import traceback
import zipfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)
SAM3_COMMIT = "0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc"


def memory_snapshot() -> dict[str, float]:
    result = {"maxRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}
    for file, keys in (("/proc/self/status", ("VmRSS", "VmSwap")),
                       ("/proc/meminfo", ("MemAvailable", "Cached", "SwapFree")),
                       ("/proc/self/io", ("read_bytes", "write_bytes")),
                       ("/proc/vmstat", ("pswpin", "pswpout"))):
        try:
            for line in Path(file).read_text().splitlines():
                key, value, *_ = line.replace(":", " ").split()
                if key in keys:
                    result[key] = float(value)
        except (OSError, ValueError):
            pass
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_initialized():
        result["gpuAllocatedMiB"] = torch.cuda.memory_allocated() / 1024**2
        result["gpuReservedMiB"] = torch.cuda.memory_reserved() / 1024**2
    return result


def build_structure() -> Any:
    from sam3.model_builder import build_sam3_image_model
    # Keep upstream's explicit CUDA caches, computed buffers and initialization.
    # meta construction is not safe: pinned ViT calls .item() on torch.linspace.
    return build_sam3_image_model(checkpoint_path=None, load_from_HF=False,
                                 enable_inst_interactivity=True, device="cpu", eval_mode=True)


def shared_parameters(model: Any, *, buffers: bool = False) -> list[list[str]]:
    groups: dict[int, list[str]] = {}
    values = model.named_buffers(remove_duplicate=False) if buffers else model.named_parameters(remove_duplicate=False)
    for name, parameter in values:
        groups.setdefault(id(parameter), []).append(name)
    return [names for names in groups.values() if len(names) > 1]


def restore_shared_parameters(model: Any, groups: list[list[str]], *, buffers: bool = False) -> None:
    for names in groups:
        parameter = model.get_buffer(names[-1]) if buffers else model.get_parameter(names[-1])
        for name in names[:-1]:
            parent, _, key = name.rpartition(".")
            setattr(model.get_submodule(parent), key, parameter)


def checkpoint_state(checkpoint: dict[str, Any]) -> dict[str, Any]:
    checkpoint = checkpoint.get("model", checkpoint)
    if not isinstance(checkpoint, dict):
        raise ValueError("SAM3 checkpoint model must be a state dictionary")
    # Match upstream detector/tracker renaming, sharing tensor storage.
    result = {key.replace("detector.", ""): value for key, value in checkpoint.items() if "detector" in key}
    result.update({key.replace("tracker.", "inst_interactive_predictor.model."): value
                   for key, value in checkpoint.items() if "tracker" in key})
    return result


def load_model(checkpoint_path: str, *, timings: dict[str, float], device: str = "cuda") -> Any:
    import torch
    # Legacy torch.save formats cannot be mapped. Decide before any model exists;
    # all other errors propagate once, including CUDA OOM and corrupt archives.
    mapped = zipfile.is_zipfile(checkpoint_path)
    started = time.monotonic()

    def stage(name: str) -> None:
        nonlocal started
        timings[name + "Seconds"] = round(time.monotonic() - started, 3)
        logger.info("SAM3 load stage=%s seconds=%.3f memory=%s", name, timings[name + "Seconds"], memory_snapshot())
        started = time.monotonic()

    model = checkpoint = state = None
    try:
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True, mmap=mapped)
        state = checkpoint_state(checkpoint)
        stage("checkpoint")
        model = build_structure()
        stage("structure")
        shared = shared_parameters(model)
        shared_buffers = shared_parameters(model, buffers=True)
        # Upstream copy loading preserves the model's dtype. assign=True alone
        # would silently change it for mixed/older checkpoints.
        for key, expected in model.state_dict().items():
            if key in state and state[key].dtype != expected.dtype:
                state[key] = state[key].to(dtype=expected.dtype)
        model.load_state_dict(state, strict=True, assign=True)
        restore_shared_parameters(model, shared)
        restore_shared_parameters(model, shared_buffers, buffers=True)
        expected = None
        checkpoint = state = None
        stage("assignment")
        model = model.to(device).eval()
        restore_shared_parameters(model, shared)
        restore_shared_parameters(model, shared_buffers, buffers=True)
        if any(value.is_meta for value in (*model.parameters(), *model.buffers())):
            raise RuntimeError("SAM3 model contains unmaterialized meta tensors")
        stage("transfer")
        return model
    except BaseException as exc:
        # Tracebacks must not retain a partially loaded model or mapped storage.
        traceback.clear_frames(exc.__traceback__)
        model = checkpoint = state = expected = None
        raise
