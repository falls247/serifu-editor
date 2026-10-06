import { newLayer, draw, hit, handleAt, localPoint, clamp, EFFECTS } from './renderer.js';
import { normalizeLayer, checkpoint, restore, duplicateLayer, swapText, copyToNext } from './model.js';
import { exportName } from './renderer.js';

const $ = id => document.getElementById(id);
let pages = [], activeId = null, busy = false, drag = null, changed = false;
const editing = new WeakSet();
const active = () => pages.find(p => p.id === activeId);
const selected = p => p.layers.find(l => l.id === p.selectedId);
const status = text => $('status').textContent = text;

function pageFrom(element) {
  return pages.find(p => p.id === element.closest('.image-row')?.dataset.pageId);
}

function createPage({ name, src, img, file = null, directory = null, layers = [], done = false }) {
  return { id: crypto.randomUUID(), name, src, img, file, directory, layers, done, selectedId: layers[0]?.id || null, undo: [], redo: [] };
}

function updateGlobal() {
  $('empty').hidden = pages.length > 0;
  $('count').textContent = `${pages.length} 枚`;
  $('progress').textContent = pages.length ? `確認済み ${pages.filter(p => p.done).length} / ${pages.length} 枚` : '画像ごとに編集内容を保持';
  $('save').disabled = !pages.length || busy;
  $('projectSave').disabled = !pages.length || busy;
  for (const id of ['open', 'files', 'projectLoad', 'demo']) $(id).disabled = busy;
  const index = pages.findIndex(p => p.id === activeId);
  $('previous').disabled = busy || index <= 0;
  $('next').disabled = busy || index < 0 || index >= pages.length - 1;
  $('jump').disabled = busy || !pages.length;
  if ($('jump').value !== activeId) $('jump').value = activeId || '';
  $('deck').inert = busy;
  pages.forEach((p, i) => {
    if (!p.row) return;
    p.row.classList.toggle('active', p.id === activeId);
    p.row.classList.toggle('done', p.done);
    p.row.querySelector('.page-number').textContent = String(i + 1).padStart(2, '0');
    p.row.querySelector('[data-action=complete]').textContent = p.done ? '✓ 確認済み・次へ ↓' : '編集完了・次へ ↓';
    p.row.querySelector('[data-action=undo]').disabled = !p.undo.length;
    p.row.querySelector('[data-action=redo]').disabled = !p.redo.length;
    const copy = p.row.querySelector('[data-action=copy-next]');
    if (copy) copy.disabled = !p.layers.length || i === pages.length - 1;
  });
}

function drawPage(p) {
  if (!p?.canvas) return;
  const scale = p.canvas.width / p.img.width;
  const displayScale = p.canvas.getBoundingClientRect().width / p.img.width || scale;
  draw(p.canvas.getContext('2d'), p.img, p.layers, p.id === activeId ? p.selectedId : null, scale, displayScale);
}

function sizePreview(p) {
  const frame = p.row.querySelector('.preview-frame');
  const width = Math.max(1, Math.min(frame.clientWidth - 2, 620 * p.img.width / p.img.height));
  p.canvas.style.width = `${width}px`;
  p.canvas.style.height = `${width * p.img.height / p.img.width}px`;
  drawPage(p);
}

function updateControls(p) {
  if (!p?.row) return;
  const l = selected(p), controls = p.row.querySelector('.position-controls');
  controls.disabled = !l;
  controls.querySelector('legend').textContent = l ? `${l.kind === 'sfx' ? '効果音' : l.speaker === 'female' ? '女性セリフ' : '男性セリフ'}：${l.text || '（未入力）'}` : '文字を選択して位置調整';
  for (const input of controls.querySelectorAll('[data-field]')) {
    if (input !== document.activeElement) input.value = l ? String(l[input.dataset.field]) : '';
  }
  for (const card of p.row.querySelectorAll('.layer-card')) card.classList.toggle('selected', card.dataset.layerId === p.selectedId);
}

