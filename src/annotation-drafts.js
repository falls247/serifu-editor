import { scaledCopy } from './model.js';

const TYPES = new Set(['dialogue', 'caption', 'sound_effect', 'speech_bubble']);

export function draftFileName(imageName) {
  return `${imageName}.json`;
}

function invalidDraft(message) {
  return new Error(`注釈下書きを読み込めない: ${message}`);
}

export function parseAnnotationDraft(text, imageName) {
  if (typeof text !== 'string') throw invalidDraft('JSONデータが文字列ではない');
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw invalidDraft(`JSONを解析できない (${error.message})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidDraft('ルート要素がオブジェクトではない');
  if (data.schemaVersion !== 1) throw invalidDraft('schemaVersion が1ではない');
  if (data.imageFile !== imageName) throw invalidDraft(`画像ファイル名が一致しない (${String(data.imageFile)})`);
  if (!Array.isArray(data.annotations)) throw invalidDraft('annotations が配列ではない');

  const annotations = [], warnings = [];
  for (let index = 0; index < data.annotations.length; index++) {
    const item = data.annotations[index];
    const plain = item && typeof item === 'object' && !Array.isArray(item);
    const validType = plain && TYPES.has(item.type);
    const validText = plain && typeof item.text === 'string';
    const validSpeaker = item?.type !== 'dialogue' || item.speaker === 'male' || item.speaker === 'female';
    if (!validType || !validText || !validSpeaker) {
      warnings.push(`注釈 ${index + 1} 件目をスキップした: 種類・話者・本文が不正`);
      continue;
    }
    annotations.push(item.type === 'dialogue'
      ? { type: item.type, speaker: item.speaker, text: item.text }
      : { type: item.type, text: item.text });
  }
  return { annotations, warnings };
}

export function createDraftLayers(annotations, width, height, makeLayer) {
  if (typeof makeLayer !== 'function') throw new TypeError('makeLayer は関数である必要がある');
  const kinds = { dialogue: 'dialogue', caption: 'caption', sound_effect: 'sfx', speech_bubble: 'balloon' };
  return annotations.map(annotation => {
    const layer = annotation.type === 'dialogue'
      ? makeLayer(kinds[annotation.type], width, height, annotation.speaker)
      : makeLayer(kinds[annotation.type], width, height);
    layer.text = annotation.text;
    return layer;
  });
}

function scaledLayer(layer, factor) {
  const copy = scaledCopy(layer, 1, 1, factor, factor);
  copy.id = layer.id;
  if (Object.hasOwn(layer, 'layoutOrder')) copy.layoutOrder = layer.layoutOrder;
  return copy;
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('注釈配置を中断した');
  error.name = 'AbortError';
  throw error;
}

function measureAll(layers, measureBounds, signal) {
  return layers.map((layer, index) => {
    if ((index & 31) === 0) checkAbort(signal);
    const bounds = measureBounds(layer);
    if (!bounds || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(bounds[key]))
      || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) {
      throw new TypeError('measureBounds は有効なAABBを返す必要がある');
    }
    return bounds;
  });
}

function placeShelf(layers, bounds, width, height, gap, margin, signal) {
  const placed = layers.map(layer => ({ ...layer }));
  let rowTop = margin, rowHeight = 0, right = width - margin, rowEmpty = true, fits = true;
  for (let i = 0; i < layers.length; i++) {
    if ((i & 31) === 0) checkAbort(signal);
    const b = bounds[i], boxWidth = b.maxX - b.minX, boxHeight = b.maxY - b.minY;
    if (!rowEmpty && right - boxWidth < margin) {
      rowTop += rowHeight + gap;
      rowHeight = 0; right = width - margin; rowEmpty = true;
    }
    const x = right - b.maxX;
    const y = rowTop - b.minY;
    placed[i].x = x; placed[i].y = y;
    if (boxWidth > width - margin * 2 || boxHeight > height - margin * 2 || right - boxWidth < margin || rowTop + boxHeight > height - margin) fits = false;
    right = x + b.minX - gap;
    rowHeight = Math.max(rowHeight, boxHeight);
    rowEmpty = false;
  }
  return { layers: placed, bounds, fits };
}

function minimumFactor(layers) {
  // A zero multiplier maps every bounded dimension to its model minimum.
  // Keeping this explicit makes the fallback independent of the source size.
  return layers.length ? 0 : 1;
}

export function layoutDraftLayers(layers, width, height, measureBounds, { signal } = {}) {
  if (!Array.isArray(layers)) throw new TypeError('layers は配列である必要がある');
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) throw new TypeError('画像サイズが不正');
  if (typeof measureBounds !== 'function') throw new TypeError('measureBounds は関数である必要がある');
  checkAbort(signal);
  const gap = Math.max(2, Math.round(Math.min(width, height) * .02)), margin = gap;
  const originalBounds = measureAll(layers, measureBounds, signal);
  const normal = placeShelf(layers, originalBounds, width, height, gap, margin, signal);
  if (normal.fits) return { layers: normal.layers, overflow: false };

  let low = minimumFactor(layers), high = 1, best = null;
  // Search scales in logarithmic work, measuring only a bounded number of times.
  for (let step = 0; step < 22; step++) {
    checkAbort(signal);
    const factor = (low + high) / 2;
    const candidate = layers.map(layer => scaledLayer(layer, factor));
    const bounds = measureAll(candidate, measureBounds, signal);
    const placed = placeShelf(candidate, bounds, width, height, gap, margin, signal);
    if (placed.fits) { best = placed; low = factor; }
    else high = factor;
  }
  if (!best) {
    const minimum = layers.map(layer => scaledLayer(layer, 0));
    const minimumBounds = measureAll(minimum, measureBounds, signal);
    best = placeShelf(minimum, minimumBounds, width, height, gap, margin, signal);
  }
  const overflow = best.layers.some((layer, index) => {
    if ((index & 31) === 0) checkAbort(signal);
    const bounds = best.bounds[index];
    return layer.x + bounds.minX < 0 || layer.y + bounds.minY < 0
      || layer.x + bounds.maxX > width || layer.y + bounds.maxY > height;
  });
  return { layers: best.layers, overflow };
}
