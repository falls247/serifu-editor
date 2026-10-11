import { draw } from './renderer.js';
import { imageSize } from './image-edit.js';
import { fontLoadQueries } from './fonts.js';
import { exportKey } from './export-cache.js';

const canvas = document.getElementById('fullPreviewCanvas');
const RETAIN_BYTES = 64 * 1024 ** 2;
let entry = null, generation = 0, releaseTimer;
const fontVersions = new Map();
document.fonts?.addEventListener('loadingdone', event => {
  for (const font of event.fontfaces) fontVersions.set(font.family, (fontVersions.get(font.family) ?? 0) + 1);
});
const fontStamp = queries => queries.map(query => [query, fontVersions.get(query.split(' ').at(-1)) ?? 0]);

// One original-resolution surface shared by the modal and magnifier.
export function getPreviewCanvas(page) {
  clearTimeout(releaseTimer);
  const queries = [...new Set(page.layers.flatMap(fontLoadQueries))].filter(Boolean);
  const signature = `${page.src}:${exportKey(page, fontStamp(queries))}`;
  if (entry?.signature === signature) return entry.promise;
  const token = ++generation;
  const snapshot = { layers: structuredClone(page.layers), imageEdit: structuredClone(page.imageEdit),
    maskEffects: structuredClone(page.maskEffects ?? []), maskAssets: { ...page.maskAssets } };
  const original = page.img, size = imageSize(original.width, original.height, snapshot.imageEdit);
  const ownsImage = typeof original.decode !== 'function';
  const image = ownsImage ? new Image() : original;
  if (ownsImage) image.src = page.src;
  const pendingFonts = queries.filter(query => document.fonts && !document.fonts.check(query));
  const next = { signature, ready: false };
  entry = next;
  next.promise = (async () => {
    // The mounted page already owns the decoded original; avoid a second decode.
    await Promise.all([...(image.complete && image.naturalWidth ? [] : [image.decode()]),
      ...pendingFonts.map(query => document.fonts.load(query))]);
    if (token !== generation) return null;
    canvas.width = size.width; canvas.height = size.height;
    draw(canvas.getContext('2d'), image, snapshot.layers, null, 1, 1, snapshot.imageEdit, original,
      { maskEffects: snapshot.maskEffects, maskAssets: snapshot.maskAssets });
    next.ready = true;
    next.signature = `${page.src}:${exportKey({ ...page, ...snapshot }, fontStamp(queries))}`;
    return canvas;
  })().catch(error => {
    if (entry === next) entry = null;
    throw error;
  }).finally(() => { if (ownsImage) image.src = ''; });
  return next.promise;
}

export function releasePreviewCanvas() {
  clearTimeout(releaseTimer);
  const clear = () => { generation++; entry = null; canvas.width = canvas.height = 1; };
  if (!entry?.ready || canvas.width * canvas.height * 4 > RETAIN_BYTES) clear();
  else releaseTimer = setTimeout(clear, 30000);
}
