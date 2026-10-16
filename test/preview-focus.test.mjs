import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePreviewFocusZoom, previewFocusScale, previewFocusPanForPoint,
  previewFocusPointAtCenter, previewFocusPointFromClient, previewFocusPanForAnchor,
} from '../src/preview-focus.js';

test('100% maps source pixels to CSS pixels and selected edge points can be centered', () => {
  const fitWidth = 420, imageWidth = 1200;
  const scale = previewFocusScale(fitWidth, imageWidth, 100);
  assert.equal(fitWidth * scale, imageWidth);

  const frame = { width: 360, height: 220 }, edgePoint = { x: 4, y: 8 };
  const pan = previewFocusPanForPoint(frame, edgePoint, 100);
  assert.deepEqual(previewFocusPointAtCenter(frame, pan, 100), edgePoint);
  assert.ok(pan.x > 0 && pan.y > 0, 'centering image-edge objects permits blank margins');
});

test('client coordinates invert the displayed canvas transform', () => {
  const imageSize = { width: 1000, height: 750 };
  const canvasRect = { left: 130, top: 80, width: 2000, height: 1500 };
  assert.deepEqual(previewFocusPointFromClient({ x: 630, y: 830 }, canvasRect, imageSize), { x: 250, y: 375 });
});

test('pinch zoom keeps the source point under the moving gesture anchor', () => {
  const sourcePoint = { x: 80, y: 40 }, nextAnchor = { x: 210, y: 150 };
  const pan = previewFocusPanForAnchor(nextAnchor, sourcePoint, 250);
  const mapped = { x: pan.x + sourcePoint.x * 2.5, y: pan.y + sourcePoint.y * 2.5 };
  assert.deepEqual(mapped, nextAnchor);
});

test('focus zoom accepts numeric percentages and bounds unusable extremes', () => {
  assert.equal(normalizePreviewFocusZoom('175'), 175);
  assert.equal(normalizePreviewFocusZoom('0'), 1);
  assert.equal(normalizePreviewFocusZoom('100000'), 5000);
  assert.equal(normalizePreviewFocusZoom(''), null);
  assert.equal(normalizePreviewFocusZoom('not a number'), null);
});
