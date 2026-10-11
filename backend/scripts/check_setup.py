from __future__ import annotations

import importlib.metadata
import os
import shutil
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = Path.home() / "dev/models/vision/sam3.pt"
MIN_CUDA = (12, 6)


def _print(label: str, value: object) -> None:
    print(f"{label}: {value}")


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    _print("Python", sys.version.split()[0])
    if sys.version_info[:2] != (3, 12):
        errors.append("Use Python 3.12 (`uv python install 3.12`).")

    model_path = Path(os.getenv("SAM3_MODEL_PATH", str(DEFAULT_MODEL))).expanduser()
    _print("SAM3_MODEL_PATH", model_path)
    if not model_path.is_file():
        errors.append("Checkpoint is missing; set SAM3_MODEL_PATH to an existing sam3.pt.")
    else:
        _print("Checkpoint bytes", model_path.stat().st_size)
        disk = shutil.disk_usage(model_path.parent)
        _print("Free disk bytes", disk.free)
        if disk.free < 8 * 1024**3:
            warnings.append("Less than 8 GiB is free beside the checkpoint.")

    try:
        import torch
    except Exception as exc:
        errors.append(
            f"PyTorch import failed ({type(exc).__name__}); run `uv sync --locked --extra gpu`."
        )
        torch = None

    if torch is not None:
        _print("PyTorch", torch.__version__)
        cuda_version = torch.version.cuda
        _print("PyTorch CUDA runtime", cuda_version or "none")
        if cuda_version:
            parts = tuple(int(part) for part in cuda_version.split(".")[:2])
            if parts < MIN_CUDA:
                errors.append("Install a PyTorch build with CUDA 12.6 or newer.")
        else:
            errors.append("Install the CUDA-enabled PyTorch build from the gpu extra.")
        available = bool(torch.cuda.is_available())
        _print("CUDA available", available)
        if not available:
            errors.append("NVIDIA GPU is unavailable to this WSL process.")
        else:
            properties = torch.cuda.get_device_properties(0)
            _print("GPU", properties.name)
            _print("Compute capability", f"{properties.major}.{properties.minor}")
            _print("CUDA memory bytes", properties.total_memory)

    for distribution in ("sam3", "torchvision", "einops", "pycocotools", "psutil"):
        try:
            version = importlib.metadata.version(distribution)
            _print(distribution, version)
        except importlib.metadata.PackageNotFoundError:
            errors.append(
                f"{distribution} is missing; run `uv sync --locked --extra gpu`."
            )

    try:
        from sam3.model.data_misc import interpolate  # noqa: F401
        from sam3.model.sam3_image_processor import Sam3Processor  # noqa: F401
        from sam3.model_builder import build_sam3_image_model  # noqa: F401

        _print("SAM3 runtime API imports", "ok")
    except Exception as exc:
        errors.append(
            f"SAM3 runtime import failed ({type(exc).__name__}); run `uv sync --locked --extra gpu`."
        )

    try:
        import torchvision

        _print("torchvision import", torchvision.__version__)
    except Exception as exc:
        errors.append(f"torchvision import failed ({type(exc).__name__}).")

    if errors:
        for message in errors:
            print(f"ERROR: {message}")
    if warnings:
        for message in warnings:
            print(f"WARNING: {message}")
    if not errors:
        print("Setup checks passed. Model weights are not downloaded by this command.")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
