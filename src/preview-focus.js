export const PREVIEW_FOCUS_MIN_ZOOM = 1;
export const PREVIEW_FOCUS_MAX_ZOOM = 5000;

export function normalizePreviewFocusZoom(value) {
  if (typeof value === 'string' && !value.trim()) return null;
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return null;
  return Math.max(PREVIEW_FOCUS_MIN_ZOOM, Math.min(PREVIEW_FOCUS_MAX_ZOOM, zoom));
}

export function previewFocusScale(fitWidth, imageWidth, zoomPercent) {
  if (!(fitWidth > 0) || !(imageWidth > 0)) return 1;
  return imageWidth * (zoomPercent / 100) / fitWidth;
}

export function previewFocusPanForPoint(frame, point, zoomPercent) {
  const zoom = zoomPercent / 100;
  return { x: frame.width / 2 - point.x * zoom, y: frame.height / 2 - point.y * zoom };
}

export function previewFocusPointAtCenter(frame, pan, zoomPercent) {
  const zoom = zoomPercent / 100;
  return { x: (frame.width / 2 - pan.x) / zoom, y: (frame.height / 2 - pan.y) / zoom };
}

export function previewFocusPointFromClient(client, canvasRect, imageSize) {
  return {
    x: (client.x - canvasRect.left) * imageSize.width / canvasRect.width,
    y: (client.y - canvasRect.top) * imageSize.height / canvasRect.height,
  };
}

export function previewFocusPanForAnchor(anchor, point, zoomPercent) {
  const zoom = zoomPercent / 100;
  return { x: anchor.x - point.x * zoom, y: anchor.y - point.y * zoom };
}
