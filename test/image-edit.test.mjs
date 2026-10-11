import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImageEdit, imageSize, imagePoint, rotateImage, cropImage, cropRectangle, cropModeAt, dragCropRectangle } from '../src/image-edit.js';
import { newLayer } from '../src/renderer.js';
import { checkpoint, restore, hasEdits, cutLayers, setSelection, selectedLayers, copyLayers, pasteSelectedLayers } from '../src/model.js';
import { projectBlob, readProject } from '../src/project-io.js';
import { exportKey } from '../src/export-cache.js';

test('cropped quarter turns map source corners into the output and invert pointer coordinates', () => {
  const crop = { x: 50, y: 30, width: 200, height: 100 };
  for (const rotation of [0, 90, 180, 270]) {
    const edit = normalizeImageEdit({ crop, rotation }, 400, 300), size = imageSize(400, 300, edit);
    const corners = [{ x: 50, y: 30 }, { x: 250, y: 30 }, { x: 50, y: 130 }, { x: 250, y: 130 }];
    const outputs = corners.map(point => imagePoint(point, 400, 300, edit));
    assert.equal(Math.min(...outputs.map(p => p.x)), 0); assert.equal(Math.max(...outputs.map(p => p.x)), size.width);
    assert.equal(Math.min(...outputs.map(p => p.y)), 0); assert.equal(Math.max(...outputs.map(p => p.y)), size.height);
    for (const point of [...corners, { x: 127.5, y: 93.75 }])
      assert.deepEqual(imagePoint(imagePoint(point, 400, 300, edit), 400, 300, edit, true), point);
  }
});

test('cropping a rotated view composes in source coordinates without discarding the original', () => {
  const rotated = rotateImage(400, 300, null, 90);
  const cropped = cropImage(400, 300, rotated, { x: 40, y: 50, width: 120, height: 200 });
  assert.deepEqual(cropped, { rotation: 90, crop: { x: 50, y: 140, width: 200, height: 120 } });
  assert.deepEqual(imageSize(400, 300, cropped), { width: 120, height: 200 });
  const twice = cropImage(400, 300, cropped, { x: 10, y: 20, width: 60, height: 90 });
  assert.deepEqual(twice.crop, { x: 70, y: 190, width: 90, height: 60 });
  assert.deepEqual(imagePoint({ x: 70, y: 250 }, 400, 300, twice), { x: 0, y: 0 });
  let edit = null;
  for (let i = 0; i < 4; i++) edit = rotateImage(400, 300, edit, 90);
  assert.equal(edit, null); assert.equal(normalizeImageEdit({}, 400, 300), null);
});

test('invalid image edits cannot request out-of-source or empty output; reverse drags stay in bounds', () => {
  for (const crop of [{ x: -1, y: 0, width: 30, height: 20 }, { x: 0, y: 0, width: 0, height: 20 },
    { x: 395, y: 0, width: 10, height: 20 }, { x: 0, y: 0, width: 30, height: 301 }, { x: .5, y: 0, width: 30, height: 20 }])
    assert.throws(() => normalizeImageEdit({ crop }, 400, 300), /不正/);
  assert.throws(() => normalizeImageEdit({ rotation: 45 }, 400, 300), /不正/);
  assert.throws(() => cropImage(400, 300, rotateImage(400, 300, null, 90), { x: 0, y: 0, width: 301, height: 100 }), /不正/);
  assert.deepEqual(cropRectangle({ x: 410, y: 200 }, { x: -20, y: 50 }, 400, 300), { x: 0, y: 50, width: 400, height: 150 });
});

test('crop selection distinguishes scaled handles, edges, interior and new selection', () => {
  const rect = { x: 40, y: 30, width: 280, height: 210 };
  for (const [mode, point] of [['nw', { x: 40, y: 30 }], ['n', { x: 180, y: 30 }],
    ['ne', { x: 320, y: 30 }], ['e', { x: 320, y: 135 }], ['se', { x: 320, y: 240 }],
    ['s', { x: 180, y: 240 }], ['sw', { x: 40, y: 240 }], ['w', { x: 40, y: 135 }],
    ['n', { x: 90, y: 30 }], ['e', { x: 320, y: 80 }], ['s', { x: 90, y: 240 }], ['w', { x: 40, y: 80 }],
    ['move', { x: 120, y: 100 }], ['create', { x: 10, y: 10 }]])
    assert.equal(cropModeAt(rect, point, 400, 300, 1), mode);
  assert.equal(cropModeAt(rect, { x: 55, y: 30 }, 400, 300, .5), 'nw');
  assert.equal(cropModeAt(rect, { x: 55, y: 30 }, 400, 300, 2), 'n');
  assert.equal(cropModeAt({ x: 0, y: 0, width: 400, height: 300 }, { x: 120, y: 100 }, 400, 300, 1), 'create');
});

