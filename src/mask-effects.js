import { adjustMaskMargin, transformMask } from './mask-geometry.js';
import { paintOrder } from './balloons.js';

function imageDataBytes(source, width, height) {
  const bytes = source?.data ?? source;
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray) || bytes.length !== width * height * 4) throw new Error('元画像のpixel dataが不正');
  return bytes;
}

function averageTile(source, width, height, x, y, blockSize) {
  const left = Math.floor(x / blockSize) * blockSize, top = Math.floor(y / blockSize) * blockSize;
  const right = Math.min(width, left + blockSize), bottom = Math.min(height, top + blockSize);
  const sum = [0, 0, 0]; let alphaSum = 0, count = 0;
  for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
    const offset = (row * width + col) * 4;
    const alpha = source[offset + 3];
    for (let channel = 0; channel < 3; channel++) sum[channel] += source[offset + channel] * alpha;
    alphaSum += alpha;
    count++;
  }
  return [...sum.map(value => alphaSum ? Math.round(value / alphaSum) : 0), Math.round(alphaSum / count)];
}

function premultiplyRGBA(source) {
  const output = new Float32Array(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    const alpha = source[offset + 3] / 255;
    output[offset] = source[offset] * alpha; output[offset + 1] = source[offset + 1] * alpha;
    output[offset + 2] = source[offset + 2] * alpha; output[offset + 3] = source[offset + 3];
  }
  return output;
}

function unpremultiplyRGBA(source) {
  const output = new Uint8ClampedArray(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    const alpha = source[offset + 3];
    if (alpha > 0) {
      output[offset] = source[offset] * 255 / alpha; output[offset + 1] = source[offset + 1] * 255 / alpha;
      output[offset + 2] = source[offset + 2] * 255 / alpha;
    }
    output[offset + 3] = alpha;
  }
  return output;
}

function boxPass(input, width, height, radius, horizontal) {
  const output = new Float32Array(input.length), length = horizontal ? width : height;
  const lines = horizontal ? height : width, prefix = new Float64Array((length + 1) * 4);
  for (let line = 0; line < lines; line++) {
    prefix.fill(0);
    for (let index = 0; index < length; index++) {
      const sourceOffset = horizontal ? (line * width + index) * 4 : (index * width + line) * 4;
      const prefixOffset = (index + 1) * 4, previousOffset = index * 4;
      for (let channel = 0; channel < 4; channel++) prefix[prefixOffset + channel] = prefix[previousOffset + channel] + input[sourceOffset + channel];
    }
    for (let index = 0; index < length; index++) {
      const start = Math.max(0, index - radius), end = Math.min(length, index + radius + 1), divisor = end - start;
      const outputOffset = horizontal ? (line * width + index) * 4 : (index * width + line) * 4;
      for (let channel = 0; channel < 4; channel++) output[outputOffset + channel] = (prefix[end * 4 + channel] - prefix[start * 4 + channel]) / divisor;
    }
  }
  return output;
}

function blurRegion(source, imageWidth, imageHeight, mask, radius) {
  const passes = radius < 3 ? radius : 3, boxRadius = radius < 3 ? 1 : Math.max(1, Math.round(radius / 3));
  const support = passes * boxRadius;
  const x = Math.max(0, mask.x - support), y = Math.max(0, mask.y - support);
  const right = Math.min(imageWidth, mask.x + mask.width + support), bottom = Math.min(imageHeight, mask.y + mask.height + support);
  const width = right - x, height = bottom - y, bytes = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sourceStart = ((y + row) * imageWidth + x) * 4;
    bytes.set(source.subarray(sourceStart, sourceStart + width * 4), row * width * 4);
  }
  let blurred = premultiplyRGBA(bytes);
  for (let pass = 0; pass < passes; pass++) {
    blurred = boxPass(blurred, width, height, boxRadius, true);
    blurred = boxPass(blurred, width, height, boxRadius, false);
  }
  return { x, y, width, data: unpremultiplyRGBA(blurred) };
}

function effectList(effects, assets, draft) {
  const list = [...(effects ?? [])], assetMap = new Map(Object.entries(assets ?? {}));
  if (draft?.candidates?.length) {
    for (const candidate of draft.candidates) {
      if (!candidate?.selected || !candidate.mask) continue;
      const asset = candidate.mask, assetId = asset.id || candidate.id;
      if (!assetMap.has(assetId)) assetMap.set(assetId, asset);
      list.push({ id: candidate.id, kind: 'mask-effect', assetId, name: candidate.id, createdOrder: Number.MAX_SAFE_INTEGER, layoutOrder: Number.MAX_SAFE_INTEGER,
        visible: true, effect: draft.effect, blockSize: draft.blockSize, blurRadius: draft.blurRadius, marginPx: 0,
        x: asset.bbox.x, y: asset.bbox.y, w: asset.bbox.width, h: asset.bbox.height });
    }
  }
  return { list, assetMap };
}

