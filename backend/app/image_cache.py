from __future__ import annotations

import hashlib
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import numpy as np


class ImageExpiredError(KeyError):
    pass


class ImageCacheFullError(ValueError):
    pass


@dataclass(slots=True)
class CachedImage:
    image_id: str
    rgb: np.ndarray
    digest: str
    expires_at: float
    last_access: float

    @property
    def width(self) -> int:
        return int(self.rgb.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgb.shape[0])

    @property
    def nbytes(self) -> int:
        return int(self.rgb.nbytes)

    def expires_at_iso(self) -> str:
        value = datetime.now(UTC) + timedelta(seconds=max(0.0, self.expires_at - time.monotonic()))
        return value.isoformat(timespec="seconds").replace("+00:00", "Z")


class ImageCache:
    def __init__(self, *, ttl_seconds: int, max_bytes: int) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_bytes = max_bytes
        self._entries: OrderedDict[str, CachedImage] = OrderedDict()
        self._hash_to_id: dict[str, str] = {}
        self._bytes_used = 0
        self._lock = threading.RLock()

    @property
    def bytes_used(self) -> int:
        with self._lock:
            return self._bytes_used

    def add(self, rgb: np.ndarray) -> tuple[CachedImage, bool]:
        image = np.ascontiguousarray(rgb, dtype=np.uint8)
        if image.ndim != 3 or image.shape[2] != 3:
            raise ValueError("cached image must be an RGB array")
        byte_length = int(image.nbytes)
        if byte_length > self.max_bytes:
            raise ImageCacheFullError("one image exceeds the RAM cache capacity")
        digest = hashlib.sha256(memoryview(image)).hexdigest()
        now = time.monotonic()
        with self._lock:
            self._remove_expired_locked(now)
            existing_id = self._hash_to_id.get(digest)
            if existing_id is not None:
                existing = self._entries.get(existing_id)
                if existing is not None:
                    existing.expires_at = now + self.ttl_seconds
                    existing.last_access = now
                    self._entries.move_to_end(existing_id)
                    return existing, True
            while self._bytes_used + byte_length > self.max_bytes and self._entries:
                self._evict_oldest_locked()
            image.flags.writeable = False
            entry = CachedImage(
                image_id=str(uuid.uuid4()),
                rgb=image,
                digest=digest,
                expires_at=now + self.ttl_seconds,
                last_access=now,
            )
            self._entries[entry.image_id] = entry
            self._hash_to_id[digest] = entry.image_id
            self._bytes_used += byte_length
            return entry, False

    def get(self, image_id: str) -> CachedImage:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(image_id)
            if entry is None:
                raise ImageExpiredError(image_id)
            if entry.expires_at <= now:
                self._remove_locked(image_id)
                raise ImageExpiredError(image_id)
            entry.expires_at = now + self.ttl_seconds
            entry.last_access = now
            self._entries.move_to_end(image_id)
            return entry

    def delete(self, image_id: str) -> bool:
        with self._lock:
            return self._remove_locked(image_id)

    def cleanup_expired(self) -> list[str]:
        now = time.monotonic()
        with self._lock:
            return self._remove_expired_locked(now)

    def _remove_expired_locked(self, now: float) -> list[str]:
        expired = [
            image_id
            for image_id, entry in self._entries.items()
            if entry.expires_at <= now
        ]
        for image_id in expired:
            self._remove_locked(image_id)
        return expired

    def _evict_oldest_locked(self) -> None:
        image_id = next(iter(self._entries))
        self._remove_locked(image_id)

    def _remove_locked(self, image_id: str) -> bool:
        entry = self._entries.pop(image_id, None)
        if entry is None:
            return False
        self._bytes_used -= entry.nbytes
        if self._hash_to_id.get(entry.digest) == image_id:
            self._hash_to_id.pop(entry.digest, None)
        return True

