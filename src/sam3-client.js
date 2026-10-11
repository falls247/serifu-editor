const API_ROOT = '/api/sam3';

export class Sam3ApiError extends Error {
  constructor(message, { code = 'SAM3_ERROR', retryable = false, status = 0, requestId = null } = {}) {
    super(message || code);
    this.name = 'Sam3ApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.requestId = requestId;
  }
}

function abortError(signal) {
  return signal?.reason || new DOMException('中断', 'AbortError');
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    function done() { cleanup(); resolve(); }
    function onAbort() { cleanup(); reject(abortError(signal)); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function responseError(response, requestId = null) {
  let body = null;
  try { body = await response.json(); } catch {}
  const detail = body?.error ?? body;
  const status = response.status;
  return new Sam3ApiError(detail?.message || `SAM3 API error (${status})`, {
    code: detail?.code || (status === 410 ? 'IMAGE_EXPIRED' : 'HTTP_ERROR'),
    retryable: detail?.retryable === true,
    status,
    requestId: detail?.requestId || requestId,
  });
}

export class LatestSam3Request {
  constructor(pageId) {
    this.pageId = pageId;
    this.sequence = 0;
    this.controller = null;
  }

  begin(input) {
    this.controller?.abort(new DOMException('新しいSAM3入力に置き換え', 'AbortError'));
    const controller = new AbortController();
    this.controller = controller;
    const requestSeq = ++this.sequence;
    const snapshot = structuredClone(input);
    if (Array.isArray(snapshot.points)) {
      for (const point of snapshot.points) Object.freeze(point);
      Object.freeze(snapshot.points);
    }
    Object.freeze(snapshot);
    return Object.freeze({
      requestSeq,
      requestId: `${this.pageId}:${requestSeq}`,
      signal: controller.signal,
      snapshot,
      isCurrent: () => this.sequence === requestSeq && !controller.signal.aborted,
    });
  }

  cancel() {
    this.controller?.abort(new DOMException('SAM3要求をキャンセル', 'AbortError'));
    this.controller = null;
    this.sequence++;
  }
}

export function createSam3RequestNamespace(pageId, sessionId = globalThis.crypto.randomUUID()) {
  const session = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36) || globalThis.crypto.randomUUID();
  const page = String(pageId || 'page').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, Math.max(1, 95 - session.length)) || 'page';
  return `${page}-${session}`;
}

