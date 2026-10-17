import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftLayers, draftFileName, layoutDraftLayers, parseAnnotationDraft } from '../src/annotation-drafts.js';
import { captionOutline } from '../src/captions.js';
import { layerBounds, newLayer } from '../src/renderer.js';

test('sidecar parsing strips a UTF-8 BOM, keeps source order and preserves empty or multiline text', () => {
  const parsed = parseAnnotationDraft('\uFEFF' + JSON.stringify({
    schemaVersion: 1, imageFile: 'image.jpg', savedAt: 'ignored', annotations: [
      { type: 'dialogue', speaker: 'female', text: '' },
      { type: 'caption', text: '一行目\n二行目' },
      { type: 'sound_effect', text: 'ドン！' },
      { type: 'speech_bubble', text: '吹き出し' },
    ],
  }), 'image.jpg');
  assert.deepEqual(parsed.annotations, [
    { type: 'dialogue', speaker: 'female', text: '' },
    { type: 'caption', text: '一行目\n二行目' },
    { type: 'sound_effect', text: 'ドン！' },
    { type: 'speech_bubble', text: '吹き出し' },
  ]);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(draftFileName('image.jpg'), 'image.jpg.json');
});

test('invalid annotations are skipped with one-based Japanese warnings containing their index', () => {
  const result = parseAnnotationDraft(JSON.stringify({ schemaVersion: 1, imageFile: 'a.png', annotations: [
    { type: 'dialogue', speaker: 'other', text: 'skip' },
    { type: 'unknown', text: 'skip' },
    { type: 'caption', text: 'keep' },
    { type: 'sfx', text: 12 },
    null,
  ] }), 'a.png');
  assert.deepEqual(result.annotations, [{ type: 'caption', text: 'keep' }]);
  assert.equal(result.warnings.length, 4);
  for (const index of [1, 2, 4, 5]) assert.ok(result.warnings.some(warning => warning.includes(`${index} 件目`)));
  assert.ok(result.warnings.every(warning => warning.includes('スキップ')));
});

test('invalid sidecar roots, version, filename, array and JSON produce useful Japanese errors', () => {
  for (const [input, name] of [
    ['{', 'a.jpg'],
    ['[]', 'a.jpg'],
    [JSON.stringify({ schemaVersion: 2, imageFile: 'a.jpg', annotations: [] }), 'a.jpg'],
    [JSON.stringify({ schemaVersion: 1, imageFile: 'b.jpg', annotations: [] }), 'a.jpg'],
    [JSON.stringify({ schemaVersion: 1, imageFile: 'a.jpg', annotations: {} }), 'a.jpg'],
  ]) assert.throws(() => parseAnnotationDraft(input, name), error => /注釈下書き/.test(error.message));
});

test('draft layers map annotation types to existing model kinds and assign text after preset creation', () => {
  const calls = [];
  const layers = createDraftLayers([
    { type: 'dialogue', speaker: 'female', text: '台詞' },
    { type: 'caption', text: '見出し' },
    { type: 'sound_effect', text: '効果音' },
    { type: 'speech_bubble', text: '吹き出し' },
  ], 640, 480, (...args) => {
    calls.push(args);
    return { id: `id-${calls.length}`, kind: args[0], text: 'preset text' };
  });
  assert.deepEqual(calls, [['dialogue', 640, 480, 'female'], ['caption', 640, 480], ['sfx', 640, 480], ['balloon', 640, 480]]);
  assert.deepEqual(layers.map(layer => layer.kind), ['dialogue', 'caption', 'sfx', 'balloon']);
  assert.deepEqual(layers.map(layer => layer.text), ['台詞', '見出し', '効果音', '吹き出し']);
  assert.deepEqual(layers.map(layer => layer.id), ['id-1', 'id-2', 'id-3', 'id-4']);
});

const box = (width, height) => layer => ({ minX: 0, minY: 0, maxX: layer.w ?? width, maxY: layer.h ?? height });
const item = (id, w, h) => ({ id, kind: 'dialogue', x: 0, y: 0, w, h, size: 40, outline: 2, text: id });

