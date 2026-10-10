import { newLayer, draw, hit, handleAt, localPoint, clamp, EFFECTS, WARP_CHOICES, clearGlyphCache, paintOrder } from './renderer.js';
import { BALLOON_LIMITS } from './balloons.js';
import { CAPTION_LIMITS, CAPTION_ALIGNMENTS, captionLayout } from './captions.js';
import { PROJECT_VERSION, normalizeLayer, checkpoint, restore, duplicateLayer, copySelection, pasteSelection, scaledCopy, EFFECT_LIMITS, THICKNESS_LIMIT } from './model.js';
import { exportName } from './renderer.js';
import { pageExportName, textExport } from './export.js';
import { PREFS_KEY, defaultPreferences, normalizePreferences, createPreset, applyPreset, PRESET_KINDS, MAX_USER_PRESETS } from './presets.js';
import { getDraftMeta, getDraftImages, getImageIds, saveDraft as writeDraft, clearDraft as forgetDraft } from './storage.js';
import { BulkTask, boundedResults, checkAbort, awaitWithAbort, yieldToBrowser, prepareLayers } from './bulk-task.js';
import { ZipArchive } from './zip.js';
import { imageDimensions } from './image-metadata.js';
import { ImagePool } from './bulk-pool.js';
import { ExportCache, exportKey } from './export-cache.js';
import { originalBlob, projectParts, projectBlob, readProject, writeParts } from './project-io.js';
import { FONT_CATALOG, FONT_STYLES, fontDescription } from './fonts.js';

const $ = id => document.getElementById(id);
const presetControls=[['defaultDialogue','dialogue'],['defaultSfx','sfx'],['defaultBalloon','balloon'],['defaultCaption','caption']];
const presetLabels={dialogue:'セリフ',sfx:'効果音',balloon:'吹き出し',caption:'キャプション'};
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
let sourceDirectory = null, currentTask=null, fontVersion=0;
const imagePool=new ImagePool(),pngCache=new ExportCache();
const editLocked=()=>busy&&currentTask?.data.kind!=='画像追加';
const viewLocked=()=>busy&&currentTask?.data.kind==='レイヤー一括操作';
function displayTask(data){
  const running=['running','cancelling'].includes(data.state);
  $('bulkPanel').hidden=!running;$('bulkPanel').setAttribute('aria-busy',String(running));
  const states={running:'処理中',cancelling:'中断中',cancelled:'中断',failed:'失敗',succeeded:'完了'};
  const title=`${data.kind} · ${states[data.state]} · ${data.stage}`;if($('bulkTitle').textContent!==title)$('bulkTitle').textContent=title;
  $('bulkStage').textContent=`段階${Math.min(data.completedStages+1,data.stageCount)} / ${data.stageCount}：${data.stage}`;
  $('bulkCounts').textContent=`${data.processed} / ${data.total??'未確定'}件 · 成功${data.succeeded} · 失敗${data.failed}${data.errorMessage?' · '+data.errorMessage:''}`;
  if(data.total===null)$('bulkProgress').removeAttribute('value');else{$('bulkProgress').max=Math.max(1,data.total);$('bulkProgress').value=data.processed;}
  $('bulkName').textContent=data.currentName;$('bulkName').title=data.currentName;
  $('bulkElapsed').textContent=`${Math.floor(data.elapsedMs/60000).toString().padStart(2,'0')}:${Math.floor(data.elapsedMs/1000)%60<10?'0':''}${Math.floor(data.elapsedMs/1000)%60}`;
  $('bulkCancel').disabled=data.state!=='running';
}
$('bulkCancel').onclick=()=>currentTask?.cancel();
function releasePage(p){unmountPage(p);p.thumbnail?.remove();if(p.src.startsWith('blob:'))URL.revokeObjectURL(p.src);if(p.thumbnailSrc.startsWith('blob:'))URL.revokeObjectURL(p.thumbnailSrc);pngCache.invalidate(p.id);}

const VIEW_KEY = 'serifu.view.v1';
let view = { pageSize: 50, thumbnails: true, scale: 100 }, batchStart = 0, syncingView = false;
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY));
  if ([50, 100, 'all'].includes(saved?.pageSize)) view.pageSize = saved.pageSize;
  if (typeof saved?.thumbnails === 'boolean') view.thumbnails = saved.thumbnails;
  if (Number.isFinite(saved?.scale)) view.scale = clamp(saved.scale, 50, 200);
} catch {}
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

function createPage({ id=crypto.randomUUID(), name, src, img, prepared, file = null, directory = null, layers = [], done = false, edited = false, expectedSize, preserveEdited=false }) {
  let thumbnailSrc;
  if(prepared){img=new Image(prepared.width,prepared.height);thumbnailSrc=URL.createObjectURL(prepared.thumbnail);}
  else{
    const thumbnail=document.createElement('canvas'),ratio=Math.min(1,320/Math.max(img.width,img.height));
    thumbnail.width=Math.max(1,Math.round(img.width*ratio));thumbnail.height=Math.max(1,Math.round(img.height*ratio));thumbnail.getContext('2d').drawImage(img,0,0,thumbnail.width,thumbnail.height);thumbnailSrc=thumbnail.toDataURL('image/webp',.75);thumbnail.width=1;thumbnail.height=1;
    img.width=img.naturalWidth||img.width;img.height=img.naturalHeight||img.height;img.onload=null;img.onerror=null;img.src='';
  }
  return { id, name, src, thumbnailSrc, img, file, directory, layers, done, edited:expectedSize||preserveEdited?edited===true:edited===true||layers.length>0, selectedId: layers[0]?.id || null, undo: [], redo: [] };
}
async function prepareImageJob(blob,task,dimensions=null){return imagePool.run('prepare-image',{blob,dimensions},task,async()=>{
  const src=URL.createObjectURL(blob);let img,canvas;
  try{img=await decode(src);canvas=document.createElement('canvas');const ratio=Math.min(1,320/Math.max(img.width,img.height));canvas.width=Math.max(1,Math.round(img.width*ratio));canvas.height=Math.max(1,Math.round(img.height*ratio));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    const thumbnail=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.75));if(!thumbnail)throw new Error('サムネイルを生成できない');return {width:img.width,height:img.height,thumbnail};
  }finally{if(img)img.src='';if(canvas){canvas.width=1;canvas.height=1;}URL.revokeObjectURL(src);}
});}
async function prepareImage(blob,task,dimensions=null){
  checkAbort(task?.signal);if(!task)return prepareImageJob(blob,task,dimensions);
  task.preparedBlobs ||= new WeakMap();if(task.preparedBlobs.has(blob)){task.metrics.preparationHits=(task.metrics.preparationHits||0)+1;return task.preparedBlobs.get(blob);}
  const prepared=prepareImageJob(blob,task,dimensions);task.preparedBlobs.set(blob,prepared);return prepared;
}
function jobEstimate(p){const pixels=(p.expectedSize?.width||p.img?.width||0)*(p.expectedSize?.height||p.img?.height||0);return pixels?{work:pixels*12,result:pixels*4+65536}:{work:256*1024**2,result:64*1024**2};}
function queueOptions(task,preparing=false){return {signal:task.signal,concurrency:preparing?imagePool.size:Math.min(2,imagePool.size),estimate:p=>{const estimate=jobEstimate(p);if(preparing)estimate.result=320*320*4+65536;return estimate;},onMetrics:metrics=>Object.assign(task.metrics,metrics),onStop:()=>{if(!task.signal.aborted)task.controller.abort(new DOMException('残りの画像処理を停止','AbortError'));}};}

