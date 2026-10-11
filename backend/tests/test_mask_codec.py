from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from app.mask_codec import InvalidMask, decode_mask, encode_mask


FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "test"
    / "fixtures"
    / "mask-codec.json"
)


@pytest.mark.parametrize("fixture", json.loads(FIXTURE.read_text(encoding="utf-8")))
def test_shared_javascript_codec_fixtures(fixture: dict[str, object]) -> None:
    bbox = fixture["bbox"]
    assert isinstance(bbox, dict)
    payload = base64.b64decode(fixture["dataBase64"], validate=True)
    assert len(payload) == fixture["byteLength"]
    assert hashlib.sha256(payload).hexdigest() == fixture["sha256"]
    decoded = decode_mask(
        str(fixture["codec"]),
        payload,
        int(bbox["width"]),
        int(bbox["height"]),
    )
    assert decoded.reshape(-1).tolist() == fixture["decoded"]


def test_encoder_uses_bbox_and_shortest_lossless_codec() -> None:
    mask = np.zeros((12, 40), dtype=np.uint8)
    mask[2:10, 3:33] = 1
    encoded = encode_mask(mask)
    assert encoded.bbox == {"x": 3, "y": 2, "width": 30, "height": 8}
    assert encoded.codec == "rle32le-v1"
    assert len(encoded.data) == encoded.byte_length
    decoded = decode_mask(encoded.codec, encoded.data, 30, 8)
    np.testing.assert_array_equal(decoded, np.ones((8, 30), dtype=np.uint8))


def test_bitpack_tie_prefers_bitpack_and_padding_is_zero() -> None:
    mask = np.array([[1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1]], dtype=np.uint8)
    encoded = encode_mask(mask)
    assert encoded.codec == "bitpack-lsb-v1"
    assert encoded.data[-1] & 0b11110000 == 0


@pytest.mark.parametrize(
    ("codec", "payload", "width", "height"),
    [
        ("bitpack-lsb-v1", b"\xff\xff", 3, 3),
        ("bitpack-lsb-v1", b"\x00", 4, 4),
        ("rle32le-v1", b"\x01\x00\x00", 1, 1),
        ("rle32le-v1", b"\x01\x00\x00\x00\x00\x00\x00\x00", 1, 1),
        ("rle32le-v1", b"\x02\x00\x00\x00", 1, 1),
    ],
)
def test_decoder_rejects_malformed_payloads(
    codec: str, payload: bytes, width: int, height: int
) -> None:
    with pytest.raises(InvalidMask):
        decode_mask(codec, payload, width, height)


def test_empty_and_non_finite_masks_are_rejected() -> None:
    with pytest.raises(InvalidMask):
        encode_mask(np.zeros((2, 2), dtype=np.uint8))
    with pytest.raises(InvalidMask):
        encode_mask(np.array([[np.nan]], dtype=np.float32))

