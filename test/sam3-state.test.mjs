import test from 'node:test';
import assert from 'node:assert/strict';
import { createSam3RequestNamespace, LatestSam3Request, Sam3Client } from '../src/sam3-client.js';

const healthData = (status = 'ready', modelPath = '/models/sam3.pt') => ({ status, modelPath, modelLoaded: status === 'ready', gpuAvailable: true });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const activityHealth = (revision = 0, seconds = 900) => ({ ...healthData(), modelIdleSeconds: seconds,
  serverEpoch: 'server-a', settingsRevision: revision, activityEpoch: 'abc123', activityWindow: 100, idleRemainingSeconds: seconds, idleElapsedSeconds: 0 });

test('activity batches only actual operations and drops stale, hidden, offline or previous-generation input', async () => {
  const document = new EventTarget(); document.hidden = false;
  let clock = 0, failed = false;
  const notices = [];
  const client = new Sam3Client({ documentImpl: document, now: () => clock, activityInterval: 5000, fetchImpl: async (url, options) => {
    if (url.endsWith('/health')) return Response.json(activityHealth());
    notices.push(JSON.parse(options.body));
    if (failed) throw new Error('offline');
    return Response.json({ accepted: true });
  } });
  const cleanup = client.startActivityTracking(document, new EventTarget());
  assert.equal(client.startActivityTracking(document), cleanup, 'one listener set per app');
  try {
    await client.health();
    document.dispatchEvent(new Event('input'));
    assert.equal(client.activityPending, null, 'synthetic edits and health are not activity');
    client.noteActivity();
    await until(() => notices.length === 1);
    clock = 1000;
    for (let i = 0; i < 100; i++) client.noteActivity();
    assert.equal(notices.length, 1);
    clock = 4000;
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    await until(() => notices.length === 2);
    assert.equal(notices[1].elapsedSeconds, 3);
    assert.deepEqual(Object.keys(notices[1]).sort(), ['elapsedSeconds', 'epoch', 'sequence', 'sessionId', 'window']);
    client.noteActivity(); assert.equal(client.activityPending, null);
    document.hidden = false;
    clock = 5000; client.noteActivity(); clock = 16_000;
    await client.flushActivity();
    assert.equal(notices.length, 2, 'stale operations are never replayed');
    client.noteActivity(); client.modelState.activityEpoch = 'new';
    await client.flushActivity();
    assert.equal(notices.length, 2, 'prior generation does not renew lifetime');
    failed = true; client.noteActivity(); await client.flushActivity();
    await until(() => !client.activityInFlight);
    client.noteActivity();
    assert.equal(client.activityPending, null, 'failures back off and discard input');
    clock = 60_000; client.modelError = new Error('offline'); client.noteActivity();
    assert.equal(client.activityPending, null);
  } finally { cleanup(); }
  assert.equal(client.activityTimer, null);
  assert.equal(client.healthTimer, null);
  assert.equal(client.modelSubscribers.size, 0);
});

test('saving idle time invalidates delayed health and publishes applied settings to every panel', async () => {
  const delayed = deferred(), received = [];
  let healthCalls = 0;
  const client = new Sam3Client({ fetchImpl: async url => {
    if (url.endsWith('/settings')) return Response.json({ modelPath: '/models/sam3.pt', ...activityHealth(2, 60) });
    healthCalls++;
    return Response.json(healthCalls === 1 ? await delayed.promise : activityHealth(2, 60));
  } });
  client.publishModelState(activityHealth(1));
  const unsub = client.subscribeModelState(({ health }) => received.push(health?.modelIdleSeconds));
  try {
    const old = client.health({ force: true });
    await until(() => healthCalls === 1);
    await client.saveIdleMinutes(1);
    delayed.resolve(activityHealth(1));
    assert.equal((await old).modelIdleSeconds, 60);
    assert.equal(received.at(-1), 60);
    assert.deepEqual(received, [900, 60]);
    for (const value of [0, 241, 1.5, NaN, '1']) await assert.rejects(client.saveIdleMinutes(value));
  } finally { unsub(); }
});

test('out-of-order settings responses cannot restore an older applied revision', async () => {
  const first = deferred();
  let saves = 0;
  const client = new Sam3Client({ fetchImpl: async url => {
    if (url.endsWith('/settings')) return Response.json(++saves === 1 ? await first.promise : activityHealth(2, 120));
    return Response.json(activityHealth(2, 120));
  } });
  client.publishModelState(activityHealth());
  const old = client.saveIdleMinutes(1);
  await until(() => saves === 1);
  await client.saveIdleMinutes(2);
  first.resolve(activityHealth(1, 60));
  assert.equal((await old).modelIdleSeconds, 120);
  assert.equal(client.modelState.modelIdleSeconds, 120);
  assert.equal(client.settingsRevision, 2);
});

test('a response from a retired server cannot replace settings after restart', async () => {
  const old = deferred();
  const current = { ...activityHealth(0, 120), serverEpoch: 'server-b' };
  const client = new Sam3Client({ fetchImpl: async url => Response.json(url.endsWith('/settings') ? await old.promise : current) });
  client.publishModelState(activityHealth(10));
  const save = client.saveIdleMinutes(1);
  client.publishModelState(current);
  old.resolve(activityHealth(11, 60));
  assert.equal((await save).modelIdleSeconds, 120);
  assert.equal(client.modelState.serverEpoch, 'server-b');
  assert.equal(client.modelState.settingsRevision, 0);
});
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

