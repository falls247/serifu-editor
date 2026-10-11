import { decodeMask, MAX_MASK_PIXELS_LIMIT } from './mask-codec.js';

const MAX_MARGIN = 100;

function assertImage(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width > 30000 || height > 30000 || width * height > MAX_MASK_PIXELS_LIMIT) throw new Error('画像寸法がマスク処理の範囲外');
}

function trimMask(mask) {
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (!mask.data[y * mask.width + x]) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < minX) return { x: mask.x, y: mask.y, width: 0, height: 0, data: new Uint8Array() };
  const width = maxX - minX + 1, height = maxY - minY + 1, data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(mask.data.subarray((y + minY) * mask.width + minX, (y + minY) * mask.width + maxX + 1), y * width);
  return { x: mask.x + minX, y: mask.y + minY, width, height, data };
}

export function transformMask(asset, effect, imageWidth = asset?.imageWidth, imageHeight = asset?.imageHeight) {
  assertImage(imageWidth, imageHeight);
  if (!effect || ![effect.x, effect.y, effect.w, effect.h].every(Number.isSafeInteger) || effect.w <= 0 || effect.h <= 0
      || effect.w > imageWidth || effect.h > imageHeight || effect.w * effect.h > MAX_MASK_PIXELS_LIMIT) throw new Error('マスク変形の座標・サイズが不正');
  const source = asset.decoded instanceof Uint8Array ? asset.decoded : decodeMask(asset);
  if (source.length !== asset.bbox.width * asset.bbox.height) throw new Error('展開済みマスク寸法が不正');
  const x0 = Math.max(0, effect.x), y0 = Math.max(0, effect.y);
  const x1 = Math.min(imageWidth, effect.x + effect.w), y1 = Math.min(imageHeight, effect.y + effect.h);
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, width: 0, height: 0, data: new Uint8Array() };
  const width = x1 - x0, height = y1 - y0, data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(asset.bbox.height - 1, Math.floor((y0 + y + 0.5 - effect.y) * asset.bbox.height / effect.h));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(asset.bbox.width - 1, Math.floor((x0 + x + 0.5 - effect.x) * asset.bbox.width / effect.w));
      data[y * width + x] = source[sourceY * asset.bbox.width + sourceX] ? 1 : 0;
    }
  }
  return trimMask({ x: x0, y: y0, width, height, data });
}

function edt1d(input, output, length, cap, vertices, boundaries) {
  let top = -1;
  for (let q = 0; q < length; q++) {
    const fq = input[q];
    if (fq >= cap) continue;
    let intersection = -Infinity;
    while (top >= 0) {
      const v = vertices[top], fv = input[v];
      intersection = ((fq + q * q) - (fv + v * v)) / (2 * (q - v));
      if (intersection > boundaries[top]) break;
      top--;
    }
    top++;
    vertices[top] = q;
    boundaries[top] = top === 0 ? -Infinity : intersection;
    boundaries[top + 1] = Infinity;
  }
  if (top < 0) { output.fill(cap, 0, length); return; }
  let k = 0;
  for (let q = 0; q < length; q++) {
    while (k < top && boundaries[k + 1] < q) k++;
    const delta = q - vertices[k], value = input[vertices[k]] + delta * delta;
    output[q] = value < cap ? value : cap;
  }
}

function distanceToFeatures(features, width, height, maxDistanceSquared) {
  const cap = maxDistanceSquared + 1, result = new Float32Array(features.length);
  const lineIn = new Float64Array(Math.max(width, height)), lineOut = new Float64Array(lineIn.length);
  const vertices = new Int32Array(lineIn.length), boundaries = new Float64Array(lineIn.length + 1);
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) lineIn[x] = features[offset + x] ? 0 : cap;
    edt1d(lineIn, lineOut, width, cap, vertices, boundaries);
    result.set(lineOut.subarray(0, width), offset);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) lineIn[y] = result[y * width + x];
    edt1d(lineIn, lineOut, height, cap, vertices, boundaries);
    for (let y = 0; y < height; y++) result[y * width + x] = lineOut[y];
  }
  return result;
}

export function adjustMaskMargin(mask, marginPx, imageWidth, imageHeight) {
  assertImage(imageWidth, imageHeight);
  if (!Number.isSafeInteger(marginPx) || Math.abs(marginPx) > MAX_MARGIN) throw new Error('マスク輪郭補正の値が範囲外');
  if (!mask || ![mask.x, mask.y, mask.width, mask.height].every(Number.isSafeInteger)
      || mask.width <= 0 || mask.height <= 0 || mask.x < 0 || mask.y < 0
      || mask.x + mask.width > imageWidth || mask.y + mask.height > imageHeight
      || mask.data?.length !== mask.width * mask.height) throw new Error('マスクbboxまたは画素数が不正');
  if (marginPx === 0) return { ...mask, data: Uint8Array.from(mask.data) };
  const radius = Math.abs(marginPx), distanceSquared = radius * radius;
  if (marginPx > 0) {
    const x = Math.max(0, mask.x - radius), y = Math.max(0, mask.y - radius);
    const right = Math.min(imageWidth, mask.x + mask.width + radius), bottom = Math.min(imageHeight, mask.y + mask.height + radius);
    const width = right - x, height = bottom - y;
    if (width * height > MAX_MASK_PIXELS_LIMIT) throw new Error('膨張後のマスクが上限を超える');
    const features = new Uint8Array(width * height);
    for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) {
      if (mask.data[row * mask.width + col]) features[(mask.y + row - y) * width + mask.x + col - x] = 1;
    }
    const distances = distanceToFeatures(features, width, height, distanceSquared), data = new Uint8Array(features.length);
    for (let i = 0; i < data.length; i++) data[i] = distances[i] <= distanceSquared ? 1 : 0;
    return trimMask({ x, y, width, height, data });
  }

  const width = mask.width + 2, height = mask.height + 2;
  if (width * height > MAX_MASK_PIXELS_LIMIT) throw new Error('収縮対象のマスクが上限を超える');
  const background = new Uint8Array(width * height).fill(1);
  for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) {
    if (mask.data[row * mask.width + col]) background[(row + 1) * width + col + 1] = 0;
  }
  const distances = distanceToFeatures(background, width, height, distanceSquared), data = new Uint8Array(mask.width * mask.height);
  for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) {
    const sourceIndex = row * mask.width + col;
    data[sourceIndex] = mask.data[sourceIndex] && distances[(row + 1) * width + col + 1] > distanceSquared ? 1 : 0;
  }
  return trimMask({ x: mask.x, y: mask.y, width: mask.width, height: mask.height, data });
}

export const MAX_MASK_MARGIN = MAX_MARGIN;