export class Sam3Client {
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = API_ROOT, pollInterval = 500, maxWait = 10 * 60_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.pollInterval = pollInterval;
    this.maxWait = maxWait;
    this.images = new Map();
    this.healthRequest = null;
    this.healthCheckedAt = 0;
  }

  async health({ force = false, signal } = {}) {
    if (!force && this.healthRequest && Date.now() - this.healthCheckedAt < 3000) return this.healthRequest;
    const pending = this.fetch(`${this.baseUrl}/health`, { signal, headers: { Accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) throw await responseError(response);
        const data = await response.json();
        if (!['ready', 'loading', 'unloaded', 'error'].includes(data?.status)) throw new Sam3ApiError('SAM3 health response is invalid', { code: 'INVALID_RESPONSE' });
        return data;
      });
    this.healthRequest = pending;
    this.healthCheckedAt = Date.now();
    try { return await pending; }
    catch (error) { if (this.healthRequest === pending) this.healthRequest = null; throw error; }
  }

  async ensureImage(pageId, blob, width, height, { signal, force = false } = {}) {
    if (!force) {
      const cached = this.images.get(pageId);
      if (cached && cached.width === width && cached.height === height) return cached;
    }
    if (!(blob instanceof Blob) || blob.size <= 0) throw new Sam3ApiError('元画像のデータを取得できない', { code: 'INVALID_IMAGE' });
    const form = new FormData();
    form.append('file', blob, 'original-image');
    const response = await this.fetch(`${this.baseUrl}/images`, { method: 'POST', body: form, signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw await responseError(response);
    const image = await response.json();
    if (typeof image.imageId !== 'string' || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) {
      throw new Sam3ApiError('画像アップロードの応答が不正', { code: 'INVALID_RESPONSE' });
    }
    if (image.width !== width || image.height !== height) {
      throw new Sam3ApiError(`画像サイズが一致しない（画面 ${width}×${height} / API ${image.width}×${image.height}）`, { code: 'IMAGE_SIZE_MISMATCH' });
    }
    const stored = { imageId: image.imageId, width, height, expiresAt: image.expiresAt ?? null };
    this.images.set(pageId, stored);
    return stored;
  }

  async infer(input, { signal, onState = () => {} } = {}) {
    const { pageId, blob, width, height, requestId, mode, prompt, threshold, points = [], candidateId } = input;
    let expiredRetry = false;
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      let jobId = null;
      try {
        const image = await this.ensureImage(pageId, blob, width, height, { signal, force: expiredRetry });
        const payload = { imageId: image.imageId, requestId, mode, threshold };
        if (mode === 'text') payload.prompt = String(prompt ?? '').trim();
        if (mode === 'points' || mode === 'refine') payload.points = points.map(({ x, y, positive }) => ({ x, y, positive: !!positive }));
        if (mode === 'refine') payload.candidateId = candidateId;
        const response = await this.fetch(`${this.baseUrl}/infer`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload),
        });
        if (!response.ok) throw await responseError(response, requestId);
        const job = await response.json();
        if (typeof job.jobId !== 'string') throw new Sam3ApiError('推論ジョブの応答が不正', { code: 'INVALID_RESPONSE', requestId });
        jobId = job.jobId;
        if (job.requestId && job.requestId !== requestId) throw new Sam3ApiError('推論要求IDが一致しない', { code: 'STALE_RESPONSE', requestId });
        onState(job.status || 'queued');
        const startedAt = Date.now();
        while (true) {
          if (signal?.aborted) throw abortError(signal);
          if (Date.now() - startedAt > this.maxWait) throw new Sam3ApiError('SAM3推論がタイムアウトした。入力を保持したまま再試行できる', { code: 'INFERENCE_TIMEOUT', retryable: true, status: 504, requestId });
          await wait(this.pollInterval, signal);
          const resultResponse = await this.fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`, { signal, headers: { Accept: 'application/json' } });
          if (!resultResponse.ok) throw await responseError(resultResponse, requestId);
          const result = await resultResponse.json();
          if (result.requestId && result.requestId !== requestId) throw new Sam3ApiError('推論結果の要求IDが一致しない', { code: 'STALE_RESPONSE', requestId });
          onState(result.status);
          if (result.status === 'ready') return result;
          if (['failed', 'cancelled', 'superseded'].includes(result.status)) {
            const detail = result.error?.error ?? result.error;
            throw new Sam3ApiError(detail?.message || (typeof detail === 'string' ? detail : `SAM3 ${result.status}`), {
              code: detail?.code || String(result.status).toUpperCase(), retryable: detail?.retryable === true, status: result.status === 'failed' ? 503 : 409, requestId,
            });
          }
          if (!['queued', 'loading', 'running'].includes(result.status)) throw new Sam3ApiError('推論ジョブの状態が不正', { code: 'INVALID_RESPONSE', requestId });
        }
      } catch (error) {
        if (error?.code === 'IMAGE_EXPIRED' && !expiredRetry && !signal?.aborted) {
          expiredRetry = true;
          const cached = this.images.get(pageId);
          this.images.delete(pageId);
          if (cached?.imageId) void this.deleteImage(cached.imageId);
          continue;
        }
        throw error;
      } finally {
        if (jobId && signal?.aborted) void this.cancelJob(jobId);
      }
    }
  }

  async cancelJob(jobId) {
    try { await this.fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: { Accept: 'application/json' } }); } catch {}
  }

  async deleteImage(imageId) {
    try { await this.fetch(`${this.baseUrl}/images/${encodeURIComponent(imageId)}`, { method: 'DELETE', headers: { Accept: 'application/json' } }); } catch {}
  }

  async forgetPage(pageId) {
    const image = this.images.get(pageId);
    this.images.delete(pageId);
    if (image?.imageId) await this.deleteImage(image.imageId);
  }
}

