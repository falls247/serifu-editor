"""単一プロセス・単一モデルで変更前後を計測。既存API停止後に実行する。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import engine as engine_module
from app.model_loader import memory_snapshot
from app.settings import Settings
from importlib.machinery import SourceFileLoader


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strategy", choices=("baseline", "mapped"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int)
    parser.add_argument("--min-available-mib", type=int, default=512)
    args = parser.parse_args()
    settings = Settings.from_env()
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", settings.api_port)) == 0:
            raise SystemExit("既存APIが稼働中。利用者が停止してから計測すること。")
    import logging
    logging.basicConfig(level=logging.INFO)
    import numpy as np
    import torch
    from PIL import Image
    if not torch.cuda.is_available():
        raise SystemExit("CUDA GPU required")
    if torch.cuda.memory_allocated():
        raise SystemExit("A model is already allocated in this process")
    if args.threads is not None:
        torch.set_num_threads(args.threads)
    baseline_loader = engine_module.load_model
    if args.strategy == "baseline":
        def baseline(path, *, timings):
            from sam3.model_builder import build_sam3_image_model
            return build_sam3_image_model(checkpoint_path=path, load_from_HF=False,
                enable_inst_interactivity=True, device="cuda", eval_mode=True)
        engine_module.load_model = baseline
    report = {"strategy": args.strategy, "threads": torch.get_num_threads(),
              "checkpoint": str(settings.model_path), "before": memory_snapshot(), "samples": []}
    stop = threading.Event()
    def monitor():
        while not stop.wait(0.2):
            sample = memory_snapshot()
            report["samples"].append(sample)
            if sample.get("MemAvailable", float("inf")) < args.min_available_mib * 1024:
                report["result"] = "ABORTED_LOW_MEMORY"
                args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
                os._exit(2)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    engine = engine_module.Sam3Engine(settings)
    try:
        started = time.monotonic()
        engine.load()
        torch.cuda.synchronize()
        report["loadSeconds"] = time.monotonic() - started
        report["loadTimings"] = engine.load_timings
        report["afterLoad"] = memory_snapshot()
        report["gpuAllocatedMiB"] = torch.cuda.memory_allocated() / 1024**2
        report["gpuPeakMiB"] = torch.cuda.max_memory_allocated() / 1024**2
        weights = hashlib.sha256()
        for key, tensor in engine._model.state_dict().items():
            weights.update(key.encode())
            weights.update(str(tensor.dtype).encode())
            weights.update(tensor.detach().cpu().contiguous().numpy().tobytes())
        report["weightsSha256"] = weights.hexdigest()
        tensor = None
        fixture = SourceFileLoader("sam3_fixture", str(Path(__file__).with_name("sam3-gpu-lifecycle.py"))).load_module()
        image = np.array(Image.open(io.BytesIO(fixture.fixture_png())).convert("RGB"))
        points = [{"x": 128., "y": 128., "positive": True}, {"x": 20., "y": 20., "positive": False}]
        report["inferences"] = {}
        bbox = None
        for mode in ("text", "points", "refine"):
            result = engine.infer(image=image, mode=mode, prompt="face" if mode == "text" else None,
                threshold=0.5, points=[] if mode == "text" else points, refine_bbox=bbox if mode == "refine" else None)
            assert result.candidates, f"no {mode} candidates"
            report["inferences"][mode] = [{"score": candidate.score, "bbox": candidate.mask.bbox,
                "maskSha256": candidate.mask.sha256} for candidate in result.candidates]
            if mode == "text": bbox = result.candidates[0].mask.bbox
        report["result"] = "PASS"
    finally:
        engine.unload()
        stop.set(); watcher.join()
        engine_module.load_model = baseline_loader
        report["afterUnload"] = memory_snapshot()
        report["gpuAfterUnloadMiB"] = torch.cuda.memory_allocated() / 1024**2
        torch.clear_autocast_cache()
        torch.cuda.empty_cache()
        report["gpuAfterCastCacheClearMiB"] = torch.cuda.memory_allocated() / 1024**2
        samples = report.pop("samples")
        report["sampleCount"] = len(samples)
        report["minMemAvailableKiB"] = min((s.get("MemAvailable", float("inf")) for s in samples), default=0)
        report["maxProcessSwapKiB"] = max((s.get("VmSwap", 0) for s in samples), default=0)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("result", "strategy", "loadSeconds", "afterLoad", "gpuPeakMiB")}))


if __name__ == "__main__":
    main()
