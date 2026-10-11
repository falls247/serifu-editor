from __future__ import annotations

import base64
import hashlib
import math
import struct
from dataclasses import dataclass
from typing import Any

import numpy as np


class InvalidMask(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class EncodedMask:
    bbox: dict[str, int]
    codec: str
    data: bytes
    byte_length: int
    sha256: str

    def json_payload(self) -> dict[str, Any]:
        return {
            "codec": self.codec,
            "byteLength": self.byte_length,
            "dataBase64": base64.b64encode(self.data).decode("ascii"),
            "sha256": self.sha256,
        }


def _as_binary(mask: np.ndarray) -> np.ndarray:
    array = np.asarray(mask)
    if array.ndim != 2 or array.size == 0:
        raise InvalidMask("mask must be a non-empty 2D array")
    if array.dtype.kind == "f":
        if not np.isfinite(array).all():
            raise InvalidMask("mask contains non-finite values")
        binary = array > 0.5
    elif array.dtype.kind in "biu":
        binary = array != 0
    else:
        raise InvalidMask("mask must contain numeric or boolean values")
    return np.ascontiguousarray(binary, dtype=np.uint8)


def _encode_rle(bits: np.ndarray) -> bytes:
    flat = bits.reshape(-1)
    changes = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    boundaries = np.concatenate((np.array([0]), changes, np.array([flat.size])))
    lengths = np.diff(boundaries).astype(np.uint64, copy=False)
    if flat[0] == 1:
        lengths = np.concatenate((np.array([0], dtype=np.uint64), lengths))
    if np.any(lengths > np.iinfo(np.uint32).max):
        raise InvalidMask("mask run exceeds uint32 range")
    return lengths.astype("<u4").tobytes()


def encode_mask(mask: np.ndarray) -> EncodedMask:
    binary = _as_binary(mask)
    occupied_rows = np.flatnonzero(binary.any(axis=1))
    occupied_cols = np.flatnonzero(binary.any(axis=0))
    if occupied_rows.size == 0 or occupied_cols.size == 0:
        raise InvalidMask("empty masks cannot be encoded")

    y0, y1 = int(occupied_rows[0]), int(occupied_rows[-1]) + 1
    x0, x1 = int(occupied_cols[0]), int(occupied_cols[-1]) + 1
    crop = np.ascontiguousarray(binary[y0:y1, x0:x1].reshape(-1))
    bitpack = np.packbits(crop, bitorder="little").tobytes()
    rle = _encode_rle(crop)
    if len(bitpack) <= len(rle):
        codec, payload = "bitpack-lsb-v1", bitpack
    else:
        codec, payload = "rle32le-v1", rle
    bbox = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
    return EncodedMask(
        bbox=bbox,
        codec=codec,
        data=payload,
        byte_length=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )


def decode_mask(codec: str, payload: bytes, width: int, height: int) -> np.ndarray:
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
        raise InvalidMask("mask dimensions must be positive integers")
    pixel_count = width * height
    if pixel_count > 40_000_000:
        raise InvalidMask("mask exceeds the pixel limit")
    data = bytes(payload)

    if codec == "bitpack-lsb-v1":
        expected = math.ceil(pixel_count / 8)
        if len(data) != expected:
            raise InvalidMask("bitpack payload length mismatch")
        if pixel_count % 8 and data[-1] >> (pixel_count % 8):
            raise InvalidMask("unused bitpack padding bits must be zero")
        packed = np.frombuffer(data, dtype=np.uint8)
        return np.unpackbits(packed, bitorder="little")[:pixel_count].copy().reshape(
            height, width
        )

    if codec != "rle32le-v1":
        raise InvalidMask("unsupported mask codec")
    if len(data) == 0 or len(data) % 4:
        raise InvalidMask("RLE payload length must be a positive multiple of four")
    runs = np.frombuffer(data, dtype="<u4")
    if len(runs) > pixel_count + 1:
        raise InvalidMask("RLE contains too many runs")
    if len(runs) > 1 and np.any(runs[1:] == 0):
        raise InvalidMask("only the initial RLE run may be zero")
    if int(runs.astype(np.uint64).sum()) != pixel_count:
        raise InvalidMask("RLE run lengths do not match the mask dimensions")

    flat = np.zeros(pixel_count, dtype=np.uint8)
    offset = 0
    value = 0
    for index, run in enumerate(runs):
        length = int(run)
        if value and length:
            flat[offset : offset + length] = 1
        offset += length
        value ^= 1
        if index == 0 and length == 0:
            value = 1
    return flat.reshape(height, width)

