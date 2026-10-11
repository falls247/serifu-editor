import { clamp } from './renderer.js';
import { imageSize } from './image-edit.js';
import { getPreviewCanvas, releasePreviewCanvas } from './preview-render.js';

const dialog = document.getElementById('fullPreview');
const canvas = document.getElementById('fullPreviewCanvas');
const viewport = document.getElementById('fullPreviewViewport');
const slider = document.getElementById('fullPreviewZoom');
const output = document.getElementById('fullPreviewZoomValue');
const message = document.getElementById('fullPreviewStatus');
let preview = null, generation = 0, previousOverflow = '', previousGutter = '', opener = null;
let pan = null;

export const previewIsOpen = () => dialog.open;

function endPan(event) {
  if (!pan || (event && event.pointerId !== pan.pointerId)) return;
  const { pointerId } = pan; pan = null;
  viewport.classList.remove('is-panning');
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
}

function zoomTo(value, anchor = null) {
  if (!preview) return;
  endPan();
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
  endPan();
  const token = ++generation, size = imageSize(page.img.width, page.img.height, page.imageEdit);
  preview = { ...size, zoom: 100 }; opener = trigger;
  document.getElementById('fullPreviewTitle').textContent = page.name;
  document.getElementById('fullPreviewSize').textContent = `${size.width} × ${size.height} px`;
  message.textContent = 'プレビューを準備中…'; canvas.hidden = true;
  if (!dialog.open) {
    previousOverflow = document.body.style.overflow;
    previousGutter = document.documentElement.style.scrollbarGutter;
    if (window.innerWidth > document.documentElement.clientWidth) document.documentElement.style.scrollbarGutter = 'stable';
    document.body.style.overflow = 'hidden';
  }
  dialog.showModal();
  zoomTo(100); viewport.scrollLeft = 0; viewport.scrollTop = 0;
  try {
    const result = await getPreviewCanvas(page);
    if (!result || token !== generation || !dialog.open) return;
    canvas.hidden = false; message.textContent = ''; viewport.scrollLeft = 0; viewport.scrollTop = 0;
  } catch (error) {
    if (token === generation && dialog.open) message.textContent = `プレビューを表示できなかった: ${error.message}`;
  }
}

canvas.addEventListener('pointerdown', event => {
  if (!preview || !dialog.open || canvas.hidden || pan || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  viewport.classList.add('is-panning');
});
canvas.addEventListener('pointermove', event => {
  if (!pan || event.pointerId !== pan.pointerId) return;
  event.preventDefault();
  viewport.scrollLeft += pan.x - event.clientX;
  viewport.scrollTop += pan.y - event.clientY;
  pan.x = event.clientX; pan.y = event.clientY;
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, endPan);
canvas.addEventListener('dragstart', event => event.preventDefault());

slider.addEventListener('input', () => zoomTo(Number(slider.value)));
document.getElementById('fullPreviewZoomOut').onclick = () => zoomTo(preview.zoom - 10);
document.getElementById('fullPreviewZoomIn').onclick = () => zoomTo(preview.zoom + 10);
document.getElementById('fullPreviewActual').onclick = () => zoomTo(100);
document.getElementById('fullPreviewClose').onclick = () => dialog.close();
dialog.addEventListener('keydown', event => {
  const { key: pressed } = event;
  // Native undo can target the last edited background input even inside a dialog.
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(pressed.toLowerCase())) event.preventDefault();
});
dialog.addEventListener('wheel', event => {
  if (!event.ctrlKey || !preview) return;
  event.preventDefault(); event.stopPropagation();
  if (event.deltaY) zoomTo(preview.zoom + (event.deltaY < 0 ? 10 : -10), viewport.contains(event.target) ? { x: event.clientX, y: event.clientY } : null);
}, { passive: false });
dialog.addEventListener('close', () => {
  endPan();
  generation++; preview = null; canvas.hidden = true; releasePreviewCanvas();
  document.body.style.overflow = previousOverflow; document.documentElement.style.scrollbarGutter = previousGutter;
  opener?.isConnected && opener.focus({ preventScroll: true }); opener = null;
});
