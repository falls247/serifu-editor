import test from 'node:test';
import assert from 'node:assert/strict';
import { createSam3RequestNamespace, LatestSam3Request, Sam3Client } from '../src/sam3-client.js';

const healthData = (status = 'ready', modelPath = '/models/sam3.pt') => ({ status, modelPath, modelLoaded: status === 'ready', gpuAvailable: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'SAM3 state transition timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('50 panels share loading health, forced refreshes and one poll loop', async () => {
  let requests = 0, active = 0, maxActive = 0;
  const first = deferred(), states = Array.from({ length: 50 }, () => []);
  const client = new Sam3Client({ healthLoadingInterval: 5, healthPollInterval: 60_000, fetchImpl: async () => {
    requests++; maxActive = Math.max(maxActive, ++active);
    const data = requests === 1 ? await first.promise : healthData('ready');
    active--;
    return Response.json(data);
  } });
  const unsubscribers = states.map(list => client.subscribeModelState(({ health }) => list.push(health?.status)));
  try {
    const refreshes = Array.from({ length: 10 }, () => client.health({ force: true }));
    await until(() => requests === 1);
    first.resolve(healthData('loading'));
    await Promise.all(refreshes);
    await until(() => states.every(list => list.at(-1) === 'ready'));
    assert.equal(requests, 2);
    assert.equal(maxActive, 1);
    assert.ok(states.every(list => list.join(',') === 'loading,ready'));
  } finally { unsubscribers.forEach(unsubscribe => unsubscribe()); }
  assert.equal(client.healthTimer, null);
  assert.equal(client.modelSubscribers.size, 0);
});

test('page cancellation does not abort shared health or update disposed subscribers', async () => {
  const response = deferred(), controller = new AbortController();
  let updates = 0, sharedSignal;
  const client = new Sam3Client({ fetchImpl: async (_url, options) => {
    sharedSignal = options.signal;
    return Response.json(await response.promise);
  } });
  const unsubscribe = client.subscribeModelState(() => updates++);
  const first = client.health({ force: true, signal: controller.signal });
  const second = client.health({ force: true });
  controller.abort(); unsubscribe();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(sharedSignal.aborted, false);
  response.resolve(healthData());
  assert.equal((await second).status, 'ready');
  assert.equal(updates, 0);
  assert.equal(client.healthTimer, null);
});

test('saving model path discards delayed pre-save health and fetches current state once', async () => {
  const old = deferred(), paths = [];
  let requests = 0;
  const client = new Sam3Client({ fetchImpl: async url => {
    if (url.endsWith('/settings')) return Response.json({ modelPath: '/models/new.pt' });
    requests++;
    return Response.json(requests === 1 ? await old.promise : healthData('unloaded', '/models/new.pt'));
  } });
  const unsubscribe = client.subscribeModelState(({ health }) => { if (health) paths.push(health.modelPath); });
  try {
    const pending = client.health({ force: true });
    await until(() => requests === 1);
    await client.saveModelPath('/models/new.pt');
    old.resolve(healthData('ready', '/models/old.pt'));
    assert.equal((await pending).modelPath, '/models/new.pt');
    assert.deepEqual(paths, ['/models/new.pt']);
    assert.equal(requests, 2);
  } finally { unsubscribe(); }
});

test('hidden tabs pause monitoring and resume with fresh health, then remove listener', async () => {
  class Visibility extends EventTarget {
    hidden = false;
    setHidden(value) { this.hidden = value; this.dispatchEvent(new Event('visibilitychange')); }
  }
  const document = new Visibility();
  let requests = 0;
  const client = new Sam3Client({ documentImpl: document, healthPollInterval: 60_000, fetchImpl: async () => {
    requests++;
    return Response.json(healthData());
  } });
  const unsubscribe = client.subscribeModelState(() => {});
  await client.health();
  document.setHidden(true);
  assert.equal(client.healthTimer, null);
  document.setHidden(false);
  await until(() => requests === 2 && !client.healthRequest);
  unsubscribe();
  document.setHidden(true); document.setHidden(false);
  await Promise.resolve();
  assert.equal(requests, 2);
  assert.equal(client.healthTimer, null);
});

test('shared model monitoring recovers from connection failure without losing model state', async () => {
  let fail = false;
  const updates = [];
  const client = new Sam3Client({ fetchImpl: async () => {
    if (fail) throw new Error('offline');
    return Response.json(healthData());
  } });
  const unsubscribe = client.subscribeModelState(update => updates.push(update));
  try {
    await client.health();
    fail = true;
    await assert.rejects(client.health({ force: true }), /offline/);
    assert.equal(updates.at(-1).health.status, 'ready');
    assert.equal(updates.at(-1).error.message, 'offline');
    fail = false;
    await client.health({ force: true });
    assert.equal(updates.at(-1).error, null);
    assert.equal(client.healthFailures, 0);
  } finally { unsubscribe(); }
});

