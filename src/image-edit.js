// Image edits are rectangles in source pixels plus clockwise quarter turns.
export function normalizeImageEdit(input, width, height) {
  if (input == null) return null;
  const rotation = input.rotation ?? 0, crop = input.crop ?? { x: 0, y: 0, width, height };
  if (!input || typeof input !== 'object' || ![0, 90, 180, 270].includes(rotation) ||
      !crop || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(crop[key])) ||
      crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
      crop.x + crop.width > width || crop.y + crop.height > height) throw new Error('画像のクロップ・回転設定が不正');
  if (!rotation && !crop.x && !crop.y && crop.width === width && crop.height === height) return null;
  return { rotation, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } };
}

export function imageSize(width, height, edit) {
  const crop = edit?.crop ?? { width, height };
  return edit?.rotation % 180 ? { width: crop.height, height: crop.width } : { width: crop.width, height: crop.height };
}

export function imageMatrix(width, height, edit) {
  const { x, y, width: w, height: h } = edit?.crop ?? { x: 0, y: 0, width, height };
  switch (edit?.rotation ?? 0) {
    case 90: return [0, 1, -1, 0, y + h, -x];
    case 180: return [-1, 0, 0, -1, x + w, y + h];
    case 270: return [0, -1, 1, 0, -y, x + w];
    default: return [1, 0, 0, 1, -x, -y];
  }
}

export function imagePoint(point, width, height, edit, inverse = false) {
  const [a, b, c, d, e, f] = imageMatrix(width, height, edit);
  if (inverse) return { x: a * (point.x - e) + b * (point.y - f), y: c * (point.x - e) + d * (point.y - f) };
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function rotateImage(width, height, edit, degrees) {
  return normalizeImageEdit({ crop: edit?.crop, rotation: ((edit?.rotation ?? 0) + degrees + 360) % 360 }, width, height);
}

export function cropImage(width, height, edit, rect) {
  const size = imageSize(width, height, edit);
  normalizeImageEdit({ crop: rect }, size.width, size.height);
  const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }]
    .map(point => imagePoint(point, width, height, edit, true));
  return normalizeImageEdit({ rotation: edit?.rotation ?? 0, crop: {
    x: Math.min(...corners.map(p => p.x)), y: Math.min(...corners.map(p => p.y)),
    width: Math.abs(corners[1].x - corners[0].x), height: Math.abs(corners[1].y - corners[0].y),
  } }, width, height);
}

export function cropRectangle(start, end, width, height) {
  const bound = (value, max) => Math.max(0, Math.min(max, Math.round(value)));
  const left = bound(Math.min(start.x, end.x), width - 1), top = bound(Math.min(start.y, end.y), height - 1);
  return { x: left, y: top, width: Math.max(1, bound(Math.max(start.x, end.x), width) - left), height: Math.max(1, bound(Math.max(start.y, end.y), height) - top) };
}

// Handles and hit areas are fixed in displayed pixels, independent of preview zoom.
export function cropHandles(rect) {
  const { x, y, width, height } = rect;
  return [['nw', x, y], ['n', x + width / 2, y], ['ne', x + width, y],
    ['e', x + width, y + height / 2], ['se', x + width, y + height],
    ['s', x + width / 2, y + height], ['sw', x, y + height], ['w', x, y + height / 2]];
}

export function cropModeAt(rect, point, width, height, displayScale) {
  const radius = 8 / displayScale, edge = 5 / displayScale;
  const handle = cropHandles(rect).find(([, x, y]) => Math.abs(point.x - x) <= radius && Math.abs(point.y - y) <= radius);
  if (handle) return handle[0];
  const { x, y, width: w, height: h } = rect;
  if (point.x >= x && point.x <= x + w) {
    if (Math.abs(point.y - y) <= edge) return 'n';
    if (Math.abs(point.y - y - h) <= edge) return 's';
  }
  if (point.y >= y && point.y <= y + h) {
    if (Math.abs(point.x - x) <= edge) return 'w';
    if (Math.abs(point.x - x - w) <= edge) return 'e';
  }
  // Start with a full-image frame, whose interior can be dragged to select a new crop.
  if (!x && !y && w === width && h === height) return 'create';
  return point.x > x && point.x < x + w && point.y > y && point.y < y + h ? 'move' : 'create';
}

export function dragCropRectangle(rect, mode, start, end, width, height) {
  if (mode === 'create') return cropRectangle(start, end, width, height);
  const bound = (value, min, max) => Math.max(min, Math.min(max, value));
  const dx = Math.round(end.x - start.x), dy = Math.round(end.y - start.y);
  if (mode === 'move') return { ...rect, x: bound(rect.x + dx, 0, width - rect.width), y: bound(rect.y + dy, 0, height - rect.height) };
  let left = rect.x, top = rect.y, right = left + rect.width, bottom = top + rect.height;
  if (mode.includes('w')) left = bound(left + dx, 0, right - 1);
  if (mode.includes('e')) right = bound(right + dx, left + 1, width);
  if (mode.includes('n')) top = bound(top + dy, 0, bottom - 1);
  if (mode.includes('s')) bottom = bound(bottom + dy, top + 1, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