test('shelf layout places objects top-right and proceeds right-to-left without mutation', () => {
  const source = [item('a', 30, 20), item('b', 40, 25)];
  const before = structuredClone(source);
  const result = layoutDraftLayers(source, 200, 100, box());
  assert.equal(result.overflow, false);
  assert.deepEqual(result.layers.map(({ x, y }) => [x, y]), [[168, 2], [126, 2]]);
  assert.deepEqual(source, before);
  assert.notEqual(result.layers[0], source[0]);
});

test('shelf layout wraps to the next row using the prior row height', () => {
  const result = layoutDraftLayers([item('a', 60, 20), item('b', 60, 30)], 100, 100, box());
  assert.deepEqual(result.layers.map(({ x, y }) => [x, y]), [[38, 2], [38, 24]]);
  assert.equal(result.overflow, false);
});

test('objects scale uniformly to fit and retain their IDs without changing sources', () => {
  const source = [item('a', 60, 50), item('b', 60, 50)];
  source[0].thickness = 20;
  const before = structuredClone(source);
  const result = layoutDraftLayers(source, 100, 70, box());
  assert.equal(result.overflow, false);
  assert.ok(result.layers.every(layer => layer.w < 60 && layer.h < 50));
  assert.ok(Math.abs(result.layers[0].w / 60 - result.layers[0].h / 50) < .001);
  assert.ok(result.layers[0].thickness > 5 && result.layers[0].thickness < 20);
  assert.ok(Math.abs(result.layers[0].thickness / 20 - result.layers[0].w / 60) < .001);
  assert.deepEqual(result.layers.map(layer => layer.id), ['a', 'b']);
  assert.deepEqual(source, before);
});

test('minimum-size fallback keeps every object and rows continue below tiny images', () => {
  const result = layoutDraftLayers([item('a', 60, 40), item('b', 70, 50)], 20, 20, box());
  assert.equal(result.overflow, true);
  assert.deepEqual(result.layers.map(layer => [layer.w, layer.h, layer.size]), [[30, 30, 8], [30, 30, 8]]);
  assert.equal(result.layers[0].x + 30, 18, 'oversized first object aligns to the image right edge');
  assert.equal(result.layers[0].y + 30 <= result.layers[1].y, true);
  assert.deepEqual(result.layers.map(layer => layer.id), ['a', 'b']);
});

test('pre-aborted layout rejects with AbortError before measuring layers', () => {
  const controller = new AbortController();controller.abort();
  assert.throws(() => layoutDraftLayers([item('a', 30, 20)], 100, 100, () => { throw new Error('測定されてはいけない'); }, { signal: controller.signal }), { name: 'AbortError' });
});

const context = () => {
  const stack=[];
  return {
  font: '', textAlign:'left', textBaseline:'alphabetic',
  save() { stack.push([this.font,this.textAlign,this.textBaseline]); },
  restore() { [this.font,this.textAlign,this.textBaseline]=stack.pop(); },
  measureText(char) {
    const size = Number(this.font.match(/([\d.]+)px/)[1]), width = size * (char === 'I' ? .4 : 1);
    return { width, actualBoundingBoxLeft: width / 2, actualBoundingBoxRight: width / 2, actualBoundingBoxAscent: size * .8, actualBoundingBoxDescent: size * .2 };
  },
  };
};

test('layer bounds include rotated selection geometry, balloon tails and shadow', () => {
  const ctx = context();
  const rotated = { ...newLayer('dialogue', 400, 300), x: 300, y: 250, w: 100, h: 40, rotation: 90 };
  const rotatedBounds = layerBounds(ctx, rotated);
  assert.ok(rotatedBounds.maxX - rotatedBounds.minX >= 40);
  assert.ok(rotatedBounds.maxY - rotatedBounds.minY >= 100);
  const balloon = { ...newLayer('balloon', 400, 300), w: 100, h: 80, rotation: 90, tail: true, tailX: 160, tailY: 0, shadowEnabled: true, shadowBlur: 10, shadowOffsetY: 15 };
  const balloonBounds = layerBounds(ctx, balloon);
  assert.ok(balloonBounds.maxY > 170, 'rotated tail and shadow extend the measured bounds');
});

