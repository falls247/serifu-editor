from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .engine import EngineCandidate, EngineError, EngineResult
from .image_cache import ImageCache, ImageExpiredError
from .schemas import ActivityRequest, InferRequest
from .settings import Settings

logger = logging.getLogger(__name__)


class ApiException(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int,
        retryable: bool = False,
        request_id: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable
        self.request_id = request_id


@dataclass(slots=True)
class CandidateRecord:
    candidate_id: str
    image_id: str
    bbox: dict[str, int]
    expires_at: float


@dataclass(slots=True)
class Job:
    job_id: str
    request: InferRequest
    image_id: str
    page_id: str
    request_seq: int
    refine_bbox: dict[str, int] | None = None
    created_at: float = field(default_factory=time.monotonic)
    status: str = "queued"
    candidates: list[dict[str, Any]] | None = None
    warnings: list[str] = field(default_factory=list)
    error: dict[str, Any] | None = None


class JobManager:
    """Single-worker, latest-wins job scheduler. GPU calls never overlap."""

    def __init__(self, settings: Settings, engine: Any, image_cache: ImageCache) -> None:
        self.settings = settings
        self.engine = engine
        self.image_cache = image_cache
        self.jobs: OrderedDict[str, Job] = OrderedDict()
        self.candidates: OrderedDict[str, CandidateRecord] = OrderedDict()
        self.latest_seq_by_page: dict[str, int] = {}
        self._pending: asyncio.Queue[Job | None] = asyncio.Queue(maxsize=1)
        self._gpu_lock = asyncio.Lock()
        self._worker_task: asyncio.Task[None] | None = None
        self._maintenance_task: asyncio.Task[None] | None = None
        self._startup_load_task: asyncio.Task[None] | None = None
        self._model_load_task: asyncio.Task[None] | None = None
        self._active: Job | None = None
        self._stopping = False
        self._last_inference_finished: float | None = None
        self._last_model_ready: float | None = None
        self.model_generation = uuid.uuid4().hex
        self.load_count = 0
        self.load_started: float | None = None
        self.last_load_seconds: float | None = None
        self._updating_model_path = False
        self._settings_lock = asyncio.Lock()
        self.settings_revision = 0
        self.server_epoch = uuid.uuid4().hex
        self.activity_epoch = uuid.uuid4().hex
        self._last_activity: float | None = None
        self._activity_sessions: OrderedDict[str, tuple[int, float]] = OrderedDict()

    async def set_model_path(self, value: str) -> Path:
        await self.update_settings(model_path=value)
        return self.settings.model_path

    async def update_settings(self, *, model_path: str | None = None, model_idle_seconds: int | None = None) -> None:
        async with self._settings_lock:
            if model_path is not None:
                await self._set_model_settings(model_path, model_idle_seconds)
            else:
                try:
                    await asyncio.to_thread(self.settings.save_settings, model_idle_seconds=model_idle_seconds)
                except OSError:
                    raise ApiException("SETTINGS_SAVE_FAILED", "解放時間を保存できない。保存先の権限を確認。", status=500, retryable=True) from None
                self.settings = replace(self.settings, model_idle_seconds=model_idle_seconds)
                self.engine.settings = self.settings
            self.settings_revision += 1
            self._last_activity = time.monotonic()

    async def _set_model_settings(self, value: str, idle: int | None) -> None:
        if self._gpu_lock.locked() or self._active is not None or not self._pending.empty() or self.model_loading:
            raise ApiException(
                "MODEL_BUSY", "モデル読込・推論が終わってから保存を再試行。",
                status=409, retryable=True,
            )
        try:
            model_path = Path(value).expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            raise ApiException("INVALID_MODEL_PATH", "モデルパスが不正。", status=422) from None
        async with self._gpu_lock:
            self._updating_model_path = True
            try:
                try:
                    if idle is None:
                        await asyncio.to_thread(self.settings.save_model_path, model_path)
                    else:
                        await asyncio.to_thread(self.settings.save_settings, model_path=model_path, model_idle_seconds=idle)
                except OSError:
                    raise ApiException(
                        "SETTINGS_SAVE_FAILED", "モデルパスを保存できない。保存先の権限を確認。",
                        status=500, retryable=True,
                    ) from None
                if model_path != self.settings.model_path:
                    await asyncio.to_thread(self.engine.unload)
                    self.settings = replace(self.settings, model_path=model_path)
                    self.engine.settings = self.settings
                    self.engine.status = "unloaded"
                    self.engine.load_error = None
                    self.engine.load_error_message = None
                    self.model_generation = uuid.uuid4().hex
                    self.activity_epoch = uuid.uuid4().hex
                    self._activity_sessions.clear()
                    self._last_model_ready = None
                    self._last_inference_finished = None
                    self.load_started = None
                    self.last_load_seconds = None
                    if hasattr(self.engine, "load_timings"):
                        self.engine.load_timings = {}
                    self._model_load_task = None
                    self.candidates.clear()
                if idle is not None:
                    self.settings = replace(self.settings, model_idle_seconds=idle)
                    self.engine.settings = self.settings
            finally:
                self._updating_model_path = False

    def record_activity(self, request: ActivityRequest) -> bool:
        now = time.monotonic()
        # Short server-issued windows reject notifications delayed across sleep,
        # reconnect, or a server/model configuration generation change.
        if request.epoch != self.activity_epoch or not 0 <= int(now // 10) - request.window <= 2:
            return False
        previous = self._activity_sessions.get(request.sessionId)
        if previous is not None and request.sequence <= previous[0]:
            return False
        self._activity_sessions[request.sessionId] = (request.sequence, now)
        self._activity_sessions.move_to_end(request.sessionId)
        while len(self._activity_sessions) > 2048:
            self._activity_sessions.popitem(last=False)
        observed = now - request.elapsedSeconds
        self._last_activity = max(self._last_activity or observed, observed)
        return True

    def idle_state(self) -> dict[str, Any]:
        now = time.monotonic()
        times = [value for value in (self._last_model_ready, self._last_inference_finished, self._last_activity) if value is not None]
        elapsed = max(0, now - max(times)) if times else 0
        return {
            "serverEpoch": self.server_epoch,
            "settingsRevision": self.settings_revision,
            "activityEpoch": self.activity_epoch,
            "activityWindow": int(now // 10),
            "modelIdleSeconds": self.settings.model_idle_seconds,
            "idleElapsedSeconds": round(elapsed, 3),
            "idleRemainingSeconds": round(max(0, self.settings.model_idle_seconds - elapsed), 3),
            "idleReleaseDeferred": self.model_loading or self._active is not None or not self._pending.empty(),
        }

    async def start(self) -> None:
        self._stopping = False
        self._worker_task = asyncio.create_task(self._worker(), name="sam3-job-worker")
        self._maintenance_task = asyncio.create_task(
            self._maintain(), name="sam3-maintenance"
        )
        self._startup_load_task = asyncio.create_task(
            self._load_startup_model(), name="sam3-model-startup-load"
        )
        self._startup_load_task.add_done_callback(self._observe_startup_load)

    async def _load_startup_model(self) -> None:
        async with self._gpu_lock:
            await self._ensure_model_ready_locked()

    @property
    def model_loading(self) -> bool:
        return self._model_load_task is not None and not self._model_load_task.done()

    @property
    def load_elapsed_seconds(self) -> float | None:
        if self.model_loading and self.load_started is not None:
            return round(time.monotonic() - self.load_started, 3)
        return None

    async def _ensure_model_ready_locked(self) -> None:
        """Caller owns _gpu_lock, including while a cancelled waiter drains the load."""
        if self.engine.model_loaded:
            if self._last_model_ready is None:
                self._last_model_ready = time.monotonic()
            return
        if not self.model_loading:
            self._model_load_task = asyncio.create_task(self._load_model(), name="sam3-model-load")
        task = self._model_load_task
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # Cancelling an asyncio waiter cannot stop its native GPU thread.
            # Keep the GPU lock until that thread has actually finished.
            await asyncio.gather(task, return_exceptions=True)
            raise

    async def _load_model(self) -> None:
        self.load_count += 1
        self.load_started = time.monotonic()
        try:
            await asyncio.to_thread(self.engine.load)
            self._last_model_ready = time.monotonic()
        finally:
            self.last_load_seconds = round(time.monotonic() - self.load_started, 3)
            logger.info("SAM3 model load %s finished in %.3fs", self.load_count, self.last_load_seconds)

    def _idle_expired(self) -> bool:
        times = [value for value in (self._last_model_ready, self._last_inference_finished, self._last_activity) if value is not None]
        return bool(times) and time.monotonic() - max(times) >= self.settings.model_idle_seconds

    def _observe_startup_load(self, task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.warning("SAM3 startup load failed (%s)", type(exc).__name__)

    async def stop(self) -> None:
        self._stopping = True
        while not self._pending.empty():
            try:
                job = self._pending.get_nowait()
            except asyncio.QueueEmpty:
                break
            if job.status not in self._terminal_states():
                job.status = "cancelled"
            self._pending.task_done()
        if self._active is not None and self._active.status in {
            "queued",
            "loading",
            "running",
        }:
            self._active.status = "cancelled"
        if self._worker_task is not None:
            self._pending.put_nowait(None)
        if self._maintenance_task is not None:
            self._maintenance_task.cancel()
        tasks = [
            task
            for task in (self._worker_task, self._maintenance_task)
            if task is not None
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._startup_load_task is not None:
            await asyncio.gather(self._startup_load_task, return_exceptions=True)
        if self.engine.model_loaded:
            await asyncio.to_thread(self.engine.unload)
        self._worker_task = None
        self._maintenance_task = None
        self._startup_load_task = None

    def submit(self, request: InferRequest) -> Job:
        if self._updating_model_path:
            raise ApiException(
                "MODEL_BUSY", "モデルパスの保存が終わってから検出を再試行。",
                status=409, retryable=True, request_id=request.requestId,
            )
        request.validate_mode()
        try:
            image = self.image_cache.get(request.imageId)
        except ImageExpiredError:
            raise ApiException(
                "IMAGE_EXPIRED",
                "The uploaded image expired. Upload the image again and retry.",
                status=410,
                retryable=True,
                request_id=request.requestId,
            ) from None
        for point in request.points:
            if not (0 <= point.x < image.width and 0 <= point.y < image.height):
                raise ApiException(
                    "INVALID_POINTS",
                    "All point coordinates must lie inside the uploaded image.",
                    status=422,
                    request_id=request.requestId,
                )
        page_id, seq_text = request.requestId.rsplit(":", maxsplit=1)
        request_seq = int(seq_text)
        latest_seq = self.latest_seq_by_page.get(page_id, -1)
        if request_seq <= latest_seq:
            raise ApiException(
                "SUPERSEDED",
                "A newer request already exists for this page.",
                status=409,
                request_id=request.requestId,
            )
        refine_candidate: CandidateRecord | None = None
        if request.mode == "refine":
            refine_candidate = self.candidates.get(request.candidateId or "")
            if (
                refine_candidate is None
                or refine_candidate.expires_at <= time.monotonic()
                or refine_candidate.image_id != request.imageId
            ):
                raise ApiException(
                    "CANDIDATE_NOT_FOUND",
                    "The selected candidate is no longer available for refinement.",
                    status=404,
                    request_id=request.requestId,
                )

        if len(request.points) > self.settings.max_points:
            raise ApiException(
                "INVALID_POINTS",
                f"A request can contain at most {self.settings.max_points} points.",
                status=422,
                request_id=request.requestId,
            )
        if request.prompt is not None and len(request.prompt) > self.settings.max_prompt_length:
            raise ApiException(
                "INVALID_PROMPT",
                f"Prompt must be at most {self.settings.max_prompt_length} characters.",
                status=422,
                request_id=request.requestId,
            )
        self.latest_seq_by_page[page_id] = request_seq

        self._prune_jobs()
        self._prune_candidates()
        self._supersede_pending()
        if self._active is not None and self._active.status in {
            "queued",
            "loading",
            "running",
        }:
            self._active.status = "superseded"
            self._active.candidates = None
        job = Job(
            job_id=str(uuid.uuid4()),
            request=request,
            image_id=request.imageId,
            page_id=page_id,
            request_seq=request_seq,
        )
        self.jobs[job.job_id] = job
        if refine_candidate is not None:
            job.refine_bbox = dict(refine_candidate.bbox)
        self._pending.put_nowait(job)
        return job

    def _supersede_pending(self) -> None:
        while not self._pending.empty():
            try:
                old = self._pending.get_nowait()
            except asyncio.QueueEmpty:
                break
            if old.status not in self._terminal_states():
                old.status = "superseded"
                old.candidates = None
            self._pending.task_done()

    def get(self, job_id: str) -> Job | None:
        self._prune_jobs()
        job = self.jobs.get(job_id)
        if job is not None:
            self.jobs.move_to_end(job_id)
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None:
            return True
        if job.status in {"queued", "loading", "running"}:
            job.status = "cancelled"
            job.candidates = None
            if job is not self._active:
                self._remove_pending(job)
        return True

    def delete_image(self, image_id: str) -> None:
        for job in self.jobs.values():
            if job.image_id == image_id and job.status in {
                "queued",
                "loading",
                "running",
            }:
                job.status = "cancelled"
                job.candidates = None
                if job is not self._active:
                    self._remove_pending(job)
        for candidate_id, candidate in list(self.candidates.items()):
            if candidate.image_id == image_id:
                self.candidates.pop(candidate_id, None)

    def _remove_pending(self, target: Job) -> None:
        if self._pending.empty():
            return
        try:
            queued = self._pending.get_nowait()
        except asyncio.QueueEmpty:
            return
        if queued is target:
            self._pending.task_done()
            return
        self._pending.put_nowait(queued)

    async def _worker(self) -> None:
        while True:
            job = await self._pending.get()
            try:
                if job is None:
                    return
                if job.status != "queued" or self._stopping:
                    continue
                self._active = job
                await self._run(job)
            finally:
                self._active = None
                self._pending.task_done()

    async def _run(self, job: Job) -> None:
        try:
            image = self.image_cache.get(job.image_id)
        except ImageExpiredError:
            self._fail(
                job,
                EngineError(
                    "IMAGE_EXPIRED",
                    "The uploaded image expired. Upload the image again and retry.",
                    http_status=410,
                    retryable=True,
                ),
            )
            return

        refine_bbox = job.refine_bbox
        async with self._gpu_lock:
            if job.status in self._terminal_states():
                return
            if not self.engine.model_loaded:
                job.status = "loading"
                try:
                    await self._ensure_model_ready_locked()
                except EngineError as exc:
                    self._fail(job, exc)
                    return
                except Exception as exc:
                    logger.warning("SAM3 model reload failed (%s)", type(exc).__name__)
                    self._fail(
                        job,
                        EngineError(
                            "MODEL_LOAD_FAILED",
                            "SAM3 model reload failed. Check setup and retry.",
                        ),
                    )
                    return
            if job.status in self._terminal_states():
                return
            job.status = "running"
            inference = asyncio.create_task(
                asyncio.to_thread(
                    self.engine.infer,
                    image=image.rgb,
                    mode=job.request.mode,
                    prompt=job.request.prompt,
                    threshold=job.request.threshold,
                    points=[point.model_dump() for point in job.request.points],
                    refine_bbox=refine_bbox,
                )
            )
            try:
                result = await asyncio.wait_for(
                    asyncio.shield(inference),
                    timeout=self.settings.inference_timeout_seconds,
                )
            except asyncio.TimeoutError:
                if job.status == "running":
                    self._fail(
                        job,
                        EngineError(
                            "INFERENCE_TIMEOUT",
                            "SAM3 inference timed out. Retry the latest request.",
                            http_status=504,
                            retryable=True,
                        ),
                    )
                try:
                    await inference
                except Exception as exc:
                    logger.warning("Timed-out SAM3 job ended with %s", type(exc).__name__)
                self._last_inference_finished = time.monotonic()
                return
            except EngineError as exc:
                self._last_inference_finished = time.monotonic()
                self._fail(job, exc)
                return
            except Exception as exc:
                self._last_inference_finished = time.monotonic()
                logger.warning("SAM3 job failed (%s)", type(exc).__name__)
                self._fail(
                    job,
                    EngineError(
                        "INFERENCE_FAILED",
                        "SAM3 inference failed. Retry the latest request.",
                        retryable=True,
                    ),
                )
                return

        self._last_inference_finished = time.monotonic()
        if job.status in self._terminal_states():
            return
        try:
            job.candidates, job.warnings = self._serialize_result(job, result, image.expires_at)
        except Exception as exc:
            logger.warning("SAM3 result serialization failed (%s)", type(exc).__name__)
            self._fail(
                job,
                EngineError("RESPONSE_LIMIT", "SAM3 result exceeded response limits."),
            )
            return
        job.status = "ready"

    def _serialize_result(
        self, job: Job, result: EngineResult, image_expiry: float
    ) -> tuple[list[dict[str, Any]], list[str]]:
        output: list[dict[str, Any]] = []
        warnings_found = set(result.warnings)
        decoded_pixels = 0
        response_bytes = 0
        for engine_candidate in result.candidates:
            candidate_id = engine_candidate.candidate_id
            if job.request.mode == "refine":
                candidate_id = job.request.candidateId
            elif candidate_id is None:
                candidate_id = str(uuid.uuid4())
            encoded = engine_candidate.mask
            next_pixels = decoded_pixels + (
                encoded.bbox["width"] * encoded.bbox["height"]
            )
            payload = encoded.json_payload()
            next_response = response_bytes + len(payload["dataBase64"]) + 320
            if next_pixels > self.settings.max_candidate_pixels:
                warnings_found.add("CANDIDATE_MEMORY_LIMIT")
                continue
            if next_response > self.settings.max_response_bytes:
                warnings_found.add("RESPONSE_SIZE_LIMIT")
                break
            output.append(
                {
                    "candidateId": candidate_id,
                    "score": max(0.0, min(1.0, float(engine_candidate.score))),
                    "bbox": dict(encoded.bbox),
                    "mask": payload,
                }
            )
            decoded_pixels = next_pixels
            response_bytes = next_response
            self.candidates[candidate_id] = CandidateRecord(
                candidate_id=candidate_id,
                image_id=job.image_id,
                bbox=dict(encoded.bbox),
                expires_at=image_expiry,
            )
            self.candidates.move_to_end(candidate_id)
        self._prune_candidates()
        return output, sorted(warnings_found)

    @staticmethod
    def _fail(job: Job, exc: EngineError) -> None:
        if job.status in {"cancelled", "superseded"}:
            return
        job.status = "failed"
        job.candidates = None
        job.error = {
            "code": exc.code,
            "message": exc.message,
            "retryable": exc.retryable,
            "requestId": job.request.requestId,
        }

    async def _maintain(self) -> None:
        while True:
            await asyncio.sleep(self.settings.maintenance_interval_seconds)
            expired_images = self.image_cache.cleanup_expired()
            for image_id in expired_images:
                self.delete_image(image_id)
            self._prune_jobs()
            self._prune_candidates()
            await self.unload_if_idle()

    async def unload_if_idle(self) -> None:
        generation = self.model_generation
        if (
            self.engine.model_loaded
            and not self.model_loading
            and self._active is None
            and self._pending.empty()
            and self._idle_expired()
        ):
            try:
                async with self._gpu_lock:
                    if (
                        generation == self.model_generation
                        and not self._settings_lock.locked()
                        and self.engine.model_loaded
                        and self._active is None
                        and self._pending.empty()
                        and not self.model_loading
                        and self._idle_expired()
                    ):
                        await asyncio.to_thread(self.engine.unload)
            except Exception as exc:
                logger.warning("SAM3 idle unload failed (%s)", type(exc).__name__)

    def _prune_jobs(self) -> None:
        now = time.monotonic()
        for job_id, job in list(self.jobs.items()):
            if (
                job.status in self._terminal_states()
                and now - job.created_at > self.settings.job_ttl_seconds
            ):
                self.jobs.pop(job_id, None)
                if self.latest_seq_by_page.get(job.page_id) == job.request_seq:
                    self.latest_seq_by_page.pop(job.page_id, None)
        while len(self.jobs) > self.settings.max_jobs:
            removable = next(
                (
                    job_id
                    for job_id, job in self.jobs.items()
                    if job.status in self._terminal_states()
                ),
                None,
            )
            if removable is None:
                break
            removed = self.jobs.pop(removable)
            if self.latest_seq_by_page.get(removed.page_id) == removed.request_seq:
                self.latest_seq_by_page.pop(removed.page_id, None)

    def _prune_candidates(self) -> None:
        now = time.monotonic()
        for candidate_id, candidate in list(self.candidates.items()):
            if candidate.expires_at <= now:
                self.candidates.pop(candidate_id, None)
        while len(self.candidates) > 2048:
            self.candidates.popitem(last=False)

    @staticmethod
    def _terminal_states() -> set[str]:
        return {"ready", "failed", "cancelled", "superseded"}