function activate(p, id = p.selectedId, scroll = false) {
  const previous = active(); activeId = p.id; p.selectedId = id;
  if (previous && previous !== p) drawPage(previous);
  updateControls(p); drawPage(p); updateGlobal();
  if (scroll) p.row.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(action, text, title) {
  const b = element('button', '', text); b.dataset.action = action;
  if (title) b.title = title;
  return b;
}

function updateSwapOptions(p) {
  for (const card of p.row.querySelectorAll('.layer-card')) {
    const select = card.querySelector('[data-swap-target]'), old = select.value;
    select.replaceChildren();
    for (const other of p.layers.filter(l => l.id !== card.dataset.layerId)) {
      const option = element('option', '', `${other.kind === 'sfx' ? '✦' : other.speaker === 'female' ? '女性' : '男性'} ${other.text || '（未入力）'}`);
      option.value = other.id; select.append(option);
    }
    if ([...select.options].some(o => o.value === old)) select.value = old;
    select.disabled = p.layers.length < 2;
    card.querySelector('[data-action=swap]').disabled = p.layers.length < 2;
  }
}

function renderCards(p) {
  const container = p.row.querySelector('.layer-cards'); container.replaceChildren();
  p.row.querySelector('.no-layers').hidden = p.layers.length > 0;
  for (const l of p.layers) {
    const card = element('div', 'layer-card'); card.dataset.layerId = l.id; card.dataset.speaker = l.speaker;
    const header = element('div', 'card-header');
    header.append(element('span', 'kind-label', l.kind === 'sfx' ? '✦ 効果音' : l.speaker === 'female' ? '● 女性セリフ' : '● 男性セリフ'));
    const mini = element('div', 'card-mini-actions');
    mini.append(button('duplicate', '複製'), button('drop-layer', '×', 'この文字を削除')); header.append(mini); card.append(header);
    if (l.kind === 'dialogue') {
      const roles = element('div', 'role-switch');
      for (const [speaker, label] of [['male', '男性・黒'], ['female', '女性・ピンク']]) {
        const b = button(`speaker-${speaker}`, label); b.classList.toggle('chosen', l.speaker === speaker); roles.append(b);
      }
      card.append(roles);
    }
    const text = element('textarea'); text.dataset.field = 'text'; text.value = l.text; text.rows = 3;
    text.placeholder = l.kind === 'sfx' ? 'ドーン！' : 'セリフを入力';
    text.setAttribute('aria-label', l.kind === 'sfx' ? '効果音テキスト' : l.speaker === 'female' ? '女性セリフ' : '男性セリフ');
    card.append(text);
    if (l.kind === 'sfx') {
      const options = element('div', 'card-options'), label = element('label', '', '漫画エフェクト');
      const select = element('select'); select.dataset.field = 'effect';
      for (const [value, name] of Object.entries(EFFECTS)) { const o = element('option', '', name); o.value = value; select.append(o); }
      select.value = l.effect; label.append(select); options.append(label);
      const colorLabel = element('label', '', '文字色'), color = element('input');
      color.type = 'color'; color.dataset.field = 'color'; color.value = l.color; colorLabel.append(color); options.append(colorLabel); card.append(options);
    }
    const swap = element('div', 'swap-controls'), target = element('select'); target.dataset.swapTarget = '';
    target.setAttribute('aria-label', 'セリフを入れ替える相手'); swap.append(target, button('swap', 'セリフ交換')); card.append(swap);
    container.append(card);
  }
  updateSwapOptions(p); updateControls(p); updateGlobal();
}

function mountPage(p) {
  const row = $('pageTemplate').content.firstElementChild.cloneNode(true); row.dataset.pageId = p.id; p.row = row;
  row.querySelector('.page-name').textContent = p.name;
  row.querySelector('.dimensions').textContent = `${p.img.width} × ${p.img.height}`;
  const original = row.querySelector('.original'); original.src = p.src; original.alt = `元画像 ${p.name}`;
  row.querySelector('[data-action=delete]').disabled = !p.directory;
  row.querySelector('.source-note').textContent = p.directory ? '元ファイルは上書きしない。削除は確認後に完全削除。' : '元ファイルとの接続なし。元画像削除は無効。';
  const copy = button('copy-next', '文字を次の画像へ複製 →'); copy.className = 'copy-next'; row.querySelector('.dialogue-pane').append(copy);
  p.canvas = row.querySelector('canvas'); p.canvas.tabIndex = 0;
  const scale = Math.min(1, 1400 / Math.max(p.img.width, p.img.height));
  p.canvas.width = Math.max(1, Math.round(p.img.width * scale)); p.canvas.height = Math.max(1, Math.round(p.img.height * scale));
  $('deck').append(row); renderCards(p);
  p.resizeObserver = new ResizeObserver(() => sizePreview(p)); p.resizeObserver.observe(row.querySelector('.preview-frame'));
  connectCanvas(p); sizePreview(p);
}

function refreshJump() {
  $('jump').replaceChildren();
  pages.forEach((p, i) => { const option = element('option', '', `${i + 1}. ${p.name}`); option.value = p.id; $('jump').append(option); });
  updateGlobal();
}

function markChanged(p) {
  changed = true; p.done = false; updateGlobal();
}

function edit(p, fn, rebuild = true) {
  if (busy) return;
  checkpoint(p); fn(); markChanged(p);
  if (rebuild) renderCards(p);
  updateControls(p); drawPage(p);
}

$('deck').addEventListener('focusin', event => {
  if (busy) return;
  const p = pageFrom(event.target); if (!p) return;
  const id = event.target.closest('.layer-card')?.dataset.layerId;
  activate(p, id || p.selectedId);
});
$('deck').addEventListener('focusout', event => editing.delete(event.target));
$('deck').addEventListener('input', event => {
  if (busy) return;
  const input = event.target, field = input.dataset.field;
  if (!field) return;
  const p = pageFrom(input), id = input.closest('.layer-card')?.dataset.layerId || p.selectedId;
  const l = p.layers.find(item => item.id === id); if (!l) return;
  let value = input.value;
  const limits = { size: [8, 500], rotation: [-180, 180], w: [30, 30000], h: [30, 30000], outline: [1, 80] };
  if (['x', 'y', ...Object.keys(limits)].includes(field)) {
    if (value === '' || !Number.isFinite(Number(value))) return;
    value = Number(value);
    if (limits[field]) value = clamp(value, ...limits[field]);
  } else if (field === 'vertical') value = value === 'true';
  if (l[field] === value) return;
  if (!editing.has(input)) { checkpoint(p); editing.add(input); }
  l[field] = value; markChanged(p); drawPage(p); updateControls(p);
  if (field === 'text') updateSwapOptions(p);
});

$('deck').addEventListener('click', event => {
  if (busy) return;
  const p = pageFrom(event.target); if (!p) return;
  const card = event.target.closest('.layer-card'), cardId = card?.dataset.layerId;
  activate(p, cardId || p.selectedId);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const l = selected(p);
  if (action.startsWith('add-')) {
    const kind = action === 'add-sfx' ? 'sfx' : 'dialogue', speaker = action === 'add-female' ? 'female' : 'male';
    edit(p, () => {
      const layer = newLayer(kind, p.img.width, p.img.height, speaker);
      const offset = p.layers.length % 5; layer.y = p.img.height * (.3 + offset * .12);
      p.layers.push(layer); p.selectedId = layer.id;
    });
    p.row.querySelector(`.layer-card[data-layer-id="${p.selectedId}"] textarea`).focus({ preventScroll: true });
  } else if (action.startsWith('speaker-') && l?.kind === 'dialogue') {
    edit(p, () => l.speaker = action.slice(8));
  } else if (action === 'duplicate' && l) {
    edit(p, () => { const copy = duplicateLayer(l); p.layers.push(copy); p.selectedId = copy.id; });
  } else if (action === 'drop-layer' && l) {
    edit(p, () => { p.layers = p.layers.filter(item => item.id !== l.id); p.selectedId = p.layers[0]?.id || null; });
  } else if (action === 'swap' && l) {
    if (swapText(p, l.id, card.querySelector('[data-swap-target]').value)) { markChanged(p); renderCards(p); drawPage(p); }
  } else if (['backward', 'forward'].includes(action) && l) {
    edit(p, () => { const i = p.layers.indexOf(l), j = clamp(i + (action === 'forward' ? 1 : -1), 0, p.layers.length - 1); [p.layers[i], p.layers[j]] = [p.layers[j], p.layers[i]]; });
  } else if (action === 'center' && l) {
    edit(p, () => { l.x = p.img.width / 2; l.y = p.img.height / 2; }, false);
  } else if (['undo', 'redo'].includes(action)) {
    if (restore(p, action)) { changed = true; renderCards(p); drawPage(p); updateGlobal(); }
  } else if (action === 'complete') {
    p.done = true; changed = true; updateGlobal();
    const next = pages[pages.indexOf(p) + 1];
    if (next) activate(next, next.selectedId, true); else status('最後の画像まで確認済み。一括保存で書き出せる。');
  } else if (action === 'copy-next') {
    const next = pages[pages.indexOf(p) + 1];
    if (next && copyToNext(p, next, p.img.width, p.img.height, next.img.width, next.img.height)) {
      next.selectedId = next.layers.at(-1)?.id || null; markChanged(next); renderCards(next); drawPage(next); activate(next, next.selectedId, true);
    }
  } else if (action === 'remove') {
    if (p.layers.length && !confirm(`「${p.name}」を一覧から外す？ 未保存の編集は失われる。元ファイルは残る。`)) return;
    removePage(p);
  } else if (action === 'delete') {
    guard(async () => {
      if (!p.directory || !confirm(`元画像「${p.name}」をフォルダから完全に削除する？\nゴミ箱には移動しない。未保存の編集も失われる。`)) return;
      await p.directory.removeEntry(p.name); removePage(p); status('元画像を削除した');
    });
  }
});

function coords(event, p) {
  const rect = p.canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * p.img.width / rect.width, y: (event.clientY - rect.top) * p.img.height / rect.height };
}

