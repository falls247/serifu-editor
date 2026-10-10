import { newLayer, draw, hit, handleAt, localPoint, clamp, EFFECTS, WARP_CHOICES, clearGlyphCache, paintOrder } from './renderer.js';
import { BALLOON_LIMITS } from './balloons.js';
import { CAPTION_LIMITS, CAPTION_ALIGNMENTS, captionLayout } from './captions.js';
import { PROJECT_VERSION, normalizeLayer, checkpoint, restore, duplicateLayer, copySelection, pasteSelection, copyLayers, cutLayers, pasteLayers, swapText, copyToNext, EFFECT_LIMITS, THICKNESS_LIMIT } from './model.js';
import { exportName } from './renderer.js';
import { pageExportName, textExport } from './export.js';
import { PREFS_KEY, defaultPreferences, normalizePreferences, createPreset, applyPreset } from './presets.js';
import { getDraftMeta, getDraftImages, saveDraft as writeDraft, clearDraft as forgetDraft } from './storage.js';
import { FONT_CATALOG, FONT_STYLES, fontDescription } from './fonts.js';

const $ = id => document.getElementById(id);
const fontStyles=document.createElement('style');fontStyles.textContent=FONT_STYLES;document.head.append(fontStyles);
for(const select of $('pageTemplate').content.querySelectorAll('[data-field=font]')){
  const groups=new Map();
  for(const [key,font] of Object.entries(FONT_CATALOG)){
    if(!groups.has(font.group)){const group=element('optgroup');group.label=font.group;select.append(group);groups.set(font.group,group);}
    const option=element('option','',font.label);option.value=key;groups.get(font.group).append(option);
  }
}
const fontLoads=new Map();
const fontErrors=new Set();
function requestPageFonts(p){
  if(!document.fonts)return;
  for(const layer of p.layers){
    if(layer.kind==='balloon')continue;
    const query=fontDescription(layer).load;
    if(!query||document.fonts.check(query)||fontLoads.has(query))continue;
    fontLoads.set(query,document.fonts.load(query).then(()=>{fontErrors.delete(query);clearGlyphCache();pages.forEach(drawPage);pages.forEach(updateControls);}).catch(error=>{fontErrors.add(query);pages.forEach(updateControls);status(`書体を読み込めなかった: ${error.message}。ページを再読込して再試行。`);}));
  }
}
let pages = [], activeId = null, busy = false, drag = null, changed = false;
let sourceDirectory = null;
let layerClipboard=null;
let pageClipboard=null;
const clipboardPastes=new Map();
let preferences;
try { preferences=normalizePreferences(JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { preferences=defaultPreferences(); }
let revision=0, lastSavedRevision=-1, draftMeta=null, draftTask=null, autosaveTimer=null;
function dirty() { changed=true; revision++; }
const editing = new WeakSet();
const active = () => pages.find(p => p.id === activeId);
const selected = p => p.layers.find(l => l.id === p.selectedId);
const status = text => $('status').textContent = text;

function pageFrom(element) {
  return pages.find(p => p.id === element.closest('.image-row')?.dataset.pageId);
}

function createPage({ id=crypto.randomUUID(), name, src, img, file = null, directory = null, layers = [], done = false, edited = false }) {
  return { id, name, src, img, file, directory, layers, done, edited:edited===true||layers.length>0, selectedId: layers[0]?.id || null, undo: [], redo: [] };
}

function updateGlobal() {
  $('empty').hidden = pages.length > 0;
  $('count').textContent = `${pages.length} 枚`;
  $('progress').textContent = pages.length ? `確認済み ${pages.filter(p => p.done).length} / ${pages.length} 枚` : '画像ごとに編集内容を保持';
  $('save').disabled = !pages.length || busy;
  $('saveEdited').disabled = !pages.some(p=>p.edited) || busy;
  $('projectSave').disabled = !pages.length || busy;
  $('textTarget').disabled = !pages.length || busy;
  $('textSave').disabled = !pages.length || busy;
  for (const id of ['open', 'files', 'projectLoad', 'demo']) $(id).disabled = busy;
  const index = pages.findIndex(p => p.id === activeId);
  $('previous').disabled = busy || index <= 0;
  $('next').disabled = busy || index < 0 || index >= pages.length - 1;
  $('jump').disabled = busy || !pages.length;
  if ($('jump').value !== activeId) $('jump').value = activeId || '';
  $('deck').inert = busy;
  $('temporarySave').disabled=busy||!pages.length;
  $('savePreset').disabled=busy||!active()||!selected(active())||!['dialogue','sfx'].includes(selected(active()).kind);
  for(const id of ['defaultDialogue','defaultSfx','autosaveEnabled','autosaveMinutes','restoreDraft','clearDraft'])$(id).disabled=busy;
  updateDraftUI();
  pages.forEach((p, i) => {
    if (!p.row) return;
    p.row.classList.toggle('active', p.id === activeId);
    p.row.classList.toggle('done', p.done);
    p.row.querySelector('.page-number').textContent = String(i + 1).padStart(2, '0');
    p.row.querySelector('.edited-badge').hidden=!p.edited;
    p.row.querySelector('[data-action=complete]').textContent = p.done ? '✓ 確認済み・次へ ↓' : '編集完了・次へ ↓';
    p.row.querySelector('[data-action=undo]').disabled = !p.undo.length;
    p.row.querySelector('[data-action=redo]').disabled = !p.redo.length;
    p.row.querySelector('[data-action=save-image]').disabled = busy;
    p.row.querySelector('[data-action=move-up]').disabled = busy || i === 0;
    p.row.querySelector('[data-action=move-down]').disabled = busy || i === pages.length - 1;
    const copy = p.row.querySelector('[data-action=copy-next]');
    if (copy) copy.disabled = !p.layers.length || i === pages.length - 1;
    p.row.querySelector('[data-action=copy-all]').disabled = busy || !p.layers.length;
    p.row.querySelector('[data-action=cut-all]').disabled = busy || !p.layers.length;
    p.row.querySelector('[data-action=paste-all]').disabled = busy || !pageClipboard?.layers.length;
    p.row.querySelector('.batch-copy-hint').textContent = pageClipboard
      ? `${pageClipboard.cut?'カット':'コピー'}済み：${pageClipboard.name} · ${pageClipboard.layers.length}件。この画像に追加。カット・貼付けは各画像の「戻す」で取り消せる。`
      : '台詞・効果音・吹き出し・キャプションをまとめて別の画像に追加。貼付け一回分は「戻す」で取り消せる。';
  });
}

function drawPage(p) {
  if (!p?.canvas) return;
  requestPageFonts(p);
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
  const balloon=l?.kind==='balloon',caption=l?.kind==='caption';
  controls.querySelector('legend').textContent = balloon?'吹き出し：楕円とテールの位置調整':l ? `${caption?'キャプション':l.kind === 'sfx' ? '効果音' : l.speaker === 'female' ? '女性セリフ' : '男性セリフ'}：${l.text || '（未入力）'}` : '文字・吹き出し・キャプションを選択して位置調整';
  for(const node of controls.querySelectorAll('[data-text-control]'))node.hidden=balloon;
  for(const node of controls.querySelectorAll('[data-ink-control]'))node.hidden=balloon||caption;
  controls.querySelector('.balloon-style-controls').hidden=!balloon&&!caption;
  controls.querySelector('.caption-controls').hidden=!caption;
  controls.querySelector('[data-field=size]').disabled=caption&&l.autoFit;
  controls.querySelector('.balloon-tail-controls').hidden=!balloon||!l.tail;
  controls.querySelector('.balloon-position-note').hidden=!balloon;
  controls.querySelector('[data-action=backward]').textContent=balloon?'効果音の下へ':'背面へ';
  controls.querySelector('[data-action=forward]').textContent=balloon?'効果音の上へ':'前面へ';
  for (const input of controls.querySelectorAll('[data-field]')) {
    if (input !== document.activeElement) {
      if(input.type==='checkbox')input.checked=l?.[input.dataset.field]===true;
      else input.value = l?.[input.dataset.field]===undefined?'':String(l[input.dataset.field]);
    }
  }
  const captionStatus=controls.querySelector('.caption-fit-status');captionStatus.hidden=!caption;
  if(caption){const layout=captionLayout(p.canvas.getContext('2d'),l);captionStatus.textContent=`表示文字サイズ：${layout.size}px · ${l.autoFit?'ボックスに自動追従':'手動指定'}${layout.fits?'':' · 本文が収まらないため、ボックスを広げるか文字を減らす。'}`;}
  const query=l&&!balloon&&fontDescription(l).load,fontStatus=p.row.querySelector('.font-status');
  fontStatus.textContent=query&&document.fonts&&!document.fonts.check(query)?fontErrors.has(query)?'書体の読込に失敗。ページを再読込して再試行。':'選択した書体を読込中…':'';
  fontStatus.hidden=!fontStatus.textContent;
  const fontNote=controls.querySelector('.font-note');
  fontNote.textContent=l&&!balloon?FONT_CATALOG[l.font]?.note||'':'';fontNote.hidden=!fontNote.textContent;
  for (const card of p.row.querySelectorAll('.layer-card')) {
    card.classList.toggle('selected', card.dataset.layerId === p.selectedId);
    const layer=p.layers.find(layer=>layer.id===card.dataset.layerId);
    if(layer?.kind==='sfx'){
      card.querySelector('.taper-controls').hidden=layer.effect!=='taper';
      const rate=card.querySelector('[data-field=taperRate]');if(rate!==document.activeElement)rate.value=String(layer.taperRate);
    }
    if(layer?.kind==='balloon'||layer?.kind==='caption')for(const input of card.querySelectorAll('[data-field]')){
      if(input===document.activeElement)continue;
      if(input.type==='checkbox')input.checked=layer[input.dataset.field];
      else input.value=String(layer[input.dataset.field]);
    }
  }
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

function fitTextInput(input) {
  input.rows=Math.max(1,input.value.split('\n').length);
}

function button(action, text, title) {
  const b = element('button', '', text); b.dataset.action = action;
  if (title) b.title = title;
  return b;
}

function updateSwapOptions(p) {
  for (const card of p.row.querySelectorAll('.layer-card')) {
    const select = card.querySelector('[data-swap-target]');if(!select)continue;
    const old = select.value,others=p.layers.filter(l=>['dialogue','sfx'].includes(l.kind)&&l.id!==card.dataset.layerId);
    select.replaceChildren();
    for (const other of others) {
      const option = element('option', '', `${other.kind === 'sfx' ? '✦' : other.speaker === 'female' ? '女性' : '男性'} ${other.text || '（未入力）'}`);
      option.value = other.id; select.append(option);
    }
    if ([...select.options].some(o => o.value === old)) select.value = old;
    select.disabled = !others.length;
    card.querySelector('[data-action=swap]').disabled = !others.length;
  }
}

function renderCards(p) {
  const container = p.row.querySelector('.layer-cards'); container.replaceChildren();
  p.row.querySelector('.no-layers').hidden = p.layers.length > 0;
  for (const l of p.layers) {
    const card = element('div', 'layer-card'); card.dataset.layerId = l.id; card.dataset.kind=l.kind;if(l.speaker)card.dataset.speaker = l.speaker;
    const header = element('div', 'card-header');
    header.append(element('span', 'kind-label', l.kind==='caption'?'▭ キャプション':l.kind==='balloon'?'○ 吹き出し':l.kind === 'sfx' ? '✦ 効果音' : l.speaker === 'female' ? '● 女性セリフ' : '● 男性セリフ'));
    const mini = element('div', 'card-mini-actions');
    mini.append(button('duplicate', '複製'), button('drop-layer', '×', 'このレイヤーを削除')); header.append(mini); card.append(header);
    if(l.kind==='balloon'){
      const grid=element('div','effect-grid');
      for(const [field,labelText,type] of [['color','吹き出しの色','color'],['transparency','透過率（%）','number'],['borderColor','枠線の色','color'],['borderWidth','枠線の太さ（px）','number']]){
        const label=element('label','',labelText),input=element('input');input.type=type;input.dataset.field=field;input.value=String(l[field]);
        if(type==='number'){[input.min,input.max]=BALLOON_LIMITS[field];input.step=field==='borderWidth'?'0.5':'1';}label.append(input);grid.append(label);
      }
      const orderLabel=element('label','','効果音との重なり'),order=element('select');order.dataset.field='sfxOrder';
      for(const [value,text] of [['behind','効果音の下'],['above','効果音の上']]){const option=element('option','',text);option.value=value;order.append(option);}order.value=l.sfxOrder;orderLabel.append(order);grid.append(orderLabel);card.append(grid);
      const tailLabel=element('label','tail-toggle','テールを追加'),tail=element('input');tail.type='checkbox';tail.dataset.field='tail';tail.checked=l.tail;tailLabel.prepend(tail);card.append(tailLabel);
      card.append(element('p','effect-note','25%透過＝不透明度75%。台詞より常に下。楕円の位置・幅・高さと、テールの先端・付根は右側で調整。'));
      container.append(card);continue;
    }
    if(l.kind==='caption'){
      const text=element('textarea');text.dataset.field='text';text.value=l.text;text.wrap='off';fitTextInput(text);text.placeholder='モノローグ・説明を入力';text.setAttribute('aria-label','キャプションの本文');card.append(text);
      const grid=element('div','effect-grid');
      for(const [field,labelText,type] of [['textColor','文字色','color'],['color','背景色','color'],['transparency','背景の透過率（%）','number'],['borderColor','枠線の色','color'],['borderWidth','枠線の太さ（px）','number'],['padding','内側の余白（px）','number']]){
        const label=element('label','',labelText),input=element('input');input.type=type;input.dataset.field=field;input.value=String(l[field]);
        if(type==='number'){[input.min,input.max]=CAPTION_LIMITS[field];input.step=field==='borderWidth'?'0.5':'1';}label.append(input);grid.append(label);
      }
      for(const [field,labelText] of [['alignX','左右の揃え方'],['alignY','上下の揃え方']]){
        const label=element('label','',labelText),select=element('select');select.dataset.field=field;
        for(const [value,text] of Object.entries(CAPTION_ALIGNMENTS[field])){const option=element('option','',text);option.value=value;select.append(option);}select.value=l[field];label.append(select);grid.append(label);
      }
      const autoLabel=element('label','tail-toggle','文字サイズをボックスに合わせる'),auto=element('input');auto.type='checkbox';auto.dataset.field='autoFit';auto.checked=l.autoFit;autoLabel.prepend(auto);
      card.append(grid,autoLabel,element('p','effect-note','25%透過＝背景の不透明度75%。本文と枠線は不透明。左右・上下は初期値が中央。自動追従OFFならボックスを変えても文字サイズを保持。書体・文字方向・位置は右側で調整。'));container.append(card);continue;
    }
    if (l.kind === 'dialogue') {
      const roles = element('div', 'role-switch');
      for (const [speaker, label] of [['male', '男性・黒'], ['female', '女性・ピンク']]) {
        const b = button(`speaker-${speaker}`, label); b.classList.toggle('chosen', l.speaker === speaker); roles.append(b);
      }
      card.append(roles);
    }
    const presetLine=element('div','preset-controls'),presetSelect=element('select');
    presetSelect.dataset.presetSelect='';presetSelect.setAttribute('aria-label',l.kind==='sfx'?'効果音プリセット':'セリフプリセット');presetLine.append(presetSelect);card.append(presetLine);
    const text = element('textarea'); text.dataset.field = 'text'; text.value = l.text; text.wrap='off';fitTextInput(text);
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
      const taper=element('div','taper-controls'),rateLabel=element('label','','先細りの変化率（%／文字）'),rate=element('input');
      rate.type='number';rate.dataset.field='taperRate';[rate.min,rate.max]=EFFECT_LIMITS.taperRate;rate.step='0.5';rate.value=String(l.taperRate);rateLabel.append(rate);
      taper.hidden=l.effect!=='taper';taper.append(rateLabel,element('p','effect-note','初期値10%。基準100pxなら100→90→80px。最小8px。改行しても縮小を継続。ばらつき0なら指定率どおり。'));card.append(taper);
      card.append(element('p','effect-note','「なし」「先細り」は集中線・立体影なし。ブラー・掠れ・歪みは下のパラメータで独立調整。'));
    }
    if(l.kind==='sfx') {
      const details=element('details','effect-details');details.append(element('summary','','文字のばらつき・ブラー・掠れ・歪みの調整'));
      const grid=element('div','effect-grid');
      const labels={sizeVariation:'文字サイズのばらつき（%）',horizontalJitter:'左右のズレ（%）',blurY:'縦ブラー（px）',blurX:'横ブラー（px）',blurStrength:'滲みの強さ（%）',inkCore:'文字の芯（%）',roughness:'輪郭の荒れ（%）',dryInk:'筆の掠れ（%）',brushTails:'ハネ・払い（%）',blur:'全方向ブラー（px）',motionBlur:'流れる残像（px）',blurAngle:'残像の方向 °',distortion:'歪み（%）',skew:'傾き °',stretchX:'横倍率（%）',stretchY:'縦倍率（%）'};
      for(const [field,labelText] of Object.entries(labels)){const label=element('label','',labelText),input=element('input');input.type='number';input.dataset.field=field;[input.min,input.max]=EFFECT_LIMITS[field];input.step=['blur','sizeVariation','horizontalJitter'].includes(field)?'0.5':'1';input.value=String(l[field]);label.append(input);grid.append(label);}
      const warpLabel=element('label','','歪みの形'),warpSelect=element('select');warpSelect.dataset.field='warp';
      for(const [value,label] of Object.entries(WARP_CHOICES)){const option=element('option','',label);option.value=value;warpSelect.append(option);}warpSelect.value=l.warp;warpLabel.append(warpSelect);grid.append(warpLabel);
      details.append(grid,element('p','effect-note','手描きの揺れはサイズ±5%・左右±3%から調整。左右は文字幅が基準。0で追加のばらつきなし。文字ごとの変化は保存・再読込でも固定。'),element('p','effect-note','感情・緊張はプリセット「感情／緊張の掠れ」から開始。縦ブラーは300px、滲みは400%まで。「文字の芯」で読みやすさを調整。掠れ・ハネは文字の形に直接適用。'));card.append(details);
    }
    const swap = element('div', 'swap-controls'), target = element('select'); target.dataset.swapTarget = '';
    target.setAttribute('aria-label', 'セリフを入れ替える相手'); swap.append(target, button('swap', 'セリフ交換')); card.append(swap);
    container.append(card);
  }
  refreshPresetMenus(); updateSwapOptions(p); updateControls(p); updateGlobal();
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

function movePage(p, offset) {
  const index = pages.indexOf(p), destination = index + offset;
  if (index < 0 || destination < 0 || destination >= pages.length) return;
  const neighbor = pages[destination];
  [pages[index], pages[destination]] = [neighbor, p];
  if (offset < 0) neighbor.row.before(p.row);
  else neighbor.row.after(p.row);
  dirty(); refreshJump(); activate(p, p.selectedId, true);
  const focusTarget = p.row.querySelector(`[data-action=move-${offset < 0 ? 'up' : 'down'}]:enabled`)
    || p.row.querySelector('.page-actions button:enabled');
  focusTarget?.focus({ preventScroll: true });
  status(`「${p.name}」を ${destination + 1} / ${pages.length} ページへ移動した`);
}

function markChanged(p) {
  dirty(); p.done = false;p.edited=true; updateGlobal();
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
$('deck').addEventListener('focusout', event => {
  editing.delete(event.target);
  const p = pageFrom(event.target);
  if (p) queueMicrotask(() => updateControls(p));
});
$('deck').addEventListener('input', event => {
  if (busy) return;
  const input = event.target, field = input.dataset.field;
  if (!field) return;
  if(field==='text')fitTextInput(input);
  const p = pageFrom(input), id = input.closest('.layer-card')?.dataset.layerId || p.selectedId;
  const l = p.layers.find(item => item.id === id); if (!l) return;
  let value = input.value;
  const limits = { size: [8, 500], thickness: THICKNESS_LIMIT, rotation: [-180, 180], w: [30, 30000], h: [30, 30000], outline: [1, 80], ...EFFECT_LIMITS,...BALLOON_LIMITS,...CAPTION_LIMITS };
  if (['x', 'y', ...Object.keys(limits)].includes(field)) {
    if (value === '' || !Number.isFinite(Number(value))) return;
    value = Number(value);
    if (limits[field]) value = clamp(value, ...limits[field]);
  } else if (field === 'vertical') value = value === 'true';
  else if(field==='tail'||field==='autoFit')value=input.checked;
  if (l[field] === value) return;
  if (!editing.has(input)) { checkpoint(p); editing.add(input); }
  l[field] = value;if(field!=='text'&&['dialogue','sfx'].includes(l.kind))l.presetId=null;markChanged(p);drawPage(p);updateControls(p);refreshPresetMenus();
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
    const kind = action === 'add-caption'?'caption':action === 'add-balloon'?'balloon':action === 'add-sfx' ? 'sfx' : 'dialogue', speaker = action === 'add-female' ? 'female' : 'male';
    edit(p, () => {
      const layer = makeLayer(kind,p.img.width,p.img.height,speaker);
      p.layers.push(layer); p.selectedId = layer.id;
    });
    p.row.querySelector(`.layer-card[data-layer-id="${p.selectedId}"] ${kind==='balloon'?'input':'textarea'}`).focus({ preventScroll: true });
  } else if (action.startsWith('speaker-') && l?.kind === 'dialogue') {
    edit(p, () => l.speaker = action.slice(8));
  } else if (action === 'duplicate' && l) {
    edit(p, () => { const copy = duplicateLayer(l); p.layers.push(copy); p.selectedId = copy.id; });
  } else if (action === 'drop-layer' && l) {
    edit(p, () => { p.layers = p.layers.filter(item => item.id !== l.id); p.selectedId = p.layers[0]?.id || null; });
  } else if (action === 'swap' && l) {
    if (swapText(p, l.id, card.querySelector('[data-swap-target]').value)) { markChanged(p); renderCards(p); drawPage(p); }
  } else if (['backward', 'forward'].includes(action) && l) {
    edit(p, () => {if(l.kind==='balloon'){l.sfxOrder=action==='forward'?'above':'behind';return;} const i = p.layers.indexOf(l), j = clamp(i + (action === 'forward' ? 1 : -1), 0, p.layers.length - 1); [p.layers[i], p.layers[j]] = [p.layers[j], p.layers[i]]; });
  } else if (action === 'center' && l) {
    edit(p, () => { l.x = p.img.width / 2; l.y = p.img.height / 2; }, false);
  } else if (['undo', 'redo'].includes(action)) {
    if (restore(p, action)) { dirty(); renderCards(p); drawPage(p); updateGlobal(); }
  } else if (action === 'save-image') {
    guard(()=>saveImage(p));
  } else if (action === 'move-up' || action === 'move-down') {
    movePage(p, action === 'move-up' ? -1 : 1);
  } else if (action === 'complete') {
    p.done = true; dirty(); updateGlobal();
    const next = pages[pages.indexOf(p) + 1];
    if (next) activate(next, next.selectedId, true); else status('最後の画像まで確認済み。一括保存で書き出せる。');
  } else if (action === 'copy-all' && p.layers.length) {
    pageClipboard = { ...copyLayers(p.layers,p.img.width,p.img.height), name:p.name };
    updateGlobal();
    status(`「${p.name}」の台詞・効果音・吹き出し・キャプション ${pageClipboard.layers.length}件をコピーした。別の画像の「文字を一括ペースト」で追加できる。`);
  } else if (action === 'cut-all' && p.layers.length) {
    pageClipboard = { ...cutLayers(p,p.img.width,p.img.height), name:p.name, cut:true };
    markChanged(p); renderCards(p); drawPage(p);
    status(`「${p.name}」の台詞・効果音・吹き出し・キャプション ${pageClipboard.layers.length}件をカットした。「文字を一括ペースト」で追加、元画像の「戻す」で復元できる。`);
  } else if (action === 'paste-all') {
    const copies = pasteLayers(pageClipboard,p,p.img.width,p.img.height);
    if (copies.length) {
      p.selectedId = copies[0].id;
      markChanged(p); renderCards(p); drawPage(p);
      status(`「${p.name}」に台詞・効果音・吹き出し ${copies.length}件を追加した。「戻す」で一括取消できる。`);
    }
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
    const l = handle ? current : paintOrder(p.layers).reverse().find(item => hit(item, pos.x, pos.y));
    activate(p, l?.id || null); p.canvas.focus({ preventScroll: true });
    if (!l) return;
    drag = { page: p, id: event.pointerId, mode: handle || 'move', dx: pos.x - l.x, dy: pos.y - l.y, start: { ...l }, checkpointed: false };
    p.canvas.setPointerCapture(event.pointerId);
  });
  p.canvas.addEventListener('pointermove', event => {
    if (!drag || drag.page !== p || drag.id !== event.pointerId) return;
    const l = selected(p), pos = coords(event, p); if (!l) return;
    let updates;
    if (drag.mode === 'move') { updates = { x: Math.round(pos.x - drag.dx), y: Math.round(pos.y - drag.dy) }; }
    else if (drag.mode === 'resize') {
      const local = localPoint(l, pos.x, pos.y), w = clamp(Math.round(local.x * 2), 30, 30000), h = clamp(Math.round(local.y * 2), 30, 30000);
      updates = l.kind==='caption'?{w,h}:l.kind==='balloon'?{w,h,tailX:clamp(drag.start.tailX*w/drag.start.w,...BALLOON_LIMITS.tailX),tailY:clamp(drag.start.tailY*h/drag.start.h,...BALLOON_LIMITS.tailY),tailWidth:clamp(drag.start.tailWidth*Math.min(w/drag.start.w,h/drag.start.h),...BALLOON_LIMITS.tailWidth)}:{ w, h, size: clamp(Math.round(drag.start.size * Math.min(w / drag.start.w, h / drag.start.h)), 8, 500) };
    } else if(drag.mode==='tail'){
      const local=localPoint(l,pos.x,pos.y);updates={tailX:clamp(Math.round(local.x),...BALLOON_LIMITS.tailX),tailY:clamp(Math.round(local.y),...BALLOON_LIMITS.tailY),tailAngle:Math.round(Math.atan2(local.y/l.h,local.x/l.w)*180/Math.PI)};
    } else {
      const angle = Math.atan2(pos.y - l.y, pos.x - l.x) * 180 / Math.PI + 90;
      updates = { rotation: Math.round(((angle + 180) % 360 + 360) % 360 - 180) };
    }
    if (Object.entries(updates).every(([key, value]) => l[key] === value)) return;
    if (!drag.checkpointed) { checkpoint(p); drag.checkpointed = true; }
    Object.assign(l, updates);
    dirty(); if(['dialogue','sfx'].includes(l.kind))l.presetId=null; p.done = false;p.edited=true; drawPage(p); updateControls(p); updateGlobal();
  });
  const end = () => { if (drag?.page === p) { drag = null; updateControls(p); } };
  p.canvas.addEventListener('pointerup', end); p.canvas.addEventListener('pointercancel', end);
}

window.addEventListener('keydown', event => {
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable || event.isComposing || busy) return;
  const p = active(); if (!p) return;
  const key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
  if (command && !event.altKey && !event.shiftKey && event.target===p.canvas && ['c','v'].includes(key)) {
    if (event.repeat) return;
    if (key==='c' && selected(p)) {
      event.preventDefault();layerClipboard=copySelection(selected(p),p.img.width,p.img.height);clipboardPastes.clear();
      status('選択した文字と設定をコピーした。貼付け先のプレビューで Ctrl／⌘＋V。');
    } else if (key==='v' && layerClipboard) {
      event.preventDefault();const count=(clipboardPastes.get(p.id)||0)+1;clipboardPastes.set(p.id,count);
      edit(p,()=>{const copy=pasteSelection(layerClipboard,p.img.width,p.img.height,count*20);p.layers.push(copy);p.selectedId=copy.id;});
      p.canvas.focus({preventScroll:true});status('文字と設定を貼り付けた。ドラッグで位置調整、Ctrl／⌘＋Zで戻す。');
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (restore(p, event.shiftKey ? 'redo' : 'undo')) { dirty(); renderCards(p); drawPage(p); updateGlobal(); }
    return;
  }
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, direction = directions[event.key], l = selected(p);
  if (direction && l) { event.preventDefault(); edit(p, () => { const step = event.shiftKey ? 10 : 1; l.x += direction[0] * step; l.y += direction[1] * step; }, false); }
});

function removePage(p) {
  const index = pages.indexOf(p); pages.splice(index, 1); p.resizeObserver.disconnect(); p.row.remove();
  if (p.src.startsWith('blob:')) URL.revokeObjectURL(p.src);
  if (activeId === p.id) activeId = pages[Math.min(index, pages.length - 1)]?.id || null;
  dirty(); refreshJump(); if (active()) activate(active());
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
    try { const p = createPage({ name: file.name, src, img: await decode(src), file, directory }); pages.push(p); first ||= p; mountPage(p); count++; if (directory) sourceDirectory = directory; }
    catch { URL.revokeObjectURL(src); failures++; }
  }
  if (!activeId && first) activeId = first.id;
  if(count>0)dirty(); refreshJump(); if (active()) activate(active());
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
  return { version: PROJECT_VERSION, preferences:structuredClone(preferences), pages: await Promise.all(snapshot.map(async p => ({ name: p.name, src: p.src.startsWith('data:') ? p.src : await dataURL(p.file), layers: p.layers, done: p.done,edited:p.edited===true }))) };
}
function snapshotPages() { return pages.map(p => ({ ...p, layers: structuredClone(p.layers) })); }
function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function prepareExportFonts(snapshot) {
  if(!document.fonts)return;
  const queries=new Set(snapshot.flatMap(p=>p.layers.filter(l=>l.kind!=='balloon').map(l=>fontDescription(l).load)).filter(Boolean));
  await Promise.all([...queries].map(query=>document.fonts.load(query)));
  clearGlyphCache();
}
async function imageBlob(p) {
  const canvas=document.createElement('canvas');canvas.width=p.img.width;canvas.height=p.img.height;
  try {
    draw(canvas.getContext('2d'),p.img,p.layers);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(!blob)throw new Error('PNG生成に失敗');
    return blob;
  } finally {canvas.width=1;canvas.height=1;}
}
async function saveImage(p) {
  const snapshot={...p,layers:structuredClone(p.layers)},name=exportName(p.name,pages.indexOf(p));
  status(`「${p.name}」の画像を保存中…`);
  await prepareExportFonts([snapshot]);
  download(await imageBlob(snapshot),name);
  status(`「${name}」のダウンロードを開始した`);
}
async function saveImages(editedOnly=false) {
  const allPages=snapshotPages();
  const snapshot=allPages.map((p,index)=>({...p,pageIndex:index})).filter(p=>!editedOnly||p.edited);
  if(!snapshot.length){status('保存対象の編集済み画像がない。');return;}
  if (!window.showDirectoryPicker) { status('新規フォルダへの直接一括保存はPC版Chrome / Edgeが対象。編集データを保存してPCへ持ち出せる。'); return; }
  const startIn = allPages.some(p=>p.directory===sourceDirectory) ? sourceDirectory : allPages.find(p=>p.directory)?.directory;
  const parent = await window.showDirectoryPicker({ mode: 'readwrite', ...(startIn ? { startIn } : {}) });
  const folder = `serifu_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}`;
  const directory = await parent.getDirectoryHandle(folder, { create: true });
  let completed = 0;
  try {
    await prepareExportFonts(snapshot);
    for (const [i, p] of snapshot.entries()) {
      status(`保存中 ${i + 1} / ${snapshot.length} 枚`);
      const blob = await imageBlob(p);
      await write(directory, pageExportName(p.name, p.pageIndex, allPages.length), blob); completed++;
    }
    await write(directory, 'serifu-project.json', JSON.stringify(await projectData(snapshot)));
    if (!editedOnly || snapshot.length === allPages.length) changed = false;
    status(`${snapshot.length} 枚と編集データを「${parent.name ? `${parent.name}/` : ''}${folder}」へ保存した`);
  } catch (error) { throw new Error(`${folder} 内に ${completed} 枚保存済み。${error.message}`); }
}
$('save').onclick = () => guard(()=>saveImages());
$('saveEdited').onclick = () => guard(()=>saveImages(true));
$('textSave').onclick = () => guard(() => {
  const target = $('textTarget').value, text = textExport(snapshotPages(), target);
  if (!text) { status('選択した対象に出力できる本文がない。'); return; }
  download(new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' }), `serifu-${target}.txt`);
  status(`${$('textTarget').selectedOptions[0].textContent}のテキストをページ順に出力した`);
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
    if (![1, 2, 3, 4, 5, 6].includes(data.version) || !Array.isArray(data.pages) || !data.pages.length) throw new Error('未対応または空の編集データ');
    const loaded = [];
    for (const p of data.pages) {
      if (typeof p.name !== 'string' || typeof p.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(p.src) || !Array.isArray(p.layers)) throw new Error('画像データが不正');
      loaded.push(createPage({ name: p.name, src: p.src, img: await decode(p.src), layers: p.layers.map(l => normalizeLayer(l, data.version)), done: p.done === true,edited:p.edited===true }));
    }
    pages.push(...loaded); for (const p of loaded) mountPage(p);
    mergePresets(data.preferences);dirty();refreshJump();activate(loaded[0], loaded[0].selectedId, true);
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
    const male = makeLayer('dialogue', 1000, 750, 'male'); male.x = 300; male.y = 170; male.text = ['さあ、出発しよう。', 'あの山の向こうへ。', 'ここから始まるんだ。'][i];
    const female = makeLayer('dialogue', 1000, 750, 'female'); female.x = 650; female.y = 280; female.text = ['うん、楽しみ！', '景色がきれい！', '続きも見てみよう。'][i];
    const sfx = makeLayer('sfx', 1000, 750);
    if(preferences.presets.find(p=>p.id===preferences.defaults.sfx)?.builtin)applyPreset(sfx,preferences.presets.find(p=>p.id===['sfx-impact','sfx-speed','sfx-tension'][i]),1000,750);
    sfx.x = 560; sfx.y = 420; sfx.text = ['ドーン！', 'シュッ', 'ゾワッ…'][i];
    const src = c.toDataURL(), p = createPage({ name: `sample-${i + 1}.png`, src, img: await decode(src), layers: [male, female, sfx] });
    pages.push(p); mountPage(p);
  }
  refreshJump();activate(pages[first],pages[first].selectedId,true);dirty();
  status('3枚のサンプルを追加。中央でセリフを編集し、右で位置を調整。');
});
window.addEventListener('beforeunload', event => { if (changed) { event.preventDefault(); event.returnValue = ''; } });
updateGlobal();

function makeLayer(kind,width,height,speaker='male') {
  const layer=newLayer(kind,width,height,speaker);
  return applyPreset(layer,preferences.presets.find(p=>p.id===preferences.defaults[kind]),width,height);
}
function fillPresetSelect(select,kind,current,custom=false) {
  if(select===document.activeElement)return;
  select.replaceChildren();
  if(custom){const option=element('option','','現在の設定（カスタム）');option.value='';select.append(option);}
  for(const preset of preferences.presets.filter(p=>p.kind===kind)){const option=element('option','',preset.name);option.value=preset.id;select.append(option);}
  select.value=current||'';
}
function refreshPresetMenus() {
  fillPresetSelect($('defaultDialogue'),'dialogue',preferences.defaults.dialogue);
  fillPresetSelect($('defaultSfx'),'sfx',preferences.defaults.sfx);
  for(const p of pages)if(p.row)for(const card of p.row.querySelectorAll('.layer-card')){
    const layer=p.layers.find(l=>l.id===card.dataset.layerId),select=card.querySelector('[data-preset-select]');if(layer&&select)fillPresetSelect(select,layer.kind,layer.presetId,true);
  }
  for(const b of document.querySelectorAll('[data-delete-preset]'))b.disabled=!!preferences.presets.find(p=>p.id===preferences.defaults[b.dataset.deletePreset])?.builtin;
}
function persistPreferences() {
  let remembered=true;
  try {localStorage.setItem(PREFS_KEY,JSON.stringify(preferences));}
  catch(error){remembered=false;status(`設定をブラウザに記憶できなかった: ${error.message}`);}
  refreshPresetMenus();
  return remembered;
}
function mergePresets(input) {
  if(!input)return;
  const imported=normalizePreferences(input);
  for(const preset of imported.presets.filter(p=>!p.builtin))if(!preferences.presets.some(p=>p.id===preset.id))preferences.presets.push(preset);
  for(const kind of ['dialogue','sfx'])if(preferences.presets.some(p=>p.id===imported.defaults[kind]&&p.kind===kind))preferences.defaults[kind]=imported.defaults[kind];
  persistPreferences();
}
for(const [id,kind] of [['defaultDialogue','dialogue'],['defaultSfx','sfx']])$(id).onchange=()=>{
  preferences.defaults[kind]=$(id).value;persistPreferences();dirty();updateGlobal();
};
$('savePreset').onclick=()=>{
  const p=active(),layer=p&&selected(p);if(!layer||!['dialogue','sfx'].includes(layer.kind))return;
  const name=prompt('この設定のプリセット名（文字内容・話者は保存せず、書式と配置を記憶）',preferences.presets.find(p=>p.id===layer.presetId&&!p.builtin)?.name||'');
  if(!name?.trim())return;
  const existing=preferences.presets.find(p=>!p.builtin&&p.kind===layer.kind&&p.name===name.trim());
  const preset=createPreset(name,layer,p.img.width,p.img.height);
  if(existing){preset.id=existing.id;preferences.presets.splice(preferences.presets.indexOf(existing),1,preset);}else preferences.presets.push(preset);
  layer.presetId=preset.id;preferences.defaults[layer.kind]=preset.id;const remembered=persistPreferences();dirty();updateGlobal();
  status(remembered?`「${preset.name}」を記憶。＋ボタンと次の画像でもこの設定を使う。`:'設定はこのタブに適用済み。ブラウザへの記憶は失敗したため、編集データを書き出して保管。');
};
for(const button of document.querySelectorAll('[data-delete-preset]'))button.onclick=()=>{
  const kind=button.dataset.deletePreset,preset=preferences.presets.find(p=>p.id===preferences.defaults[kind]);
  if(!preset||preset.builtin||!confirm(`プリセット「${preset.name}」を削除する？ 配置済みの文字は残る。`))return;
  preferences.presets=preferences.presets.filter(p=>p.id!==preset.id);preferences.defaults[kind]=defaultPreferences().defaults[kind];
  for(const p of pages)for(const l of p.layers)if(l.presetId===preset.id)l.presetId=null;
  persistPreferences();dirty();updateGlobal();
};
$('deck').addEventListener('change',event=>{
  if(busy||!event.target.matches('[data-preset-select]')||!event.target.value)return;
  const p=pageFrom(event.target),layer=p.layers.find(l=>l.id===event.target.closest('.layer-card').dataset.layerId);
  const preset=preferences.presets.find(p=>p.id===event.target.value);if(!layer||!preset)return;
  edit(p,()=>applyPreset(layer,preset,p.img.width,p.img.height));preferences.defaults[layer.kind]=preset.id;persistPreferences();
});

function savedTime(timestamp) {return new Date(timestamp).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});}
function updateDraftUI() {
  $('draftNotice').hidden=!draftMeta;
  if(draftMeta)$('draftSummary').textContent=`一時保存：${new Date(draftMeta.savedAt).toLocaleString('ja-JP')} · ${draftMeta.pages.length} 枚`;
  $('restoreDraft').disabled=busy||!!draftTask;$('clearDraft').disabled=busy||!!draftTask;
  if(draftTask){$('draftStatus').textContent='一時保存中…';return;}
  if($('draftStatus').dataset.error)return;
  $('draftStatus').textContent=draftMeta?`${savedTime(draftMeta.savedAt)} 保存済${revision!==lastSavedRevision&&pages.length?' · 保存後の変更あり':''}`:'まだ一時保存なし';
}
const storageReady=(async()=>{
  try {draftMeta=await getDraftMeta();updateDraftUI();}
  catch(error){$('draftStatus').dataset.error='true';$('draftStatus').textContent=`一時保存を利用できない: ${error.message}`;}
})();
async function temporarySave(manual=false) {
  if(!pages.length||busy)return;
  if(draftTask){if(!manual)return draftTask;await draftTask.catch(()=>{});return temporarySave(true);}
  if(!manual&&revision===lastSavedRevision)return;
  const snapshot=snapshotPages(),captured=revision,prefs=structuredClone(preferences);
  const meta={version:PROJECT_VERSION,savedAt:Date.now(),preferences:prefs,pages:snapshot.map(p=>({id:p.id,name:p.name,layers:p.layers,done:p.done,edited:p.edited===true}))};
  delete $('draftStatus').dataset.error;
  draftTask=(async()=>{
    await storageReady;
    const images=await Promise.all(snapshot.map(async p=>{
      const original=pages.find(page=>page.id===p.id);
      const blob=p.assetBlob||p.file||await (await fetch(p.src)).blob();
      if(original)original.assetBlob=blob;
      return {id:p.id,blob};
    }));
    await writeDraft(meta,images);draftMeta=meta;lastSavedRevision=captured;changed=revision!==captured;
  })();
  updateDraftUI();
  try {await draftTask;if(manual)status('画像・文字・位置・設定をこのブラウザに一時保存した。');}
  catch(error){$('draftStatus').dataset.error='true';$('draftStatus').textContent=error.name==='QuotaExceededError'?'保存容量不足。編集データを書き出して保管。':`一時保存に失敗: ${error.message}`;if(manual)status($('draftStatus').textContent);}
  finally{draftTask=null;updateDraftUI();}
}
$('temporarySave').onclick=()=>temporarySave(true);
function configureAutosave() {
  if(autosaveTimer)clearInterval(autosaveTimer);
  autosaveTimer=preferences.autosave.enabled?setInterval(()=>temporarySave(false),preferences.autosave.minutes*60000):null;
  $('autosaveEnabled').checked=preferences.autosave.enabled;$('autosaveMinutes').value=String(preferences.autosave.minutes);
}
$('autosaveEnabled').onchange=()=>{preferences.autosave.enabled=$('autosaveEnabled').checked;persistPreferences();configureAutosave();dirty();updateGlobal();};
$('autosaveMinutes').onchange=()=>{
  const value=Number($('autosaveMinutes').value);
  if(!Number.isFinite(value)||value<.1||value>1440){$('autosaveMinutes').setCustomValidity('0.1〜1440分で指定');$('autosaveMinutes').reportValidity();return;}
  $('autosaveMinutes').setCustomValidity('');preferences.autosave.minutes=value;persistPreferences();configureAutosave();dirty();updateGlobal();
};
$('restoreDraft').onclick=()=>guard(async()=>{
  await storageReady;const meta=await getDraftMeta();if(!meta)return;
  if(pages.length&&!confirm('現在の一覧を一時保存の内容に置き換える？ 保存後の変更は失われる。'))return;
  if(![3,4,5,6].includes(meta.version)||!Array.isArray(meta.pages))throw new Error('未対応の一時保存データ');
  const images=await getDraftImages(meta.pages.map(p=>p.id)),loaded=[];
  try {
    for(const [i,p] of meta.pages.entries()){
      const src=URL.createObjectURL(images[i].blob);
      try {loaded.push(createPage({id:p.id,name:p.name,src,img:await decode(src),file:images[i].blob,layers:p.layers.map(l=>normalizeLayer(l,meta.version)),done:p.done===true,edited:p.edited===true}));}
      catch(error){URL.revokeObjectURL(src);throw error;}
    }
  }catch(error){for(const p of loaded)URL.revokeObjectURL(p.src);throw error;}
  for(const p of pages){p.resizeObserver.disconnect();if(p.src.startsWith('blob:'))URL.revokeObjectURL(p.src);}
  $('deck').replaceChildren();pages=loaded;activeId=loaded[0]?.id||null;drag=null;
  mergePresets(meta.preferences);for(const p of loaded)mountPage(p);refreshJump();if(active())activate(active());
  dirty();lastSavedRevision=revision;changed=false;draftMeta=meta;updateDraftUI();status('一時保存を復元した。元ファイルへの接続はないため、元画像削除は無効。');
});
$('clearDraft').onclick=()=>guard(async()=>{
  if(!confirm('このブラウザの一時保存を消去する？ 編集中の画像は残る。'))return;
  await forgetDraft();draftMeta=null;lastSavedRevision=-1;delete $('draftStatus').dataset.error;updateDraftUI();
  status('一時保存を消去した。自動保存がONなら次の周期で再保存する。');
});
refreshPresetMenus();configureAutosave();updateGlobal();
if(document.fonts){
  const redrawFonts=()=>{clearGlyphCache();pages.forEach(drawPage);};
  document.fonts.addEventListener('loadingdone',redrawFonts);
  document.fonts.load('900 64px MangaBold').then(redrawFonts).catch(()=>{});
}
