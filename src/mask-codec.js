const MAX_MASK_PIXELS = 100_000_000;
const MAX_MASK_PAYLOAD_BYTES = 32 * 1024 * 1024;
const CODECS = new Set(['rle32le-v1', 'bitpack-lsb-v1']);

function assertDimension(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30000) throw new Error(`マスクの${name}が不正`);
}

function assertArea(width, height) {
  assertDimension(width, '幅');
  assertDimension(height, '高さ');
  const area = width * height;
  if (!Number.isSafeInteger(area) || area > MAX_MASK_PIXELS) throw new Error('マスクの画素数が上限を超える');
  return area;
}

function validateAssetMetadata(asset) {
  if (!asset || typeof asset !== 'object' || !CODECS.has(asset.codec)) throw new Error('マスクcodecが不正');
  assertDimension(asset.imageWidth, '画像幅'); assertDimension(asset.imageHeight, '画像高さ');
  const { x, y, width, height } = asset.bbox ?? {};
  const area = assertArea(width, height);
  if (![x, y].every(Number.isSafeInteger) || x < 0 || y < 0 || x + width > asset.imageWidth || y + height > asset.imageHeight) throw new Error('マスクbboxが画像範囲外');
  const packedLength = Math.ceil(area / 8);
  const maxEncodedLength = asset.codec === 'bitpack-lsb-v1' ? packedLength : Math.min(MAX_MASK_PAYLOAD_BYTES, 4 * (area + 1));
  if (asset.byteLength !== undefined && (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > maxEncodedLength)) {
    throw new Error('マスクbyteLengthが不正');
  }
  return { area, maxEncodedLength, packedLength };
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Uint8Array.from(value);
  throw new Error('マスクの圧縮データが不正');
}

function fromBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('マスクのBase64が不正');
  }
  if (typeof atob === 'function') {
    const binary = atob(value), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new Uint8Array(Math.floor(value.length * 3 / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  let out = 0;
  for (let i = 0; i < value.length; i += 4) {
    const chunk = (alphabet.indexOf(value[i]) << 18) | (alphabet.indexOf(value[i + 1]) << 12)
      | ((alphabet.indexOf(value[i + 2]) || 0) << 6) | (alphabet.indexOf(value[i + 3]) || 0);
    if (out < bytes.length) bytes[out++] = chunk >>> 16;
    if (out < bytes.length) bytes[out++] = chunk >>> 8 & 255;
    if (out < bytes.length) bytes[out++] = chunk & 255;
  }
  return bytes;
}

export function maskBytesToBase64(value) {
  const bytes = asBytes(value);
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], hasB = i + 1 < bytes.length, hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1] : 0, c = hasC ? bytes[i + 2] : 0;
    result += alphabet[a >>> 2] + alphabet[(a & 3) << 4 | b >>> 4]
      + (hasB ? alphabet[(b & 15) << 2 | c >>> 6] : '=') + (hasC ? alphabet[c & 63] : '=');
  }
  return result;
}

function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256を利用できない');
  return crypto.subtle.digest('SHA-256', bytes).then(digest =>
    [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
}

function packBits(bits) {
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) packed[i >> 3] |= 1 << (i & 7);
  return packed;
}

function encodeRle(bits) {
  const runs = [];
  let value = 0, length = 0;
  for (const bit of bits) {
    if (bit === value) length++;
    else { runs.push(length); value = bit; length = 1; }
  }
  runs.push(length);
  const bytes = new Uint8Array(runs.length * 4), view = new DataView(bytes.buffer);
  runs.forEach((run, index) => view.setUint32(index * 4, run, true));
  return bytes;
}

function decodeBits(asset, count, bytes) {
  if (asset.codec === 'bitpack-lsb-v1') {
    if (bytes.length !== Math.ceil(count / 8)) throw new Error('bitpack長が不正');
    const tail = count & 7;
    if (tail && (bytes.at(-1) & (0xff << tail))) throw new Error('bitpackの未使用bitが不正');
    const bits = new Uint8Array(count);
    for (let i = 0; i < count; i++) bits[i] = bytes[i >> 3] >> (i & 7) & 1;
    return bits;
  }
  if (asset.codec !== 'rle32le-v1' || !bytes.length || bytes.length % 4) throw new Error('RLE形式または長さが不正');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bits = new Uint8Array(count);
  let offset = 0, value = 0;
  for (let i = 0; i < bytes.length / 4; i++) {
    const run = view.getUint32(i * 4, true);
    if (run === 0 && i !== 0) throw new Error('RLEのゼロ長runが不正');
    if (run > count - offset) throw new Error('RLEのrun合計が上限を超える');
    if (value) bits.fill(1, offset, offset + run);
    offset += run; value ^= 1;
  }
  if (offset !== count) throw new Error('RLEのrun合計が不正');
  return bits;
}

function makeAsset({ id = crypto.randomUUID(), imageWidth, imageHeight, bbox, codec, data, decoded, sha256 }) {
  const asset = {
    id, imageWidth, imageHeight,
    bbox: Object.freeze({ x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }),
    codec, byteLength: data.byteLength, sha256, data, decoded,
  };
  return Object.freeze(asset);
}

