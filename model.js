import { DIALOGUE_COLORS, EFFECTS, FONT_CHOICES, WARP_CHOICES, clamp } from './renderer.js';
export const EFFECT_LIMITS = Object.freeze({ blur: [0,30], motionBlur: [0,300], blurAngle: [-180,180], blurX:[0,150], blurY:[0,300], blurStrength:[0,400], inkCore:[0,100], roughness:[0,100], dryInk:[0,100], brushTails:[0,100], distortion: [0,100], skew: [-45,45], stretchX: [30,250], stretchY: [30,250] });

export function normalizeLayer(input, version = 3) {
  if (!input || typeof input.text !== 'string' || typeof input.vertical !== 'boolean') throw new Error('文字設定が不正');
  const legacy = version === 1;
  const kind = legacy && input.kind === 'bubble' ? 'dialogue' : input.kind;
  if (!['dialogue', 'sfx'].includes(kind)) throw new Error('文字の種類が不正');
  for (const key of ['x', 'y', 'w', 'h', 'size', 'rotation']) {
    if (!Number.isFinite(input[key])) throw new Error('座標またはサイズが不正');
  }
  if (input.w < 30 || input.w > 30000 || input.h < 30 || input.h > 30000 || input.size < 8 || input.size > 500 || Math.abs(input.rotation) > 180) throw new Error('座標またはサイズが範囲外');
  const speaker = legacy ? 'male' : input.speaker;
  const effect = legacy ? 'impact' : input.effect;
  const outline = legacy ? Math.max(2, Math.round(input.size * .15)) : input.outline;
  if (!Object.hasOwn(DIALOGUE_COLORS, speaker) || !Object.hasOwn(EFFECTS, effect)) throw new Error('話者または効果音設定が不正');
  if (!Number.isFinite(outline) || outline < 1 || outline > 80) throw new Error('白い縁の太さが不正');
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('文字色が不正');
  const extras = { font: kind==='sfx'?'comic':'sans', warp:'taper', blur:0, motionBlur:0, blurAngle:90, blurX:0, blurY:0, blurStrength:200, inkCore:80, roughness:0, dryInk:0, brushTails:0, distortion:0, skew:0, stretchX:100, stretchY:100 };
  for (const key of Object.keys(extras)) if (input[key] !== undefined) extras[key] = input[key];
  if (!Object.hasOwn(FONT_CHOICES,extras.font) || !Object.hasOwn(WARP_CHOICES,extras.warp)) throw new Error('書体または歪み設定が不正');
  for (const [key,[min,max]] of Object.entries(EFFECT_LIMITS)) if (!Number.isFinite(extras[key]) || extras[key]<min || extras[key]>max) throw new Error('効果音の設定が範囲外');
  return {
    id: crypto.randomUUID(), kind, speaker, text: input.text,
    x: input.x, y: input.y, w: input.w, h: input.h, size: input.size,
    rotation: input.rotation, vertical: input.vertical, outline, effect, color: input.color,
    ...extras, presetId: typeof input.presetId==='string' ? input.presetId : null,
  };
}

export function checkpoint(page) {
  page.undo.push(JSON.stringify({ layers: page.layers, done: page.done }));
  if (page.undo.length > 100) page.undo.shift();
  page.redo = []; page.done = false;
}

export function restore(page, direction) {
  const from = direction === 'undo' ? page.undo : page.redo;
  const to = direction === 'undo' ? page.redo : page.undo;
  if (!from.length) return false;
  to.push(JSON.stringify({ layers: page.layers, done: page.done }));
  const state = JSON.parse(from.pop());
  page.layers = state.layers; page.done = state.done;
  page.selectedId = page.layers.some(l => l.id === page.selectedId) ? page.selectedId : page.layers[0]?.id || null;
  return true;
}

export function duplicateLayer(layer) {
  return { ...layer, id: crypto.randomUUID(), x: layer.x + 20, y: layer.y + 20 };
}

export function swapText(page, firstId, secondId) {
  const first = page.layers.find(l => l.id === firstId), second = page.layers.find(l => l.id === secondId);
  if (!first || !second || first === second) return false;
  checkpoint(page); [first.text, second.text] = [second.text, first.text]; return true;
}

export function copyToNext(source, target, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!source || !target) return false;
  checkpoint(target);
  const sx = targetWidth / sourceWidth, sy = targetHeight / sourceHeight;
  for (const layer of source.layers) target.layers.push({
    ...layer, id: crypto.randomUUID(), x: layer.x * sx, y: layer.y * sy,
    w: clamp(layer.w * sx, 30, 30000), h: clamp(layer.h * sy, 30, 30000),
    size: clamp(layer.size * Math.min(sx, sy), 8, 500), outline: clamp(layer.outline * Math.min(sx, sy), 1, 80),
    blur: clamp(layer.blur * Math.min(sx,sy),0,30), motionBlur: clamp(layer.motionBlur * Math.min(sx,sy),0,300),
    blurX:clamp((layer.blurX||0)*sx,0,150),blurY:clamp((layer.blurY||0)*sy,0,300),
  });
  return true;
}
