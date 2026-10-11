"""起動済みローカルAPIで実GPUの10分解放・再ロードを検証する。"""
from __future__ import annotations

import argparse
import base64
import json
import struct
import subprocess
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path


def fixture_png() -> bytes:
    size = 256
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            face = ((x - 128) / 76) ** 2 + ((y - 128) / 92) ** 2 < 1
            eye = ((x - 100) ** 2 + (y - 106) ** 2 < 64 or
                   (x - 156) ** 2 + (y - 106) ** 2 < 64)
            mouth = 100 <= x <= 156 and 164 <= y <= 169
            pixels.extend((30, 20, 15) if face and (eye or mouth) else
                          (236, 188, 147) if face else (65, 135, 185))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack('>I', len(data)) + kind + data +
                struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))


def gpu_memory_mib() -> int:
    result = subprocess.run(
        ['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
        check=True, capture_output=True, text=True,
    )
    return int(result.stdout.strip().splitlines()[0])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=5173)
    parser.add_argument('--output', type=Path, default=Path('artifacts/sam3-gpu-lifecycle.json'))
    args = parser.parse_args()
    origin = f'http://127.0.0.1:{args.port}'
    report: dict = {'fixture': 'generated cartoon face, 256x256', 'inferences': []}

    def request(path: str, method: str = 'GET', body: bytes | None = None,
                content_type: str = 'application/json') -> dict:
        req = urllib.request.Request(origin + '/api/sam3' + path, data=body,
                                     method=method, headers={'Origin': origin,
                                                            'Content-Type': content_type})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    def upload() -> str:
        boundary = 'serifu-gpu-lifecycle-fixture'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                'filename="face.png"\r\nContent-Type: image/png\r\n\r\n').encode()
        body += fixture_png() + f'\r\n--{boundary}--\r\n'.encode()
        return request('/images', 'POST', body, f'multipart/form-data; boundary={boundary}')['imageId']

    def infer(image_id: str, sequence: int, mode: str, **extra: object) -> dict:
        started = time.monotonic()
        data = {'imageId': image_id, 'requestId': f'lifecycle:{sequence}',
                'mode': mode, 'threshold': 0.5, **extra}
        job = request('/infer', 'POST', json.dumps(data).encode())
        while time.monotonic() - started < 900:
            result = request('/jobs/' + job['jobId'])
            if result['status'] == 'ready':
                candidates = result['candidates']
                if not candidates:
                    raise AssertionError(f'{mode} returned no candidates')
                def inspect_mask(candidate: dict) -> dict:
                    box, payload = candidate['bbox'], candidate['mask']
                    raw = base64.b64decode(payload['dataBase64'], validate=True)
                    if payload['codec'] == 'bitpack-lsb-v1':
                        mask = [(raw[i // 8] >> (i % 8)) & 1 for i in range(box['width'] * box['height'])]
                    else:
                        mask = []
                        for index, (length,) in enumerate(struct.iter_unpack('<I', raw)):
                            mask.extend([index % 2] * length)
                    foreground, intersection, union = 0, 0, 0
                    for y in range(256):
                        for x in range(256):
                            expected = ((x - 128) / 76) ** 2 + ((y - 128) / 92) ** 2 < 1
                            included = (box['x'] <= x < box['x'] + box['width'] and
                                        box['y'] <= y < box['y'] + box['height'] and
                                        bool(mask[(y - box['y']) * box['width'] + x - box['x']]))
                            foreground += included
                            intersection += included and expected
                            union += included or expected
                    return {'score': candidate['score'], 'bbox': box, 'foregroundPixels': foreground,
                            'faceIoU': round(intersection / max(1, union), 4)}
                entry = {'mode': mode, 'seconds': round(time.monotonic() - started, 3),
                         'candidateCount': len(candidates),
                         'gpuMemoryMiB': gpu_memory_mib(),
                         'firstCandidate': inspect_mask(candidates[0]),
                         'warnings': result.get('warnings', [])}
                report['inferences'].append(entry)
                print(json.dumps(entry), flush=True)
                return result
            if result['status'] in {'failed', 'cancelled', 'superseded'}:
                raise AssertionError(result)
            time.sleep(0.5)
        raise TimeoutError('GPU job did not finish within 900 seconds')

    started = time.monotonic()
    last_progress = started
    while time.monotonic() - started < 900:
        try:
            health = request('/health')
            if health['status'] == 'ready':
                report['health'] = health
                report['readyWaitSeconds'] = round(time.monotonic() - started, 3)
                break
            if health['status'] == 'error':
                raise AssertionError(health)
        except (urllib.error.URLError, ConnectionError):
            pass
        if time.monotonic() - last_progress >= 60:
            print('Waiting for real model initialization', flush=True)
            last_progress = time.monotonic()
        time.sleep(2)
    else:
        raise TimeoutError('Model did not become ready')

    image_id = upload()
    text_result = infer(image_id, 1, 'text', prompt='face')
    points = [{'x': 128, 'y': 128, 'positive': True}]
    infer(image_id, 2, 'points', points=points)
    infer(image_id, 3, 'refine', candidateId=text_result['candidates'][0]['candidateId'],
          points=points + [{'x': 20, 'y': 20, 'positive': False}])
    loaded_memory = gpu_memory_mib()
    idle_started = time.monotonic()
    last_progress = idle_started
    while time.monotonic() - idle_started < 660:
        health = request('/health')
        idle_seconds = time.monotonic() - idle_started
        if health['status'] == 'unloaded' and not health['modelLoaded']:
            if idle_seconds < 590:
                raise AssertionError(f'Model unloaded too early: {idle_seconds}')
            released_memory = gpu_memory_mib()
            report['idle'] = {'seconds': round(idle_seconds, 3),
                              'loadedGpuMemoryMiB': loaded_memory,
                              'unloadedGpuMemoryMiB': released_memory,
                              'releasedMiB': loaded_memory - released_memory}
            if report['idle']['releasedMiB'] < 512:
                raise AssertionError(report['idle'])
            print(json.dumps(report['idle']), flush=True)
            break
        if idle_seconds - (last_progress - idle_started) >= 60:
            print(f'Idle {idle_seconds:.0f}s / 600s, model {health["status"]}', flush=True)
            last_progress = time.monotonic()
        time.sleep(5)
    else:
        raise TimeoutError('Model did not unload after 600-second idle')

    try:
        infer(image_id, 4, 'points', points=points)
        report['expiredImageReuploaded'] = False
    except urllib.error.HTTPError as exc:
        error = json.load(exc)
        if exc.code != 410 or error.get('error', {}).get('code') != 'IMAGE_EXPIRED':
            raise
        image_id = upload()
        report['expiredImageReuploaded'] = True
        infer(image_id, 5, 'points', points=points)
    report['result'] = 'PASS'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'PASS: {args.output}', flush=True)


if __name__ == '__main__':
    main()