function connectCanvas(p) {
  p.canvas.addEventListener('pointerdown', event => {
    if (busy) return;
    const pos = coords(event, p), scale = p.canvas.getBoundingClientRect().width / p.img.width;
    const current = selected(p), handle = current && handleAt(current, pos.x, pos.y, scale);
    const l = handle ? current : [...p.layers].reverse().find(item => hit(item, pos.x, pos.y));
    activate(p, l?.id || null); p.canvas.focus({ preventScroll: true });
    if (!l) return;
    checkpoint(p); drag = { page: p, id: event.pointerId, mode: handle || 'move', dx: pos.x - l.x, dy: pos.y - l.y, start: { ...l } };
    p.canvas.setPointerCapture(event.pointerId);
  });
  p.canvas.addEventListener('pointermove', event => {
    if (!drag || drag.page !== p || drag.id !== event.pointerId) return;
    const l = selected(p), pos = coords(event, p); if (!l) return;
    if (drag.mode === 'move') { l.x = Math.round(pos.x - drag.dx); l.y = Math.round(pos.y - drag.dy); }
    else if (drag.mode === 'resize') {
      const local = localPoint(l, pos.x, pos.y); l.w = clamp(Math.round(local.x * 2), 30, 30000); l.h = clamp(Math.round(local.y * 2), 30, 30000);
      l.size = clamp(Math.round(drag.start.size * Math.min(l.w / drag.start.w, l.h / drag.start.h)), 8, 500);
    } else {
      const angle = Math.atan2(pos.y - l.y, pos.x - l.x) * 180 / Math.PI + 90;
      l.rotation = Math.round(((angle + 180) % 360 + 360) % 360 - 180);
    }
    changed = true; p.done = false; drawPage(p); updateControls(p); updateGlobal();
  });
  const end = () => { if (drag?.page === p) { drag = null; updateControls(p); } };
  p.canvas.addEventListener('pointerup', end); p.canvas.addEventListener('pointercancel', end);
}