export function decodeMask(asset, { maxPixels = MAX_MASK_PIXELS } = {}) {
  const { area } = validateAssetMetadata(asset);
  if (area > maxPixels) throw new Error('マスクの画素数が上限を超える');
  const bytes = asBytes(asset.data);
  if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength !== bytes.byteLength) throw new Error('マスクbyteLengthが不正');
  const decoded = decodeBits(asset, area, bytes);
  if (!decoded.includes(1)) throw new Error('空マスクは保存できない');
  const width = asset.bbox.width, height = asset.bbox.height;
  let top = false, bottom = false, left = false, right = false;
  for (let x = 0; x < width; x++) { top ||= !!decoded[x]; bottom ||= !!decoded[(height - 1) * width + x]; }
  for (let y = 0; y < height; y++) { left ||= !!decoded[y * width]; right ||= !!decoded[y * width + width - 1]; }
  if (!top || !bottom || !left || !right) throw new Error('マスクbboxがtightでない');
  return decoded;
}

export async function verifyMaskAsset(asset, { imageWidth, imageHeight, maxPixels = MAX_MASK_PIXELS } = {}) {
  const decoded = decodeMask(asset, { maxPixels });
  if (imageWidth !== undefined && asset.imageWidth !== imageWidth || imageHeight !== undefined && asset.imageHeight !== imageHeight) {
    throw new Error('マスク画像寸法が一致しない');
  }
  const checksum = await sha256Hex(asBytes(asset.data));
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) || checksum !== asset.sha256) throw new Error('マスクchecksumが一致しない');
  if (asset.decoded !== undefined && (!(asset.decoded instanceof Uint8Array) || asset.decoded.length !== decoded.length || asset.decoded.some((value, index) => value !== decoded[index]))) {
    throw new Error('展開済みマスクが圧縮データと一致しない');
  }
  return decoded;
}

export async function encodeMask(mask, width, height, { id = crypto.randomUUID(), imageWidth = width, imageHeight = height } = {}) {
  const area = assertArea(width, height);
  if (imageWidth !== width || imageHeight !== height) throw new Error('マスク寸法は元画像と一致させる');
  if (mask instanceof ArrayBuffer) mask = new Uint8Array(mask);
  else if (ArrayBuffer.isView(mask)) {
    if (mask.BYTES_PER_ELEMENT !== 1) throw new Error('マスク画素は1byte二値でなければならない');
    mask = new Uint8Array(mask.buffer, mask.byteOffset, mask.byteLength);
  } else if (Array.isArray(mask)) mask = Uint8Array.from(mask);
  if (!(mask instanceof Uint8Array || mask instanceof Uint8ClampedArray) || mask.length !== area) {
    throw new Error('マスク画素数が不正');
  }
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = mask[y * width + x];
    if (value !== 0 && value !== 1 && value !== 255) throw new Error('マスクは二値でなければならない');
    if (value) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < minX) throw new Error('空マスクは保存できない');
  const bbox = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const decoded = new Uint8Array(bbox.width * bbox.height);
  for (let y = 0; y < bbox.height; y++) for (let x = 0; x < bbox.width; x++) decoded[y * bbox.width + x] = mask[(y + minY) * width + x + minX] ? 1 : 0;
  const packed = packBits(decoded), rle = encodeRle(decoded), useRle = rle.length < packed.length;
  const data = useRle ? rle : packed, codec = useRle ? 'rle32le-v1' : 'bitpack-lsb-v1';
  const sha256 = await sha256Hex(data);
  return makeAsset({ id, imageWidth, imageHeight, bbox, codec, data, decoded, sha256 });
}

export async function assetFromEncoded(input) {
  if (!input || typeof input !== 'object') throw new Error('マスクassetが不正');
  const { maxEncodedLength } = validateAssetMetadata(input);
  if (input.dataBase64 !== undefined) {
    if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(maxEncodedLength / 3) * 4) throw new Error('マスクBase64が上限を超える');
  }
  const data = input.data !== undefined ? asBytes(input.data) : fromBase64(input.dataBase64);
  const asset = {
    id: input.id || crypto.randomUUID(), imageWidth: input.imageWidth, imageHeight: input.imageHeight,
    bbox: input.bbox, codec: input.codec, byteLength: input.byteLength ?? data.byteLength,
    sha256: input.sha256, data,
  };
  const decoded = await verifyMaskAsset(asset);
  return makeAsset({ ...asset, decoded });
}

export function maskAssetMetadata(asset) {
  return {
    id: asset.id, imageWidth: asset.imageWidth, imageHeight: asset.imageHeight,
    bbox: { ...asset.bbox }, codec: asset.codec, byteLength: asset.byteLength, sha256: asset.sha256,
  };
}

export function maxMaskPayloadBytes(metadata) {
  return validateAssetMetadata(metadata).maxEncodedLength;
}

export const MAX_MASK_PIXELS_LIMIT = MAX_MASK_PIXELS;