test('layer bounds include vertical punctuation ink outside its em cell', () => {
  const punctuation = { ...newLayer('dialogue', 300, 300), text: '、', size: 80, w: 30, h: 30, rotation: 90 };
  const ctx=context();ctx.font='18px sans';ctx.textAlign='right';ctx.textBaseline='top';
  const bounds = layerBounds(ctx, punctuation);
  assert.ok(bounds.minY < -45, 'the punctuation corner offset rotates with its glyph');
  assert.deepEqual([ctx.font,ctx.textAlign,ctx.textBaseline],['18px sans','right','top']);
});

test('balloon bounds include overflowing text and its outline after offsets and rotation', () => {
  for(const vertical of [true,false])for(const rotation of [0,90])for(const direction of [-1,1]){
    const balloon={...newLayer('balloon',400,300),text:'枠外',w:80,h:80,size:40,lineAlign:'center',vertical,rotation,textOffsetX:direction*140,outline:8,thickness:2};
    const bounds=layerBounds(context(),balloon),axis=rotation===0?'X':'Y';
    assert.ok(direction<0?bounds[`min${axis}`]<-150:bounds[`max${axis}`]>150,'shifted text must extend the measured bounds beyond the frame');
  }
});

test('spiky caption bounds include solid miter joins beyond the outline vertices', () => {
  const caption = { ...newLayer('caption', 500, 400), shape: 'spiky', shapeSeed: 12345, distortion: 100, w: 220, h: 170, borderWidth: 24, borderStyle: 'solid' };
  const points = captionOutline(caption),vertices=points.slice(0,-1),bounds = layerBounds(context(), caption),half=caption.borderWidth/2;
  const miterReach=vertices.reduce((maximum,point,index)=>{
    const previous=vertices[(index+vertices.length-1)%vertices.length],next=vertices[(index+1)%vertices.length];
    const ax=point.x-previous.x,ay=point.y-previous.y,bx=next.x-point.x,by=next.y-point.y;
    const turn=Math.acos(Math.max(-1,Math.min(1,(ax*bx+ay*by)/(Math.hypot(ax,ay)*Math.hypot(bx,by)))));
    return Math.max(maximum,Math.min(half*10,half/Math.max(.0001,Math.cos(turn/2))));
  },half);
  const minX = Math.min(...points.map(point => point.x)), minY = Math.min(...points.map(point => point.y));
  assert.ok(miterReach > half + 2, 'fixture exercises an acute spike beyond the old half-width padding');
  assert.ok(bounds.minX <= minX - miterReach);
  assert.ok(bounds.minY <= minY - miterReach);
});

test('sound effect bounds include ink beyond the selection box', () => {
  const layer = { ...newLayer('sfx', 500, 400), text: 'WW', size: 60, w: 30, h: 30, vertical: false, effect: 'none', outline: 4 };
  const bounds = layerBounds(context(), layer);
  assert.ok(bounds.maxX - bounds.minX > layer.w);
  assert.ok(bounds.maxY - bounds.minY > layer.h);
});

test('layout uses rotated balloon tail bounds when placing its layer', () => {
  const ctx = context();
  const balloon = { ...newLayer('balloon', 400, 300), w: 100, h: 80, rotation: 90, tail: true, tailX: 80, tailY: 0 };
  const result = layoutDraftLayers([balloon], 300, 300, layer => layerBounds(ctx, layer));
  const bounds = layerBounds(ctx, result.layers[0]);
  assert.equal(result.overflow, false);
  assert.ok(result.layers[0].x + bounds.minX >= 0);
  assert.ok(result.layers[0].y + bounds.minY >= 0);
  assert.ok(result.layers[0].x + bounds.maxX <= 300);
  assert.ok(result.layers[0].y + bounds.maxY <= 300);
  assert.equal(result.layers[0].id, balloon.id);
});