window.addEventListener('keydown', event => {
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || busy) return;
  const p = active(); if (!p) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (restore(p, event.shiftKey ? 'redo' : 'undo')) { changed = true; renderCards(p); drawPage(p); updateGlobal(); }
    return;
  }
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, direction = directions[event.key], l = selected(p);
  if (direction && l) { event.preventDefault(); edit(p, () => { const step = event.shiftKey ? 10 : 1; l.x += direction[0] * step; l.y += direction[1] * step; }, false); }
});

function removePage(p) {
  const index = pages.indexOf(p); pages.splice(index, 1); p.resizeObserver.disconnect(); p.row.remove();
  if (p.src.startsWith('blob:')) URL.revokeObjectURL(p.src);
  if (activeId === p.id) activeId = pages[Math.min(index, pages.length - 1)]?.id || null;
  changed = true; refreshJump(); if (active()) activate(active());
}

$('previous').onclick = () => { const p = pages[pages.indexOf(active()) - 1]; if (p) activate(p, p.selectedId, true); };
$('next').onclick = () => { const p = pages[pages.indexOf(active()) + 1]; if (p) activate(p, p.selectedId, true); };
$('jump').onchange = () => { const p = pages.find(p => p.id === $('jump').value); if (p) activate(p, p.selectedId, true); };

