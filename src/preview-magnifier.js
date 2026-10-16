import { clamp, sfxScene } from './renderer.js';
import { imagePoint, uncroppedImageEdit } from './image-edit.js';
import { getPreviewCanvas, releasePreviewCanvas } from './preview-render.js';

let lens = null;

function sfxFocus(page) {
  const layer = page.layers.find(layer => layer.id === page.selectedId);
  if (layer?.kind !== 'sfx') return null;
  let point = { x: 0, y: 0 };
  if (layer.lettering?.enabled) {
    const scene = sfxScene(page.canvas.getContext('2d'), layer), mode = page.glyphEdit;
    const indices = new Set(mode?.id === layer.id ? mode.indices ?? [mode.selected] : []);
    const chosen = scene.items.filter(item => item.members.some(index => indices.has(index)) ||
      mode?.id === layer.id && item.type === 'stroke' && mode.strokeRuns?.includes(item.stroke.runStart));
    const items = chosen.length ? chosen : scene.items;
    if (items.length) point = {
      x: (Math.min(...items.map(item => item.bounds.minX)) + Math.max(...items.map(item => item.bounds.maxX))) / 2,
      y: (Math.min(...items.map(item => item.bounds.minY)) + Math.max(...items.map(item => item.bounds.maxY))) / 2,
    };
  }
  const angle = layer.rotation * Math.PI / 180;
  return imagePoint({ x: layer.x + point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: layer.y + point.x * Math.sin(angle) + point.y * Math.cos(angle) }, page.img.width, page.img.height,
    page.cropDraft ? uncroppedImageEdit(page.img.width, page.img.height, page.imageEdit) : page.imageEdit);
}

function place(current) {
  const width = current.frame.clientWidth, height = current.frame.clientHeight;
  current.width = clamp(current.width, Math.min(160, width), width);
  current.height = clamp(current.height, Math.min(100, height), height);
  current.x = clamp(current.x, 0, width - current.width);
  current.y = clamp(current.y, 0, height - current.height);
  if (width > current.width) current.panX = current.x / (width - current.width);
  if (height > current.height) current.panY = current.y / (height - current.height);
  current.panX = clamp(current.panX, 0, 1); current.panY = clamp(current.panY, 0, 1);
  Object.assign(current.element.style, { left: `${current.x}px`, top: `${current.y}px`,
    width: `${current.width}px`, height: `${current.height}px` });
  paint(current);
}

function paint(current) {
  if (!current.source || current !== lens) return;
  const { canvas, source } = current, width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  // Map the complete window travel to the complete original-image travel.
  const x = Math.round(source.width > width ? (source.width - width) * current.panX : (source.width - width) / 2);
  const y = Math.round(source.height > height ? (source.height - height) * current.panY : (source.height - height) / 2);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, -x, -y);
  canvas.dataset.sourceX = String(x); canvas.dataset.sourceY = String(y);
}

async function render(current) {
  const token = ++current.generation;
  current.element.setAttribute('aria-busy', 'true');
  try {
    const page = current.page;
    const source = await getPreviewCanvas(page.cropDraft
      ? { ...page, imageEdit: uncroppedImageEdit(page.img.width, page.img.height, page.imageEdit) } : page);
    if (!source || lens !== current || token !== current.generation) return;
    current.source = source; current.message.textContent = '';
    if (current.focusPoint) {
      const { canvas, frame } = current;
      current.panX = clamp((current.focusPoint.x - canvas.clientWidth / 2) / Math.max(1, source.width - canvas.clientWidth), 0, 1);
      current.panY = clamp((current.focusPoint.y - canvas.clientHeight / 2) / Math.max(1, source.height - canvas.clientHeight), 0, 1);
      current.x = current.panX * Math.max(0, frame.clientWidth - current.width);
      current.y = current.panY * Math.max(0, frame.clientHeight - current.height);
      current.focusPoint = null;
    }
    place(current);
  } catch (error) {
    if (lens === current && token === current.generation) current.message.textContent = `表示できなかった: ${error.message}`;
  } finally {
    if (lens === current && token === current.generation) current.element.setAttribute('aria-busy', 'false');
  }
}