test('crop drags preserve the opposite edges, dimensions on movement, integer bounds and a one-pixel minimum', () => {
  const rect = { x: 40, y: 30, width: 280, height: 210 }, start = { x: 100, y: 100 }, end = { x: 120.4, y: 110.2 };
  const expected = { nw: [60,40,260,200], n: [40,40,280,200], ne: [40,40,300,200], e: [40,30,300,210],
    se: [40,30,300,220], s: [40,30,280,220], sw: [60,30,260,220], w: [60,30,260,210], move: [60,40,280,210] };
  for (const [mode, [x,y,width,height]] of Object.entries(expected))
    assert.deepEqual(dragCropRectangle(rect, mode, start, end, 400, 300), { x,y,width,height });
  assert.deepEqual(dragCropRectangle(rect, 'move', start, { x: 900, y: 900 }, 400, 300), { ...rect, x: 120, y: 90 });
  assert.deepEqual(dragCropRectangle(rect, 'move', start, { x: -900, y: -900 }, 400, 300), { ...rect, x: 0, y: 0 });
  assert.deepEqual(dragCropRectangle(rect, 'nw', start, { x: 900, y: 900 }, 400, 300), { x: 319, y: 239, width: 1, height: 1 });
  assert.deepEqual(dragCropRectangle(rect, 'se', start, { x: -900, y: -900 }, 400, 300), { x: 40, y: 30, width: 1, height: 1 });
  assert.deepEqual(dragCropRectangle(rect, 'nw', start, { x: -900, y: -900 }, 400, 300), { x: 0, y: 0, width: 320, height: 240 });
  assert.deepEqual(dragCropRectangle(rect, 'se', start, { x: 900, y: 900 }, 400, 300), { x: 40, y: 30, width: 360, height: 270 });
});

test('image edits survive deleting all objects and history restores edits and group selections together', () => {
  const layers = ['dialogue', 'balloon'].map(kind => newLayer(kind, 400, 300));
  const page = { layers, undo: [], redo: [], done: true, imageEdit: null }; setSelection(page, layers.map(l => l.id));
  checkpoint(page); page.imageEdit = rotateImage(400, 300, null, 90);
  const clipboard = cutLayers(page, 400, 300); assert.equal(clipboard.layers.length, 2);
  assert.equal(page.edited, true); assert.equal(hasEdits(page), true);
  restore(page, 'undo'); assert.deepEqual(page.selectedIds, layers.map(l => l.id)); assert.equal(page.imageEdit.rotation, 90);
  restore(page, 'undo'); assert.equal(page.imageEdit, null); assert.equal(page.done, true);
  restore(page, 'redo'); restore(page, 'redo'); assert.equal(page.layers.length, 0); assert.equal(page.edited, true);
  checkpoint(page); page.imageEdit = null; assert.equal(hasEdits(page), false);
  restore(page, 'undo'); assert.equal(page.edited, true); restore(page, 'redo'); assert.equal(page.edited, false);
});

test('selected subset snapshots preserve stacking, relative placement, styles and independent IDs', () => {
  const layers = ['dialogue', 'sfx', 'balloon', 'caption'].map((kind, i) => ({ ...newLayer(kind, 400, 300, 'female'), x: 50 + i * 40, y: 60 + i * 30, text: kind }));
  const source = { layers }; setSelection(source, [layers[3].id, layers[0].id, layers[2].id], layers[2].id);
  const clipboard = copyLayers(selectedLayers(source), 400, 300); layers[0].text = 'changed';
  const copies = pasteSelectedLayers(clipboard, 800, 600, 20), repeat = pasteSelectedLayers(clipboard, 800, 600, 40);
  assert.deepEqual(copies.map(l => l.kind), ['dialogue', 'balloon', 'caption']);
  assert.equal(copies[0].text, 'dialogue'); assert.equal(copies[1].speaker, 'female');
  assert.equal(copies[2].x - copies[0].x, 240); assert.equal(copies[2].y - copies[0].y, 180);
  assert.equal(repeat[0].x, copies[0].x + 20); assert.equal(new Set([...copies, ...repeat].map(l => l.id)).size, 6);
  copies[0].text = 'target'; assert.equal(clipboard.layers[0].text, 'dialogue');
});

test('both project formats retain image edits and original bytes, and edits invalidate PNG cache', async () => {
  const edit = rotateImage(400, 300, null, 90), page = { id: 'source', name: 'test.png', img: { width: 400, height: 300 },
    file: new Blob(['original image bytes'], { type: 'image/png' }), src: 'data:image/png;base64,b3JpZ2luYWw=', layers: [], imageEdit: edit, edited: true };
  for (const format of ['json', 'serifu']) {
    const project = await readProject(await projectBlob([page], {}, { format }));
    assert.equal(project.version, 10); assert.deepEqual(project.pages[0].imageEdit, edit);
    if (format === 'serifu') { assert.equal(await project.pages[0].blob.text(), await page.file.text()); assert.equal(project.pages[0].expectedSize.width, 400); }
    else assert.equal(project.pages[0].src, page.src);
  }
  assert.notEqual(exportKey(page), exportKey({ ...page, imageEdit: null }));
  assert.equal(exportKey(page), exportKey({ ...page, selectedIds: ['anything'], done: true }));
});
