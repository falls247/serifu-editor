import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImageEdit, imageSize, imagePoint, rotateImage, cropImage, cropRectangle } from '../src/image-edit.js';
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
