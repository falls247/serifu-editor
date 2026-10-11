from __future__ import annotations

import io
import warnings

import numpy as np
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError


class InvalidImage(ValueError):
    pass


SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}


def decode_image(
    payload: bytes,
    *,
    max_pixels: int,
    max_dimension: int,
) -> np.ndarray:
    if not payload:
        raise InvalidImage("image file is empty")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            source = Image.open(io.BytesIO(payload))
            if source.format not in SUPPORTED_FORMATS:
                raise InvalidImage("unsupported image format")
            if getattr(source, "n_frames", 1) != 1:
                raise InvalidImage("animated images are not supported")
            width, height = source.size
            if (
                width < 1
                or height < 1
                or width > max_dimension
                or height > max_dimension
                or width * height > max_pixels
            ):
                raise InvalidImage("image dimensions exceed the configured limit")
            source.load()
            oriented = ImageOps.exif_transpose(source)
            rgba = oriented.convert("RGBA")
            profile = oriented.info.get("icc_profile")
            if profile:
                try:
                    source_profile = ImageCms.ImageCmsProfile(io.BytesIO(profile))
                    srgb = ImageCms.createProfile("sRGB")
                    rgb = ImageCms.profileToProfile(
                        rgba,
                        source_profile,
                        srgb,
                        outputMode="RGBA",
                    )
                except (ImageCms.PyCMSError, OSError, ValueError):
                    raise InvalidImage("image color profile is invalid") from None
            else:
                rgb = rgba
            background = Image.new("RGBA", rgb.size, (255, 255, 255, 255))
            normalized = Image.alpha_composite(background, rgb).convert("RGB")
            result = np.asarray(normalized, dtype=np.uint8).copy()
    except InvalidImage:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise InvalidImage("image dimensions exceed the configured limit") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise InvalidImage("file is not a supported image") from None
    if result.shape[1] * result.shape[0] > max_pixels:
        raise InvalidImage("oriented image dimensions exceed the configured limit")
    return result
