from __future__ import annotations

import gc
import importlib.metadata
import logging
import math
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from .mask_codec import EncodedMask, encode_mask
from .settings import Settings

logger = logging.getLogger(__name__)


class EngineError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 503,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class EngineCandidate:
    score: float
    mask: EncodedMask
    candidate_id: str | None = None

    @property
    def decoded_pixels(self) -> int:
        return self.mask.bbox["width"] * self.mask.bbox["height"]


@dataclass(frozen=True, slots=True)
class EngineResult:
    candidates: tuple[EngineCandidate, ...]
    warnings: tuple[str, ...] = ()


class Sam3Engine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.status = "unloaded"
        self.model_loaded = False
        self.gpu_available = False
        self.version = self._sam3_version()
        self.load_error: str | None = None
        self.load_error_message: str | None = None
        self.last_inference_finished: float | None = None
        self._model: Any = None
        self._processor: Any = None
        self._torch: Any = None
        self._lock = threading.RLock()

    @staticmethod
    def _sam3_version() -> str:
        try:
            return importlib.metadata.version("sam3")
        except importlib.metadata.PackageNotFoundError:
            return "not-installed"

    def load(self) -> None:
        with self._lock:
            if self.model_loaded:
                return
            self.status = "loading"
            self.load_error = None
            self.load_error_message = None
            if not self.settings.model_path.is_file():
                self.status = "error"
                self.load_error = "MODEL_NOT_FOUND"
                self.load_error_message = (
                    "SAM3 checkpoint is missing. Set SAM3_MODEL_PATH to an existing sam3.pt."
                )
                raise EngineError(
                    "MODEL_NOT_FOUND",
                    f"SAM3 checkpoint not found: {self.settings.model_path}. "
                    "Set SAM3_MODEL_PATH to an existing sam3.pt file.",
                )
            try:
                import torch
                from sam3.model.data_misc import interpolate
                from sam3.model.sam3_image_processor import Sam3Processor
                from sam3.model_builder import build_sam3_image_model
            except Exception as exc:
                self.status = "error"
                self.load_error = "MODEL_LOAD_FAILED"
                self.load_error_message = (
                    "SAM3 dependencies are unavailable. Run `uv sync --locked --extra gpu`."
                )
                logger.warning(
                    "SAM3 dependencies could not be imported (%s)", type(exc).__name__
                )
                raise EngineError(
                    "MODEL_LOAD_FAILED",
                    "SAM3 dependencies are unavailable. Run `uv sync --locked --extra gpu`.",
                ) from None

            self._torch = torch
            self.gpu_available = bool(torch.cuda.is_available())
            if not self.gpu_available:
                self.status = "error"
                self.load_error = "GPU_UNAVAILABLE"
                self.load_error_message = (
                    "CUDA GPU is unavailable. Check the NVIDIA driver and PyTorch CUDA build."
                )
                raise EngineError(
                    "GPU_UNAVAILABLE",
                    "CUDA GPU is unavailable. Check the NVIDIA driver and PyTorch CUDA build.",
                )

            limits = {
                "max_candidates": self.settings.max_candidates,
                "max_candidate_pixels": self.settings.max_candidate_pixels,
                "max_response_bytes": self.settings.max_response_bytes,
            }

            class BoundedSam3Processor(Sam3Processor):
                """Apply output limits before expanding masks to original resolution."""

                def _forward_grounding(self, state: dict[str, Any]) -> dict[str, Any]:
                    outputs = self.model.forward_grounding(
                        backbone_out=state["backbone_out"],
                        find_input=self.find_stage,
                        geometric_prompt=state["geometric_prompt"],
                        find_target=None,
                    )
                    original_height = int(state["original_height"])
                    original_width = int(state["original_width"])
                    probabilities = outputs["pred_logits"].sigmoid()
                    presence_score = outputs["presence_logit_dec"].sigmoid().unsqueeze(1)
                    probabilities = (probabilities * presence_score).squeeze(-1)
                    keep = probabilities > self.confidence_threshold
                    original_count = int(keep.sum().item())
                    kept_scores = probabilities[keep]
                    kept_masks = outputs["pred_masks"][keep]
                    if kept_scores.numel():
                        order = torch.argsort(kept_scores, descending=True, stable=True)
                        kept_scores = kept_scores[order]
                        kept_masks = kept_masks[order]
                    candidate_limit_hit = original_count > limits["max_candidates"]
                    kept_scores = kept_scores[: limits["max_candidates"]]
                    kept_masks = kept_masks[: limits["max_candidates"]]

                    decoded_pixels = 0
                    response_bytes = 0
                    encoded_candidates: list[tuple[float, EncodedMask]] = []
                    warnings_found: set[str] = set()
                    if candidate_limit_hit:
                        warnings_found.add("CANDIDATES_TRUNCATED")

                    for index in range(int(kept_scores.shape[0])):
                        selected_mask = kept_masks[index]
                        logits = selected_mask.reshape(
                            1, 1, *selected_mask.shape[-2:]
                        )
                        probability = interpolate(
                            logits,
                            (original_height, original_width),
                            mode="bilinear",
                            align_corners=False,
                        ).sigmoid()[0, 0]
                        binary = (probability > 0.5).to(torch.uint8).cpu().numpy()
                        del probability, logits, selected_mask
                        if not binary.any():
                            del binary
                            continue
                        encoded = encode_mask(binary)
                        del binary
                        next_pixels = decoded_pixels + (
                            encoded.bbox["width"] * encoded.bbox["height"]
                        )
                        next_response = (
                            response_bytes
                            + ((encoded.byte_length + 2) // 3) * 4
                            + 320
                        )
                        if next_pixels > limits["max_candidate_pixels"]:
                            warnings_found.add("CANDIDATE_MEMORY_LIMIT")
                            continue
                        if next_response > limits["max_response_bytes"]:
                            warnings_found.add("RESPONSE_SIZE_LIMIT")
                            break
                        encoded_candidates.append(
                            (float(kept_scores[index].item()), encoded)
                        )
                        decoded_pixels = next_pixels
                        response_bytes = next_response

                    state["encodedCandidates"] = encoded_candidates
                    state["candidateCountBeforeLimits"] = original_count
                    state["candidateWarnings"] = tuple(sorted(warnings_found))
                    state["scores"] = kept_scores.detach().cpu()
                    state["boxes"] = outputs["pred_boxes"].detach().cpu()
                    state["masks"] = None
                    return state

            try:
                model = build_sam3_image_model(
                    checkpoint_path=str(self.settings.model_path),
                    load_from_HF=False,
                    enable_inst_interactivity=True,
                    device="cuda",
                    eval_mode=True,
                )
                model.eval()
                processor = BoundedSam3Processor(
                    model,
                    resolution=1008,
                    device="cuda",
                    confidence_threshold=0.5,
                )
                processor.output_limits = limits
            except Exception as exc:
                self.status = "error"
                self.load_error = "MODEL_LOAD_FAILED"
                self.load_error_message = (
                    "SAM3 model initialization failed. Check checkpoint compatibility and GPU memory."
                )
                logger.warning("SAM3 model load failed (%s)", type(exc).__name__)
                self._release_references()
                raise EngineError(
                    "MODEL_LOAD_FAILED",
                    "SAM3 model initialization failed. Check checkpoint compatibility and GPU memory.",
                ) from None
            self._model = model
            self._processor = processor
            self.version = self._sam3_version()
            self.model_loaded = True
            self.status = "ready"
            self.load_error = None
            self.load_error_message = None

    def infer(
        self,
        *,
        image: np.ndarray,
        mode: str,
        prompt: str | None,
        threshold: float,
        points: list[dict[str, float | bool]],
        refine_bbox: dict[str, int] | None,
    ) -> EngineResult:
        with self._lock:
            if not self.model_loaded:
                self.load()
            for attempt in range(2):
                try:
                    result = self._infer_once(
                        image=image,
                        mode=mode,
                        prompt=prompt,
                        threshold=threshold,
                        points=points,
                        refine_bbox=refine_bbox,
                    )
                    self.last_inference_finished = time.monotonic()
                    return result
                except Exception as exc:
                    if not self._is_cuda_oom(exc):
                        if isinstance(exc, EngineError):
                            raise
                        logger.warning("SAM3 inference failed (%s)", type(exc).__name__)
                        raise EngineError(
                            "INFERENCE_FAILED",
                            "SAM3 inference failed. Retry the latest request.",
                            http_status=503,
                            retryable=True,
                        ) from None
                    logger.warning("SAM3 CUDA OOM during attempt %d", attempt + 1)
                    if attempt == 0:
                        exc.__traceback__ = None
                        self._clear_cuda_cache()
                        continue
                    self.last_inference_finished = time.monotonic()
                    raise EngineError(
                        "GPU_OOM",
                        "SAM3 ran out of GPU memory after one retry. Close other GPU applications and retry.",
                        http_status=503,
                        retryable=True,
                    ) from None
        raise AssertionError("unreachable inference retry state")

    def _infer_once(
        self,
        *,
        image: np.ndarray,
        mode: str,
        prompt: str | None,
        threshold: float,
        points: list[dict[str, float | bool]],
        refine_bbox: dict[str, int] | None,
    ) -> EngineResult:
        torch = self._torch
        model = self._model
        processor = self._processor
        if torch is None or model is None or processor is None:
            raise EngineError("MODEL_LOAD_FAILED", "SAM3 model is not loaded.")

        pil_image = Image.fromarray(image)
        with torch.inference_mode():
            processor.confidence_threshold = threshold
            state = processor.set_image(pil_image)
            if mode == "text":
                state = processor.set_text_prompt(state=state, prompt=prompt or "")
                pairs = state.get("encodedCandidates", [])
                warnings_found = set(state.get("candidateWarnings", ()))
                candidates = [
                    EngineCandidate(score=score, mask=encoded)
                    for score, encoded in pairs
                ]
                return EngineResult(
                    candidates=tuple(candidates),
                    warnings=tuple(sorted(warnings_found)),
                )

            predictor_points = np.asarray(
                [[float(point["x"]), float(point["y"])] for point in points],
                dtype=np.float32,
            )
            predictor_labels = np.asarray(
                [1 if bool(point["positive"]) else 0 for point in points],
                dtype=np.int32,
            )
            call: dict[str, Any] = {
                "inference_state": state,
                "point_coords": predictor_points,
                "point_labels": predictor_labels,
                "multimask_output": True,
            }
            if mode == "refine" and refine_bbox is not None:
                call["box"] = np.asarray(
                    [
                        refine_bbox["x"],
                        refine_bbox["y"],
                        refine_bbox["x"] + refine_bbox["width"],
                        refine_bbox["y"] + refine_bbox["height"],
                    ],
                    dtype=np.float32,
                )
            masks, scores, _low_res_masks = model.predict_inst(**call)

        mask_array = np.asarray(masks)
        score_array = np.asarray(scores, dtype=np.float32).reshape(-1)
        if mask_array.ndim == 2:
            mask_array = mask_array[None, ...]
        if mask_array.ndim == 4 and mask_array.shape[1] == 1:
            mask_array = mask_array[:, 0]
        if mask_array.ndim != 3 or mask_array.shape[0] != score_array.shape[0]:
            raise EngineError(
                "MODEL_LOAD_FAILED",
                "SAM3 returned an unsupported interactive mask format.",
            )

        ranked = sorted(
            (
                (index, float(score))
                for index, score in enumerate(score_array)
                if math.isfinite(float(score))
                and (mode == "refine" or float(score) > threshold)
            ),
            key=lambda item: (-item[1], item[0]),
        )
        if mode == "refine":
            ranked = ranked[:1]
        candidates: list[EngineCandidate] = []
        warnings_found: set[str] = set()
        decoded_pixels = 0
        response_bytes = 0
        if len(ranked) > self.settings.max_candidates:
            warnings_found.add("CANDIDATES_TRUNCATED")

        for index, score in ranked[: self.settings.max_candidates]:
            candidate_mask = np.asarray(mask_array[index])
            if candidate_mask.shape != (image.shape[0], image.shape[1]):
                raise EngineError(
                    "MODEL_LOAD_FAILED",
                    "SAM3 returned a mask with unexpected image dimensions.",
                )
            if candidate_mask.dtype.kind == "f":
                candidate_mask = candidate_mask > 0.5
            if not np.any(candidate_mask):
                continue
            encoded = encode_mask(candidate_mask)
            next_pixels = decoded_pixels + (
                encoded.bbox["width"] * encoded.bbox["height"]
            )
            next_response = response_bytes + ((encoded.byte_length + 2) // 3) * 4 + 320
            if next_pixels > self.settings.max_candidate_pixels:
                warnings_found.add("CANDIDATE_MEMORY_LIMIT")
                continue
            if next_response > self.settings.max_response_bytes:
                warnings_found.add("RESPONSE_SIZE_LIMIT")
                break
            candidates.append(EngineCandidate(score, encoded))
            decoded_pixels = next_pixels
            response_bytes = next_response

        return EngineResult(tuple(candidates), tuple(sorted(warnings_found)))

    def unload(self) -> None:
        with self._lock:
            if not self.model_loaded:
                return
            self._release_references()
            self.model_loaded = False
            self.status = "unloaded"
            self.load_error = None
            self.load_error_message = None

    def _release_references(self) -> None:
        self._processor = None
        self._model = None
        gc.collect()
        if self._torch is not None:
            try:
                if self._torch.cuda.is_available():
                    self._torch.cuda.empty_cache()
            except Exception:
                logger.warning("CUDA cache cleanup failed")

    def _clear_cuda_cache(self) -> None:
        predictor = getattr(self._model, "inst_interactive_predictor", None)
        if predictor is not None:
            predictor._features = None
            predictor._is_image_set = False
            if hasattr(predictor, "_is_batch"):
                predictor._is_batch = False
        gc.collect()
        if self._torch is not None:
            try:
                if self._torch.cuda.is_available():
                    self._torch.cuda.empty_cache()
            except Exception:
                logger.warning("CUDA cache cleanup after OOM failed")

    def _is_cuda_oom(self, exc: Exception) -> bool:
        cuda = getattr(self._torch, "cuda", None)
        oom_type = getattr(cuda, "OutOfMemoryError", ())
        if oom_type and isinstance(exc, oom_type):
            return True
        text = str(exc).lower()
        return isinstance(exc, RuntimeError) and "cuda" in text and "out of memory" in text


class MockSam3Engine:
    """Deterministic API mock; used only when SAM3_MOCK=1 is explicitly set."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.status = "ready"
        self.model_loaded = True
        self.gpu_available = False
        self.version = "mock"
        self.load_error: str | None = None
        self.load_error_message: str | None = None
        self.last_inference_finished: float | None = None

    def load(self) -> None:
        self.status = "ready"
        self.model_loaded = True

    def infer(
        self,
        *,
        image: np.ndarray,
        mode: str,
        prompt: str | None,
        threshold: float,
        points: list[dict[str, float | bool]],
        refine_bbox: dict[str, int] | None,
    ) -> EngineResult:
        self.last_inference_finished = time.monotonic()
        height, width = image.shape[:2]
        mask = np.zeros((height, width), dtype=np.uint8)
        if mode == "refine" and refine_bbox is not None:
            x0, y0 = refine_bbox["x"], refine_bbox["y"]
            x1 = min(width, x0 + refine_bbox["width"])
            y1 = min(height, y0 + refine_bbox["height"])
        elif mode == "points" and points:
            center_x, center_y = int(points[0]["x"]), int(points[0]["y"])
            radius = max(1, min(width, height) // 8)
            x0, y0 = max(0, center_x - radius), max(0, center_y - radius)
            x1, y1 = min(width, center_x + radius + 1), min(height, center_y + radius + 1)
        else:
            x0, y0 = width // 4, height // 4
            x1, y1 = max(x0 + 1, width * 3 // 4), max(y0 + 1, height * 3 // 4)
        mask[y0:y1, x0:x1] = 1
        return EngineResult((EngineCandidate(0.9, encode_mask(mask)),))

    def unload(self) -> None:
        self.status = "unloaded"
        self.model_loaded = False

