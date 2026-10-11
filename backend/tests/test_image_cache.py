from __future__ import annotations

import time

import numpy as np
import pytest

from app.image_cache import ImageCache, ImageCacheFullError, ImageExpiredError


def test_cache_deduplicates_and_touches_ttl() -> None:
    cache = ImageCache(ttl_seconds=1, max_bytes=256)
    pixels = np.zeros((4, 4, 3), dtype=np.uint8)
    first, deduplicated = cache.add(pixels)
    duplicate, was_deduplicated = cache.add(pixels.copy())
    assert not deduplicated
    assert was_deduplicated
    assert duplicate.image_id == first.image_id
    assert cache.bytes_used == 48
    assert cache.get(first.image_id).rgb.flags.writeable is False


def test_cache_evicts_oldest_and_rejects_single_oversized_image() -> None:
    cache = ImageCache(ttl_seconds=10, max_bytes=60)
    first, _ = cache.add(np.zeros((4, 4, 3), dtype=np.uint8))
    second, _ = cache.add(np.ones((4, 4, 3), dtype=np.uint8))
    assert cache.bytes_used == 48
    with pytest.raises(ImageExpiredError):
        cache.get(first.image_id)
    assert cache.get(second.image_id).width == 4
    with pytest.raises(ImageCacheFullError):
        cache.add(np.zeros((5, 5, 3), dtype=np.uint8))


def test_cache_expires_images() -> None:
    cache = ImageCache(ttl_seconds=0, max_bytes=256)
    entry, _ = cache.add(np.zeros((2, 2, 3), dtype=np.uint8))
    time.sleep(0.002)
    assert cache.cleanup_expired() == [entry.image_id]
    with pytest.raises(ImageExpiredError):
        cache.get(entry.image_id)