test('latest SAM3 request keeps immutable point snapshots and aborts stale input', () => {
  const requests = new LatestSam3Request('page-a');
  const input = { mode: 'points', threshold: 0.5, points: [{ x: 12, y: 18, positive: true }] };
  const first = requests.begin(input);
  input.points[0].x = 90;
  assert.equal(first.requestId, 'page-a:1');
  assert.equal(first.snapshot.points[0].x, 12);
  assert.equal(Object.isFrozen(first.snapshot.points[0]), true);

  const second = requests.begin({ mode: 'text', prompt: '傘', threshold: 0.55, points: [] });
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.requestId, 'page-a:2');
  assert.equal(second.isCurrent(), true);
  requests.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
});

test('SAM3 request namespaces stay unique across remounts and valid for backend IDs', () => {
  const first = new LatestSam3Request(createSam3RequestNamespace('page:one', 'mount-a'));
  const remounted = new LatestSam3Request(createSam3RequestNamespace('page:one', 'mount-b'));
  const oldRequestId = first.begin({ mode: 'text', prompt: 'first', threshold: 0.5, points: [] }).requestId;
  const newRequestId = remounted.begin({ mode: 'text', prompt: 'after remount', threshold: 0.5, points: [] }).requestId;
  const parse = id => {
    assert.match(id, /^[A-Za-z0-9_-]{1,96}:[0-9]{1,12}$/);
    assert.ok(id.length <= 112);
    const split = id.lastIndexOf(':');
    return [id.slice(0, split), Number(id.slice(split + 1))];
  };
  const [oldScope, oldSeq] = parse(oldRequestId), [newScope, newSeq] = parse(newRequestId);
  assert.equal(oldSeq, 1);
  assert.equal(newSeq, 1);
  assert.notEqual(oldScope, newScope, 'new mount uses a fresh backend latest-sequence scope');
});

test('expired image cache is re-uploaded once and latest request ID is preserved', async () => {
  const calls = [], imageIds = ['image-old', 'image-new'];
  let uploads = 0, inference = 0, polls = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/images') && options.method === 'POST') {
      uploads++;
      return Response.json({ imageId: imageIds[uploads - 1], width: 2, height: 2, expiresAt: 'later' });
    }
    if (url.endsWith('/infer')) {
      inference++;
      const payload = JSON.parse(options.body);
      assert.equal(payload.requestId, 'page-b:7');
      if (inference === 1) return Response.json({ error: { code: 'IMAGE_EXPIRED', message: 'expired', retryable: true } }, { status: 410 });
      assert.equal(payload.imageId, 'image-new');
      return Response.json({ jobId: 'job-new', status: 'queued', requestId: payload.requestId }, { status: 202 });
    }
    if (url.endsWith('/jobs/job-new')) {
      polls++;
      return Response.json({ jobId: 'job-new', status: 'ready', requestId: 'page-b:7', candidates: [] });
    }
    return Response.json({ deleted: true });
  };
  const client = new Sam3Client({ fetchImpl, pollInterval: 0, maxWait: 1000 });
  const result = await client.infer({
    pageId: 'page-b', blob: new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
    width: 2, height: 2, requestId: 'page-b:7', mode: 'text', prompt: 'cat', threshold: 0.5,
  });
  assert.equal(result.status, 'ready');
  assert.equal(uploads, 2);
  assert.equal(inference, 2);
  assert.equal(polls, 1);
  assert.equal(client.images.get('page-b').imageId, 'image-new');
  assert.equal(calls.some(call => call.url.endsWith('/images/image-old') && call.options.method === 'DELETE'), true);
});

test('job polling continues while backend reports model loading', async () => {
  const states = [], calls = [];
  let polls = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/images')) return Response.json({ imageId: 'image-loading', width: 2, height: 2 });
    if (url.endsWith('/infer')) return Response.json({ jobId: 'job-loading', status: 'queued', requestId: 'page-load:1' }, { status: 202 });
    if (url.endsWith('/jobs/job-loading')) {
      polls++;
      return Response.json({ jobId: 'job-loading', status: polls === 1 ? 'loading' : 'ready', requestId: 'page-load:1', candidates: [] });
    }
    return Response.json({ deleted: true });
  };
  const client = new Sam3Client({ fetchImpl, pollInterval: 0, maxWait: 1000 });
  const result = await client.infer({
    pageId: 'page-load', blob: new Blob([new Uint8Array([1])]), width: 2, height: 2,
    requestId: 'page-load:1', mode: 'text', prompt: 'object', threshold: 0.5,
  }, { onState: status => states.push(status) });
  assert.equal(result.status, 'ready');
  assert.equal(polls, 2);
  assert.deepEqual(states, ['queued', 'loading', 'ready']);
});