async function guard(fn) {
  if (busy) return; busy = true; updateGlobal();
  try { await fn(); } catch (error) { if (error.name !== 'AbortError') status(`処理できなかった: ${error.message}`); }
  finally { busy = false; updateGlobal(); }
}

function decode(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('画像を読み込めない')); img.src = src; });
}
function dataURL(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('元画像を読み込めない')); r.readAsDataURL(file); });
}
async function addFiles(entries) {
  let count = 0, failures = 0, first = null;
  for (const { file, directory = null } of entries) {
    if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(file.name)) continue;
    const src = URL.createObjectURL(file);
    try { const p = createPage({ name: file.name, src, img: await decode(src), file, directory }); pages.push(p); first ||= p; mountPage(p); count++; }
    catch { URL.revokeObjectURL(src); failures++; }
  }
  if (!activeId && first) activeId = first.id;
  changed ||= count > 0; refreshJump(); if (active()) activate(active());
  status(`${count} 枚を追加。画像ごとに下へスクロールして編集${failures ? ` · ${failures} 枚は読込失敗` : ''}`);
}
$('open').onclick = () => {
  if (!window.showDirectoryPicker) { $('folderInput').click(); status('フォルダ内の画像を読み込める。直接保存と元画像削除はPC版Chrome / Edgeが対象。'); return; }
  guard(async () => {
    const directory = await window.showDirectoryPicker({ mode: 'readwrite' }), entries = [];
    for await (const entry of directory.values()) if (entry.kind === 'file') entries.push({ file: await entry.getFile(), directory });
    entries.sort((a, b) => a.file.name.localeCompare(b.file.name, 'ja', { numeric: true })); await addFiles(entries);
  });
};
$('files').onclick = () => $('fileInput').click();
for (const id of ['fileInput', 'folderInput']) $(id).onchange = event => {
  const files = [...event.target.files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true })); event.target.value = '';
  guard(() => addFiles(files.map(file => ({ file }))));
};

