import test from 'node:test';
import assert from 'node:assert/strict';
import { createSam3RequestNamespace, LatestSam3Request, Sam3Client } from '../src/sam3-client.js';

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

