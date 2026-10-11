from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app.image_io import InvalidImage, decode_image


def _save(image: Image.Image, format: str = "PNG", **kwargs: object) -> bytes:
    output = io.BytesIO()
    image.save(output, format=format, **kwargs)
    return output.getvalue()


def test_decode_flattens_alpha_over_white() -> None:
    image = Image.new("RGBA", (2, 1), (0, 0, 0, 0))
    image.putpixel((0, 0), (0, 0, 0, 255))
    decoded = decode_image(_save(image), max_pixels=100, max_dimension=20)
    assert decoded.tolist() == [[[0, 0, 0], [255, 255, 255]]]


def test_decode_applies_exif_orientation() -> None:
    image = Image.new("RGB", (3, 2), "red")
    exif = image.getexif()
    exif[274] = 6
    decoded = decode_image(
        _save(image, exif=exif), max_pixels=100, max_dimension=20
    )
    assert decoded.shape == (3, 2, 3)


def test_decode_rejects_wrong_format_and_dimensions() -> None:
    jpeg = _save(Image.new("RGB", (4, 4)), format="JPEG")
    with pytest.raises(InvalidImage, match="dimensions"):
        decode_image(jpeg, max_pixels=8, max_dimension=20)
    gif = _save(Image.new("RGB", (2, 2)), format="GIF")
    with pytest.raises(InvalidImage, match="unsupported"):
        decode_image(gif, max_pixels=100, max_dimension=20)

