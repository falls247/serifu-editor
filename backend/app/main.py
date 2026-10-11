from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile as StarletteUploadFile

from . import __version__
from .engine import EngineError, MockSam3Engine, Sam3Engine
from .image_cache import ImageCache, ImageCacheFullError
from .image_io import InvalidImage, decode_image
from .jobs import ApiException, JobManager
from .schemas import HealthError, HealthResponse, InferRequest
from .settings import Settings

logger = logging.getLogger("serifu.sam3")
_REQUEST_ID_HEADER = re.compile(r"^[A-Za-z0-9_:-]{1,112}$")


def _request_id_from_scope(scope: dict[str, Any]) -> str:
    for key, value in scope.get("headers", []):
        if key.lower() == b"x-request-id":
            text = value.decode("latin-1", errors="ignore")
            if _REQUEST_ID_HEADER.fullmatch(text):
                return text
    return ""


def _error_body(
    code: str,
    message: str,
    *,
    retryable: bool,
    request_id: str = "",
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "requestId": request_id,
        }
    }


async def _send_error(
    scope: dict[str, Any],
    send: Callable[[dict[str, Any]], Awaitable[None]],
    *,
    status: int,
    code: str,
    message: str,
    retryable: bool = False,
    request_id: str | None = None,
) -> None:
    body = json.dumps(
        _error_body(
            code,
            message,
            retryable=retryable,
            request_id=(request_id if request_id is not None else _request_id_from_scope(scope)),
        ),
        separators=(",", ":"),
    ).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class LocalSecurityMiddleware:
    def __init__(self, app: Any, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        host = headers.get(b"host", b"").decode("latin-1").lower()
        allowed_host = f"127.0.0.1:{self.settings.api_port}"
        if host != allowed_host:
            await _send_error(
                scope,
                send,
                status=421,
                code="INVALID_HOST",
                message="This local API accepts requests only through its loopback host.",
            )
            return
        origin_raw = headers.get(b"origin")
        origin = origin_raw.decode("latin-1").rstrip("/") if origin_raw else None
        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()
        is_mutation = method in {"POST", "PUT", "PATCH", "DELETE"}
        if origin is not None and origin not in self.settings.ui_origins:
            await _send_error(
                scope,
                send,
                status=403,
                code="INVALID_ORIGIN",
                message="This local API accepts requests only from the editor origin.",
            )
            return
        if is_mutation and origin is None:
            await _send_error(
                scope,
                send,
                status=403,
                code="ORIGIN_REQUIRED",
                message="An allowed editor Origin header is required for changes.",
            )
            return
        fetch_site = headers.get(b"sec-fetch-site", b"").decode("latin-1").lower()
        if fetch_site == "cross-site":
            await _send_error(
                scope,
                send,
                status=403,
                code="INVALID_ORIGIN",
                message="Cross-site requests are not accepted.",
            )
            return
        await self.app(scope, receive, send)


class RequestSizeMiddleware:
    """Bound both declared and streamed request bodies before multipart parsing."""

    def __init__(self, app: Any, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        limit = (
            self.settings.max_upload_bytes + 1024 * 1024
            if path == "/api/sam3/images"
            else 256 * 1024
        )
        is_image_upload = path == "/api/sam3/images"
        too_large_code = "INVALID_IMAGE" if is_image_upload else "REQUEST_TOO_LARGE"
        too_large_message = (
            "Image upload exceeds the configured size limit."
            if is_image_upload
            else "Request body exceeds the configured size limit."
        )
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length")
        if raw_length:
            try:
                declared = int(raw_length)
            except ValueError:
                await _send_error(
                    scope,
                    send,
                    status=400,
                    code="INVALID_REQUEST",
                    message="Content-Length header is invalid.",
                )
                return
            if declared < 0 or declared > limit:
                await _send_error(
                    scope,
                    send,
                    status=413,
                code=too_large_code,
                message=too_large_message,
                )
                return

        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > limit:
                await _send_error(
                    scope,
                    send,
                    status=413,
                    code=too_large_code,
                    message=too_large_message,
                )
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break

        body = b"".join(chunks)
        sent = False

        async def replay_receive() -> dict[str, Any]:
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay_receive, send)


def create_app(
    settings: Settings | None = None,
    *,
    engine: Any | None = None,
) -> FastAPI:
    config = settings or Settings.from_env()
    if engine is None:
        engine = MockSam3Engine(config) if config.mock_mode else Sam3Engine(config)
    image_cache = ImageCache(
        ttl_seconds=config.image_ttl_seconds,
        max_bytes=config.image_cache_bytes,
    )
    manager = JobManager(config, engine, image_cache)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await manager.start()
        yield
        await manager.stop()

    app = FastAPI(
        title="Serifu Editor SAM3 API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.sam3_engine = engine
    app.state.sam3_jobs = manager
    app.state.sam3_image_cache = image_cache

    app.add_middleware(RequestSizeMiddleware, settings=config)
    app.add_middleware(LocalSecurityMiddleware, settings=config)

    @app.exception_handler(ApiException)
    async def api_exception_handler(_request: Request, exc: ApiException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=_error_body(
                exc.code,
                exc.message,
                retryable=exc.retryable,
                request_id=exc.request_id,
            ),
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        body = exc.body if isinstance(exc.body, dict) else {}
        request_id = body.get("requestId", "")
        fields = {str(loc[-1]) for error in exc.errors() for loc in [error.get("loc", ())] if loc}
        if "prompt" in fields:
            code, message = "INVALID_PROMPT", "Prompt is required and must be at most 500 characters."
        elif "points" in fields or "x" in fields or "y" in fields:
            code, message = "INVALID_POINTS", "Point input is invalid or exceeds its limit."
        else:
            code, message = "INVALID_REQUEST", "Request fields are invalid."
        return JSONResponse(
            status_code=422,
            content=_error_body(code, message, retryable=False, request_id=request_id),
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(Exception)
    async def unexpected_exception_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        logger.error("Unhandled SAM3 API exception (%s)", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content=_error_body(
                "INTERNAL_ERROR",
                "The local SAM3 API encountered an internal error.",
                retryable=True,
                request_id=request.headers.get("x-request-id", ""),
            ),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/sam3/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        load_error = getattr(engine, "load_error", None)
        message = getattr(engine, "load_error_message", None)
        error = (
            HealthError(
                code=load_error,
                message=message or "SAM3 model initialization failed.",
                retryable=load_error in {"MODEL_LOAD_FAILED", "GPU_UNAVAILABLE"},
            )
            if load_error is not None
            else None
        )
        return HealthResponse(
            status=engine.status,
            modelLoaded=bool(engine.model_loaded),
            gpuAvailable=bool(engine.gpu_available),
            version=f"{__version__};sam3={engine.version}",
            error=error,
        )

    @app.post("/api/sam3/images", status_code=201)
    async def upload_image(request: Request) -> dict[str, Any]:
        try:
            form = await request.form(max_files=1, max_fields=0)
        except Exception:
            raise ApiException(
                "INVALID_IMAGE",
                "Upload one image file using multipart field `file`.",
                status=400,
            ) from None
        try:
            files = form.getlist("file")
            if len(form) != 1 or len(files) != 1 or not isinstance(
                files[0], StarletteUploadFile
            ):
                raise ApiException(
                    "INVALID_IMAGE",
                    "Upload exactly one image file using multipart field `file`.",
                    status=400,
                )
            upload = files[0]
            payload = await upload.read(config.max_upload_bytes + 1)
            if len(payload) > config.max_upload_bytes:
                raise ApiException(
                    "INVALID_IMAGE",
                    "Image upload exceeds the 30 MiB size limit.",
                    status=413,
                )
            try:
                rgb = await asyncio.to_thread(
                    decode_image,
                    payload,
                    max_pixels=config.max_image_pixels,
                    max_dimension=config.max_image_dimension,
                )
            except InvalidImage as exc:
                too_large = "dimensions exceed" in str(exc) or "pixel limit" in str(exc)
                raise ApiException(
                    "INVALID_IMAGE",
                    str(exc),
                    status=413 if too_large else 400,
                ) from None
            try:
                cached, _deduplicated = image_cache.add(rgb)
            except ImageCacheFullError:
                raise ApiException(
                    "IMAGE_CACHE_FULL",
                    "The image exceeds available local RAM cache capacity.",
                    status=503,
                    retryable=True,
                ) from None
            return {
                "imageId": cached.image_id,
                "width": cached.width,
                "height": cached.height,
                "expiresAt": cached.expires_at_iso(),
            }
        finally:
            await form.close()

    @app.post("/api/sam3/infer", status_code=202)
    async def submit_inference(infer_request: InferRequest) -> dict[str, str]:
        try:
            job = manager.submit(infer_request)
        except ValueError as exc:
            message = str(exc)
            code = "INVALID_PROMPT" if "prompt" in message else "INVALID_POINTS"
            raise ApiException(
                code,
                message,
                status=422,
                request_id=infer_request.requestId,
            ) from None
        return {
            "jobId": job.job_id,
            "status": "queued",
            "requestId": job.request.requestId,
        }

    @app.get("/api/sam3/jobs/{job_id}")
    async def get_job(job_id: str) -> dict[str, Any]:
        job = manager.get(job_id)
        if job is None:
            raise ApiException(
                "JOB_NOT_FOUND",
                "Job was not found or its result expired.",
                status=404,
            )
        response: dict[str, Any] = {
            "jobId": job.job_id,
            "status": job.status,
            "requestId": job.request.requestId,
        }
        if job.status == "ready":
            response["candidates"] = job.candidates or []
            if job.warnings:
                response["warnings"] = job.warnings
        if job.error is not None:
            response["error"] = job.error
        return response

    @app.delete("/api/sam3/jobs/{job_id}")
    async def cancel_job(job_id: str) -> dict[str, bool]:
        manager.cancel(job_id)
        return {"cancelled": True}

    @app.delete("/api/sam3/images/{image_id}")
    async def delete_image(image_id: str) -> dict[str, bool]:
        image_cache.delete(image_id)
        manager.delete_image(image_id)
        return {"deleted": True}

    return app


app = create_app()