/** Apply masks over original pixels in order; each effect samples the unchanged source. */
export function applyMaskEffectsToImageData(sourceImageData, width, height, maskEffects = [], maskAssets = {}, { draft = null } = {}) {
  const source = imageDataBytes(sourceImageData, width, height), output = new Uint8ClampedArray(source);
  if (!Array.isArray(maskEffects)) throw new Error('マスク加工一覧が不正');
  const { list, assetMap } = effectList(maskEffects, maskAssets, draft);
  for (const effect of paintOrder([],list)) {
    const patch=maskEffectPatch(source,width,height,effect,assetMap.get(effect.assetId));
    if(!patch)continue;
    for(let row=0;row<patch.height;row++)for(let col=0;col<patch.width;col++){
      const index=row*patch.width+col;if(!patch.mask[index])continue;
      const destination=((patch.y+row)*width+patch.x+col)*4;
      output.set(patch.pixels.subarray(index*4,index*4+4),destination);
    }
  }
  return output;
}

/** Bbox-sized pixels and binary coverage, sampled from the original image. */
export function maskEffectPatch(sourceImageData,width,height,effect,asset) {
    if(effect.visible===false)return null;
    const source=imageDataBytes(sourceImageData,width,height);
    if (!['pixelate', 'blur', 'fill-black', 'fill-white'].includes(effect.effect)) throw new Error('マスク加工方式が不正');
    if (!Number.isSafeInteger(effect.marginPx ?? 0) || Math.abs(effect.marginPx ?? 0) > 100
        || !Number.isSafeInteger(effect.blockSize) || effect.blockSize < 1 || effect.blockSize > 200
        || !Number.isSafeInteger(effect.blurRadius) || effect.blurRadius < 0 || effect.blurRadius > 100) throw new Error('マスク加工の強度が範囲外');
    if (!asset) throw new Error(`マスク素材が見つからない: ${effect.assetId}`);
    let mask = transformMask(asset, effect, width, height);
    if (!mask.width || !mask.height) return null;
    mask = adjustMaskMargin(mask, effect.marginPx ?? 0, width, height);
    if (!mask.width || !mask.height) return null;
    const output=new Uint8ClampedArray(mask.width*mask.height*4);
    const pixelatedTiles = effect.effect === 'pixelate' ? new Map() : null;
    const radiusZeroBlur = effect.effect === 'blur' && effect.blurRadius === 0;
    const blurred = effect.effect === 'blur' && !radiusZeroBlur ? blurRegion(source, width, height, mask, effect.blurRadius) : null;
    for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) {
      if (!mask.data[row * mask.width + col]) continue;
      const x = mask.x + col, y = mask.y + row, destination = (row * mask.width + col) * 4;
      if (effect.effect === 'fill-black' || effect.effect === 'fill-white') {
        const channel = effect.effect === 'fill-black' ? 0 : 255;
        output[destination] = output[destination + 1] = output[destination + 2] = channel; output[destination + 3] = 255;
      } else if (effect.effect === 'pixelate') {
        const blockSize = effect.blockSize;
        const tileX = Math.floor(x / blockSize) * blockSize, tileY = Math.floor(y / blockSize) * blockSize, key = `${tileX},${tileY}`;
        let average = pixelatedTiles.get(key);
        if (!average) { average = averageTile(source, width, height, x, y, blockSize); pixelatedTiles.set(key, average); }
        output.set(average, destination);
      } else if (radiusZeroBlur) {
        const sourceOffset=(y*width+x)*4;
        output.set(source.subarray(sourceOffset, sourceOffset + 4), destination);
      } else {
        const sourceOffset = ((y - blurred.y) * blurred.width + x) * 4;
        output[destination] = blurred.data[sourceOffset]; output[destination + 1] = blurred.data[sourceOffset + 1];
        output[destination + 2] = blurred.data[sourceOffset + 2]; output[destination + 3] = blurred.data[sourceOffset + 3];
      }
    }
  return {x:mask.x,y:mask.y,width:mask.width,height:mask.height,mask:mask.data,pixels:output};
}

export { blurRegion as blurMaskRegion };