function updateGlobal() {
  if (syncingView) return;
  $('empty').hidden = pages.length > 0;
  $('count').textContent = `${pages.length} 枚`;
  $('progress').textContent = pages.length ? `確認済み ${pages.filter(p => p.done).length} / ${pages.length} 枚` : '画像ごとに編集内容を保持';
  $('save').disabled = !pages.length || busy;
  $('saveEdited').disabled = !pages.some(p=>p.edited) || busy;
  $('projectSave').disabled = !pages.length || busy;
  $('projectFormat').disabled=busy;
  $('textTarget').disabled = !pages.length || busy;
  $('textSave').disabled = !pages.length || busy;
  for (const id of ['open', 'files', 'projectLoad', 'demo']) $(id).disabled = busy;
  const index = pages.findIndex(p => p.id === activeId);
  $('previous').disabled = viewLocked() || index <= 0;
  $('next').disabled = viewLocked() || index < 0 || index >= pages.length - 1;
  $('jump').disabled = viewLocked() || !pages.length;
  if ($('jump').value !== activeId) $('jump').value = activeId || '';
  $('deck').inert = editLocked();
  $('thumbnailList').inert = viewLocked();
  for (const id of ['pageSize', 'toggleThumbnails', 'thumbnailScale']) $(id).disabled = viewLocked();
  const batchEnd = view.pageSize === 'all' ? pages.length : Math.min(pages.length, batchStart + view.pageSize);
  $('viewRange').textContent = pages.length ? `${batchStart + 1}–${batchEnd} / ${pages.length}枚` : '0 / 0枚';
  $('previousBatch').disabled = viewLocked() || batchStart === 0;
  $('nextBatch').disabled = viewLocked() || batchEnd >= pages.length;
  $('thumbnailProgress').textContent = `現在 ${index < 0 ? 0 : index + 1} / ${pages.length} · 確認済み ${pages.filter(p=>p.done).length}`;
  $('temporarySave').disabled=busy||!!draftTask||!pages.length;
  $('savePreset').disabled=busy||!active()||!selected(active())||!PRESET_KINDS.includes(selected(active()).kind);
  for(const id of [...presetControls.map(([id])=>id),'autosaveEnabled','autosaveMinutes','restoreDraft','clearDraft'])$(id).disabled=busy;
  for(const b of document.querySelectorAll('[data-delete-preset]'))b.disabled=busy||!!preferences.presets.find(p=>p.id===preferences.defaults[b.dataset.deletePreset])?.builtin;
  updateDraftUI();
  pages.forEach((p, i) => {
    if (p.thumbnail) {
      const state = `${i}:${p.edited}:${p.done}:${p.id === activeId}`;
      if (p.thumbnailState !== state) {
        p.thumbnailState = state;
        p.thumbnail.classList.toggle('active', p.id === activeId);
        p.thumbnail.classList.toggle('edited', p.edited);
        p.thumbnail.classList.toggle('done', p.done);
        if (p.id === activeId) p.thumbnail.setAttribute('aria-current', 'page');
        else p.thumbnail.removeAttribute('aria-current');
        p.thumbnail.querySelector('.thumbnail-number').textContent = String(i + 1).padStart(2, '0');
        p.thumbnail.querySelector('.thumbnail-state').textContent = p.done ? '✓ 確認済み' : p.edited ? '編集済み' : '未編集';
        p.thumbnail.setAttribute('aria-label', `${i + 1}ページ ${p.name} ${p.done ? '確認済み' : p.edited ? '編集済み' : '未編集'}`);
      }
    }
    if (!p.row) return;
    for(const action of ['remove','delete','complete'])p.row.querySelector(`[data-action=${action}]`).disabled=busy||(action==='delete'&&!p.directory);
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
    if (copy) copy.disabled = busy || !p.layers.length || i === pages.length - 1;
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
  if (!p.img.complete || !p.img.naturalWidth) return;
  const scale = p.canvas.width / p.img.width;
  const displayScale = p.canvas.getBoundingClientRect().width / p.img.width || scale;
  draw(p.canvas.getContext('2d'), p.img, p.layers, p.id === activeId ? p.selectedId : null, scale, displayScale);
}

function sizePreview(p) {
  if (!p.row) return;
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
  const index = pages.indexOf(p);
  const nextStart = view.pageSize === 'all' ? 0 : Math.floor(index / view.pageSize) * view.pageSize;
  if (!p.row || batchStart !== nextStart) { batchStart = nextStart; syncVisiblePages(); }
  if (previous && previous !== p) drawPage(previous);
  updateControls(p); drawPage(p); updateGlobal();
  if (scroll) p.row.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function unmountPage(p) {
  if (!p.row) return;
  p.resizeObserver?.disconnect();
  p.canvas.width = 1; p.canvas.height = 1;
  p.row.remove(); p.row = null; p.canvas = null; p.resizeObserver = null;
  p.img.src = '';
}

function syncVisiblePages() {
  const count = view.pageSize === 'all' ? Math.max(1, pages.length) : view.pageSize;
  batchStart = Math.min(batchStart, Math.floor(Math.max(0, pages.length - 1) / count) * count);
  const visible = new Set(pages.slice(batchStart, batchStart + count));
  const wasSyncing=syncingView;syncingView = true;
  try {
    for (const p of pages) if (!visible.has(p)) unmountPage(p);
    let position=0;for (const p of visible) {
      if (!p.row) mountPage(p);
      const existing=$('deck').children[position++];if(existing!==p.row)$('deck').insertBefore(p.row,existing||null);
    }
  } finally { syncingView = wasSyncing; }
  updateGlobal();
}

function refreshThumbnails() {
  let position=0;
  for (const p of pages) {
    if (!p.thumbnail) {
      const thumbnail = element('button', 'thumbnail'); thumbnail.dataset.pageId = p.id;
      const image = element('img'); image.loading = 'lazy'; image.decoding = 'async'; image.src = p.thumbnailSrc; image.alt = '';
      const caption = element('span', 'thumbnail-caption');
      caption.append(element('b', 'thumbnail-number'), element('span', 'thumbnail-state'));
      const name = element('span', 'thumbnail-name', p.name); name.title = p.name;
      thumbnail.append(image, caption, name); p.thumbnail = thumbnail;
    }
    const existing=$('thumbnailList').children[position++];if(existing!==p.thumbnail)$('thumbnailList').insertBefore(p.thumbnail,existing||null);
  }
}

function applyViewSettings() {
  $('pageSize').value = String(view.pageSize);
  $('thumbnailSidebar').hidden = !view.thumbnails;
  $('workspace').classList.toggle('sidebar-hidden', !view.thumbnails);
  $('toggleThumbnails').textContent = view.thumbnails ? 'サムネイルを非表示' : 'サムネイルを表示';
  $('toggleThumbnails').setAttribute('aria-expanded', String(view.thumbnails));
  $('thumbnailScale').value = String(view.scale);
  $('thumbnailScaleValue').value = `${view.scale}%`;
  $('workspace').style.setProperty('--thumbnail-width', `${160 * view.scale / 100}px`);
}

function rememberView() {
  applyViewSettings();
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { status('表示設定を記憶できなかった。現在の表示には適用した。'); }
}
$('toggleThumbnails').onclick = () => { view.thumbnails = !view.thumbnails; rememberView(); };
$('thumbnailScale').oninput = event => { view.scale = Number(event.target.value); rememberView(); };
$('pageSize').onchange = event => {
  view.pageSize = event.target.value === 'all' ? 'all' : Number(event.target.value);
  const index = Math.max(0, pages.indexOf(active()));
  batchStart = view.pageSize === 'all' ? 0 : Math.floor(index / view.pageSize) * view.pageSize;
  rememberView(); syncVisiblePages();
  if (active()) activate(active());
};
$('thumbnailList').onclick = event => {
  if (viewLocked()) return;
  const p = pages.find(p=>p.id===event.target.closest('[data-page-id]')?.dataset.pageId);
  if (p) activate(p, p.selectedId, true);
};
for (const [id, offset] of [['previousBatch', -1], ['nextBatch', 1]]) $(id).onclick = () => {
  if (viewLocked() || view.pageSize === 'all') return;
  const p = pages[batchStart + offset * view.pageSize];
  if (p) activate(p, p.selectedId, true);
};

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

function renderCards(p) {
  if (!p.row) return;
  const container = p.row.querySelector('.layer-cards'); container.replaceChildren();
  p.row.querySelector('.no-layers').hidden = p.layers.length > 0;
  for (const l of p.layers) {
    const card = element('div', 'layer-card'); card.dataset.layerId = l.id; card.dataset.kind=l.kind;if(l.speaker)card.dataset.speaker = l.speaker;
    const header = element('div', 'card-header'),heading=element('div','card-heading');
    heading.append(element('span', 'kind-label', l.kind==='caption'?'▭ キャプション':l.kind==='balloon'?'○ 吹き出し':l.kind === 'sfx' ? '✦ 効果音' : l.speaker === 'female' ? '● 女性セリフ' : '● 男性セリフ'));
    if (l.kind === 'dialogue') {
      const roles = element('div', 'role-switch');roles.setAttribute('role','group');roles.setAttribute('aria-label','話者の切替');
      for (const [speaker, label] of [['male', '男性・黒'], ['female', '女性・ピンク']]) {
        const b = button(`speaker-${speaker}`, label);b.classList.toggle('chosen', l.speaker === speaker);b.setAttribute('aria-pressed',String(l.speaker===speaker));roles.append(b);
      }
      heading.append(roles);
    }
    header.append(heading);
    const mini = element('div', 'card-mini-actions');
    mini.append(button('duplicate', '複製'), button('drop-layer', '×', 'このレイヤーを削除')); header.append(mini); card.append(header);
    const presetLine=element('div','preset-controls'),presetSelect=element('select');
    presetSelect.dataset.presetSelect='';presetSelect.setAttribute('aria-label',`${presetLabels[l.kind]}プリセット`);
    presetLine.append(presetSelect,button('save-preset','保存','この設定に名前を付けてプリセットを保存'),button('delete-preset','削除','選択中の保存プリセットを削除'));card.append(presetLine);
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
      for(const [field,labelText,type] of [['textColor','文字色','color'],['textOutlineColor','文字の輪郭色','color'],['textOutlineWidth','文字の輪郭の太さ（px）','number'],['color','背景色','color'],['transparency','背景の透過率（%）','number'],['borderColor','枠線の色','color'],['borderWidth','枠線の太さ（px）','number'],['padding','内側の余白（px）','number']]){
        const label=element('label','',labelText),input=element('input');input.type=type;input.dataset.field=field;input.value=String(l[field]);
        if(type==='number'){[input.min,input.max]=CAPTION_LIMITS[field];input.step=['borderWidth','textOutlineWidth'].includes(field)?'0.5':'1';}label.append(input);grid.append(label);
      }
      for(const [field,labelText] of [['alignX','左右の揃え方'],['alignY','上下の揃え方']]){
        const label=element('label','',labelText),select=element('select');select.dataset.field=field;
        for(const [value,text] of Object.entries(CAPTION_ALIGNMENTS[field])){const option=element('option','',text);option.value=value;select.append(option);}select.value=l[field];label.append(select);grid.append(label);
      }
      const autoLabel=element('label','tail-toggle','文字サイズをボックスに合わせる'),auto=element('input');auto.type='checkbox';auto.dataset.field='autoFit';auto.checked=l.autoFit;autoLabel.prepend(auto);
      card.append(grid,autoLabel,element('p','effect-note','25%透過＝背景の不透明度75%。本文と枠線は不透明。左右・上下は初期値が中央。自動追従OFFならボックスを変えても文字サイズを保持。書体・文字方向・位置は右側で調整。'));container.append(card);continue;
    }
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
    container.append(card);
  }
  refreshPresetMenus(p); updateControls(p);
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
  p.img.onload = () => { if (p.row) { sizePreview(p); updateControls(p); } };
  p.img.onerror = () => { if (p.row) status(`「${p.name}」のプレビュー画像を読み込めなかった。`); };
  p.img.src = p.src;
  const scale = Math.min(1, 1400 / Math.max(p.img.width, p.img.height));
  p.canvas.width = Math.max(1, Math.round(p.img.width * scale)); p.canvas.height = Math.max(1, Math.round(p.img.height * scale));
  $('deck').append(row); renderCards(p);
  p.resizeObserver = new ResizeObserver(() => sizePreview(p)); p.resizeObserver.observe(row.querySelector('.preview-frame'));
  connectCanvas(p); sizePreview(p);
}

function refreshJump() {
  const wasSyncing=syncingView;syncingView=true;
  try{syncVisiblePages();refreshThumbnails();
    while($('jump').options.length>pages.length)$('jump').lastElementChild.remove();
    pages.forEach((p,i)=>{let option=$('jump').options[i];if(!option){option=element('option');$('jump').append(option);}const name=`${i+1}. ${p.name}`;if(option.value!==p.id)option.value=p.id;if(option.textContent!==name)option.textContent=name;});
  }finally{syncingView=wasSyncing;}
  updateGlobal();
}

function movePage(p, offset) {
  if(busy)return;
  const index = pages.indexOf(p), destination = index + offset;
  if (index < 0 || destination < 0 || destination >= pages.length) return;
  const neighbor = pages[destination];
  [pages[index], pages[destination]] = [neighbor, p];
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
  if (editLocked()) return;
  checkpoint(p); fn(); markChanged(p);
  if (rebuild) renderCards(p);else updateControls(p);
  drawPage(p);
}

$('deck').addEventListener('focusin', event => {
  if (editLocked()) return;
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
  if (editLocked()) return;
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
  l[field] = value;if(field!=='text')l.presetId=null;markChanged(p);drawPage(p);updateControls(p);if(field!=='text')refreshPresetMenus(p);
});

$('deck').addEventListener('click', event => {
  if (editLocked()) return;
  const p = pageFrom(event.target); if (!p) return;
  const card = event.target.closest('.layer-card'), cardId = card?.dataset.layerId;
  activate(p, cardId || p.selectedId);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || (busy&&['move-up','move-down','remove','delete','complete','copy-next','copy-all','cut-all','paste-all','save-image'].includes(action))) return;
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
  } else if (action === 'save-preset' && l) {
    saveSelectedPreset();
  } else if (action === 'delete-preset' && l) {
    deletePreset(card.querySelector('[data-preset-select]').value);
  } else if (action === 'duplicate' && l) {
    edit(p, () => { const copy = duplicateLayer(l); p.layers.push(copy); p.selectedId = copy.id; });
  } else if (action === 'drop-layer' && l) {
    edit(p, () => { p.layers = p.layers.filter(item => item.id !== l.id); p.selectedId = p.layers[0]?.id || null; });
  } else if (['backward', 'forward'].includes(action) && l) {
    edit(p, () => {if(l.kind==='balloon'){l.sfxOrder=action==='forward'?'above':'behind';l.presetId=null;return;} const i = p.layers.indexOf(l), j = clamp(i + (action === 'forward' ? 1 : -1), 0, p.layers.length - 1); [p.layers[i], p.layers[j]] = [p.layers[j], p.layers[i]]; });
  } else if (action === 'center' && l) {
    edit(p, () => { l.x = p.img.width / 2; l.y = p.img.height / 2;l.presetId=null; }, false);refreshPresetMenus();
  } else if (['undo', 'redo'].includes(action)) {
    if (restore(p, action)) { dirty(); renderCards(p); drawPage(p); updateGlobal(); }
  } else if (action === 'save-image') {
    guard(task=>saveImage(p,task),'PNG保存',2);
  } else if (action === 'move-up' || action === 'move-down') {
    movePage(p, action === 'move-up' ? -1 : 1);
  } else if (action === 'complete') {
    p.done = true; dirty(); updateGlobal();
    const next = pages[pages.indexOf(p) + 1];
    if (next) activate(next, next.selectedId, true); else status('最後の画像まで確認済み。一括保存で書き出せる。');
  } else if (['copy-all','cut-all','paste-all','copy-next'].includes(action)) {
    guard(task=>bulkLayers(action,p,task),'レイヤー一括操作',3);
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

async function bulkLayers(action,p,task){
  const source=action==='paste-all'?pageClipboard:{layers:p.layers,width:p.img.width,height:p.img.height,name:p.name};
  const target=action==='copy-next'?pages[pages.indexOf(p)+1]:p;if(!source?.layers.length||!target){task.stage('対象なし',0);return;}
  const copies=await prepareLayers(source.layers,layer=>action==='copy-all'||action==='cut-all'?structuredClone(layer):scaledCopy(layer,source.width,source.height,target.img.width,target.img.height),task);
  checkAbort(task.signal);task.stage('データ適用',copies.length);
  if(action==='copy-all'||action==='cut-all')pageClipboard={layers:copies,width:source.width,height:source.height,name:p.name,cut:action==='cut-all'};
  if(action==='cut-all'){checkpoint(p);p.layers=[];p.selectedId=null;dirty();}
  else if(action==='paste-all'||action==='copy-next'){checkpoint(target);target.layers.push(...copies);target.selectedId=action==='copy-next'?copies.at(-1).id:copies[0].id;dirty();}
  task.update({processed:copies.length,succeeded:copies.length},true);task.stage('画面反映',1);
  if(action!=='copy-all'){renderCards(target);drawPage(target);}if(action==='copy-next')activate(target,target.selectedId,true);else updateGlobal();
  task.result(target.name);status(`「${target.name}」の文字を${{ 'copy-all':'コピー','cut-all':'カット','paste-all':'貼付け','copy-next':'複製'}[action]}した（${copies.length}件）。`);
}

function coords(event, p) {
  const rect = p.canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * p.img.width / rect.width, y: (event.clientY - rect.top) * p.img.height / rect.height };
}

function connectCanvas(p) {
  p.canvas.addEventListener('pointerdown', event => {
    if (editLocked()) return;
    const pos = coords(event, p), scale = p.canvas.getBoundingClientRect().width / p.img.width;
    const current = selected(p), handle = current && handleAt(current, pos.x, pos.y, scale);
    const l = handle ? current : paintOrder(p.layers).reverse().find(item => hit(item, pos.x, pos.y));
    activate(p, l?.id || null); p.canvas.focus({ preventScroll: true });
    if (!l) return;
    drag = { page: p, id: event.pointerId, mode: handle || 'move', dx: pos.x - l.x, dy: pos.y - l.y, start: { ...l }, checkpointed: false };
    p.canvas.setPointerCapture(event.pointerId);
  });
  p.canvas.addEventListener('pointermove', event => {
    if (editLocked() || !drag || drag.page !== p || drag.id !== event.pointerId) return;
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
    dirty(); l.presetId=null; p.done = false;p.edited=true; drawPage(p); updateControls(p); updateGlobal();
  });
  const end = () => { if (drag?.page === p) { drag = null; updateControls(p);refreshPresetMenus(); } };
  p.canvas.addEventListener('pointerup', end); p.canvas.addEventListener('pointercancel', end);
}

window.addEventListener('keydown', event => {
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable || event.isComposing || editLocked()) return;
  const p = active(); if (!p) return;
  const key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
  if (key === 'delete' && event.target === p.canvas && !command && !event.altKey) {
    if (!selected(p) || event.repeat) return;
    event.preventDefault();
    edit(p, () => { p.layers = p.layers.filter(l=>l.id!==p.selectedId); p.selectedId = null; });
    p.canvas.focus({ preventScroll: true }); status('選択オブジェクトを削除した。Ctrl／⌘＋Zで戻せる。');
    return;
  }
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
  const index = pages.indexOf(p); pages.splice(index, 1); releasePage(p);
  if (activeId === p.id) activeId = pages[Math.min(index, pages.length - 1)]?.id || null;
  dirty(); refreshJump(); if (active()) activate(active());
}

$('previous').onclick = () => { const p = pages[pages.indexOf(active()) - 1]; if (p) activate(p, p.selectedId, true); };
$('next').onclick = () => { const p = pages[pages.indexOf(active()) + 1]; if (p) activate(p, p.selectedId, true); };
$('jump').onchange = () => { const p = pages.find(p => p.id === $('jump').value); if (p) activate(p, p.selectedId, true); };

async function guard(fn,kind='処理',stageCount=1) {
  if(busy)return;busy=true;drag=null;
  const task=new BulkTask(kind,{stageCount,onProgress:displayTask});task.metrics.poolStart=structuredClone(imagePool.metrics);currentTask=task;updateGlobal();let failure;
  try {if(draftTask){task.data.stageCount++;task.stage('一時保存の完了待ち');await awaitWithAbort(draftTask.catch(()=>{}),task.signal);}await fn(task);}
  catch(error){failure=error;if(error.name!=='AbortError')status(`処理できなかった: ${error.message}`);else status(`処理を中断した。${task.data.succeeded}件完了。${task.data.currentName}`);}
  finally{imagePool.resize(2);const poolDelta={jobs:imagePool.metrics.jobs-task.metrics.poolStart.jobs,fallbackJobs:imagePool.metrics.fallbackJobs-task.metrics.poolStart.fallbackJobs,timings:Object.fromEntries(Object.entries(imagePool.metrics.timings).map(([key,value])=>[key,value-(task.metrics.poolStart.timings[key]||0)]))};window.serifuMetrics={...task.finish(failure),poolDelta,pool:structuredClone(imagePool.metrics),cache:{bytes:pngCache.bytes,hits:pngCache.hits,misses:pngCache.misses}};currentTask=null;busy=false;updateGlobal();if(preferences.autosave.enabled&&revision!==lastSavedRevision)setTimeout(()=>temporarySave(false),0);}
}
function decode(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('画像を読み込めない')); img.src = src; });
}
async function addFiles(entries,task) {
  entries=entries.filter(e=>/\.(png|jpe?g|webp|gif|avif)$/i.test(e.file?.name||e.handle?.name));
  let count=0,failures=0,first=null,lastFlush=performance.now(),unflushed=0;
  const flush=()=>{if(!unflushed)return;if(!activeId&&first)activeId=first.id;dirty();const flushed=performance.now();refreshJump();task.metrics.flushMs=(task.metrics.flushMs||0)+performance.now()-flushed;if(task.metrics.firstEditableMs===null){task.metrics.firstEditableMs=performance.now()-task.started;}unflushed=0;lastFlush=performance.now();};
  if(entries.length>=4)imagePool.resize(4);task.stage('画像準備と表示反映',entries.length);
  try{for(let start=0;start<entries.length;start+=20){
    const batch=entries.slice(start,start+20),ready=[];
    for await(const result of boundedResults(batch,async entry=>{const file=entry.file||await entry.handle.getFile();return {...entry,file,expectedSize:await imageDimensions(file)};},{signal:task.signal,concurrency:2})){
      ready.push(result.error?{...batch[result.index],metadataError:result.error}:result.value);
    }
    for await(const result of boundedResults(ready,async entry=>{if(entry.metadataError)throw entry.metadataError;return {...entry,prepared:await prepareImage(entry.file,task,entry.expectedSize)};},queueOptions(task,true))){
      checkAbort(task.signal);const entry=ready[result.index],name=entry.file?.name||entry.handle?.name;
      if(result.error){failures++;task.result(name,false);(task.metrics.failures ||= []).push({name,reason:result.error.message});task.update({errorMessage:`${name}: ${result.error.message}`},true);continue;}
      const {file,directory=null,prepared}=result.value,p=createPage({name:file.name,src:URL.createObjectURL(file),file,directory,prepared});pages.push(p);first ||= p;count++;unflushed++;if(directory)sourceDirectory=directory;
      task.result(name);if(unflushed>=20||performance.now()-lastFlush>=100){flush();await yieldToBrowser();}
    }
    flush();await yieldToBrowser();
  }}finally{flush();}

  status(`${count} 枚を追加。画像ごとに下へスクロールして編集${failures?` · ${failures} 枚は読込失敗`:''}`);
}
$('open').onclick = () => {
  if(busy)return;if (!window.showDirectoryPicker) { $('folderInput').click(); status('フォルダ内の画像を読み込める。直接保存と元画像削除はPC版Chrome / Edgeが対象。'); return; }
  const picked=window.showDirectoryPicker({mode:'readwrite'}).then(parent=>({parent}),error=>({error}));
  guard(async task=>{const selection=await picked;if(selection.error)throw selection.error;const directory=selection.parent,entries=[];task.stage('フォルダ列挙');
    for await(const entry of directory.values()){checkAbort(task.signal);if(entry.kind==='file'&&/\.(png|jpe?g|webp|gif|avif)$/i.test(entry.name)){entries.push({handle:entry,directory});task.result(entry.name);}if(entries.length%20===0)await yieldToBrowser();}
    entries.sort((a,b)=>a.handle.name.localeCompare(b.handle.name,'ja',{numeric:true}));await addFiles(entries,task);
  },'画像追加',2);
};
$('files').onclick = () => {if(!busy)$('fileInput').click();};
for (const id of ['fileInput', 'folderInput']) $(id).onchange = event => {
  const files = [...event.target.files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true })); event.target.value = '';
  guard(task=>addFiles(files.map(file=>({file})),task),'画像追加');
};
function snapshotPages() { return pages.map(p => ({ ...p, layers: structuredClone(p.layers) })); }
function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function prepareExportFonts(snapshot,task) {
  task?.stage('書体準備');if(!document.fonts)return;
  const queries=new Set(snapshot.flatMap(p=>p.layers.filter(l=>l.kind!=='balloon').map(l=>fontDescription(l).load)).filter(Boolean));
  for(const query of queries){checkAbort(task?.signal);const faces=await document.fonts.load(query);if(!faces.length)throw new Error(`書体を読込できない: ${query}`);}
  clearGlyphCache();
}
async function imageBlobFallback(p) {
  const canvas=document.createElement('canvas');canvas.width=p.img.width;canvas.height=p.img.height;let image;
  try {image=await decode(p.src);draw(canvas.getContext('2d'),image,p.layers);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('PNG生成に失敗');return blob;}
  finally{canvas.width=1;canvas.height=1;if(image)image.src='';}
}
async function imageBlob(p,task){
  const key=exportKey(p,fontVersion),cached=pngCache.get(key);if(cached)return cached;
  const blob=await imagePool.run('render-png',{blob:await originalBlob(p),width:p.img.width,height:p.img.height,layers:p.layers},task,()=>imageBlobFallback(p));
  checkAbort(task?.signal);pngCache.put(key,blob,p.id);return blob;
}
async function saveImage(p,task) {
  const snapshot={...p,layers:structuredClone(p.layers)},name=exportName(p.name,pages.indexOf(p));await prepareExportFonts([snapshot],task);task.stage('PNG生成',1);const blob=await imageBlob(snapshot,task);checkAbort(task.signal);download(blob,name);task.result(name,true,blob.size);status(`「${name}」のダウンロードを開始した`);
}
async function saveImages(task,editedOnly=false,picked) {
  if(!picked)return saveImagesZip(task,editedOnly);
  task.stage('保存先の選択と準備');task.update({currentName:'保存先フォルダを選択してほしい'},true);
  const selection=await awaitWithAbort(picked,task.signal);if(selection.error)throw selection.error;const parent=selection.parent;checkAbort(task.signal);
  const allPages=snapshotPages(),snapshot=allPages.map((p,index)=>({...p,pageIndex:index})).filter(p=>!editedOnly||p.edited),format=$('projectFormat').value,prefs=structuredClone(preferences),captured=revision;
  if(!snapshot.length){task.stage('対象なし',0);status('保存対象の編集済み画像がない。');return;}
  const folder=`serifu_${new Date().toISOString().replace(/[:.]/g,'-')}_${crypto.randomUUID().slice(0,8)}`;task.update({currentName:`${parent.name||'保存先'}/${folder}`},true);const directory=await awaitWithAbort(parent.getDirectoryHandle(folder,{create:true}),task.signal);let completed=0,projectSaved=false;task.metrics.pngWritten=0;task.metrics.projectSaved=false;
  try{await prepareExportFonts(snapshot,task);task.stage('PNG生成と書込み',snapshot.length);
    for await(const result of boundedResults(snapshot,p=>imageBlob(p,task),queueOptions(task))){const p=snapshot[result.index],name=pageExportName(p.name,p.pageIndex,allPages.length);task.update({currentName:name});if(result.error)throw new Error(`${p.name}: ${result.error.message}`);checkAbort(task.signal);const started=performance.now();await writeParts(directory,name,[result.value],task.signal);task.metrics.writeMs=(task.metrics.writeMs||0)+performance.now()-started;completed++;task.metrics.pngWritten=completed;task.result(name,true,result.value.size);}
    await writeParts(directory,`serifu-project.${format}`,projectParts(snapshot,prefs,{format,task}),task.signal,bytes=>task.update({writtenBytes:task.data.writtenBytes+bytes}),()=>task.stage('編集データの書込み確定',1));projectSaved=true;task.result(`serifu-project.${format}`);task.metrics.pngWritten=completed;task.metrics.projectSaved=true;
    if((!editedOnly||snapshot.length===allPages.length)&&captured===revision)changed=false;
    status(`${snapshot.length} 枚と編集データを「${parent.name?parent.name+'/':''}${folder}」へ保存した`);
  }catch(error){const failedStage=task.data.stage;task.metrics.errorFile=failedStage==='書体準備'?'':failedStage==='PNG生成と書込み'?task.data.currentName:`serifu-project.${format}`;task.update({currentName:`${folder} · PNG ${completed}枚 · 編集データ${projectSaved?'あり':'なし'}`},true);if(error.name==='AbortError')throw error;if(failedStage==='書体準備')task.result('書体準備',false);else{if(failedStage!=='PNG生成と書込み')task.stage('編集データの書込み確定',1);task.result(task.metrics.errorFile,false);}throw new Error(`${folder} 内に ${completed} 枚保存済み。${error.message}`);}
}
async function saveImagesZip(task,editedOnly){
  const allPages=snapshotPages(),snapshot=allPages.map((p,index)=>({...p,pageIndex:index})).filter(p=>!editedOnly||p.edited),format=$('projectFormat').value,prefs=structuredClone(preferences);
  if(!snapshot.length){task.stage('対象なし',0);status('保存対象の編集済み画像がない。');return;}
  const archive=new ZipArchive(),name=`serifu${editedOnly?'-edited':''}_${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;task.metrics.pngPacked=0;
  await prepareExportFonts(snapshot,task);task.stage('PNG生成とZIP準備',snapshot.length);
  for await(const result of boundedResults(snapshot,p=>imageBlob(p,task),queueOptions(task))){const p=snapshot[result.index],filename=pageExportName(p.name,p.pageIndex,allPages.length);task.update({currentName:filename});if(result.error)throw new Error(`${p.name}: ${result.error.message}`);await archive.add(filename,result.value,task.signal);task.metrics.pngPacked++;task.result(filename);}
  const project=await projectBlob(snapshot,prefs,{format,task});task.stage('ZIP作成',1);await archive.add(`serifu-project.${format}`,project,task.signal);const blob=archive.blob(task.signal);task.result(name);task.stage('ダウンロード準備',1);checkAbort(task.signal);download(blob,name);task.metrics.archiveEntries=archive.entries.length;task.result(name);status(`${snapshot.length} 枚と編集データをまとめた「${name}」のダウンロードを開始した。展開して利用できる。`);
}
function startSave(editedOnly=false){
  if(busy)return;let picked;
  if(typeof window.showDirectoryPicker==='function'){const startIn=pages.some(p=>p.directory===sourceDirectory)?sourceDirectory:pages.find(p=>p.directory)?.directory;try{picked=Promise.resolve(window.showDirectoryPicker({mode:'readwrite',...(startIn?{startIn}:{})})).then(parent=>({parent}),error=>({error}));}catch(error){picked=Promise.resolve({error});}}
  guard(task=>saveImages(task,editedOnly,picked),picked?'一括PNG保存':editedOnly?'編集済み画像ZIP保存':'一括PNG ZIP保存',5);
}
$('save').onclick = () => startSave();
$('saveEdited').onclick = () => startSave(true);
$('textSave').onclick = () => guard(async task => {
  const target=$('textTarget').value,snapshot=snapshotPages(),parts=[];task.stage('ページ走査',snapshot.length);
  for(const p of snapshot){checkAbort(task.signal);parts.push(textExport([p],target));task.result(p.name);if(parts.length%20===0)await yieldToBrowser();}
  task.stage('整形',1);const text=parts.join('');task.result('本文');if(!text){task.stage('対象なし',0);status('選択した対象に出力できる本文がない。');return;}checkAbort(task.signal);task.stage('ダウンロード準備',1);
  download(new Blob(['\ufeff',text],{type:'text/plain;charset=utf-8'}),`serifu-${target}.txt`);task.result(`serifu-${target}.txt`);status(`${$('textTarget').selectedOptions[0].textContent}のテキストのダウンロードを開始した`);
},'本文テキスト出力',3);
$('projectSave').onclick = () => guard(async task => {
  if(!pages.length){task.stage('対象なし',0);return;}task.stage('メタ情報準備',pages.length);const snapshot=snapshotPages(),prefs=structuredClone(preferences);task.update({processed:snapshot.length,succeeded:snapshot.length});const format=$('projectFormat').value,blob=await projectBlob(snapshot,prefs,{format,task});checkAbort(task.signal);task.stage('ダウンロード準備',1);download(blob,`serifu-project.${format}`);task.result(`serifu-project.${format}`,true,blob.size);status('編集データのダウンロードを開始した');
},'編集データ保存',3);
async function prepareProjectPages(records,version,task,{restoreIds=false}={}){
  task.stage('検証',records.length);const validated=[];
  for(const p of records){checkAbort(task.signal);try{validated.push({...p,layers:p.layers.map(l=>normalizeLayer(l,version))});task.result(p.name);}catch(error){task.result(p.name,false);throw new Error(`${p.name}: ${error.message}`);}if(validated.length%20===0)await yieldToBrowser();}
  const loaded=[],sources=new Map();if(records.length>=4)imagePool.resize(4);task.stage('画像準備',records.length);
  try{for(let start=0;start<validated.length;start+=20){
    const batch=validated.slice(start,start+20),ready=[];
    for await(const result of boundedResults(batch,async p=>{let blob=p.blob;if(!blob){if(!sources.has(p.src))sources.set(p.src,originalBlob(p));blob=await sources.get(p.src);}checkAbort(task.signal);const dimensions=await imageDimensions(blob);return {...p,blob,allocationSize:p.expectedSize||dimensions,thumbnailSize:dimensions};},{signal:task.signal,concurrency:2})){
      if(result.error){task.result(batch[result.index].name,false);throw new Error(`${batch[result.index].name}: ${result.error.message}`);}ready.push(result.value);
    }
    for await(const result of boundedResults(ready,async p=>prepareImage(p.blob,task,p.thumbnailSize),{...queueOptions(task,true),estimate:p=>({...jobEstimate({...p,expectedSize:p.allocationSize}),result:320*320*4+65536})})){
      if(result.error){task.result(ready[result.index].name,false);throw new Error(`${ready[result.index].name}: ${result.error.message}`);}checkAbort(task.signal);const p=ready[result.index],prepared=result.value;
      if(p.expectedSize&&(p.expectedSize.width!==prepared.width||p.expectedSize.height!==prepared.height))throw new Error(`画像寸法が不正: ${p.name}`);
      loaded.push(createPage({id:restoreIds?p.id:undefined,name:p.name,layers:p.layers,done:p.done===true,edited:p.edited===true,expectedSize:p.expectedSize,preserveEdited:restoreIds&&typeof p.edited==='boolean',src:URL.createObjectURL(p.blob),file:p.blob,prepared}));task.result(p.name);
    }
    await yieldToBrowser();
  }

    checkAbort(task.signal);return loaded;
  }catch(error){loaded.forEach(releasePage);throw error;}
}
$('projectLoad').onclick = () => {if(!busy)$('projectInput').click();};
$('projectInput').onchange = event => {
  const file=event.target.files[0];event.target.value='';if(!file)return;
  guard(async task=>{task.stage('ファイル解析',1);let data;try{data=await readProject(file,{signal:task.signal});task.result(file.name);}catch(error){if(error.name!=='AbortError')task.result(file.name,false);throw error;}const loaded=await prepareProjectPages(data.pages,data.version,task);checkAbort(task.signal);
    pages.push(...loaded);const presetNotice=mergePresets(data.preferences);dirty();task.stage('一覧反映',loaded.length);refreshJump();activate(loaded[0],loaded[0].selectedId,true);task.update({processed:loaded.length,succeeded:loaded.length},true);
    status((data.version===1?'旧データを追加。吹き出しは白縁の男性セリフへ変換した。':'編集データを追加。元ファイルとの接続がないため元画像削除は無効。')+presetNotice);
  },'編集データ読込',4);
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
    pages.push(p);
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
function refreshPresetMenus(target=null) {
  if(!target)for(const [id,kind] of presetControls)fillPresetSelect($(id),kind,preferences.defaults[kind]);
  for(const p of target?[target]:pages)if(p.row)for(const card of p.row.querySelectorAll('.layer-card')){
    const layer=p.layers.find(l=>l.id===card.dataset.layerId),select=card.querySelector('[data-preset-select]');
    if(layer&&select){
      fillPresetSelect(select,layer.kind,layer.presetId,true);
      const preset=preferences.presets.find(p=>p.id===layer.presetId&&p.kind===layer.kind);
      card.querySelector('[data-action=delete-preset]').disabled=busy||!preset||preset.builtin;
    }
  }
  for(const b of document.querySelectorAll('[data-delete-preset]'))b.disabled=busy||!!preferences.presets.find(p=>p.id===preferences.defaults[b.dataset.deletePreset])?.builtin;
}
function persistPreferences() {
  let remembered=true;
  try {localStorage.setItem(PREFS_KEY,JSON.stringify(preferences));}
  catch(error){remembered=false;status(`設定をブラウザに記憶できなかった: ${error.message}`);}
  refreshPresetMenus();
  return remembered;
}
function mergePresets(input) {
  if(!input)return '';
  const imported=normalizePreferences(input);
  let count=preferences.presets.filter(p=>!p.builtin).length,skipped=0;
  for(const preset of imported.presets.filter(p=>!p.builtin)){
    if(preferences.presets.some(p=>p.id===preset.id))continue;
    if(count>=MAX_USER_PRESETS){skipped++;continue;}
    preferences.presets.push(preset);count++;
  }
  for(const kind of PRESET_KINDS)if(preferences.presets.some(p=>p.id===imported.defaults[kind]&&p.kind===kind))preferences.defaults[kind]=imported.defaults[kind];
  persistPreferences();
  return skipped?` プリセットの上限${MAX_USER_PRESETS}件のため${skipped}件は未登録。配置済みの見た目は保持。`:'';
}
for(const [id,kind] of presetControls)$(id).onchange=()=>{
  preferences.defaults[kind]=$(id).value;persistPreferences();dirty();updateGlobal();
};
function saveSelectedPreset() {
  const p=active(),layer=p&&selected(p);if(busy||!layer||!PRESET_KINDS.includes(layer.kind))return;
  const name=prompt('この設定のプリセット名（本文・話者は保持し、書式と配置を保存）',preferences.presets.find(p=>p.id===layer.presetId&&!p.builtin)?.name||'');
  if(!name?.trim())return;
  if(name.trim().length>60){status('プリセット名は60文字以内で入力。');return;}
  const existing=preferences.presets.find(p=>!p.builtin&&p.kind===layer.kind&&p.name===name.trim());
  if(existing&&!confirm(`同じ名前のプリセット「${existing.name}」を上書きする？`))return;
  if(!existing&&preferences.presets.filter(p=>!p.builtin).length>=MAX_USER_PRESETS){status(`保存できるプリセットは${MAX_USER_PRESETS}件まで。不要なプリセットを削除してから保存。`);return;}
  const preset=createPreset(name,layer,p.img.width,p.img.height);
  if(existing){preset.id=existing.id;preferences.presets.splice(preferences.presets.indexOf(existing),1,preset);}else preferences.presets.push(preset);
  layer.presetId=preset.id;preferences.defaults[layer.kind]=preset.id;const remembered=persistPreferences();dirty();updateGlobal();
  status(remembered?`「${preset.name}」を記憶。＋ボタンと次の画像でもこの設定を使う。`:'設定はこのタブに適用済み。ブラウザへの記憶は失敗したため、編集データを書き出して保管。');
}
$('savePreset').onclick=saveSelectedPreset;
function deletePreset(id) {
  const preset=preferences.presets.find(p=>p.id===id);
  if(busy||!preset||preset.builtin||!confirm(`プリセット「${preset.name}」を削除する？ 配置済みのオブジェクトは残る。`))return;
  preferences.presets=preferences.presets.filter(p=>p.id!==preset.id);
  if(preferences.defaults[preset.kind]===preset.id)preferences.defaults[preset.kind]=defaultPreferences().defaults[preset.kind];
  for(const p of pages)for(const l of p.layers)if(l.presetId===preset.id)l.presetId=null;
  const remembered=persistPreferences();dirty();updateGlobal();
  status(remembered?`プリセット「${preset.name}」を削除した。配置済みのオブジェクトは保持。`:'このタブでプリセットを削除した。ブラウザへの記憶は失敗。編集データを保存して保管。');
}
for(const button of document.querySelectorAll('[data-delete-preset]'))button.onclick=()=>deletePreset(preferences.defaults[button.dataset.deletePreset]);
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
  if(draftTask){if(!$('draftStatus').textContent.startsWith('自動保存'))$('draftStatus').textContent='一時保存中…';return;}
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
  const task=new BulkTask(manual?'一時保存':'自動保存',{stageCount:3,onProgress:data=>{if(manual&&currentTask?.data.operationId===data.operationId)displayTask(data);else if(!manual)$('draftStatus').textContent=`自動保存 · ${data.stage} ${data.processed}/${data.total??'未確定'}`;}});
  if(manual){currentTask=task;task.emit(true);}delete $('draftStatus').dataset.error;
  draftTask=(async()=>{await storageReady;checkAbort(task.signal);const ids=await getImageIds(),missing=snapshot.filter(p=>!ids.has(p.id)),images=[];task.stage('画像差分準備',missing.length);
    for(const p of missing){checkAbort(task.signal);const blob=await originalBlob(p),original=pages.find(page=>page.id===p.id);if(original)original.assetBlob=blob;images.push({id:p.id,blob});task.result(p.name);if(images.length%20===0)await yieldToBrowser();}
    task.metrics.newImages=images.length;task.stage('DB要求',images.length);if(!images.length)task.stage('コミット',1);
    await writeDraft(meta,images,{signal:task.signal,onProgress:(processed,total)=>{if(processed===total)task.stage('コミット',1);else task.update({processed,total,succeeded:0});}});
    task.result('一時保存');draftMeta=meta;lastSavedRevision=captured;changed=revision!==captured;
  })();updateDraftUI();let failure;
  try{await draftTask;if(manual)status('画像・文字・位置・設定をこのブラウザに一時保存した。');}
  catch(error){failure=error;if(error.name!=='AbortError')task.result('一時保存',false);$('draftStatus').dataset.error='true';$('draftStatus').textContent=error.name==='AbortError'?'一時保存を中断。前回の保存を維持。':error.name==='QuotaExceededError'?'保存容量不足。編集データを書き出して保管。':`一時保存に失敗: ${error.message}`;if(manual)status($('draftStatus').textContent);}
  finally{const metrics=task.finish(failure);if(currentTask===task){currentTask=null;window.serifuDraftMetrics=metrics;}draftTask=null;updateDraftUI();updateGlobal();}
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
$('restoreDraft').onclick=()=>guard(async task=>{
  await storageReady;task.stage('メタ情報');const meta=await getDraftMeta();if(!meta)return;
  if(pages.length&&!confirm('現在の一覧を一時保存の内容に置き換える？ 保存後の変更は失われる。'))return;
  if(![3,4,5,6].includes(meta.version)||!Array.isArray(meta.pages))throw new Error('未対応の一時保存データ');
  task.stage('画像取得',meta.pages.length);const images=await getDraftImages(meta.pages.map(p=>p.id));checkAbort(task.signal);
  const loaded=await prepareProjectPages(meta.pages.map((p,i)=>({...p,blob:images[i].blob})),meta.version,task,{restoreIds:true});checkAbort(task.signal);
  pages.forEach(releasePage);$('deck').replaceChildren();pages=loaded;activeId=loaded[0]?.id||null;drag=null;pngCache.clear();
  batchStart=0;const presetNotice=mergePresets(meta.preferences);task.stage('一覧置換',loaded.length);refreshJump();if(active())activate(active());task.update({processed:loaded.length,succeeded:loaded.length},true);
  dirty();lastSavedRevision=revision;changed=false;draftMeta=meta;updateDraftUI();status('一時保存を復元した。元ファイルへの接続はないため、元画像削除は無効。'+presetNotice);
},'一時保存復元',5);
$('clearDraft').onclick=()=>guard(async()=>{
  if(!confirm('このブラウザの一時保存を消去する？ 編集中の画像は残る。'))return;
  await forgetDraft();draftMeta=null;lastSavedRevision=-1;delete $('draftStatus').dataset.error;updateDraftUI();
  status('一時保存を消去した。自動保存がONなら次の周期で再保存する。');
});
applyViewSettings();refreshPresetMenus();configureAutosave();updateGlobal();
if(document.fonts){
  const redrawFonts=()=>{fontVersion++;pngCache.clear();clearGlyphCache();pages.forEach(drawPage);};
  document.fonts.addEventListener('loadingdone',redrawFonts);
  document.fonts.load('900 64px MangaBold').then(redrawFonts).catch(()=>{});
}
