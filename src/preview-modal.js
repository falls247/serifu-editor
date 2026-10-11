import { draw, clamp } from './renderer.js';
import { imageSize } from './image-edit.js';
import { fontLoadQueries } from './fonts.js';

const dialog = document.getElementById('fullPreview');
const canvas = document.getElementById('fullPreviewCanvas');
const viewport = document.getElementById('fullPreviewViewport');
const slider = document.getElementById('fullPreviewZoom');
const output = document.getElementById('fullPreviewZoomValue');
const message = document.getElementById('fullPreviewStatus');
let preview = null, generation = 0, previousOverflow = '', opener = null;

export const previewIsOpen = () => dialog.open;

function zoomTo(value, anchor = null) {
  if (!preview) return;
  const next = clamp(Math.round(value / 10) * 10, 10, 200), before = canvas.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  const point = anchor ?? { x: bounds.left + viewport.clientWidth / 2, y: bounds.top + viewport.clientHeight / 2 };
  const source = { x: (point.x - before.left) / (preview.zoom / 100), y: (point.y - before.top) / (preview.zoom / 100) };
  preview.zoom = next;
  canvas.style.width = `${preview.width * next / 100}px`; canvas.style.height = `${preview.height * next / 100}px`;
  slider.value = String(next); output.value = `${next}%`;
  document.getElementById('fullPreviewZoomOut').disabled = next === 10;
  document.getElementById('fullPreviewZoomIn').disabled = next === 200;
  const after = canvas.getBoundingClientRect();
  viewport.scrollLeft += after.left + source.x * next / 100 - point.x;
  viewport.scrollTop += after.top + source.y * next / 100 - point.y;
}

export async function openFullPreview(page, trigger) {
  const token = ++generation, size = imageSize(page.img.width, page.img.height, page.imageEdit);
  const snapshot = { src: page.src, layers: structuredClone(page.layers), imageEdit: structuredClone(page.imageEdit) };
  preview = { ...size, zoom: 100 }; opener = trigger;
  document.getElementById('fullPreviewTitle').textContent = page.name;
  document.getElementById('fullPreviewSize').textContent = `${size.width} × ${size.height} px`;
  message.textContent = 'プレビューを準備中…'; canvas.hidden = true;
  previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  dialog.showModal(); canvas.width = size.width; canvas.height = size.height;
  zoomTo(100); viewport.scrollLeft = 0; viewport.scrollTop = 0;
  const image = new Image();
  try {
    image.src = snapshot.src;
    await Promise.all([image.decode(), ...new Set(snapshot.layers.flatMap(fontLoadQueries))].map(job =>
      typeof job === 'string' ? document.fonts?.load(job) : job));
    if (token !== generation || !dialog.open) return;
    draw(canvas.getContext('2d'), image, snapshot.layers, null, 1, 1, snapshot.imageEdit);
    canvas.hidden = false; message.textContent = ''; viewport.scrollLeft = 0; viewport.scrollTop = 0;
  } catch (error) {
    if (token === generation && dialog.open) message.textContent = `プレビューを表示できなかった: ${error.message}`;
  } finally { image.src = ''; }
}

slider.addEventListener('input', () => zoomTo(Number(slider.value)));
document.getElementById('fullPreviewZoomOut').onclick = () => zoomTo(preview.zoom - 10);
document.getElementById('fullPreviewZoomIn').onclick = () => zoomTo(preview.zoom + 10);
document.getElementById('fullPreviewActual').onclick = () => zoomTo(100);
document.getElementById('fullPreviewClose').onclick = () => dialog.close();
dialog.addEventListener('wheel', event => {
  if (!event.ctrlKey || !preview) return;
  event.preventDefault(); event.stopPropagation();
  if (event.deltaY) zoomTo(preview.zoom + (event.deltaY < 0 ? 10 : -10), viewport.contains(event.target) ? { x: event.clientX, y: event.clientY } : null);
}, { passive: false });
dialog.addEventListener('close', () => {
  generation++; preview = null; canvas.width = canvas.height = 1; canvas.hidden = true;
  document.body.style.overflow = previousOverflow; opener?.isConnected && opener.focus({ preventScroll: true }); opener = null;
});
