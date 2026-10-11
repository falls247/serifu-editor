from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator


RequestId = Annotated[
    str,
    StringConstraints(
        min_length=3,
        max_length=112,
        pattern=r"^[A-Za-z0-9_-]{1,96}:[0-9]{1,12}$",
    ),
]
ImageId = Annotated[
    str,
    StringConstraints(
        min_length=16,
        max_length=64,
        pattern=r"^[a-f0-9-]+$",
    ),
]
CandidateId = Annotated[
    str,
    StringConstraints(
        min_length=16,
        max_length=64,
        pattern=r"^[a-f0-9-]+$",
    ),
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class Point(StrictModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    positive: bool


class InferRequest(StrictModel):
    imageId: ImageId
    requestId: RequestId
    mode: Literal["text", "points", "refine"]
    prompt: str | None = None
    threshold: float = Field(default=0.5, ge=0.0, le=1.0, allow_inf_nan=False)
    points: list[Point] = Field(default_factory=list, max_length=128)
    candidateId: CandidateId | None = None

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("prompt must not be empty")
        if len(trimmed) > 500:
            raise ValueError("prompt is too long")
        return trimmed

    @field_validator("points")
    @classmethod
    def validate_point_count(cls, value: list[Point]) -> list[Point]:
        if len(value) > 128:
            raise ValueError("too many points")
        return value

    def validate_mode(self) -> None:
        if self.mode == "text":
            if self.prompt is None:
                raise ValueError("prompt is required for text mode")
            if self.points or self.candidateId is not None:
                raise ValueError("text mode does not accept points or candidateId")
        elif self.mode == "points":
            if self.candidateId is not None:
                raise ValueError("candidateId is only valid for refine mode")
            if not self.points or not any(point.positive for point in self.points):
                raise ValueError("points mode requires a positive point")
        elif self.mode == "refine":
            if self.candidateId is None:
                raise ValueError("candidateId is required for refine mode")
            if not self.points or not any(point.positive for point in self.points):
                raise ValueError("refine mode requires a positive point")


class HealthError(StrictModel):
    code: str
    message: str
    retryable: bool


class HealthResponse(StrictModel):
    status: Literal["ready", "loading", "unloaded", "error"]
    modelLoaded: bool
    gpuAvailable: bool
    version: str
    modelPath: str
    error: HealthError | None = None


class ModelSettingsRequest(StrictModel):
    modelPath: str = Field(min_length=1, max_length=4096)

    @field_validator("modelPath")
    @classmethod
    def validate_model_path(cls, value: str) -> str:
        value = value.strip()
        if not value or any(character in value for character in ("\x00", "\n", "\r")):
            raise ValueError("model path is invalid")
        return value


class ImageResponse(StrictModel):
    imageId: str
    width: int
    height: int
    expiresAt: str


class JobAcceptedResponse(StrictModel):
    jobId: str
    status: Literal["queued", "running"]
    requestId: str


class BBox(StrictModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)


class MaskPayload(StrictModel):
    codec: Literal["rle32le-v1", "bitpack-lsb-v1"]
    byteLength: int = Field(ge=1)
    dataBase64: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class CandidateResponse(StrictModel):
    candidateId: str
    score: float = Field(ge=0.0, le=1.0)
    bbox: BBox
    mask: MaskPayload


JobStatus = Literal[
    "queued", "loading", "running", "ready", "failed", "cancelled", "superseded"
]


class ApiError(StrictModel):
    code: str
    message: str
    retryable: bool
    requestId: str


class ApiErrorResponse(StrictModel):
    error: ApiError

