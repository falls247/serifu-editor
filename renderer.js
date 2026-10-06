export const DIALOGUE_COLORS = Object.freeze({ male: '#111111', female: '#ef4b91' });
export const EFFECTS = Object.freeze({ impact: 'ドン！／立体', burst: 'バン！／集中線', speed: 'シュッ／スピード', rumble: 'ゴゴゴ／震え' });
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function newLayer(kind, width, height, speaker = 'male') {
  return {
    id: crypto.randomUUID(), kind, speaker,
    text: kind === 'sfx' ? 'ドーン！' : '',
    x: width * .5, y: height * .4,
    w: clamp(width * (kind === 'sfx' ? .55 : .42), 30, 30000), h: clamp(height * .25, 30, 30000),
    size: clamp(Math.round(width * (kind === 'sfx' ? .09 : .04)), 16, 500),
    rotation: kind === 'sfx' ? -12 : 0, outline: clamp(Math.round(width * .006), 2, 80),
    vertical: false, color: '#111111', effect: 'impact',
  };
}

export function localPoint(layer, x, y) {
  const angle = -layer.rotation * Math.PI / 180;
  const dx = x - layer.x, dy = y - layer.y;
  return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
}

export function hit(layer, x, y) {
  const p = localPoint(layer, x, y);
  return Math.abs(p.x) <= layer.w / 2 && Math.abs(p.y) <= layer.h / 2;
}

export function handleAt(layer, x, y, scale = 1) {
  const p = localPoint(layer, x, y), radius = 12 / scale;
  if (Math.hypot(p.x - layer.w / 2, p.y - layer.h / 2) <= radius) return 'resize';
  if (Math.hypot(p.x, p.y + layer.h / 2 + 24 / scale) <= radius) return 'rotate';
  return null;
}

function textRows(ctx, text, maxWidth) {
  const rows = [];
  for (const line of text.split('\n')) {
    let row = '';
    for (const char of line) {
      if (row && ctx.measureText(row + char).width > maxWidth) { rows.push(row); row = ''; }
      row += char;
    }
    rows.push(row);
  }
  return rows;
}

function ornament(ctx, l) {
  if (l.kind !== 'sfx') return;
  const w = l.w, h = l.h;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111111';
  if (l.effect === 'burst') {
    // Deterministic tapered strokes: the exported image matches the live preview.
    for (let i = 0; i < 18; i++) {
      const a = i * Math.PI * 2 / 18;
      const inner = .38 + (i % 3) * .03, outer = .5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * w * inner, Math.sin(a) * h * inner);
      ctx.lineTo(Math.cos(a - .015) * w * outer, Math.sin(a - .015) * h * outer);
      ctx.lineTo(Math.cos(a + .015) * w * outer, Math.sin(a + .015) * h * outer);
      ctx.closePath(); ctx.fillStyle = '#111111'; ctx.fill();
    }
  } else if (l.effect === 'speed') {
    for (let i = 0; i < 5; i++) {
      const y = (i - 2) * h * .14;
      ctx.beginPath(); ctx.moveTo(-w * .49, y + h * .07); ctx.lineTo(-w * (.13 + (i % 2) * .08), y);
      ctx.lineWidth = l.size * (.018 + (i % 3) * .008); ctx.stroke();
    }
  } else if (l.effect === 'rumble') {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const x = side * (w * .45 + (i % 2) * l.size * .05), y = (i - 3) * h * .1;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = Math.max(1, l.size * .025); ctx.stroke();
    }
  }
  ctx.restore();
}

function paintText(ctx, l) {
  const sfx = l.kind === 'sfx', color = sfx ? l.color : DIALOGUE_COLORS[l.speaker];
  const family = sfx && l.effect === 'rumble'
    ? '"Yu Mincho", "Hiragino Mincho ProN", serif'
    : '"Noto Sans JP", "Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif';
  ctx.font = `${sfx ? 'italic 900' : '700'} ${l.size}px ${family}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const outline = l.outline;
  const paint = (text, x, y) => {
    if (sfx) {
      // Extruded black offset and a white keyline give Japanese glyphs a comic silhouette.
      const depth = l.effect === 'impact' || l.effect === 'burst' ? l.size * .07 : l.size * .025;
      ctx.strokeStyle = '#111111'; ctx.fillStyle = '#111111'; ctx.lineWidth = outline * 2 + l.size * .04;
      ctx.strokeText(text, x + depth, y + depth); ctx.fillText(text, x + depth, y + depth);
    }
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = outline * 2; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  };
  ctx.save();
  if (sfx && !l.vertical) ctx.transform(1, 0, l.effect === 'speed' ? -.22 : -.12, 1, 0, 0);
  if (l.vertical) {
    const columns = [], count = Math.max(1, Math.floor(l.h * .82 / (l.size * 1.15)));
    for (const line of l.text.split('\n')) {
      const chars = Array.from(line);
      if (!chars.length) columns.push([]);
      for (let i = 0; i < chars.length; i += count) columns.push(chars.slice(i, i + count));
    }
    columns.forEach((col, i) => col.forEach((char, j) => paint(char, ((columns.length - 1) / 2 - i) * l.size * 1.2, (j - (col.length - 1) / 2) * l.size * 1.15)));
  } else {
    const rows = textRows(ctx, l.text, l.w * (sfx ? .8 : .94));
    rows.forEach((text, row) => {
      const y = (row - (rows.length - 1) / 2) * l.size * 1.28;
      if (!sfx || l.effect === 'speed') { paint(text, 0, y); return; }
      const chars = Array.from(text), widths = chars.map(char => ctx.measureText(char).width);
      let x = -widths.reduce((a, b) => a + b, 0) / 2;
      chars.forEach((char, i) => {
        ctx.save();
        const bump = l.effect === 'rumble' ? Math.sin(i * 2.2) * l.size * .045 : (i % 2 ? 1 : -1) * l.size * .02;
        ctx.translate(x + widths[i] / 2, y + bump);
        ctx.rotate((l.effect === 'rumble' ? (i % 2 ? 3 : -3) : (i % 2 ? -2 : 2)) * Math.PI / 180);
        if (l.effect === 'impact' || l.effect === 'burst') ctx.scale(1, 1 + (i % 2) * .09);
        paint(char, 0, 0); ctx.restore(); x += widths[i];
      });
    });
  }
  ctx.restore();
}

export function draw(ctx, img, layers, selected = null, scale = 1, selectionScale = scale) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
  for (const l of layers) {
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.rotation * Math.PI / 180);
    ornament(ctx, l); paintText(ctx, l);
    if (l.id === selected) {
      ctx.strokeStyle = '#b2dd78'; ctx.fillStyle = '#c8ee91'; ctx.lineWidth = 1.5 / selectionScale;
      ctx.setLineDash([5 / selectionScale, 4 / selectionScale]); ctx.strokeRect(-l.w / 2, -l.h / 2, l.w, l.h); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, -l.h / 2); ctx.lineTo(0, -l.h / 2 - 24 / selectionScale); ctx.stroke();
      ctx.fillRect(l.w / 2 - 5 / selectionScale, l.h / 2 - 5 / selectionScale, 10 / selectionScale, 10 / selectionScale);
      ctx.beginPath(); ctx.arc(0, -l.h / 2 - 24 / selectionScale, 5 / selectionScale, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

export function exportName(name, index) {
  return `${String(index + 1).padStart(3, '0')}_${name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.png`;
}