async function write(directory, name, data) {
  const file = await directory.getFileHandle(name, { create: true }), writer = await file.createWritable();
  try { await writer.write(data); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
}
async function projectData(snapshot = pages) {
  return { version: 2, pages: await Promise.all(snapshot.map(async p => ({ name: p.name, src: p.src.startsWith('data:') ? p.src : await dataURL(p.file), layers: p.layers, done: p.done }))) };
}
function snapshotPages() { return pages.map(p => ({ ...p, layers: structuredClone(p.layers) })); }
function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('save').onclick = () => guard(async () => {
  if (!window.showDirectoryPicker) { status('新規フォルダへの直接一括保存はPC版Chrome / Edgeが対象。編集データを保存してPCへ持ち出せる。'); return; }
  const parent = await window.showDirectoryPicker({ mode: 'readwrite' });
  const folder = `serifu_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}`;
  const directory = await parent.getDirectoryHandle(folder, { create: true }), snapshot = snapshotPages();
  let completed = 0;
  try {
    for (const [i, p] of snapshot.entries()) {
      status(`保存中 ${i + 1} / ${snapshot.length} 枚`);
      const canvas = document.createElement('canvas'); canvas.width = p.img.width; canvas.height = p.img.height;
      draw(canvas.getContext('2d'), p.img, p.layers);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('PNG生成に失敗');
      await write(directory, exportName(p.name, i), blob); completed++;
      canvas.width = 1; canvas.height = 1;
    }
    await write(directory, 'serifu-project.json', JSON.stringify(await projectData(snapshot)));
    changed = false; status(`${snapshot.length} 枚と編集データを「${folder}」へ保存した`);
  } catch (error) { throw new Error(`${folder} 内に ${completed} 枚保存済み。${error.message}`); }
});
$('projectSave').onclick = () => guard(async () => {
  if (!pages.length) return;
  download(new Blob([JSON.stringify(await projectData(snapshotPages()))], { type: 'application/json' }), 'serifu-project.json');
  status('画像・セリフ・効果音・位置を編集データに保存した');
});
$('projectLoad').onclick = () => $('projectInput').click();
$('projectInput').onchange = event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  guard(async () => {
    const data = JSON.parse(await file.text());
    if (![1, 2].includes(data.version) || !Array.isArray(data.pages) || !data.pages.length) throw new Error('未対応または空の編集データ');
    const loaded = [];
    for (const p of data.pages) {
      if (typeof p.name !== 'string' || typeof p.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(p.src) || !Array.isArray(p.layers)) throw new Error('画像データが不正');
      loaded.push(createPage({ name: p.name, src: p.src, img: await decode(p.src), layers: p.layers.map(l => normalizeLayer(l, data.version)), done: p.done === true }));
    }
    pages.push(...loaded); for (const p of loaded) mountPage(p);
    changed = true; refreshJump(); activate(loaded[0], loaded[0].selectedId, true);
    status(data.version === 1 ? '旧データを追加。吹き出しは白縁の男性セリフへ変換した。' : '編集データを追加。元ファイルとの接続がないため元画像削除は無効。');
  });
};

$('demo').onclick = () => guard(async () => {
  const first = pages.length;
  for (let i = 0; i < 3; i++) {
    const c = document.createElement('canvas'); c.width = 1000; c.height = 750; const ctx = c.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 1000, 750);
    gradient.addColorStop(0, ['#709d94', '#a688ac', '#7898b5'][i]); gradient.addColorStop(1, ['#edc6a0', '#e9bfa1', '#b6d9c7'][i]);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1000, 750);
    ctx.fillStyle = '#314e49'; ctx.beginPath(); ctx.moveTo(0, 650); ctx.lineTo(300, 300); ctx.lineTo(650, 750); ctx.lineTo(0, 750); ctx.fill();
    ctx.fillStyle = '#536c64'; ctx.beginPath(); ctx.moveTo(340, 750); ctx.lineTo(760, 340); ctx.lineTo(1000, 650); ctx.lineTo(1000, 750); ctx.fill();
    ctx.fillStyle = '#ffebbd'; ctx.beginPath(); ctx.arc(790, 160, 66, 0, Math.PI * 2); ctx.fill();
    const male = newLayer('dialogue', 1000, 750, 'male'); male.x = 300; male.y = 170; male.text = ['さあ、出発しよう。', 'あの山の向こうへ。', 'ここから始まるんだ。'][i];
    const female = newLayer('dialogue', 1000, 750, 'female'); female.x = 650; female.y = 280; female.text = ['うん、楽しみ！', '景色がきれい！', '続きも見てみよう。'][i];
    const sfx = newLayer('sfx', 1000, 750); sfx.x = 580; sfx.y = 555; sfx.effect = ['burst', 'speed', 'rumble'][i]; sfx.text = ['ドーン！', 'シュッ', 'ゴゴゴ…'][i];
    const src = c.toDataURL(), p = createPage({ name: `sample-${i + 1}.png`, src, img: await decode(src), layers: [male, female, sfx] });
    pages.push(p); mountPage(p);
  }
  refreshJump(); activate(pages[first], pages[first].selectedId, true); changed = true;
  status('3枚のサンプルを追加。中央でセリフを編集し、右で位置を調整。');
});
window.addEventListener('beforeunload', event => { if (changed) { event.preventDefault(); event.returnValue = ''; } });
updateGlobal();