export function closeMagnifier(page = null, focus = false) {
  if (!lens || page && lens.page !== page) return;
  const current = lens; lens = null;
  clearTimeout(current.timer); current.observer.disconnect(); current.element.remove();
  current.canvas.width = current.canvas.height = 1;
  current.trigger.setAttribute('aria-pressed', 'false');
  if (focus && current.trigger.isConnected) current.trigger.focus({ preventScroll: true });
  releasePreviewCanvas();
}

export function refreshMagnifier(page) {
  if (lens?.page !== page) return;
  clearTimeout(lens.timer);
  const current = lens;
  current.timer = setTimeout(() => { if (lens === current) void render(current); }, 80);
}

export function toggleMagnifier(page, trigger) {
  if (lens?.page === page) { closeMagnifier(page, true); return; }
  closeMagnifier();
  const frame = page.row.querySelector('.preview-frame'), element = document.createElement('div');
  element.className = 'preview-magnifier'; element.tabIndex = 0;
  element.setAttribute('role', 'region'); element.setAttribute('aria-label', 'ドラッグで移動できる等倍プレビュー');
  element.innerHTML = '<div class="magnifier-header"><span>100% <span class="magnifier-hint">ドラッグで移動</span></span><button type="button" class="magnifier-close" aria-label="拡大鏡を閉じる">×</button></div><canvas class="magnifier-canvas" aria-label="編集結果の等倍表示"></canvas><span class="magnifier-status" role="status">準備中…</span><button type="button" class="magnifier-resize" aria-label="拡大鏡のサイズを調整" title="ドラッグでサイズ調整"></button>';
  frame.append(element);
  const current = lens = { page, trigger, frame, element, canvas: element.querySelector('canvas'),
    message: element.querySelector('.magnifier-status'), width: Math.min(280, frame.clientWidth - 24),
    height: Math.min(220, frame.clientHeight - 24), x: 12, y: 12, panX: .5, panY: .5, generation: 0,
    focusPoint: sfxFocus(page) };
  trigger.setAttribute('aria-pressed', 'true');
  const resize = element.querySelector('.magnifier-resize');
  element.querySelector('.magnifier-close').onclick = () => closeMagnifier(page, true);
  element.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('.magnifier-close')) return;
    event.preventDefault(); event.stopPropagation(); element.focus({ preventScroll: true });
    current.drag = { id: event.pointerId, resize: event.target === resize, x: event.clientX, y: event.clientY,
      left: current.x, top: current.y, width: current.width, height: current.height, panX: current.panX, panY: current.panY };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove', event => {
    const drag = current.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (drag.resize) { current.width = drag.width + dx; current.height = drag.height + dy; }
    else {
      current.x = drag.left + dx; current.y = drag.top + dy;
      if (current.width >= current.frame.clientWidth) current.panX = drag.panX + dx / current.frame.clientWidth;
      if (current.height >= current.frame.clientHeight) current.panY = drag.panY + dy / current.frame.clientHeight;
    }
    place(current);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, event => {
    if (current.drag?.id !== event.pointerId) return;
    current.drag = null;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  });
  element.addEventListener('keydown', event => {
    event.stopPropagation();
    const { key: pressed } = event;
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(pressed.toLowerCase())) { event.preventDefault(); return; }
    if (pressed === 'Escape') { event.preventDefault(); closeMagnifier(page, true); return; }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[pressed];
    if (!direction || event.target.closest('.magnifier-close')) return;
    event.preventDefault(); const step = event.shiftKey ? 10 : 1;
    if (event.target === resize) { current.width += direction[0] * step; current.height += direction[1] * step; }
    else {
      current.x += direction[0] * step; current.y += direction[1] * step;
      if (current.width >= frame.clientWidth) current.panX += direction[0] * step / frame.clientWidth;
      if (current.height >= frame.clientHeight) current.panY += direction[1] * step / frame.clientHeight;
    }
    place(current);
  });
  current.observer = new ResizeObserver(() => place(current)); current.observer.observe(frame);
  place(current); element.focus({ preventScroll: true }); void render(current);
}
