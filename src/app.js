import { newLayer, draw, hit, handleAt, localPoint, clamp, EFFECTS, WARP_CHOICES, clearGlyphCache, paintOrder, dialogueColor } from './renderer.js';
import { BALLOON_LIMITS, BALLOON_SHAPES } from './balloons.js';
import { BRUSH_LIMITS, BRUSH_MODES } from './brush-stroke.js';
import { PLACEMENT_LIMITS } from './glyph-layout.js';
import { CAPTION_LIMITS, CAPTION_ALIGNMENTS, captionLayout } from './captions.js';
import { PROJECT_VERSION, normalizeLayers, normalizeMaskEffects, reorderPageObjects, checkpoint, restore, duplicateLayer, dragPlacement, copyLayers, pasteSelectedLayers, selectedLayers, setSelection, syncSelection, hasEdits, scaledCopy, EFFECT_LIMITS, THICKNESS_LIMIT, defaultMaskEffect, normalizeMaskEffect, pruneMaskAssets } from './model.js';
import { normalizeImageEdit, imageSize, imageMatrix, imagePoint, rotateImage, cropImage, cropHandles, cropModeAt, dragCropRectangle, uncroppedImageEdit, cropInFullView } from './image-edit.js';
import { openFullPreview, previewIsOpen } from './preview-modal.js';
import { toggleMagnifier, refreshMagnifier, closeMagnifier } from './preview-magnifier.js';
import { exportName } from './renderer.js';
import { pageExportName, textExport } from './export.js';
import { PREFS_KEY, defaultPreferences, normalizePreferences, createPreset, applyPreset, PRESET_KINDS, MAX_USER_PRESETS } from './presets.js';
import { getDraftMeta, getDraftImages, getDraftMasks, getImageIds, saveDraft as writeDraft, clearDraft as forgetDraft } from './storage.js';
import { BulkTask, boundedResults, checkAbort, awaitWithAbort, yieldToBrowser, prepareLayers } from './bulk-task.js';
import { ZipArchive } from './zip.js';
import { imageDimensions } from './image-metadata.js';
import { ImagePool } from './bulk-pool.js';
import { ExportCache, exportKey } from './export-cache.js';
import { originalBlob, projectParts, projectBlob, readProject, writeParts, MAX_PROJECT_MASK_DECODED_BYTES } from './project-io.js';
import { safeFilenamePart, filenameTimestamp, projectFileName, uploadedFolderName, projectFolderName } from './project-filenames.js';
import { FONT_CATALOG, FONT_STYLES, fontLoadQueries } from './fonts.js';
import { Sam3Client } from './sam3-client.js';
import { createSam3UI, createMaskEffectCard, renderMaskEffectSummary } from './sam3-ui.js';

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
const fontWaiters=new Map();
const fontErrors=new Set();
function requestPageFonts(p){
  if(!document.fonts)return;
  for(const query of new Set(p.layers.flatMap(fontLoadQueries))){
    if(!query||document.fonts.check(query))continue;
    if(fontLoads.has(query)){fontWaiters.get(query)?.add(p);continue;}
    const waiting=new Set([p]);fontWaiters.set(query,waiting);
    fontLoads.set(query,document.fonts.load(query).then(()=>{fontErrors.delete(query);clearGlyphCache();const affected=new Set([...pages,...waiting]);affected.forEach(page=>{drawPage(page);scheduleThumbnailRefresh(page,true);updateControls(page);});}).catch(error=>{fontErrors.add(query);for(const page of new Set([...pages,...waiting]))updateControls(page);status(`書体を読み込めなかった: ${error.message}。ページを再読込して再試行。`);}).finally(()=>fontWaiters.delete(query)));
  }
}
let pages = [], activeId = null, busy = false, drag = null, changed = false;
const previewDeferredDraws = new Set(), previewDeferredThumbnails = new Set();
let previewResumeScheduled = false;
function resumePreviewBackground() {
  if (previewResumeScheduled || previewIsOpen()) return;
  previewResumeScheduled = true;
  const resume = () => {
    previewResumeScheduled = false;
    if (previewIsOpen()) return;
    const page = previewDeferredDraws.values().next().value;
    if (page) { previewDeferredDraws.delete(page); if (page.canvas) drawPage(page); }
    else {
      const thumbnailPage = previewDeferredThumbnails.values().next().value;
      if (thumbnailPage) { previewDeferredThumbnails.delete(thumbnailPage); scheduleThumbnailRefresh(thumbnailPage); }
    }
    if (previewDeferredDraws.size || previewDeferredThumbnails.size) resumePreviewBackground();
  };
  if (window.requestIdleCallback) requestIdleCallback(resume, { timeout: 1000 });
  else setTimeout(resume, 16);
}
$('fullPreview').addEventListener('close', resumePreviewBackground);
let sourceDirectory = null, sourceFolderName = null, currentTask=null, fontVersion=0;
const imagePool=new ImagePool(),pngCache=new ExportCache(),sam3Client=new Sam3Client();
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
function releasePage(p){previewDeferredThumbnails.delete(p);disposeSam3UI(p);unmountPage(p);void sam3Client.forgetPage(p.id);p.thumbnailReleased=true;clearTimeout(p.thumbnailTimer);p.thumbnailGeneration++;p.thumbnail?.remove();if(p.src.startsWith('blob:'))URL.revokeObjectURL(p.src);for(const url of new Set([p.thumbnailBaseSrc,p.thumbnailSrc]))if(url?.startsWith('blob:'))URL.revokeObjectURL(url);pngCache.invalidate(p.id);}

const VIEW_KEY = 'serifu.view.v1';
const PAGE_FILTERS = ['all', 'unedited', 'edited', 'pending', 'done'];
let view = { pageSize: 50, thumbnails: true, scale: 100, sidebarWidth: null, filter: 'all' }, batchStart = 0, syncingView = false;
let displayedOrder = '';
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY));
  if ([50, 100, 'all'].includes(saved?.pageSize)) view.pageSize = saved.pageSize;
  if (typeof saved?.thumbnails === 'boolean') view.thumbnails = saved.thumbnails;
  if (Number.isFinite(saved?.scale)) view.scale = clamp(saved.scale, 50, 200);
  if (Number.isFinite(saved?.sidebarWidth)) view.sidebarWidth = Math.max(220, saved.sidebarWidth);
  if (PAGE_FILTERS.includes(saved?.filter)) view.filter = saved.filter;
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

function createPage({ id=crypto.randomUUID(), name, src, img, prepared, file = null, directory = null, layers = [], done = false, imageEdit = null, maskEffects = [], maskAssets = {}, selectedMaskId = null }) {
  let thumbnailBaseSrc;
  if(prepared){img=new Image(prepared.width,prepared.height);thumbnailBaseSrc=URL.createObjectURL(prepared.thumbnail);}
  else{
    const thumbnail=document.createElement('canvas'),ratio=Math.min(1,320/Math.max(img.width,img.height));
    thumbnail.width=Math.max(1,Math.round(img.width*ratio));thumbnail.height=Math.max(1,Math.round(img.height*ratio));thumbnail.getContext('2d').drawImage(img,0,0,thumbnail.width,thumbnail.height);thumbnailBaseSrc=thumbnail.toDataURL('image/webp',.75);thumbnail.width=1;thumbnail.height=1;
    img.width=img.naturalWidth||img.width;img.height=img.naturalHeight||img.height;img.onload=null;img.onerror=null;img.src='';
  }
  imageEdit=normalizeImageEdit(imageEdit,img.width,img.height);
  return { id, name, src, thumbnailSrc:thumbnailBaseSrc, thumbnailBaseSrc, thumbnailRenderedSignature:layers.length||imageEdit||maskEffects.length?null:thumbnailSignature({layers,imageEdit,maskEffects}), thumbnailGeneration:0, img, file, directory, layers, done, imageEdit, maskEffects, maskAssets, selectedMaskId:maskEffects.some(effect=>effect.id===selectedMaskId)?selectedMaskId:null, sam3Draft:null, edited:layers.length>0||!!imageEdit||maskEffects.length>0, selectedId: layers[0]?.id || null, selectedIds: layers.slice(0,1).map(l=>l.id), undo: [], redo: [] };
}
function thumbnailSignature(p){return `${fontVersion}:${JSON.stringify([p.layers,p.imageEdit??null,p.maskEffects??[]])}`;}
async function renderPageThumbnail(p,signal,force=false){
  checkAbort(signal);
  const signature=thumbnailSignature(p);
  if(!force&&p.thumbnailRenderedSignature===signature)return;
  const generation=++p.thumbnailGeneration;
  if(!hasEdits(p)){
    const previous=p.thumbnailSrc;p.thumbnailSrc=p.thumbnailBaseSrc;p.thumbnailRenderedSignature=signature;
    const image=p.thumbnail?.querySelector('img');if(image)image.src=p.thumbnailSrc;
    if(previous&&previous!==p.thumbnailBaseSrc&&previous.startsWith('blob:'))URL.revokeObjectURL(previous);
    return;
  }
  let base,canvas;
  try{
    base=await decode(p.maskEffects?.length?p.src:p.thumbnailBaseSrc);checkAbort(signal);
    if (!signal && previewIsOpen()) { previewDeferredThumbnails.add(p);p.thumbnailForce ||= force;return; }
    const size=imageSize(p.img.width,p.img.height,p.imageEdit),ratio=Math.min(1,320/Math.max(size.width,size.height));
    canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(size.width*ratio));canvas.height=Math.max(1,Math.round(size.height*ratio));
    draw(canvas.getContext('2d'),base,p.layers,null,ratio,ratio,p.imageEdit,p.img,{maskEffects:p.maskEffects,maskAssets:p.maskAssets});
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.8));
    if(!blob)throw new Error('サムネイルを生成できない');checkAbort(signal);
    if(generation!==p.thumbnailGeneration||thumbnailSignature(p)!==signature)return;
    const url=URL.createObjectURL(blob),previous=p.thumbnailSrc;
    p.thumbnailSrc=url;p.thumbnailRenderedSignature=signature;
    const image=p.thumbnail?.querySelector('img');if(image)image.src=url;
    if(previous&&previous!==p.thumbnailBaseSrc&&previous.startsWith('blob:'))URL.revokeObjectURL(previous);
  }finally{
    if(base)base.src='';
    if(canvas){canvas.width=1;canvas.height=1;}
  }
}
function scheduleThumbnailRefresh(p,force=false){
  if(!p?.thumbnailBaseSrc||p.thumbnailReleased)return;
  p.thumbnailWantedSignature=thumbnailSignature(p);p.thumbnailForce=!!p.thumbnailForce||force;
  clearTimeout(p.thumbnailTimer);
  if(previewIsOpen()){p.thumbnailTimer=null;previewDeferredThumbnails.add(p);return;}
  previewDeferredThumbnails.delete(p);
  p.thumbnailTimer=setTimeout(()=>{
    p.thumbnailTimer=null;
    if(previewIsOpen()){previewDeferredThumbnails.add(p);return;}
    if(p.thumbnailRendering)return;
    const targetSignature=p.thumbnailWantedSignature,rebuild=p.thumbnailForce;p.thumbnailForce=false;
    const rendering=renderPageThumbnail(p,null,rebuild).catch(error=>{
      if(!p.thumbnailReleased&&error.name!=='AbortError'){p.thumbnailFailedSignature=targetSignature;status(`「${p.name}」のサムネイルを更新できなかった: ${error.message}`);}
    }).finally(()=>{
      if(p.thumbnailRendering!==rendering)return;
      p.thumbnailRendering=null;
      if(p.thumbnailForce||(p.thumbnailWantedSignature!==p.thumbnailRenderedSignature&&(p.thumbnailWantedSignature!==p.thumbnailFailedSignature||p.thumbnailForce)))scheduleThumbnailRefresh(p,p.thumbnailForce);
    });
    p.thumbnailRendering=rendering;
  },70);
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

function matchesPageFilter(p) {
  return view.filter === 'all' || view.filter === 'unedited' && !p.edited || view.filter === 'edited' && p.edited
    || view.filter === 'pending' && !p.done || view.filter === 'done' && p.done;
}
function displayedPages() { return pages.filter(p => matchesPageFilter(p) || p.id === activeId); }

function updateGlobal() {
  if (syncingView) return;
  const displayed = displayedPages();
  if (displayedOrder !== displayed.map(p => p.id).join(',')) { refreshJump(); return; }
  const matchingCount = pages.filter(matchesPageFilter).length;
  const pinned = displayed.length > matchingCount;
  $('filteredEmpty').hidden = !pages.length || !!displayed.length;
  $('thumbnailFilterEmpty').hidden = !pages.length || !!displayed.length;
  $('thumbnailFilterCount').textContent = `${matchingCount} / ${pages.length}枚${pinned ? ' · 編集中の1枚を表示中' : ''}`;
  for (const button of $('thumbnailFilters').querySelectorAll('button')) button.disabled = viewLocked();
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
  const index = displayed.findIndex(p => p.id === activeId);
  $('previous').disabled = viewLocked() || index <= 0;
  $('next').disabled = viewLocked() || index < 0 || index >= displayed.length - 1;
  $('jump').disabled = viewLocked() || !displayed.length;
  if ($('jump').value !== activeId) $('jump').value = activeId || '';
  $('deck').inert = editLocked();
  $('thumbnailList').inert = viewLocked();
  for (const id of ['pageSize', 'toggleThumbnails', 'thumbnailScale']) $(id).disabled = viewLocked();
  const batchEnd = view.pageSize === 'all' ? displayed.length : Math.min(displayed.length, batchStart + view.pageSize);
  $('viewRange').textContent = displayed.length ? `${batchStart + 1}–${batchEnd} / ${displayed.length}枚` : '0 / 0枚';
  $('previousBatch').disabled = viewLocked() || batchStart === 0;
  $('nextBatch').disabled = viewLocked() || batchEnd >= displayed.length;
  const pageIndex = pages.findIndex(p => p.id === activeId);
  $('thumbnailProgress').textContent = `現在 ${pageIndex < 0 ? 0 : pageIndex + 1} / ${pages.length} · 確認済み ${pages.filter(p=>p.done).length}`;
  $('temporarySave').disabled=busy||!!draftTask||!pages.length;
  $('savePreset').disabled=busy||!active()||!selected(active())||!PRESET_KINDS.includes(selected(active()).kind);
  for(const id of [...presetControls.map(([id])=>id),'autosaveEnabled','autosaveMinutes','restoreDraft','clearDraft'])$(id).disabled=busy;
  for(const b of document.querySelectorAll('[data-delete-preset]'))b.disabled=busy||!!preferences.presets.find(p=>p.id===preferences.defaults[b.dataset.deletePreset])?.builtin;
  updateDraftUI();
  pages.forEach((p, i) => {
    if (p.thumbnail) {
      p.thumbnail.hidden = !matchesPageFilter(p) && p.id !== activeId;
      p.thumbnail.draggable = !busy;
      const state = `${i}:${p.edited}:${p.done}:${p.id === activeId}`;
      if (p.thumbnailState !== state) {
        p.thumbnailState = state;
        p.thumbnail.classList.toggle('active', p.id === activeId);
        p.thumbnail.classList.toggle('edited', p.edited);
        p.thumbnail.classList.toggle('done', p.done);
        if (p.id === activeId) p.thumbnail.setAttribute('aria-current', 'page');
        else p.thumbnail.removeAttribute('aria-current');
        p.thumbnail.querySelector('.thumbnail-number').textContent = String(i + 1).padStart(2, '0');
        const stateLabel=p.edited?`編集済み${p.done?' · ✓ 確認済み':''}`:p.done?'✓ 確認済み':'未編集';
        p.thumbnail.querySelector('.thumbnail-state').textContent = stateLabel;
        p.thumbnail.setAttribute('aria-label', `${i + 1}ページ ${p.name} ${stateLabel}`);
      }
    }
    if (!p.row) return;
    updateFontSizeButtons(p);
    for(const action of ['remove','delete','duplicate-image','complete'])p.row.querySelector(`[data-action=${action}]`).disabled=busy||(action==='delete'&&!p.directory);
    p.row.classList.toggle('active', p.id === activeId);
    p.row.classList.toggle('done', p.done);
    p.row.querySelector('.page-number').textContent = String(i + 1).padStart(2, '0');
    p.row.querySelector('.edited-badge').hidden=!p.edited;
    p.row.querySelector('[data-action=complete]').textContent = p.done ? '✓ 確認済み・次へ ↓' : '編集完了・次へ ↓';
    p.row.querySelector('[data-action=undo]').disabled = !p.undo.length;
    p.row.querySelector('[data-action=redo]').disabled = !p.redo.length;
    p.row.querySelector('[data-action=save-image]').disabled = busy||!!p.cropDraft;
    for(const action of ['crop-image','rotate-left','rotate-right'])p.row.querySelector(`[data-action=${action}]`).disabled=busy||(action!=='crop-image'&&!!p.cropDraft);
    p.row.querySelector('[data-action=reset-image]').disabled=busy||!p.imageEdit;
    p.row.querySelector('[data-action=move-up]').disabled = busy || i === 0;
    p.row.querySelector('[data-action=move-down]').disabled = busy || i === pages.length - 1;
    p.row.querySelector('[data-action=move-after]').disabled=busy||pages.length<2;
    const destination=p.row.querySelector('[data-page-destination]');destination.max=String(pages.length);destination.disabled=busy||pages.length<2;
    const copy = p.row.querySelector('[data-action=copy-next]');
    if (copy) copy.disabled = busy || !p.layers.length || displayed.indexOf(p) === displayed.length - 1;
    p.row.querySelector('[data-action=copy-all]').disabled = busy || !p.layers.length;
    p.row.querySelector('[data-action=cut-all]').disabled = busy || !p.layers.length;
    p.row.querySelector('[data-action=paste-all]').disabled = busy || !pageClipboard?.layers.length;
    p.row.querySelector('.batch-copy-hint').textContent = pageClipboard
      ? `${pageClipboard.cut?'カット':'コピー'}済み：${pageClipboard.name} · ${pageClipboard.layers.length}件。この画像に追加。カット・貼付けは各画像の「戻す」で取り消せる。`
      : '台詞・効果音・吹き出し・キャプションをまとめて別の画像に追加。貼付け一回分は「戻す」で取り消せる。';
  });
}

function previewImageEdit(p) {
  return p.cropDraft ? uncroppedImageEdit(p.img.width,p.img.height,p.imageEdit) : p.imageEdit;
}

function drawPage(p) {
  if (!p?.canvas) return;
  if (previewIsOpen()) { previewDeferredDraws.add(p); return; }
  previewDeferredDraws.delete(p);
  requestPageFonts(p);
  if (!p.img.complete || !p.img.naturalWidth) return;
  const imageEdit=previewImageEdit(p),size=imageSize(p.img.width,p.img.height,imageEdit),scale = p.canvas.width / size.width;
  const displayScale = p.canvas.getBoundingClientRect().width / size.width || scale;
  const ctx=p.canvas.getContext('2d');
  draw(ctx, p.img, p.layers, !p.cropDraft && p.id === activeId ? [p.selectedId,...(p.selectedIds??[]).filter(id=>id!==p.selectedId)] : null, scale, displayScale,imageEdit,p.img,{
    maskEffects:p.maskEffects,maskAssets:p.maskAssets,draft:p.sam3Draft,
    maskSelection:p.id===activeId?p.maskEffects.find(effect=>effect.id===p.selectedMaskId)??null:null,
  });
  refreshMagnifier(p);
  if(p.cropDraft){
    const r=p.cropDraft;ctx.save();ctx.setTransform(scale,0,0,scale,0,0);ctx.fillStyle='#0009';
    ctx.beginPath();ctx.rect(0,0,size.width,size.height);ctx.rect(r.x,r.y,r.width,r.height);ctx.fill('evenodd');
    ctx.strokeStyle='#c8ee91';ctx.lineWidth=2/displayScale;ctx.setLineDash([6/displayScale,4/displayScale]);ctx.strokeRect(r.x,r.y,r.width,r.height);
    ctx.setLineDash([]);const handleSize=8/displayScale;ctx.fillStyle='#c8ee91';ctx.strokeStyle='#172010';ctx.lineWidth=1/displayScale;
    for(const [,x,y] of cropHandles(r)){ctx.fillRect(x-handleSize/2,y-handleSize/2,handleSize,handleSize);ctx.strokeRect(x-handleSize/2,y-handleSize/2,handleSize,handleSize);}
    ctx.restore();
  }
  // A temporary alignment guide is preview-only, never part of the exported image.
  if(drag?.page===p && drag.duplicated && drag.axis) {
    const copy=selected(p);if(!copy)return;
    ctx.save();ctx.setTransform(scale,0,0,scale,0,0);
    ctx.transform(...imageMatrix(p.img.width,p.img.height,p.imageEdit));
    ctx.strokeStyle='#00a0dc';ctx.lineWidth=2/displayScale;
    ctx.setLineDash([7/displayScale,5/displayScale]);
    ctx.beginPath();ctx.moveTo(drag.start.x,drag.start.y);ctx.lineTo(copy.x,copy.y);ctx.stroke();
    ctx.restore();
  }
}

function layerSummary(layer) {
  if(layer.kind==='balloon')return `吹き出し：${layer.shape==='distorted-rect'?'歪み長方形':layer.shape==='spiky'?'尖り形':'楕円'}`;
  return layer.text||'（未入力）';
}

function renderLayerSummary(layer,button) {
  button.replaceChildren();
  if(layer.kind==='dialogue'||layer.kind==='balloon'){
    const speaker=layer.speaker==='female'?'女性':'男性';
    const prefix=layer.kind==='balloon'?`○ ${speaker}吹き出し：`:`●${speaker}セリフ：`;
    button.append(element('span','layer-summary-speaker',prefix),document.createTextNode(layer.text||'（未入力）'));
  }else button.textContent=layerSummary(layer);
}

function persistControlValue(p,input) {
  if(!p?.row||!input?.matches(CONTROL_SELECTOR))return;
  const field=controlField(input),card=input.closest('.layer-card'),layer=p.layers.find(item=>item.id===(card?.dataset.layerId||p.selectedId));
  if(!layer)return;
  let value=input.value;
  const limits={size:[8,500],thickness:THICKNESS_LIMIT,rotation:[-180,180],w:[30,30000],h:[30,30000],outline:[0,80],shapeSeed:[0,4294967295],brushSeed:[0,4294967295],glyphSeed:[0,4294967295],...BRUSH_LIMITS,...EFFECT_LIMITS,...BALLOON_LIMITS,...CAPTION_LIMITS};
  if(field==='vertical')value=value==='true';
  else if(input.type==='checkbox')value=input.checked;
  else if(input.type==='number'||input.type==='range'){
    if(value===''||!Number.isFinite(Number(value)))return;
    value=numericValue(Number(value),field);
    if(Object.hasOwn(limits,field))value=clamp(value,...limits[field]);
    if(numericValue(layer[field],field)===value)return;
  }
  if(Object.is(layer[field],value))return;
  checkpoint(p);layer[field]=value;if(field==='borderStyle'||field==='brushSeed'||Object.hasOwn(BRUSH_LIMITS,field))layer.brushEngine='pressure';if(field!=='text')layer.presetId=null;
  if(field==='text'){fitTextInput(input);const summary=card.querySelector('.layer-summary');if(summary)renderLayerSummary(layer,summary);}
  markChanged(p);
  drawPage(p);
  updateControls(p);if(field!=='text')refreshPresetMenus(p);
}

function persistPageControl(p) {
  if(p?.row?.contains(document.activeElement))persistControlValue(p,document.activeElement);
}

function sizePreview(p) {
  if (!p.row) return;
  const frame=p.row.querySelector('.preview-frame'),originalFrame=p.row.querySelector('.original-frame');
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p)),maxHeight=parseFloat(getComputedStyle(p.row.querySelector('.row-columns')).getPropertyValue('--image-max-height'))||620;
  for(const image of [p.canvas,p.row.querySelector('.original')]){
    const aspect=image===p.canvas?size.width/size.height:p.img.width/p.img.height;
    const imageFrame=image===p.canvas?frame:originalFrame;
    const width=Math.max(1,Math.min(imageFrame.clientWidth-2,maxHeight*aspect));
    image.style.width=`${width}px`;image.style.height=`${width/aspect}px`;
  }
  p.row.querySelector('.original-toolbar').style.height=`${p.row.querySelector('.preview-toolbar:not(.original-toolbar)').getBoundingClientRect().height}px`;
  drawPage(p);
}

function updateImageView(p) {
  if(!p?.row)return;
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p)),scale=Math.min(1,1400/Math.max(size.width,size.height));
  const width=Math.max(1,Math.round(size.width*scale)),height=Math.max(1,Math.round(size.height*scale));
  if(p.canvas.width!==width)p.canvas.width=width;if(p.canvas.height!==height)p.canvas.height=height;
  const savedSize=imageSize(p.img.width,p.img.height,p.imageEdit);
  p.row.querySelector('.image-edit-summary').textContent=`保存サイズ ${savedSize.width} × ${savedSize.height} · 回転 ${p.imageEdit?.rotation??0}°`;
  p.row.querySelector('.crop-controls').hidden=!p.cropDraft;p.canvas.classList.toggle('cropping',!!p.cropDraft);
  if(!p.cropDraft)p.canvas.style.removeProperty('cursor');
  p.row.querySelector('[data-action=crop-image]').setAttribute('aria-expanded',String(!!p.cropDraft));
  if(p.cropDraft)for(const input of p.row.querySelectorAll('[data-crop-field]')){
    const field=input.dataset.cropField;if(input!==document.activeElement)input.value=String(p.cropDraft[field]);
    input.max=String(field==='x'?size.width-1:field==='y'?size.height-1:field==='width'?size.width-p.cropDraft.x:size.height-p.cropDraft.y);
  }
  sizePreview(p);
}

function cancelCrop(p) {
  const pointer=p.cropPointer;p.cropDraft=null;p.cropPointer=null;
  if(pointer&&p.canvas.hasPointerCapture(pointer.id))p.canvas.releasePointerCapture(pointer.id);
  updateImageView(p);updateGlobal();
}

function selectObject(p,id,toggle=false,replace=false) {
  if(toggle){const ids=p.selectedIds??[p.selectedId];setSelection(p,ids.includes(id)?ids.filter(item=>item!==id):[...ids,id],id);}
  else if(replace||!p.selectedIds?.includes(id))setSelection(p,id?[id]:[]);
  else setSelection(p,p.selectedIds,id);
}

function selectMask(p,id) {
  if(!p?.maskEffects?.some(effect=>effect.id===id))return;
  if(p.id!==activeId)activate(p,p.selectedId);
  p.selectedIds=[];p.selectedId=null;p.selectedMaskId=id;
  updateControls(p);drawPage(p);updateGlobal();
}

function discardSam3Draft(p) {
  if(!p)return;
  if(p.sam3UI)p.sam3UI.discard({notify:false});
  else p.sam3Draft=null;
}

function disposeSam3UI(p) {
  if(!p)return;
  if(p.sam3UI){const ui=p.sam3UI;p.sam3UI=null;ui.dispose();}
  else p.sam3Draft=null;
}

function updateFontSizeButtons(p) {
  const layer=selected(p),autoFit=layer?.kind==='caption'&&layer.autoFit;
  for(const action of ['remember-font-size','apply-font-size']){
    const button=p.row.querySelector(`[data-action=${action}]`);if(!button)continue;
    button.disabled=busy||!layer||autoFit;
    button.title=autoFit?'文字サイズの自動調整をOFFにすると使える':action==='apply-font-size'?`記憶した${preferences.fontSizePreset}pxを反映`:'現在の文字サイズを記憶';
  }
}

function updateControls(p) {
  if (!p?.row) return;
  const l = selected(p), controls = p.row.querySelector('.position-controls');
  const count=selectedLayers(p).length;p.row.querySelector('.selection-status').textContent=count>1?`${count}件を選択中`:'';
  const mask=p.maskEffects.find(effect=>effect.id===p.selectedMaskId);
  controls.disabled = !l&&!mask;
  const balloon=l?.kind==='balloon',caption=l?.kind==='caption';
  controls.querySelector('legend').textContent = mask?`${mask.name}：カードで位置調整`:balloon?`吹き出し・${l.speaker==='female'?'女性':'男性'}：${l.text||'（セリフ未入力）'}`:l ? `${caption?'キャプション':l.kind === 'sfx' ? '効果音' : l.speaker === 'female' ? '女性セリフ' : '男性セリフ'}：${l.text || '（未入力）'}` : '文字・吹き出し・キャプションを選択して位置調整';
  controls.querySelector('.control-grid').hidden=!!mask;
  controls.querySelector('[data-action=center]').disabled=!l;
  for(const node of controls.querySelectorAll('[data-text-control]'))node.hidden=!l;
  controls.querySelector('.multiline-align-control').hidden=!l||!['dialogue','balloon'].includes(l.kind);
  for(const node of controls.querySelectorAll('[data-ink-control]'))node.hidden=!l||caption;
  for(const node of controls.querySelectorAll('[data-text-color-control]'))node.hidden=!l||l.kind==='sfx';
  controls.querySelector('.balloon-style-controls').hidden=!balloon&&!caption;
  const shapeControl=controls.querySelector('.balloon-shape-control'),shapeSelect=shapeControl.querySelector('select');
  shapeControl.hidden=!balloon&&!caption;
  shapeControl.firstChild.textContent=caption?'キャプション形状':'吹き出し形状';
  for(const option of shapeSelect.options)option.hidden=caption?!['rect','spiky'].includes(option.value):!['ellipse','distorted-rect','spiky'].includes(option.value);
  const showDistortion=balloon?['distorted-rect','spiky'].includes(l.shape):caption&&l.shape==='spiky';
  controls.querySelector('.balloon-distortion-control').hidden=!showDistortion;
  const showSeed=balloon&&['distorted-rect','spiky'].includes(l.shape);
  for(const node of controls.querySelectorAll('[data-shape-seed-control]'))node.hidden=!showSeed;
  controls.querySelector('.balloon-spike-count-control').hidden=!balloon||l.shape!=='spiky';
  controls.querySelector('.balloon-distortion-control output').value=`${numericValue(l?.distortion??55,'distortion')}%`;
  controls.querySelector('.balloon-distortion-control').firstChild.textContent=caption||l?.shape==='spiky'?'尖り度（':'歪み度（';
  controls.querySelector('.caption-controls').hidden=!caption;
  controls.querySelector('.text-position-controls').hidden=!balloon&&!caption;
  controls.querySelector('[data-field=size]').disabled=caption&&l.autoFit;
  controls.querySelector('.balloon-tail-controls').hidden=!balloon||!l.tail;
  controls.querySelector('.balloon-position-note').hidden=!balloon;
  for (const input of controls.querySelectorAll(CONTROL_SELECTOR)) {
    if (input !== document.activeElement) {
      if(input.type==='checkbox')input.checked=l?.[input.dataset.field]===true;
      else syncControlValue(input,layerFieldValue(l,controlField(input)),p);
    }
  }
  for(const input of controls.querySelectorAll('[data-numeric-field=size]'))input.disabled=caption&&l.autoFit;
  updateFontSizeButtons(p);
  const captionStatus=controls.querySelector('.caption-fit-status');captionStatus.hidden=!caption;
  if(caption){const layout=captionLayout(p.canvas.getContext('2d'),l);captionStatus.textContent=`表示文字サイズ：${numericValue(layout.size,'size')}px · ${l.autoFit?'ボックスに自動追従':'手動指定'}${layout.fits?'':' · 本文が収まらないため、ボックスを広げるか文字を減らす。'}`;}
  const pendingQueries=l&&document.fonts?fontLoadQueries(l).filter(query=>!document.fonts.check(query)):[],fontStatus=p.row.querySelector('.font-status');
  fontStatus.textContent=pendingQueries.length?pendingQueries.some(query=>fontErrors.has(query))?'書体の読込に失敗。ページを再読込して再試行。':'選択した書体を読込中…':'';
  fontStatus.hidden=!fontStatus.textContent;
  const fontNote=controls.querySelector('.font-note');
  fontNote.textContent=l?FONT_CATALOG[l.font]?.note||'':'';fontNote.hidden=!fontNote.textContent;
  for (const card of p.row.querySelectorAll('.layer-card')) {
    card.classList.toggle('selected', p.id===activeId&&card.dataset.layerId === p.selectedId);
    const included=p.id===activeId&&p.selectedIds?.includes(card.dataset.layerId);card.classList.toggle('multi-selected',!!included);
    card.querySelector('.layer-summary')?.setAttribute('aria-pressed',String(!!included));
    const layer=p.layers.find(layer=>layer.id===card.dataset.layerId);
    if(layer?.kind==='sfx'){
      card.querySelector('.taper-controls').hidden=layer.effect!=='taper';
       card.querySelector('.grunge-controls').hidden=layer.inkTexture!=='grunge';
      const rate=card.querySelector('[data-field=taperRate]');if(rate!==document.activeElement)rate.value=String(layer.taperRate);
    }
    if(layer?.kind==='balloon'){
      card.querySelector('.balloon-seed-controls').hidden=!['distorted-rect','spiky'].includes(layer.shape);
      card.querySelector('.balloon-spike-count-control').hidden=layer.shape!=='spiky';
    }
    if(layer)for(const input of card.querySelectorAll(CONTROL_SELECTOR)){
      if(input===document.activeElement)continue;
      if(input.type==='checkbox')input.checked=layer[input.dataset.field];
      else syncControlValue(input,layerFieldValue(layer,controlField(input)),p);
    }
  }
  for(const card of p.row.querySelectorAll('.mask-effect-card')){
    const selected=p.id===activeId&&card.dataset.maskId===p.selectedMaskId;
    card.classList.toggle('selected',selected);
    for(const button of card.querySelectorAll('.mask-effect-summary,[data-mask-action=select]'))button.setAttribute('aria-pressed',String(selected));
    const effect=p.maskEffects.find(effect=>effect.id===card.dataset.maskId);
    if(effect)renderMaskEffectSummary(effect,card.querySelector('.mask-effect-summary'));
  }
}

function layerFieldValue(layer,field) {
  return field==='textColor'&&['dialogue','balloon'].includes(layer?.kind)?dialogueColor(layer):layer?.[field];
}

function speechStyleControls(layer) {
  const grid=element('div','effect-grid speech-style-controls');
  for(const [field,title,type] of [['textColor','文字色','color'],['textOutlineColor','文字の輪郭色','color'],['outline','文字の輪郭の太さ（px）','number']]){
    const label=element('label','',title),input=element('input');input.type=type;input.dataset.field=field;input.value=String(layerFieldValue(layer,field));
    if(type==='number'){input.min='0';input.max='80';input.step='0.5';input.title='0で輪郭なし';}
    label.append(input);grid.append(label);
  }
  grid.append(button('reset-text-color','話者の初期色','男性は黒、女性はピンクへ文字色を戻す'));
  return grid;
}

function activate(p, id = p.selectedId, scroll = false) {
  if (!matchesPageFilter(p) && !p.row) {
    p = pages.find(page => page.id === activeId && matchesPageFilter(page)) || pages.find(matchesPageFilter);
    if (!p) { activeId = null;refreshJump();return; }
    id = p.selectedId;
  }
  const previous = active();
  if(previous&&previous!==p)persistPageControl(previous);
  if(previous&&previous!==p)discardSam3Draft(previous);
  activeId = p.id;
  if(p.selectedMaskId&&p.maskEffects.some(effect=>effect.id===p.selectedMaskId)&&(id===null||id===p.selectedId)){
    p.selectedIds=[];p.selectedId=null;
  }else selectObject(p,id);
  const index = displayedPages().indexOf(p);
  const nextStart = view.pageSize === 'all' ? 0 : Math.floor(index / view.pageSize) * view.pageSize;
  if (!p.row || batchStart !== nextStart) { batchStart = nextStart; syncVisiblePages(); }
  if (previous && previous !== p) { updateControls(previous); drawPage(previous); }
  updateControls(p); drawPage(p); updateGlobal();
  if (scroll) p.row.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function unmountPage(p) {
  previewDeferredDraws.delete(p);
  closeMagnifier(p);
  if (!p.row) { disposeSam3UI(p); return; }
  disposeSam3UI(p);
  persistPageControl(p);
  rememberCardDetails(p);
  p.resizeObserver?.disconnect();
  p.canvas.width = 1; p.canvas.height = 1;
  p.row.remove(); p.row = null; p.canvas = null; p.resizeObserver = null;
  p.img.src = '';
}

function syncVisiblePages() {
  const displayed = displayedPages();
  const count = view.pageSize === 'all' ? Math.max(1, displayed.length) : view.pageSize;
  const activeIndex = displayed.findIndex(p => p.id === activeId);
  batchStart = activeIndex < 0 ? 0 : Math.floor(activeIndex / count) * count;
  const visible = new Set(displayed.slice(batchStart, batchStart + count));
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
      thumbnail.draggable = !busy;
      thumbnail.title = 'ドラッグで順序変更 · Alt + ↑↓でも移動';
      const image = element('img'); image.draggable = false; image.loading = 'lazy'; image.decoding = 'async'; image.src = p.thumbnailSrc; image.alt = '';
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
  applySidebarWidth();
  for (const button of $('thumbnailFilters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.pageFilter === view.filter));
}

const workspace = document.getElementById('workspace');
const thumbnailSidebar = document.getElementById('thumbnailSidebar');
const thumbnailList = document.getElementById('thumbnailList');
const sidebarHandle = document.getElementById('thumbnailResize');
function sidebarWidthLimit() { return Math.max(220, workspace.clientWidth - 640); }
function applySidebarWidth() {
  if (view.sidebarWidth === null) workspace.style.removeProperty('--sidebar-width');
  else workspace.style.setProperty('--sidebar-width', `${clamp(view.sidebarWidth, 220, sidebarWidthLimit())}px`);
  sidebarHandle.setAttribute('aria-valuemin', '220');
  sidebarHandle.setAttribute('aria-valuemax', String(sidebarWidthLimit()));
  sidebarHandle.setAttribute('aria-valuenow', String(Math.round(thumbnailSidebar.getBoundingClientRect().width)));
}

let sidebarResize = null;
sidebarHandle.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  sidebarResize = { id: event.pointerId, x: event.clientX, width: thumbnailSidebar.getBoundingClientRect().width, previous: view.sidebarWidth };
  sidebarHandle.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing-sidebar');
};
sidebarHandle.onpointermove = event => {
  if (sidebarResize?.id !== event.pointerId) return;
  view.sidebarWidth = clamp(sidebarResize.width + event.clientX - sidebarResize.x, 220, sidebarWidthLimit());
  applySidebarWidth();
};

function finishSidebarResize(event) {
  if (sidebarResize?.id !== event.pointerId) return;
  if (event.type !== 'pointerup') view.sidebarWidth = sidebarResize.previous;
  sidebarResize = null;
  document.body.classList.remove('resizing-sidebar');
  if (sidebarHandle.hasPointerCapture(event.pointerId)) sidebarHandle.releasePointerCapture(event.pointerId);
  rememberView();
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) sidebarHandle.addEventListener(type, finishSidebarResize);
sidebarHandle.ondblclick = () => { view.sidebarWidth = null; rememberView(); };

window.addEventListener('resize', applySidebarWidth);
sidebarHandle.addEventListener('keydown', event => {
  const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.code];
  if (!direction) return;
  event.preventDefault();event.stopPropagation();
  view.sidebarWidth = clamp(thumbnailSidebar.getBoundingClientRect().width + direction * (event.shiftKey ? 50 : 10), 220, sidebarWidthLimit());
  rememberView();
});

function rememberView() {
  applyViewSettings();
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { status('表示設定を記憶できなかった。現在の表示には適用した。'); }
}
$('thumbnailFilters').onclick = event => {
  if (viewLocked()) return;
  const filter = event.target.closest('[data-page-filter]')?.dataset.pageFilter;
  if (!PAGE_FILTERS.includes(filter)) return;
  if (active()) persistPageControl(active());
  finishThumbnailDrag();view.filter = filter;
  const matching = pages.filter(matchesPageFilter), current = active();
  const next = matching.includes(current) ? current : matching[0];
  activeId = next?.id ?? null;batchStart = 0;
  rememberView();refreshJump();
  if (next) activate(next);
};
$('toggleThumbnails').onclick = () => { view.thumbnails = !view.thumbnails; rememberView(); };
$('thumbnailScale').oninput = event => { view.scale = Number(event.target.value); rememberView(); };
$('pageSize').onchange = event => {
  view.pageSize = event.target.value === 'all' ? 'all' : Number(event.target.value);
  const index = Math.max(0, displayedPages().indexOf(active()));
  batchStart = view.pageSize === 'all' ? 0 : Math.floor(index / view.pageSize) * view.pageSize;
  rememberView(); syncVisiblePages();
  if (active()) activate(active());
};
$('thumbnailList').onclick = event => {
  if (viewLocked()) return;
  const p = pages.find(p=>p.id===event.target.closest('[data-page-id]')?.dataset.pageId);
  if (p) activate(p, p.selectedId, true);
};
let thumbnailDrag = null, thumbnailDrop = null, thumbnailScrollFrame = null, thumbnailDragY = 0;
function clearThumbnailDrop() {
  thumbnailDrop?.node.classList.remove('drop-before', 'drop-after', 'drop-horizontal');
  thumbnailDrop = null;
}
function finishThumbnailDrag() {
  clearThumbnailDrop();
  thumbnailDrag?.thumbnail.classList.remove('dragging');
  thumbnailDrag = null;
  cancelAnimationFrame(thumbnailScrollFrame);thumbnailScrollFrame = null;
}
function scrollThumbnailDrag() {
  const box = thumbnailList.getBoundingClientRect();
  const distance = thumbnailDragY < box.top + 40 ? -Math.ceil((box.top + 40 - thumbnailDragY) / 4) : thumbnailDragY > box.bottom - 40 ? Math.ceil((thumbnailDragY - box.bottom + 40) / 4) : 0;
  if (distance) { thumbnailList.scrollTop += clamp(distance, -18, 18); clearThumbnailDrop(); }
  thumbnailScrollFrame = requestAnimationFrame(scrollThumbnailDrag);
}
thumbnailList.ondragstart = event => {
  const p = pages.find(p => p.id === event.target.closest('.thumbnail')?.dataset.pageId);
  if (busy || !p || !event.dataTransfer) { event.preventDefault(); return; }
  finishThumbnailDrag();thumbnailDrag = p;thumbnailDragY = event.clientY;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-serifu-page', p.id);
  p.thumbnail.classList.add('dragging');
  thumbnailScrollFrame = requestAnimationFrame(scrollThumbnailDrag);
};
function updateThumbnailDrop(event) {
  clearThumbnailDrop();
  if (busy || !thumbnailDrag || !pages.includes(thumbnailDrag)) return false;
  thumbnailDragY = event.clientY;
  const node = event.target.closest('.thumbnail');
  if (!node || node === thumbnailDrag.thumbnail) return false;
  const box = node.getBoundingClientRect();
  const horizontal = getComputedStyle(thumbnailList).gridTemplateColumns.split(' ').length > 1;
  const after = horizontal ? event.clientX >= box.left + box.width / 2 : event.clientY >= box.top + box.height / 2;
  const target = pages.findIndex(p => p.id === node.dataset.pageId);
  if (target < 0) return false;
  const source = pages.indexOf(thumbnailDrag), insertion = target + Number(after);
  const destination = insertion - Number(source < insertion);
  if (destination === source) return false;
  thumbnailDrop = { node, destination };
  node.classList.add(after ? 'drop-after' : 'drop-before');
  node.classList.toggle('drop-horizontal', horizontal);
  return true;
}
thumbnailList.ondragover = event => {
  if (!updateThumbnailDrop(event)) return;
  event.preventDefault();event.dataTransfer.dropEffect = 'move';
};
thumbnailList.ondrop = event => {
  if (!updateThumbnailDrop(event)) { finishThumbnailDrag(); return; }
  event.preventDefault();
  const p = thumbnailDrag, destination = thumbnailDrop.destination;
  finishThumbnailDrag();movePageTo(p, destination);
};
thumbnailList.ondragleave = event => {
  if (!thumbnailList.contains(event.relatedTarget)) { clearThumbnailDrop();thumbnailDragY = thumbnailList.getBoundingClientRect().top + thumbnailList.clientHeight / 2; }
};
thumbnailList.ondragend = finishThumbnailDrag;
thumbnailList.addEventListener('keydown', event => {
  const direction = { ArrowUp: -1, ArrowDown: 1 }[event.code];
  if (!event.altKey || !direction) return;
  event.preventDefault();event.stopPropagation();
  const p = pages.find(p => p.id === event.target.closest('.thumbnail')?.dataset.pageId);
  if (p) {
    const displayed = displayedPages(), target = displayed[displayed.indexOf(p) + direction];
    if (target) movePageTo(p, pages.indexOf(target));
  }
});

for (const [id, offset] of [['previousBatch', -1], ['nextBatch', 1]]) $(id).onclick = () => {
  if (viewLocked() || view.pageSize === 'all') return;
  const p = displayedPages()[batchStart + offset * view.pageSize];
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

function settingSelect(field,title,choices,value){
  const label=element('label','',title),select=element('select');select.dataset.field=field;
  for(const [key,text] of Object.entries(choices)){const option=element('option','',text);option.value=key;select.append(option);}
  select.value=value;label.append(select);return label;
}
function settingNumber(field,title,limits,value,step='1'){
  const label=element('label','',title),input=element('input');input.type='number';input.dataset.field=field;
  [input.min,input.max]=limits;input.step=step;input.value=String(value);label.append(input);return label;
}
function textPositionControls(layer){
  const grid=element('div','text-position-controls effect-grid'),limits=layer.kind==='balloon'?BALLOON_LIMITS:CAPTION_LIMITS;
  for(const [field,title] of [['textOffsetX','文字の横位置（px）'],['textOffsetY','文字の縦位置（px）'],['padding','内側の余白（px）']])grid.append(settingNumber(field,title,limits[field],layer[field]??0,field==='padding'?'1':'0.5'));
  return grid;
}
const CONTROL_SELECTOR='[data-field], [data-numeric-field]';
const INTEGER_FIELDS=new Set(['shapeSeed','spikeCount','brushSeed','glyphSeed',
  'x','y','w','h','size','thickness','outline','borderWidth','textOutlineWidth',
  'textOffsetX','textOffsetY','padding','tailX','tailY','tailWidth',
  'shadowBlur','shadowOffsetX','shadowOffsetY','minimumGlyphGap','blur','motionBlur','blurX','blurY']);
function numericValue(value,field){return !Number.isFinite(value)?value:INTEGER_FIELDS.has(field)?Math.round(value):Number(value.toFixed(1));}
function numericStep(field){return INTEGER_FIELDS.has(field)?'1':'0.1';}
function controlField(input){return input.dataset.field??input.dataset.numericField;}
function syncControlValue(input,value,p){
  const field=controlField(input);
  if(input.type==='range'&&['textOffsetX','textOffsetY'].includes(field)){
    const dimension=field==='textOffsetY'?p.img.height:p.img.width;
    input.min=String(Math.max(-30000,Math.min(-dimension,value??0)));
    input.max=String(Math.min(30000,Math.max(dimension,value??0)));
  }
  if(input.type==='range'&&['x','y','w','h'].includes(field)){
    const dimension=['y','h'].includes(field)?p.img.height:p.img.width;
    input.min=String(['w','h'].includes(field)?30:Math.min(-dimension,value??0));
    input.max=String(['w','h'].includes(field)?Math.min(30000,Math.max(dimension*2,value??0,30)):Math.max(dimension*2,value??0));
  }
  if(['number','range'].includes(input.type)){
    input.step=numericStep(field);
    for(const key of ['min','max'])if(input[key]!==''&&Number.isFinite(Number(input[key])))input[key]=String(numericValue(Number(input[key]),field));
  }
  input.value=value===undefined?'':Number.isFinite(value)&&['number','range'].includes(input.type)?String(numericValue(value,field)):String(value);
}
function addNumericControls(root,p){
  for(const input of root.querySelectorAll('input[data-field][type=number], input[data-field][type=range]')){
    if(input.closest('.numeric-setting'))continue;
    const field=input.dataset.field,label=input.closest('label'),title=input.getAttribute('aria-label')||label?.textContent.trim()||field;
    input.step=numericStep(field);
    const wrap=element('div','numeric-setting'),linked=element('input');linked.type=input.type==='number'?'range':'number';linked.dataset.numericField=field;
    const dimension=['y','h'].includes(field)?p.img.height:p.img.width,value=Number(input.value);
    linked.min=input.min||String(Math.min(-dimension,value||0));linked.max=input.max||String(Math.max(dimension*2,value||0));linked.step=input.step||'1';
    if(['w','h'].includes(field))linked.max=String(Math.min(30000,Math.max(dimension*2,value||0,30)));
    linked.value=input.value;linked.disabled=input.disabled;
    input.setAttribute('aria-label',`${title}${input.type==='range'?' スライダー':''}`);linked.setAttribute('aria-label',`${title}${linked.type==='range'?' スライダー':''}`);
    input.before(wrap);if(input.type==='number')wrap.append(input,linked);else wrap.append(linked,input);
    if(field==='size'){
      label.classList.add('font-size-setting');
      const line=element('div','font-size-input');
      const remember=button('remember-font-size','設定'),apply=button('apply-font-size','反映');
      remember.type=apply.type='button';remember.setAttribute('aria-label','現在の文字サイズを記憶');apply.setAttribute('aria-label','記憶した文字サイズを反映');
      line.append(input,remember,apply);wrap.prepend(line);
    }
  }
}
function rememberCardDetails(p){
  p.cardDetails??=new Map();
  for(const card of p.row?.querySelectorAll('.layer-card')??[])for(const details of card.querySelectorAll('details')){
    p.cardDetails.set(`${card.dataset.layerId}:${details.querySelector('summary').textContent}`,details.open);
  }
}
function brushControls(layer){
  const details=element('details','brush-settings effect-details');details.append(element('summary','','ブラシ輪郭'));
  const grid=element('div','effect-grid');grid.append(settingSelect('borderStyle','描画モード',BRUSH_MODES,layer.borderStyle??'solid'));
  const labels={brushRoughness:'輪郭の揺れ（%）',brushPressureVariation:'筆圧・線幅の変化（%）',brushTexture:'掠れ量（%）',brushOpacityVariation:'インク濃淡（%）'};
  for(const [field,title] of Object.entries(labels))grid.append(settingNumber(field,title,BRUSH_LIMITS[field],layer[field]));
  grid.append(settingNumber('brushSeed','ブラシseed',[0,4294967295],layer.brushSeed),button('regenerate-brush','筆跡を再生成'));
  details.append(grid,element('p','effect-note','枠線の太さが基準線幅。通常線はブラシ効果OFF。手描きペンは筆圧40%・掠れ15%、掠れ筆は筆圧65%・掠れ75%が目安。'));return details;
}
function placementControls(layer){
  const details=element('details','placement-settings effect-details');details.append(element('summary','','文字配置'));
  const grid=element('div','effect-grid');grid.append(settingSelect('kerningMode','配置方式',{standard:'標準（従来配置）',optical:'輪郭で文字詰め'},layer.kerningMode));
  const labels={kerningStrength:'文字詰め強度（%）',minimumGlyphGap:'最小インク間隔（px）',overlapAllowance:'重なりの上限（%）',rotationJitter:'回転のばらつき（±°）',verticalJitter:'上下のずれ（%）',spacingJitter:'字間のばらつき（%）',glyphOverlap:'文字の重なり（%）'};
  for(const [field,title] of Object.entries(labels))grid.append(settingNumber(field,title,PLACEMENT_LIMITS[field],layer[field],field==='minimumGlyphGap'?'0.5':'1'));
  grid.append(settingNumber('sizeVariation','サイズのばらつき（%）',EFFECT_LIMITS.sizeVariation,layer.sizeVariation,'0.5'),settingNumber('horizontalJitter','左右のずれ（%）',EFFECT_LIMITS.horizontalJitter,layer.horizontalJitter,'0.5'),settingNumber('glyphSeed','文字配置seed',[0,4294967295],layer.glyphSeed),button('regenerate-placement','配置を再生成'));
  details.append(grid,element('p','effect-note','文字詰め0%で追加の詰めなし。各ばらつき0で追加の変動なし。重なりは上限と指定量の小さい方を使う。密集レタリングは強度85%・回転4°から調整。'));return details;
}

function button(action, text, title) {
  const b = element('button', '', text); b.dataset.action = action;
  if (title) b.title = title;
  return b;
}

function renderCards(p) {
  syncSelection(p);
  updateImageView(p);
  if (!p.row) return;
  rememberCardDetails(p);
  const container = p.row.querySelector('.layer-cards'); container.replaceChildren();
  p.row.querySelector('.no-layers').hidden = p.layers.length > 0 || p.maskEffects.length > 0;
  const appendCard=(card,layer)=>{
    addNumericControls(card,p);
    for(const details of card.querySelectorAll('details'))details.open=p.cardDetails.get(`${layer.id}:${details.querySelector('summary').textContent}`)??false;
    container.append(card);
  };
  for (const l of p.layers) {
    const card = element('div', 'layer-card'); card.dataset.layerId = l.id; card.dataset.kind=l.kind;if(l.speaker)card.dataset.speaker = l.speaker;
    const summary=element('button','layer-summary');summary.type='button';summary.title='クリックして編集';renderLayerSummary(l,summary);card.append(summary);
    const header = element('div', 'card-header'),heading=element('div','card-heading');
    heading.append(element('span', 'kind-label', l.kind==='caption'?'▭ キャプション':l.kind==='balloon'?'○ 吹き出し':l.kind === 'sfx' ? '✦ 効果音' : l.speaker === 'female' ? '● 女性セリフ' : '● 男性セリフ'));
    if (l.kind === 'dialogue'||l.kind==='balloon') {
      const roles = element('div', 'role-switch');roles.setAttribute('role','group');roles.setAttribute('aria-label',l.kind==='balloon'?'吹き出し内セリフの話者切替':'話者の切替');
      for (const [speaker, label] of [['male', '男性'], ['female', '女性']]) {
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
      const text=element('textarea');text.dataset.field='text';text.value=l.text;text.wrap='off';fitTextInput(text);text.placeholder='吹き出しのセリフを入力';text.setAttribute('aria-label',l.speaker==='female'?'女性の吹き出しセリフ':'男性の吹き出しセリフ');card.append(text);
      card.append(speechStyleControls(l),textPositionControls(l),element('p','effect-note','文字位置：横は＋で右／−で左、縦は＋で下／−で上。枠は動かさず本文を移動。余白を減らすと改行までの長さが広がる。'));
      const grid=element('div','effect-grid');
      for(const [field,labelText,type] of [['color','吹き出しの色','color'],['transparency','透過率（%）','number'],['borderColor','枠線の色','color'],['borderWidth','枠線の太さ（px）','number'],['shadowColor','影の色','color'],['shadowBlur','影のぼかし（px）','number'],['shadowOffsetX','影の横ずれ（px）','number'],['shadowOffsetY','影の縦ずれ（px）','number'],['shadowOpacity','影の濃さ（%）','number']]){
        const label=element('label','',labelText),input=element('input');input.type=type;input.dataset.field=field;input.value=String(l[field]);
        if(type==='number'){[input.min,input.max]=BALLOON_LIMITS[field];input.step=field==='borderWidth'?'0.5':'1';}label.append(input);grid.append(label);
      }
      card.append(grid,brushControls(l));
      const shapeControls=element('div','balloon-seed-controls effect-grid');shapeControls.hidden=!['distorted-rect','spiky'].includes(l.shape);
      for(const [field,title,min,max] of [['shapeSeed','形状seed',0,4294967295],['spikeCount','尖りの頂点数',...BALLOON_LIMITS.spikeCount]]){
        const label=element('label',field==='spikeCount'?'balloon-spike-count-control':'',title),input=element('input');input.type='number';input.dataset.field=field;input.min=String(min);input.max=String(max);input.step='1';input.value=String(l[field]);
        label.hidden=field==='spikeCount'&&l.shape!=='spiky';label.append(input);shapeControls.append(label);
      }
      shapeControls.append(button('regenerate-shape','形状を再生成','形状seedを変更して別の歪み・尖り方にする'));card.append(shapeControls);
       const shadowLabel=element('label','tail-toggle','影を付ける'),shadowToggle=element('input');
       shadowToggle.type='checkbox';shadowToggle.dataset.field='shadowEnabled';shadowToggle.checked=l.shadowEnabled??false;
       shadowLabel.prepend(shadowToggle);card.append(shadowLabel);
      const tailLabel=element('label','tail-toggle','テールを追加'),tail=element('input');tail.type='checkbox';tail.dataset.field='tail';tail.checked=l.tail;tailLabel.prepend(tail);card.append(tailLabel);
      card.append(element('p','effect-note','25%透過＝不透明度75%。セリフ・書体・文字サイズ・方向・枠と形状は右側で調整。'));
      appendCard(card,l);continue;
    }
    if(l.kind==='caption'){
      const text=element('textarea');text.dataset.field='text';text.value=l.text;text.wrap='off';fitTextInput(text);text.placeholder='モノローグ・説明を入力';text.setAttribute('aria-label','キャプションの本文');card.append(text);
      const grid=element('div','effect-grid');
      for(const [field,labelText,type] of [['textColor','文字色','color'],['textOutlineColor','文字の輪郭色','color'],['textOutlineWidth','文字の輪郭の太さ（px）','number'],['color','背景色','color'],['transparency','背景の透過率（%）','number'],['borderColor','枠線の色','color'],['borderWidth','枠線の太さ（px）','number']]){
        const label=element('label','',labelText),input=element('input');input.type=type;input.dataset.field=field;input.value=String(l[field]);
        if(type==='number'){[input.min,input.max]=CAPTION_LIMITS[field];input.step=['borderWidth','textOutlineWidth'].includes(field)?'0.5':'1';}label.append(input);grid.append(label);
      }
      for(const [field,labelText] of [['alignX','左右の揃え方'],['alignY','上下の揃え方']]){
        const label=element('label','',labelText),select=element('select');select.dataset.field=field;
        for(const [value,text] of Object.entries(CAPTION_ALIGNMENTS[field])){const option=element('option','',text);option.value=value;select.append(option);}select.value=l[field];label.append(select);grid.append(label);
      }
      const autoLabel=element('label','tail-toggle','文字サイズをボックスに合わせる'),auto=element('input');auto.type='checkbox';auto.dataset.field='autoFit';auto.checked=l.autoFit;autoLabel.prepend(auto);
      card.append(grid,textPositionControls(l),brushControls(l),autoLabel,element('p','effect-note','文字位置：横は＋で右／−で左、縦は＋で下／−で上。自動追従ONでも文字位置だけ調整できる。25%透過＝背景の不透明度75%。左右・上下は初期値が中央。自動追従OFFならボックスを変えても文字サイズを保持。書体・文字方向・位置は右側で調整。'));appendCard(card,l);continue;
    }
    const text = element('textarea'); text.dataset.field = 'text'; text.value = l.text; text.wrap='off';fitTextInput(text);
    text.placeholder = l.kind === 'sfx' ? 'ドーン！' : 'セリフを入力';
    text.setAttribute('aria-label', l.kind === 'sfx' ? '効果音テキスト' : l.speaker === 'female' ? '女性セリフ' : '男性セリフ');
    card.append(text);
    if(l.kind==='dialogue')card.append(speechStyleControls(l));
    if (l.kind === 'sfx') {
      const options = element('div', 'card-options'), label = element('label', '', '漫画エフェクト');
      const select = element('select'); select.dataset.field = 'effect';
      for (const [value, name] of Object.entries(EFFECTS)) { const o = element('option', '', name); o.value = value; select.append(o); }
      select.value = l.effect; label.append(select); options.append(label);
      const colorLabel = element('label', '', '文字色'), color = element('input');
      color.type = 'color'; color.dataset.field = 'color'; color.value = l.color; colorLabel.append(color); options.append(colorLabel); card.append(options);
      const outlineControls=element('div','effect-grid sfx-outline-controls');
      const outlineLabel=element('label','','輪郭色'),outlineColor=element('input');outlineColor.type='color';outlineColor.dataset.field='textOutlineColor';outlineColor.value=l.textOutlineColor??'#ffffff';outlineLabel.append(outlineColor);
      outlineControls.append(outlineLabel,settingNumber('outline','輪郭の太さ（px）',[0,80],l.outline,'0.5'));card.append(outlineControls);
      const taper=element('div','taper-controls'),rateLabel=element('label','','先細りの変化率（%／文字）'),rate=element('input');
      rate.type='number';rate.dataset.field='taperRate';[rate.min,rate.max]=EFFECT_LIMITS.taperRate;rate.step='0.5';rate.value=String(l.taperRate);rateLabel.append(rate);
      taper.hidden=l.effect!=='taper';taper.append(rateLabel,element('p','effect-note','初期値10%。基準100pxなら100→90→80px。最小8px。改行しても縮小を継続。ばらつき0なら指定率どおり。'));card.append(taper);
      const inkWrap=element('div','ink-texture-panel'),inkLabel=element('label','','インク質感'),inkSelect=element('select');
      inkSelect.dataset.field='inkTexture';
      for(const [mode,title] of [['none','なし'],['grunge','かすれ印刷・荒れインク']]){const option=element('option','',title);option.value=mode;inkSelect.append(option);}
      inkSelect.value=l.inkTexture??'none';inkLabel.append(inkSelect);
      const grungeControls=element('div','grunge-controls effect-grid');
      for(const [key,title] of [['grungeAmount','欠け・荒れの強さ（%）'],['scratchLength','擦れ筋の長さ（%）'],['scratchAngle','擦れ筋の角度（°）'],['spatterAmount','インク飛沫（%）']]){
        const label=element('label','',title),input=element('input');input.type='number';input.dataset.field=key;
        [input.min,input.max]=EFFECT_LIMITS[key];input.value=String(l[key]);label.append(input);grungeControls.append(label);
      }
      grungeControls.append(button('regenerate-texture','模様を再生成'),element('p','effect-note','透明な欠けから元画像が透ける。角度90°は下方向。筆の掠れと併用可能。'));
      grungeControls.hidden=l.inkTexture!=='grunge';
      inkWrap.append(inkLabel,grungeControls);card.append(inkWrap);
      card.append(element('p','effect-note','「なし」「先細り」は集中線・立体影なし。ブラー・掠れ・歪みは下のパラメータで独立調整。'));
    }
    if(l.kind==='sfx') {
      card.append(placementControls(l));
      const details=element('details','effect-details');details.append(element('summary','','ブラー・掠れ・歪みの調整'));
      const grid=element('div','effect-grid');
      const labels={blurY:'縦ブラー（px）',blurX:'横ブラー（px）',blurStrength:'滲みの強さ（%）',inkCore:'文字の芯（%）',roughness:'輪郭の荒れ（%）',dryInk:'筆の掠れ（%）',brushTails:'ハネ・払い（%）',blur:'全方向ブラー（px）',motionBlur:'流れる残像（px）',blurAngle:'残像の方向 °',distortion:'歪み（%）',skew:'傾き °',stretchX:'横倍率（%）',stretchY:'縦倍率（%）'};
      for(const [field,labelText] of Object.entries(labels)){const label=element('label','',labelText),input=element('input');input.type='number';input.dataset.field=field;[input.min,input.max]=EFFECT_LIMITS[field];input.step=['blur','sizeVariation','horizontalJitter'].includes(field)?'0.5':'1';input.value=String(l[field]);label.append(input);grid.append(label);}
      const warpLabel=element('label','','歪みの形'),warpSelect=element('select');warpSelect.dataset.field='warp';
      for(const [value,label] of Object.entries(WARP_CHOICES)){const option=element('option','',label);option.value=value;warpSelect.append(option);}warpSelect.value=l.warp;warpLabel.append(warpSelect);grid.append(warpLabel);
      details.append(grid,element('p','effect-note','手描きの揺れはサイズ±5%・左右±3%から調整。左右は文字幅が基準。0で追加のばらつきなし。文字ごとの変化は保存・再読込でも固定。'),element('p','effect-note','感情・緊張はプリセット「感情／緊張の掠れ」から開始。縦ブラーは300px、滲みは400%まで。「文字の芯」で読みやすさを調整。掠れ・ハネは文字の形に直接適用。'));card.append(details);
    }
    appendCard(card,l);
  }
  const cards=new Map([...container.children].map(card=>[card.dataset.layerId,card]));
  for(const [index,effect] of p.maskEffects.entries())cards.set(effect.id,createMaskEffectCard(effect,p.maskAssets[effect.assetId],index,p.id===activeId&&p.selectedMaskId===effect.id,p.img.width,p.img.height));
  for(const object of paintOrder(p.layers,p.maskEffects))container.append(cards.get(object.id));
  refreshPresetMenus(p); updateControls(p);
}

function mountPage(p) {
  const row = $('pageTemplate').content.firstElementChild.cloneNode(true); row.dataset.pageId = p.id; p.row = row;
  row.querySelector('[data-page-destination]').value=p.moveAfterPage??'';
  addNumericControls(row.querySelector('.position-controls'),p);
  row.querySelector('.page-name').textContent = p.name;
  row.querySelector('.dimensions').textContent = `${p.img.width} × ${p.img.height}`;
  const original = row.querySelector('.original'); original.src = p.src; original.alt = `元画像 ${p.name}`;
  row.querySelector('[data-action=delete]').disabled = !p.directory;
  row.querySelector('.source-note').textContent = p.directory ? '元ファイルは上書きしない。削除は確認後に完全削除。' : '元ファイルとの接続なし。元画像削除は無効。';
  const copy = button('copy-next', '文字を次の画像へ複製 →'); copy.className = 'copy-next'; row.querySelector('.dialogue-pane').append(copy);
  p.canvas = row.querySelector('canvas.preview'); p.canvas.tabIndex = 0;
  p.img.onload = () => { if (p.row) { sizePreview(p); updateControls(p); } };
  p.img.onerror = () => { if (p.row) status(`「${p.name}」のプレビュー画像を読み込めなかった。`); };
  p.img.src = p.src;
  $('deck').append(row); renderCards(p);
  p.resizeObserver = new ResizeObserver(() => sizePreview(p)); p.resizeObserver.observe(row.querySelector('.preview-frame'));
  p.resizeObserver.observe(row.querySelector('.original-frame'));p.resizeObserver.observe(row.querySelector('.preview-toolbar:not(.original-toolbar)'));
  connectCanvas(p); sizePreview(p);
  p.sam3UI=createSam3UI({
    page:p,panel:row.querySelector('.sam3-panel'),overlay:row.querySelector('.sam3-overlay'),image:original,client:sam3Client,
    getOriginalBlob:()=>originalBlob(p),getRetainedMaskDecodedBytes:retainedMaskDecodedBytes,onPreview:()=>drawPage(p),
    onCommit:(candidates,settings)=>commitSam3Candidates(p,candidates,settings),
    onCancel:()=>drawPage(p),
  });
}

function refreshJump() {
  const current = active();
  if (!current || !current.row && !matchesPageFilter(current)) activeId = pages.find(matchesPageFilter)?.id ?? null;
  const wasSyncing=syncingView;syncingView=true;
  try{syncVisiblePages();refreshThumbnails();
    const displayed = displayedPages();displayedOrder = displayed.map(p => p.id).join(',');
    while($('jump').options.length>displayed.length)$('jump').lastElementChild.remove();
    const positions = new Map(pages.map((p, i) => [p.id, i + 1]));
    displayed.forEach((p,i)=>{let option=$('jump').options[i];if(!option){option=element('option');$('jump').append(option);}const name=`${positions.get(p.id)}. ${p.name}`;if(option.value!==p.id)option.value=p.id;if(option.textContent!==name)option.textContent=name;});
  }finally{syncingView=wasSyncing;}
  updateGlobal();
}

function movePageTo(p,destination,focusAction) {
  if(busy)return;
  const index = pages.indexOf(p);
  if (index < 0 || destination < 0 || destination >= pages.length) return;
  if(destination===index){status(`「${p.name}」は指定位置に配置済み`);return;}
  pages.splice(index,1);pages.splice(destination,0,p);
  dirty(); refreshJump(); activate(p, p.selectedId, !!focusAction);
  const focusTarget = focusAction ? p.row.querySelector(`[data-action=${focusAction}]:enabled`)
    || p.row.querySelector('.page-actions button:enabled') : p.thumbnail;
  focusTarget?.focus({ preventScroll: true });
  status(`「${p.name}」を ${destination + 1} / ${pages.length} ページへ移動した`);
}

function movePage(p,offset){
  const index=pages.indexOf(p);if(index>=0)movePageTo(p,index+offset,`move-${offset<0?'up':'down'}`);
}

function movePageAfter(p){
  if(busy)return;
  const input=p.row.querySelector('[data-page-destination]');if(!input.reportValidity())return;
  const after=input.valueAsNumber,index=pages.indexOf(p);
  if(index<0||!Number.isInteger(after)||after<0||after>pages.length)return;
  // Resolve the target in the current order, before removing the moving page.
  movePageTo(p,after>index?after-1:after,'move-after');
}

function markChanged(p) {
  dirty(); p.done = false;p.edited=hasEdits(p);syncSelection(p);scheduleThumbnailRefresh(p);updateGlobal();
}

function retainedMaskDecodedBytes() {
  return pages.reduce((total,page)=>total
    +Object.values(page.maskAssets||{}).reduce((sum,asset)=>sum+(asset.decoded?.byteLength||0),0)
    +(page.sam3Draft?.candidates||[]).reduce((sum,candidate)=>sum+(candidate.mask?.decoded?.byteLength||0),0),0);
}

function markMaskChanged(p) {
  dirty();p.done=false;p.edited=hasEdits(p);pruneMaskAssets(p);scheduleThumbnailRefresh(p);updateGlobal();
}

function updateMaskEffectField(p,input) {
  if(!p||!input)return;
  const card=input.closest('.mask-effect-card'),effect=p.maskEffects.find(item=>item.id===card?.dataset.maskId);if(!effect)return;
  const field=input.dataset.maskField;let value;
  if(field==='visible')value=input.checked;
  else if(field==='effect')value=input.value;
  else{
    if(input.value===''||!Number.isFinite(input.valueAsNumber))return;
    value=Math.round(input.valueAsNumber);
    if(field==='blockSize')value=clamp(value,1,200);else if(field==='blurRadius')value=clamp(value,0,100);else if(field==='marginPx')value=clamp(value,-100,100);
    else if(field==='x')value=clamp(value,0,p.img.width-1);else if(field==='y')value=clamp(value,0,p.img.height-1);
    else if(field==='w')value=clamp(value,1,p.img.width-effect.x);else if(field==='h')value=clamp(value,1,p.img.height-effect.y);
    else return;
  }
  const next={...effect,[field]:value};
  if(field==='x')next.w=Math.min(effect.w,p.img.width-value);if(field==='y')next.h=Math.min(effect.h,p.img.height-value);
  const normalized=normalizeMaskEffect(next,p.img.width,p.img.height,new Set(Object.keys(p.maskAssets)));
  if(Object.keys(normalized).every(key=>normalized[key]===effect[key]))return;
  if(!editing.has(input)){checkpoint(p);editing.add(input);}
  Object.assign(effect,normalized);if(input.type==='number')input.value=String(normalized[field]);
  for(const control of card.querySelectorAll('[data-mask-field]')){
    const key=control.dataset.maskField;if(control===input)continue;
    if(control.type==='checkbox')control.checked=effect[key];else control.value=String(effect[key]);
    if(key==='x')control.max=String(p.img.width-effect.w);if(key==='y')control.max=String(p.img.height-effect.h);
    if(key==='w')control.max=String(p.img.width-effect.x);if(key==='h')control.max=String(p.img.height-effect.y);
  }
  if(field==='effect'){
    card.querySelector('[data-mask-field=blockSize]')?.closest('label')?.toggleAttribute('hidden',effect.effect!=='pixelate');
    card.querySelector('[data-mask-field=blurRadius]')?.closest('label')?.toggleAttribute('hidden',effect.effect!=='blur');
  }
  markMaskChanged(p);drawPage(p);updateControls(p);
}

function removeMaskEffect(p,id) {
  const index=p.maskEffects.findIndex(effect=>effect.id===id);if(index<0)return;
  checkpoint(p);p.maskEffects=p.maskEffects.filter(effect=>effect.id!==id);
  if(p.selectedMaskId===id)p.selectedMaskId=p.maskEffects[Math.min(index,p.maskEffects.length-1)]?.id??null;
  markMaskChanged(p);renderCards(p);drawPage(p);updateControls(p);
}

function commitSam3Candidates(p,candidates,settings) {
  try {
    if(!Array.isArray(candidates)||!candidates.length)throw new Error('確定する候補を選択する');
    const existingDecoded=pages.reduce((total,page)=>total+Object.values(page.maskAssets||{}).reduce((sum,asset)=>sum+(asset.decoded?.byteLength||0),0),0);
    const selectedDecoded=candidates.reduce((sum,candidate)=>sum+(candidate.mask?.decoded?.byteLength||0),0);
    if(existingDecoded+selectedDecoded>MAX_PROJECT_MASK_DECODED_BYTES)throw new Error('確定後のプロジェクト全体で展開済みマスクが256MiB上限を超える。候補数を減らすか、不要な加工を削除してから再試行する');
    let createdOrder=Math.max(-1,...p.maskEffects.map(effect=>effect.createdOrder))+1;
    const assets=[],effects=[],assetIds=new Set(Object.keys(p.maskAssets));
    for(const candidate of candidates){
      if(!candidate.mask?.data||!candidate.mask?.decoded)throw new Error('候補のマスクデータが不正');
      const asset={...candidate.mask,id:crypto.randomUUID()};
      const effect=defaultMaskEffect(asset,{createdOrder:createdOrder++});effect.effect=settings.effect;effect.blockSize=settings.blockSize;effect.blurRadius=settings.blurRadius;
      const normalized=normalizeMaskEffect(effect,p.img.width,p.img.height,new Set([...assetIds,asset.id]));
      assetIds.add(asset.id);assets.push(asset);effects.push(normalized);
    }
    checkpoint(p);
    for(const asset of assets)p.maskAssets[asset.id]=asset;
    p.maskEffects.push(...effects);p.selectedIds=[];p.selectedId=null;p.selectedMaskId=effects[0].id;
    markMaskChanged(p);p.sam3UI?.discard({notify:false});renderCards(p);drawPage(p);updateControls(p);
    status(`${effects.length}件のマスク加工を追加した。一括操作として「戻す」で取り消せる。`);
  }catch(error){status(`マスク加工を確定できなかった: ${error.message}`);}
}

function edit(p, fn, rebuild = true) {
  if (editLocked()) return;
  checkpoint(p); fn(); markChanged(p);
  if (rebuild) renderCards(p);else updateControls(p);
  drawPage(p);
}

function moveObjects(p,action) {
  const ids=p.selectedMaskId?[p.selectedMaskId]:selectedLayers(p).map(layer=>layer.id);
  const ordered=reorderPageObjects(p,ids,action);
  if(ordered)edit(p,()=>Object.assign(p,ordered));
}

$('deck').addEventListener('focusin', event => {
  if (editLocked()||event.target.closest('button[data-action], .layer-summary, .mask-effect-summary')) return;
  const p = pageFrom(event.target); if (!p) return;
  const maskCard=event.target.closest('.mask-effect-card');if(maskCard){if(p.id!==activeId||p.selectedMaskId!==maskCard.dataset.maskId)selectMask(p,maskCard.dataset.maskId);return;}
  const id = event.target.closest('.layer-card')?.dataset.layerId;
  activate(p, id || p.selectedId);
});
$('deck').addEventListener('focusout', event => {
  editing.delete(event.target);
  const p = pageFrom(event.target);
  if(event.target.matches('[data-mask-field]'))return;
  if (p) { persistControlValue(p,event.target); queueMicrotask(() => updateControls(p)); }
});
$('deck').addEventListener('input', event => {
  if (editLocked()) return;
  if(event.target.matches('[data-mask-field]')){updateMaskEffectField(pageFrom(event.target),event.target);return;}
  if(event.target.matches('[data-crop-field]')){
    const p=pageFrom(event.target);if(!p?.cropDraft)return;
    const input=event.target;if(input.value===''||!Number.isFinite(input.valueAsNumber))return;
    const size=imageSize(p.img.width,p.img.height,previewImageEdit(p)),field=input.dataset.cropField;
    p.cropDraft[field]=clamp(Math.round(input.valueAsNumber),field==='x'||field==='y'?0:1,Number(input.max));
    p.cropDraft.width=Math.min(p.cropDraft.width,size.width-p.cropDraft.x);p.cropDraft.height=Math.min(p.cropDraft.height,size.height-p.cropDraft.y);
    input.value=String(p.cropDraft[field]);updateImageView(p);return;
  }
  if(event.target.matches('[data-page-destination]')){const p=pageFrom(event.target);if(p)p.moveAfterPage=event.target.value;return;}
  const input = event.target, field = controlField(input);
  if (!field) return;
  if(field==='text')fitTextInput(input);
  const p = pageFrom(input), id = input.closest('.layer-card')?.dataset.layerId || p.selectedId;
  const l = p.layers.find(item => item.id === id); if (!l) return;
  let value = input.value;
  const limits = { size: [8, 500], thickness: THICKNESS_LIMIT, rotation: [-180, 180], w: [30, 30000], h: [30, 30000], outline: [0, 80], shapeSeed:[0,4294967295],brushSeed:[0,4294967295],glyphSeed:[0,4294967295],...BRUSH_LIMITS, ...EFFECT_LIMITS,...BALLOON_LIMITS,...CAPTION_LIMITS };
  if (['x', 'y', ...Object.keys(limits)].includes(field)) {
    if (value === '' || !Number.isFinite(Number(value))) return;
    value = numericValue(Number(value),field);
    if (limits[field]) value = clamp(value, ...limits[field]);
  } else if (field === 'vertical') value = value === 'true';
  else if(field==='tail'||field==='autoFit'||field==='shadowEnabled')value=input.checked;
  if (l[field] === value) return;
  if (!editing.has(input)) { checkpoint(p); editing.add(input); }
  l[field] = value;if(field==='borderStyle'||field==='brushSeed'||Object.hasOwn(BRUSH_LIMITS,field))l.brushEngine='pressure';if(field!=='text')l.presetId=null;
  if(field==='text'){const summary=input.closest('.layer-card')?.querySelector('.layer-summary');if(summary)renderLayerSummary(l,summary);}
  markChanged(p);drawPage(p);updateControls(p);if(field!=='text')refreshPresetMenus(p);
});
$('deck').addEventListener('change',event=>{
  if(event.target.matches('[data-mask-field]')){const p=pageFrom(event.target);updateMaskEffectField(p,event.target);editing.delete(event.target);return;}
  editing.delete(event.target);if(event.target.matches('input[type=number][data-field],input[type=number][data-numeric-field]')){const p=pageFrom(event.target),l=p?.layers.find(l=>l.id===(event.target.closest('.layer-card')?.dataset.layerId||p.selectedId));if(l)syncControlValue(event.target,l[controlField(event.target)],p);}
});

$('deck').addEventListener('click', event => {
  if (editLocked()) return;
  const p = pageFrom(event.target); if (!p) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if(action==='preview-full'){
    persistPageControl(p);closeMagnifier();void openFullPreview(p,event.target.closest('button'));
    if(p.id!==activeId)activate(p);
    return;
  }
  const maskCard=event.target.closest('.mask-effect-card');
  if(maskCard){const maskId=maskCard.dataset.maskId;selectMask(p,maskId);const maskAction=event.target.closest('[data-mask-action]')?.dataset.maskAction;if(maskAction==='delete'){removeMaskEffect(p,maskId);status('選択中のマスク加工を削除した。');}else if(['forward','backward','frontmost','backmost'].includes(maskAction))moveObjects(p,maskAction);return;}
  const card = event.target.closest('.layer-card'), cardId = card?.dataset.layerId;
  const toggle=event.shiftKey&&!!event.target.closest('.layer-summary,.kind-label');
  if(cardId)selectObject(p,cardId,toggle,!toggle);
  activate(p, toggle?p.selectedId:cardId || p.selectedId);
  if(toggle){p.canvas.focus({preventScroll:true});return;}
  if (!action || (busy&&['move-up','move-down','move-after','remove','delete','duplicate-image','complete','copy-next','copy-all','cut-all','paste-all','save-image','crop-image','apply-crop','cancel-crop','rotate-left','rotate-right','reset-image'].includes(action))) return;
  const l = selected(p);
  if (action.startsWith('add-')) {
    const kind = action === 'add-caption'?'caption':action === 'add-balloon'?'balloon':action === 'add-sfx' ? 'sfx' : 'dialogue', speaker = action === 'add-female' ? 'female' : 'male';
    edit(p, () => {
      const layer = makeLayer(kind,p.img.width,p.img.height,speaker);
      if(p.imageEdit){const crop=p.imageEdit.crop;layer.x=clamp(layer.x,crop.x,crop.x+crop.width);layer.y=clamp(layer.y,crop.y,crop.y+crop.height);}
      p.layers.push(layer); p.selectedId = layer.id;
    });
    p.row.querySelector(`.layer-card[data-layer-id="${p.selectedId}"] textarea`).focus({ preventScroll: true });
  } else if (action.startsWith('speaker-') && ['dialogue','balloon'].includes(l?.kind)) {
    edit(p, () => { l.speaker = action.slice(8);l.presetId=null; });
  } else if(action==='remember-font-size'&&l){
    if(busy||l.kind==='caption'&&l.autoFit)return;
    preferences.fontSizePreset=Math.round(l.size);const remembered=persistPreferences();dirty();updateGlobal();
    if(remembered)status(`文字サイズ ${preferences.fontSizePreset}pxを記憶した。`);
  } else if(action==='apply-font-size'&&l){
    if(busy||l.kind==='caption'&&l.autoFit)return;
    if(l.size!==preferences.fontSizePreset)edit(p,()=>{l.size=preferences.fontSizePreset;l.presetId=null;},false);
    refreshPresetMenus(p);status(`文字サイズ ${preferences.fontSizePreset}pxを反映した。`);
  } else if (action === 'save-preset' && l) {
    saveSelectedPreset();
  } else if (action === 'delete-preset' && l) {
    deletePreset(card.querySelector('[data-preset-select]').value);
  } else if (action === 'regenerate-brush' && ['balloon','caption'].includes(l?.kind)) {
    edit(p,()=>{l.brushSeed=crypto.getRandomValues(new Uint32Array(1))[0];l.brushEngine='pressure';l.presetId=null;});
  } else if (action === 'regenerate-placement' && l?.kind==='sfx') {
    edit(p,()=>{l.glyphSeed=crypto.getRandomValues(new Uint32Array(1))[0];l.presetId=null;});
  } else if (action === 'regenerate-texture' && l?.kind==='sfx') {
    edit(p,()=>{l.textureSeed=(Math.imul(l.textureSeed??0,1664525)+1013904223)>>>0;l.presetId=null;});
  } else if (action === 'regenerate-shape' && l?.kind==='balloon') {
    edit(p,()=>{l.shapeSeed=(Math.imul(l.shapeSeed,1664525)+1013904223)>>>0;l.presetId=null;});
  } else if (action === 'reset-text-color' && ['dialogue','balloon'].includes(l?.kind)) {
    edit(p,()=>{l.textColor=null;l.presetId=null;});
  } else if (action === 'duplicate' && l) {
    edit(p, () => { const copies = selectedLayers(p).map(duplicateLayer); p.layers.push(...copies);setSelection(p,copies.map(l=>l.id)); });
  } else if (action === 'drop-layer' && l) {
    edit(p, () => { const ids=new Set(selectedLayers(p).map(l=>l.id));p.layers = p.layers.filter(item => !ids.has(item.id));setSelection(p,p.layers.slice(0,1).map(l=>l.id)); });
  } else if (['forward','backward','frontmost','backmost'].includes(action) && (l||p.selectedMaskId)) {
    moveObjects(p,action);
  } else if (action === 'center' && l) {
    edit(p, () => { l.x = p.img.width / 2; l.y = p.img.height / 2;l.presetId=null; }, false);refreshPresetMenus();
  } else if (['undo', 'redo'].includes(action)) {
    cancelCrop(p);if (restore(p, action)) { dirty(); scheduleThumbnailRefresh(p);renderCards(p); drawPage(p); updateGlobal(); }
  } else if(action==='duplicate-image'){
    guard(task=>duplicateImage(p,task),'画像複製',2);
  } else if(action==='preview-magnifier'){
    persistPageControl(p);toggleMagnifier(p,event.target.closest('button'));
  } else if(action==='crop-image'){
    if(p.cropDraft)cancelCrop(p);
    else{p.cropDraft=cropInFullView(p.img.width,p.img.height,p.imageEdit);updateImageView(p);updateGlobal();}
  } else if(action==='cancel-crop'){
    cancelCrop(p);
  } else if(action==='apply-crop'&&p.cropDraft){
    if(![...p.row.querySelectorAll('[data-crop-field]')].every(input=>input.reportValidity()))return;
    const next=cropImage(p.img.width,p.img.height,previewImageEdit(p),p.cropDraft);cancelCrop(p);
    if(JSON.stringify(next)!==JSON.stringify(p.imageEdit))edit(p,()=>{p.imageEdit=next;});
  } else if(action==='rotate-left'||action==='rotate-right'){
    if(p.cropDraft)return;
    edit(p,()=>{p.imageEdit=rotateImage(p.img.width,p.img.height,p.imageEdit,action==='rotate-left'?-90:90);});
  } else if(action==='reset-image'&&p.imageEdit){
    cancelCrop(p);edit(p,()=>{p.imageEdit=null;});
  } else if (action === 'save-image') {
    guard(task=>saveImage(p,task),'PNG保存',2);
  } else if (action === 'move-up' || action === 'move-down') {
    movePage(p, action === 'move-up' ? -1 : 1);
  } else if (action === 'move-after') {
    event.preventDefault();movePageAfter(p);
  } else if (action === 'complete') {
    const displayed = displayedPages(), next = displayed[displayed.indexOf(p) + 1];
    p.done = true; dirty(); updateGlobal();
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
  const displayed=displayedPages(),target=action==='copy-next'?displayed[displayed.indexOf(p)+1]:p;if(!source?.layers.length||!target){task.stage('対象なし',0);return;}
  const copies=await prepareLayers(source.layers,layer=>action==='copy-all'||action==='cut-all'?structuredClone(layer):scaledCopy(layer,source.width,source.height,target.img.width,target.img.height),task);
  checkAbort(task.signal);task.stage('データ適用',copies.length);
  if(action==='copy-all'||action==='cut-all')pageClipboard={layers:copies,width:source.width,height:source.height,name:p.name,cut:action==='cut-all'};
  if(action==='cut-all'){checkpoint(p);p.layers=[];setSelection(p,[]);markChanged(p);}
  else if(action==='paste-all'||action==='copy-next'){checkpoint(target);target.layers.push(...copies);setSelection(target,copies.map(l=>l.id),action==='copy-next'?copies.at(-1).id:copies[0].id);markChanged(target);}
  task.update({processed:copies.length,succeeded:copies.length},true);task.stage('画面反映',1);
  if(action!=='copy-all'){renderCards(target);drawPage(target);}if(action==='copy-next')activate(target,target.selectedId,true);else updateGlobal();
  task.result(target.name);status(`「${target.name}」の文字を${{ 'copy-all':'コピー','cut-all':'カット','paste-all':'貼付け','copy-next':'複製'}[action]}した（${copies.length}件）。`);
}

function previewCoords(event, p) {
  const rect = p.canvas.getBoundingClientRect();
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p));
  return { x: (event.clientX - rect.left) * size.width / rect.width, y: (event.clientY - rect.top) * size.height / rect.height };
}
function coords(event,p){return imagePoint(previewCoords(event,p),p.img.width,p.img.height,p.imageEdit,true);}

const CROP_CURSORS={create:'crosshair',move:'move',n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',nw:'nwse-resize',se:'nwse-resize',ne:'nesw-resize',sw:'nesw-resize'};
function cropPointerMode(p,pos){
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p));
  return cropModeAt(p.cropDraft,pos,size.width,size.height,p.canvas.getBoundingClientRect().width/size.width);
}

function maskModeAt(effect,point,displayScale){
  if(!effect)return null;
  const {x,y,w,h}=effect,radius=9/displayScale,edge=5/displayScale;
  const handles=[['nw',x,y],['n',x+w/2,y],['ne',x+w,y],['e',x+w,y+h/2],['se',x+w,y+h],['s',x+w/2,y+h],['sw',x,y+h],['w',x,y+h/2]];
  const handle=handles.find(([,hx,hy])=>Math.abs(point.x-hx)<=radius&&Math.abs(point.y-hy)<=radius);
  if(handle)return handle[0];
  const inside=point.x>=x&&point.x<=x+w&&point.y>=y&&point.y<=y+h;
  if(!inside)return null;
  if(Math.abs(point.x-x)<=edge)return 'w';if(Math.abs(point.x-x-w)<=edge)return 'e';
  if(Math.abs(point.y-y)<=edge)return 'n';if(Math.abs(point.y-y-h)<=edge)return 's';
  return 'move';
}

function resizeMaskEffect(start,mode,anchor,point,width,height){
  if(mode==='move')return {x:clamp(start.x+Math.round(point.x-anchor.x),0,width-start.w),y:clamp(start.y+Math.round(point.y-anchor.y),0,height-start.h),w:start.w,h:start.h};
  const dx=Math.round(point.x-anchor.x),dy=Math.round(point.y-anchor.y);let x=start.x,y=start.y,right=x+start.w,bottom=y+start.h;
  if(mode.includes('w'))x=clamp(x+dx,0,right-1);if(mode.includes('e'))right=clamp(right+dx,x+1,width);
  if(mode.includes('n'))y=clamp(y+dy,0,bottom-1);if(mode.includes('s'))bottom=clamp(bottom+dy,y+1,height);
  return {x,y,w:right-x,h:bottom-y};
}

function editMaskDrag(p,event){
  if(!drag?.maskId||drag.page!==p||drag.id!==event.pointerId)return false;
  const effect=p.maskEffects.find(item=>item.id===drag.maskId);if(!effect)return true;
  const updates=resizeMaskEffect(drag.start,drag.mode,drag.anchor,coords(event,p),p.img.width,p.img.height);
  if(Object.entries(updates).every(([key,value])=>effect[key]===value))return true;
  if(!drag.checkpointed){checkpoint(p);drag.checkpointed=true;}
  Object.assign(effect,updates);markMaskChanged(p);drawPage(p);updateControls(p);return true;
}

function connectCanvas(p) {
  p.canvas.addEventListener('pointerdown', event => {
    if (editLocked() || !event.isPrimary || event.button !== 0 || drag) return;
    if(p.cropDraft){
      event.preventDefault();activate(p);p.canvas.focus({preventScroll:true});
      const start=previewCoords(event,p),mode=cropPointerMode(p,start);
      p.cropPointer={id:event.pointerId,start,mode,before:{...p.cropDraft}};p.canvas.style.cursor=CROP_CURSORS[mode];p.canvas.setPointerCapture(event.pointerId);return;
    }
    const size=imageSize(p.img.width,p.img.height,p.imageEdit),pos = coords(event, p), scale = p.canvas.getBoundingClientRect().width / size.width;
    const current = selected(p), handle = current && handleAt(current, pos.x, pos.y, scale);
    const currentMask=p.maskEffects.find(effect=>effect.id===p.selectedMaskId),maskMode=currentMask&&maskModeAt(currentMask,pos,scale);
    const object=handle?current:maskMode&&maskMode!=='move'?currentMask:paintOrder(p.layers,p.maskEffects).reverse().find(item=>item.kind==='mask-effect'?item.visible!==false&&maskModeAt(item,pos,scale):hit(item,pos.x,pos.y));
    const l=object?.kind==='mask-effect'?null:object;
    const targetMask=object?.kind==='mask-effect'?object:null;
    const targetMode=targetMask&&maskModeAt(targetMask,pos,scale);
    if(targetMask&&targetMode){
      event.preventDefault();selectMask(p,targetMask.id);p.canvas.focus({preventScroll:true});
      drag={page:p,id:event.pointerId,maskId:targetMask.id,mode:targetMode,anchor:pos,start:{x:targetMask.x,y:targetMask.y,w:targetMask.w,h:targetMask.h},checkpointed:false,previousRedo:p.redo.slice(),previousDone:p.done};
      p.canvas.setPointerCapture(event.pointerId);p.canvas.style.cursor=CROP_CURSORS[targetMode]||'move';return;
    }
    const toggle=event.shiftKey&&!event.ctrlKey&&!event.metaKey;
    selectObject(p,l?.id||null,toggle&&!!l);activate(p);p.canvas.focus({ preventScroll: true });
    if(toggle)return;
    if (!l) return;
    drag = { page: p, id: event.pointerId, sourceId:l.id, mode: handle || 'move',
      copy:!handle && (event.ctrlKey || event.metaKey) && !event.altKey,
      anchor:pos, start:{...l}, starts:selectedLayers(p).map(l=>({...l})), checkpointed:false, duplicated:false, axis:null, previousRedo:p.redo.slice(), previousSelection:[...p.selectedIds] };
    p.canvas.setPointerCapture(event.pointerId);
  });
  p.canvas.addEventListener('pointermove', event => {
    if(p.cropDraft){
      if(editLocked())return;
      const pointer=p.cropPointer,pos=previewCoords(event,p);
      if(pointer?.id===event.pointerId){
        const size=imageSize(p.img.width,p.img.height,previewImageEdit(p));
        p.cropDraft=dragCropRectangle(pointer.before,pointer.mode,pointer.start,pos,size.width,size.height);updateImageView(p);
      }else if(!pointer)p.canvas.style.cursor=CROP_CURSORS[cropPointerMode(p,pos)];
      return;
    }
    if(drag?.maskId){editMaskDrag(p,event);return;}
    if(!drag&&p.id===activeId&&p.selectedMaskId){const effect=p.maskEffects.find(item=>item.id===p.selectedMaskId),pos=coords(event,p),size=imageSize(p.img.width,p.img.height,p.imageEdit),mode=maskModeAt(effect,pos,p.canvas.getBoundingClientRect().width/size.width);p.canvas.style.cursor=mode?CROP_CURSORS[mode]||'move':'grab';return;}
    if (editLocked() || !drag || drag.page !== p || drag.id !== event.pointerId) return;
    const l = selected(p), pos = coords(event, p); if (!l) return;
    let updates, axis = null;
    if (drag.mode === 'move') {
      const placement=dragPlacement(drag.start,pos,drag.anchor,drag.copy && event.shiftKey);
      updates={x:placement.x,y:placement.y};axis=placement.axis;
    } else if (drag.mode === 'resize') {
      const local = localPoint(l, pos.x, pos.y), w = clamp(Math.round(local.x * 2), 30, 30000), h = clamp(Math.round(local.y * 2), 30, 30000);
      updates = l.kind==='caption'?{w,h}:l.kind==='balloon'?{w,h,tailX:clamp(drag.start.tailX*w/drag.start.w,...BALLOON_LIMITS.tailX),tailY:clamp(drag.start.tailY*h/drag.start.h,...BALLOON_LIMITS.tailY),tailWidth:clamp(drag.start.tailWidth*Math.min(w/drag.start.w,h/drag.start.h),...BALLOON_LIMITS.tailWidth)}:{ w, h, size: clamp(Math.round(drag.start.size * Math.min(w / drag.start.w, h / drag.start.h)), 8, 500) };
    } else if(drag.mode==='tail'){
      const local=localPoint(l,pos.x,pos.y);updates={tailX:clamp(Math.round(local.x),...BALLOON_LIMITS.tailX),tailY:clamp(Math.round(local.y),...BALLOON_LIMITS.tailY),tailAngle:Math.round(Math.atan2(local.y/l.h,local.x/l.w)*180/Math.PI)};
    } else {
      const angle = Math.atan2(pos.y - l.y, pos.x - l.x) * 180 / Math.PI + 90;
      updates = { rotation: Math.round(((angle + 180) % 360 + 360) % 360 - 180) };
    }
    const axisChanged=drag.axis!==axis;
    drag.axis=axis;
    if (Object.entries(updates).every(([key, value]) => l[key] === value)) {
      if(axisChanged && drag.duplicated)drawPage(p);
      return;
    }
    if (!drag.checkpointed) { checkpoint(p); drag.checkpointed = true; }
    const firstCopy=drag.copy && !drag.duplicated;
    if(firstCopy) {
      const copies=drag.starts.map(layer=>({...duplicateLayer(layer),x:layer.x,y:layer.y}));
      p.layers.push(...copies);setSelection(p,copies.map(l=>l.id),copies[drag.starts.findIndex(l=>l.id===drag.sourceId)].id);drag.duplicated=true;
    }
    const target=selected(p);
    if(drag.mode==='move'){
      const targets=selectedLayers(p);targets.forEach((layer,index)=>{const start=drag.starts[index];layer.x=start.x+updates.x-drag.start.x;layer.y=start.y+updates.y-drag.start.y;layer.presetId=null;});
    }else{Object.assign(target, updates);target.presetId=null;}
    dirty(); p.done = false;p.edited=true;scheduleThumbnailRefresh(p);
    if(firstCopy)renderCards(p);
    drawPage(p); updateControls(p); updateGlobal();
  });
  const end = event => {
    if(p.cropPointer?.id===event.pointerId){
      if(event.type!=='pointerup')p.cropDraft=p.cropPointer.before;
      p.cropPointer=null;if(p.canvas.hasPointerCapture(event.pointerId))p.canvas.releasePointerCapture(event.pointerId);
      p.canvas.style.cursor=CROP_CURSORS[cropPointerMode(p,previewCoords(event,p))];updateImageView(p);return;
    }
    if (!drag || drag.page !== p || drag.id !== event.pointerId) return;
    const finished=drag;drag=null;
    if(finished.maskId){
      if(event.type!=='pointerup'&&finished.checkpointed){
        const effect=p.maskEffects.find(item=>item.id===finished.maskId);if(effect)Object.assign(effect,finished.start);
        p.undo.pop();p.redo=finished.previousRedo;p.done=finished.previousDone;p.edited=hasEdits(p);dirty();scheduleThumbnailRefresh(p);updateGlobal();
      }
      if(p.canvas.hasPointerCapture(event.pointerId))p.canvas.releasePointerCapture(event.pointerId);
      p.canvas.style.removeProperty('cursor');renderCards(p);drawPage(p);updateControls(p);return;
    }
    if(event.type==='pointercancel' && finished.duplicated) {
      const snapshot=JSON.parse(p.undo.pop());
      p.layers=snapshot.layers;p.done=snapshot.done;p.imageEdit=snapshot.imageEdit??null;p.edited=hasEdits(p);
      p.redo=finished.previousRedo;setSelection(p,finished.previousSelection,finished.sourceId);
      dirty();scheduleThumbnailRefresh(p);renderCards(p);updateGlobal();
    }
    if(finished.duplicated)drawPage(p); // Remove preview-only guide on release/cancel.
    updateControls(p);refreshPresetMenus();
  };
  p.canvas.addEventListener('pointerup', end); p.canvas.addEventListener('pointercancel', end);
  p.canvas.addEventListener('lostpointercapture', event=>{if(p.cropPointer?.id===event.pointerId||drag?.maskId&&drag.page===p&&drag.id===event.pointerId)end(event);});
  p.canvas.addEventListener('pointerleave',()=>{if(!p.cropPointer)p.canvas.style.removeProperty('cursor');});
}

window.addEventListener('keydown', event => {
  if(previewIsOpen())return;
  if(event.key==='Escape'&&active()?.cropDraft&&!event.isComposing&&!editLocked()){event.preventDefault();cancelCrop(active());return;}
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable || event.isComposing || editLocked()) return;
  const p = active(); if (!p) return;
  const key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
  if(p.cropDraft&&!(command&&key==='z'))return;
  if (!command && !event.altKey && ['f','b','c','u','e'].includes(key)) {
    const layer=selected(p);if(!layer)return;
    if(key==='e'){
      if(layer.kind!=='balloon')return;
      const shapes=Object.keys(BALLOON_SHAPES),shape=shapes[(shapes.indexOf(layer.shape)+1)%shapes.length];
      event.preventDefault();edit(p,()=>{layer.shape=shape;layer.presetId=null;},false);refreshPresetMenus();return;
    }
    if(key==='c'||key==='u'){event.preventDefault();alignLayerText(p,layer,key==='c'?'center':'top');return;}
    const presets=preferences.presets.filter(preset=>preset.kind===layer.kind);if(!presets.length)return;
    const index=presets.findIndex(preset=>preset.id===layer.presetId),step=key==='f'?1:-1;
    const preset=presets[index<0?(step===1?0:presets.length-1):(index+step+presets.length)%presets.length];
    event.preventDefault();applyLayerPreset(p,layer,preset);return;
  }
  if(key==='delete'&&p.selectedMaskId&&!command&&!event.altKey&&!event.shiftKey){event.preventDefault();removeMaskEffect(p,p.selectedMaskId);status('選択中のマスク加工を削除した。');return;}
  if (key === 'delete' && event.target === p.canvas && !command && !event.altKey) {
    if (!selected(p) || event.repeat) return;
    event.preventDefault();
    edit(p, () => {const ids=new Set(selectedLayers(p).map(l=>l.id));p.layers = p.layers.filter(l=>!ids.has(l.id));setSelection(p,[]);});
    p.canvas.focus({ preventScroll: true }); status('選択オブジェクトを削除した。');
    return;
  }
  if (command && !event.altKey && !event.shiftKey && ['c','v'].includes(key)) {
    if (event.repeat) return;
    if (key==='c' && selected(p)) {
      event.preventDefault();layerClipboard=copyLayers(selectedLayers(p),p.img.width,p.img.height);clipboardPastes.clear();
      status(`選択オブジェクト${layerClipboard.layers.length}件をコピーした。`);
    } else if (key==='v' && layerClipboard) {
      event.preventDefault();const count=(clipboardPastes.get(p.id)||0)+1;clipboardPastes.set(p.id,count);
      edit(p,()=>{const copies=pasteSelectedLayers(layerClipboard,p.img.width,p.img.height,count*20);p.layers.push(...copies);setSelection(p,copies.map(l=>l.id));});
      p.canvas.focus({preventScroll:true});status(`${layerClipboard.layers.length}件を貼り付けた。`);
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    cancelCrop(p);if (restore(p, event.shiftKey ? 'redo' : 'undo')) { dirty(); scheduleThumbnailRefresh(p);renderCards(p); drawPage(p); updateGlobal(); }
    return;
  }
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, direction = directions[event.key], l = selected(p);
  if(direction&&p.selectedMaskId){const effect=p.maskEffects.find(item=>item.id===p.selectedMaskId);if(!effect)return;event.preventDefault();const step=event.shiftKey?10:1,[a,b,c,d]=imageMatrix(p.img.width,p.img.height,p.imageEdit),x=clamp(effect.x+(a*direction[0]+b*direction[1])*step,0,p.img.width-effect.w),y=clamp(effect.y+(c*direction[0]+d*direction[1])*step,0,p.img.height-effect.h);if(x!==effect.x||y!==effect.y){checkpoint(p);effect.x=x;effect.y=y;markMaskChanged(p);renderCards(p);drawPage(p);updateControls(p);}return;}
  if (direction && l) { event.preventDefault(); edit(p, () => { const step = event.shiftKey ? 10 : 1,[a,b,c,d]=imageMatrix(p.img.width,p.img.height,p.imageEdit);for(const layer of selectedLayers(p)){layer.x+=(a*direction[0]+b*direction[1])*step;layer.y+=(c*direction[0]+d*direction[1])*step;layer.presetId=null;} }, false); }
});

async function duplicateImage(p,task){
  task.stage('元画像の準備',1);const blob=await originalBlob(p),prepared=await prepareImage(blob,task);checkAbort(task.signal);
  const match=p.name.match(/^(.*?)(\.[^.]+)?$/),stem=match[1],extension=match[2]??'';let serial=1,name;
  do{name=`${stem}_copy${serial++}${extension}`;}while(pages.some(page=>page.name===name));
  const copy=createPage({name,src:URL.createObjectURL(blob),file:blob,prepared});task.result(p.name);task.stage('一覧反映',1);
  pages.splice(pages.indexOf(p)+1,0,copy);dirty();refreshJump();activate(copy,null,true);task.result(name);
  status(`元画像を「${name}」として一覧に複製した。`);
}

function removePage(p) {
  const displayedIndex = displayedPages().indexOf(p);
  const index = pages.indexOf(p); pages.splice(index, 1); releasePage(p);
  if (activeId === p.id) { const displayed = displayedPages();activeId = displayed[Math.min(displayedIndex, displayed.length - 1)]?.id || null; }
  dirty(); refreshJump(); if (active()) activate(active());
}

$('previous').onclick = () => { const displayed=displayedPages(),p = displayed[displayed.indexOf(active()) - 1]; if (p) activate(p, p.selectedId, true); };
$('next').onclick = () => { const displayed=displayedPages(),p = displayed[displayed.indexOf(active()) + 1]; if (p) activate(p, p.selectedId, true); };
$('jump').onchange = () => { const p = pages.find(p => p.id === $('jump').value); if (p) { activate(p, p.selectedId, true);p.canvas.focus({preventScroll:true}); } };

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
  sourceFolderName=uploadedFolderName(entries)||sourceFolderName;
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
function addImageFiles(files) {
  if (busy) return;
  const images = [...files].filter(file => /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  if (!images.length) { status('追加できる画像がない。PNG / JPEG / WebP / GIF / AVIFを選択してほしい。'); return; }
  return guard(task => addFiles(images.map(file => ({file})), task), '画像追加');
}
for (const id of ['fileInput', 'folderInput']) $(id).onchange = event => {
  const files = [...event.target.files]; event.target.value = '';
  addImageFiles(files);
};
function isFileDrop(event) {
  return !thumbnailDrag && [...(event.dataTransfer?.types || [])].includes('Files');
}
for (const type of ['dragenter', 'dragover']) thumbnailSidebar.addEventListener(type, event => {
  if (!isFileDrop(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  thumbnailSidebar.classList.toggle('file-drop', !busy);
});
thumbnailSidebar.addEventListener('dragleave', event => {
  if (!thumbnailSidebar.contains(event.relatedTarget)) thumbnailSidebar.classList.remove('file-drop');
});
thumbnailSidebar.addEventListener('drop', event => {
  thumbnailSidebar.classList.remove('file-drop');
  if (!isFileDrop(event)) return;
  event.preventDefault();
  addImageFiles(event.dataTransfer.files);
});
thumbnailSidebar.addEventListener('dragend', () => thumbnailSidebar.classList.remove('file-drop'));
function snapshotPages() { return pages.map(p => ({ ...p, layers: structuredClone(p.layers), maskEffects:structuredClone(p.maskEffects||[]) })); }
function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function prepareExportFonts(snapshot,task) {
  task?.stage('書体準備');if(!document.fonts)return;
  const queries=new Set(snapshot.flatMap(p=>p.layers.flatMap(fontLoadQueries)));
  for(const query of queries){checkAbort(task?.signal);const faces=await document.fonts.load(query);if(!faces.length)throw new Error(`書体を読込できない: ${query}`);}
  clearGlyphCache();
}
async function imageBlobFallback(p) {
  const canvas=document.createElement('canvas'),size=imageSize(p.img.width,p.img.height,p.imageEdit);canvas.width=size.width;canvas.height=size.height;let image;
  try {image=await decode(p.src);draw(canvas.getContext('2d'),image,p.layers,null,1,1,p.imageEdit,p.img,{maskEffects:p.maskEffects,maskAssets:p.maskAssets});const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('PNG生成に失敗');return blob;}
  finally{canvas.width=1;canvas.height=1;if(image)image.src='';}
}
async function imageBlob(p,task){
  const key=exportKey(p,fontVersion),cached=pngCache.get(key);if(cached)return cached;
  const blob=await imagePool.run('render-png',{blob:await originalBlob(p),width:p.img.width,height:p.img.height,layers:p.layers,imageEdit:p.imageEdit,maskEffects:p.maskEffects,maskAssets:p.maskAssets},task,()=>imageBlobFallback(p));
  checkAbort(task?.signal);pngCache.put(key,blob,p.id);return blob;
}
async function saveImage(p,task) {
  const snapshot={...p,layers:structuredClone(p.layers)},name=exportName(p.name,pages.indexOf(p));await prepareExportFonts([snapshot],task);task.stage('PNG生成',1);const blob=await imageBlob(snapshot,task);checkAbort(task.signal);download(blob,name);task.result(name,true,blob.size);status(`「${name}」のダウンロードを開始した`);
}
async function saveImages(task,editedOnly=false,picked) {
  if(!picked)return saveImagesZip(task,editedOnly);
  task.stage('保存先の選択と準備');task.update({currentName:'保存先フォルダを選択してほしい'},true);
  const selection=await awaitWithAbort(picked,task.signal);if(selection.error)throw selection.error;const parent=selection.parent;checkAbort(task.signal);
  const allPages=snapshotPages(),snapshot=allPages.map((p,index)=>({...p,pageIndex:index})).filter(p=>!editedOnly||p.edited),format=$('projectFormat').value,prefs=structuredClone(preferences),captured=revision,folderName=sourceFolderName,startedAt=new Date(),baseName=`${safeFilenamePart(folderName)}_${filenameTimestamp(startedAt)}`,projectName=projectFileName(format,startedAt,folderName);
  if(!snapshot.length){task.stage('対象なし',0);status('保存対象の編集済み画像がない。');return;}
  const folder=`${baseName}${editedOnly?'_edited':''}`;task.update({currentName:`${parent.name||'保存先'}/${folder}`},true);const directory=await awaitWithAbort(parent.getDirectoryHandle(folder,{create:true}),task.signal);let completed=0,projectSaved=false;task.metrics.pngWritten=0;task.metrics.projectSaved=false;
  try{await prepareExportFonts(snapshot,task);task.stage('PNG生成と書込み',snapshot.length);
    for await(const result of boundedResults(snapshot,p=>imageBlob(p,task),queueOptions(task))){const p=snapshot[result.index],name=pageExportName(p.name,p.pageIndex,allPages.length);task.update({currentName:name});if(result.error)throw new Error(`${p.name}: ${result.error.message}`);checkAbort(task.signal);const started=performance.now();await writeParts(directory,name,[result.value],task.signal);task.metrics.writeMs=(task.metrics.writeMs||0)+performance.now()-started;completed++;task.metrics.pngWritten=completed;task.result(name,true,result.value.size);}
    await writeParts(directory,projectName,projectParts(snapshot,prefs,{format,task,sourceFolderName:folderName}),task.signal,bytes=>task.update({writtenBytes:task.data.writtenBytes+bytes}),()=>task.stage('編集データの書込み確定',1));projectSaved=true;task.result(projectName);task.metrics.pngWritten=completed;task.metrics.projectSaved=true;
    if((!editedOnly||snapshot.length===allPages.length)&&captured===revision)changed=false;
    status(`${snapshot.length} 枚と編集データを「${parent.name?parent.name+'/':''}${folder}」へ保存した`);
  }catch(error){const failedStage=task.data.stage;task.metrics.errorFile=failedStage==='書体準備'?'':failedStage==='PNG生成と書込み'?task.data.currentName:projectName;task.update({currentName:`${folder} · PNG ${completed}枚 · 編集データ${projectSaved?'あり':'なし'}`},true);if(error.name==='AbortError')throw error;if(failedStage==='書体準備')task.result('書体準備',false);else{if(failedStage!=='PNG生成と書込み')task.stage('編集データの書込み確定',1);task.result(task.metrics.errorFile,false);}throw new Error(`${folder} 内に ${completed} 枚保存済み。${error.message}`);}
}
async function saveImagesZip(task,editedOnly){
  const allPages=snapshotPages(),snapshot=allPages.map((p,index)=>({...p,pageIndex:index})).filter(p=>!editedOnly||p.edited),format=$('projectFormat').value,prefs=structuredClone(preferences),folderName=sourceFolderName,startedAt=new Date(),baseName=`${safeFilenamePart(folderName)}_${filenameTimestamp(startedAt)}`,projectName=projectFileName(format,startedAt,folderName);
  if(!snapshot.length){task.stage('対象なし',0);status('保存対象の編集済み画像がない。');return;}
  const archive=new ZipArchive(),name=`${baseName}${editedOnly?'_edited':''}.zip`;task.metrics.pngPacked=0;
  await prepareExportFonts(snapshot,task);task.stage('PNG生成とZIP準備',snapshot.length);
  for await(const result of boundedResults(snapshot,p=>imageBlob(p,task),queueOptions(task))){const p=snapshot[result.index],filename=pageExportName(p.name,p.pageIndex,allPages.length);task.update({currentName:filename});if(result.error)throw new Error(`${p.name}: ${result.error.message}`);await archive.add(filename,result.value,task.signal);task.metrics.pngPacked++;task.result(filename);}
  const project=await projectBlob(snapshot,prefs,{format,task,sourceFolderName:folderName});task.stage('ZIP作成',1);await archive.add(projectName,project,task.signal);const blob=archive.blob(task.signal);task.result(name);task.stage('ダウンロード準備',1);checkAbort(task.signal);download(blob,name);task.metrics.archiveEntries=archive.entries.length;task.result(name);status(`${snapshot.length} 枚と編集データをまとめた「${name}」のダウンロードを開始した。展開して利用できる。`);
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
  if(!pages.length){task.stage('対象なし',0);return;}task.stage('メタ情報準備',pages.length);const snapshot=snapshotPages(),prefs=structuredClone(preferences),format=$('projectFormat').value,folderName=sourceFolderName,startedAt=new Date(),name=projectFileName(format,startedAt,folderName);task.update({processed:snapshot.length,succeeded:snapshot.length});const blob=await projectBlob(snapshot,prefs,{format,task,sourceFolderName:folderName});checkAbort(task.signal);task.stage('ダウンロード準備',1);download(blob,name);task.result(name,true,blob.size);status(`編集データ「${name}」のダウンロードを開始した`);
},'編集データ保存',3);
async function prepareProjectPages(records,version,task,{restoreIds=false}={}){
  task.stage('検証',records.length);const validated=[];
  for(const p of records){checkAbort(task.signal);try{validated.push({...p,layers:normalizeLayers(p.layers,version)});task.result(p.name);}catch(error){task.result(p.name,false);throw new Error(`${p.name}: ${error.message}`);}if(validated.length%20===0)await yieldToBrowser();}
  const loaded=[],sources=new Map();if(records.length>=4)imagePool.resize(4);task.stage('画像準備',records.length);
  try{for(let start=0;start<validated.length;start+=20){
    const batch=validated.slice(start,start+20),ready=[];
    for await(const result of boundedResults(batch,async p=>{let blob=p.blob;if(!blob){if(!sources.has(p.src))sources.set(p.src,originalBlob(p));blob=await sources.get(p.src);}checkAbort(task.signal);const dimensions=await imageDimensions(blob);return {...p,blob,allocationSize:p.expectedSize||dimensions,thumbnailSize:dimensions};},{signal:task.signal,concurrency:2})){
      if(result.error){task.result(batch[result.index].name,false);throw new Error(`${batch[result.index].name}: ${result.error.message}`);}ready.push(result.value);
    }
    for await(const result of boundedResults(ready,async p=>prepareImage(p.blob,task,p.thumbnailSize),{...queueOptions(task,true),estimate:p=>({...jobEstimate({...p,expectedSize:p.allocationSize}),result:320*320*4+65536})})){
      if(result.error){task.result(ready[result.index].name,false);throw new Error(`${ready[result.index].name}: ${result.error.message}`);}checkAbort(task.signal);const p=ready[result.index],prepared=result.value;
      if(p.expectedSize&&(p.expectedSize.width!==prepared.width||p.expectedSize.height!==prepared.height))throw new Error(`画像寸法が不正: ${p.name}`);
      const imageEdit=normalizeImageEdit(p.imageEdit,prepared.width,prepared.height),maskAssets=p.maskAssets??{};
      const maskEffects=version>=12?normalizeMaskEffects(p.maskEffects??[],prepared.width,prepared.height,new Set(Object.keys(maskAssets)),version):[];
      const page=createPage({id:restoreIds?p.id:undefined,name:p.name,layers:p.layers,done:p.done===true,imageEdit,maskEffects,maskAssets,selectedMaskId:p.selectedMaskId,src:URL.createObjectURL(p.blob),file:p.blob,prepared});loaded.push(page);
      if(hasEdits(page)){requestPageFonts(page);await renderPageThumbnail(page,task.signal);}
      task.result(p.name);
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
    sourceFolderName=data.sourceFolderName||projectFolderName(file.name)||sourceFolderName;
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
    pages.push(p);scheduleThumbnailRefresh(p);
  }
  refreshJump();activate(pages[first],pages[first].selectedId,true);dirty();
  status('3枚のサンプルを追加。中央でセリフを編集し、右で位置を調整。');
});
window.addEventListener('beforeunload', event => { if (changed) { event.preventDefault(); event.returnValue = ''; } });
updateGlobal();

function makeLayer(kind,width,height,speaker='male') {
  const layer=newLayer(kind,width,height,speaker);
  applyPreset(layer,preferences.presets.find(p=>p.id===preferences.defaults[kind]),width,height);
  if(kind==='dialogue'&&layer.speaker!==speaker){layer.speaker=speaker;layer.presetId=null;}
  return layer;
}
function alignLayerText(p,layer,alignment) {
  const changes=layer.kind==='caption'?{alignY:alignment}: {lineAlign:alignment};
  if(layer.kind==='balloon'||layer.kind==='caption'){
    changes.textOffsetY=0;
    if(alignment==='center'){changes.textOffsetX=0;changes.padding=0;if(layer.kind==='caption')changes.alignX='center';}
  }
  if(Object.entries(changes).every(([field,value])=>layer[field]===value))return;
  edit(p,()=>Object.assign(layer,changes,{presetId:null}),false);refreshPresetMenus();
}
function applyLayerPreset(p,layer,preset) {
  edit(p,()=>applyPreset(layer,preset,p.img.width,p.img.height));preferences.defaults[layer.kind]=preset.id;persistPreferences();
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
  if(Number.isFinite(input.fontSizePreset)&&input.fontSizePreset>=8&&input.fontSizePreset<=500)preferences.fontSizePreset=imported.fontSizePreset;
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
  const name=prompt('この設定のプリセット名（本文・XY位置は保持し、話者・書式・効果を保存）',preferences.presets.find(p=>p.id===layer.presetId&&!p.builtin)?.name||'');
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
  applyLayerPreset(p,layer,preset);
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
  const meta={version:PROJECT_VERSION,savedAt:Date.now(),preferences:prefs,...(sourceFolderName?{sourceFolderName}:{}),pages:snapshot.map(p=>({id:p.id,name:p.name,layers:p.layers,done:p.done,edited:p.edited===true,maskEffects:p.maskEffects,...(p.selectedMaskId?{selectedMaskId:p.selectedMaskId}:{}),...(p.imageEdit?{imageEdit:p.imageEdit}:{})}))};
  const masks=snapshot.flatMap(page=>[...new Set(page.maskEffects.map(effect=>effect.assetId))].map(id=>{
    const asset=page.maskAssets?.[id];if(!asset)throw new Error(`「${page.name}」のマスク素材がない`);
    return {pageId:page.id,id,asset};
  }));
  const task=new BulkTask(manual?'一時保存':'自動保存',{stageCount:3,onProgress:data=>{if(manual&&currentTask?.data.operationId===data.operationId)displayTask(data);else if(!manual)$('draftStatus').textContent=`自動保存 · ${data.stage} ${data.processed}/${data.total??'未確定'}`;}});
  if(manual){currentTask=task;task.emit(true);}delete $('draftStatus').dataset.error;
  draftTask=(async()=>{await storageReady;checkAbort(task.signal);const ids=await getImageIds(),missing=snapshot.filter(p=>!ids.has(p.id)),images=[];task.stage('画像差分準備',missing.length);
    for(const p of missing){checkAbort(task.signal);const blob=await originalBlob(p),original=pages.find(page=>page.id===p.id);if(original)original.assetBlob=blob;images.push({id:p.id,blob});task.result(p.name);if(images.length%20===0)await yieldToBrowser();}
    task.metrics.newImages=images.length;task.stage('DB要求',images.length);if(!images.length)task.stage('コミット',1);
    await writeDraft(meta,images,{signal:task.signal,masks,onProgress:(processed,total)=>{if(processed===total)task.stage('コミット',1);else task.update({processed,total,succeeded:0});}});
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
  if(!Number.isInteger(meta.version)||meta.version<3||meta.version>PROJECT_VERSION||!Array.isArray(meta.pages))throw new Error('未対応の一時保存データ');
  task.stage('画像取得',meta.pages.length);const ids=meta.pages.map(p=>p.id),[images,storedMasks]=await Promise.all([getDraftImages(ids),getDraftMasks(ids)]);checkAbort(task.signal);
  const masksByPage=new Map(meta.pages.map(p=>[p.id,{}]));for(const {pageId,id,asset} of storedMasks)masksByPage.get(pageId)[id]=asset;
  const loaded=await prepareProjectPages(meta.pages.map((p,i)=>({...p,maskAssets:masksByPage.get(p.id),blob:images[i].blob})),meta.version,task,{restoreIds:true});checkAbort(task.signal);
  pages.forEach(releasePage);$('deck').replaceChildren();pages=loaded;activeId=loaded[0]?.id||null;drag=null;pngCache.clear();
  sourceFolderName=typeof meta.sourceFolderName==='string'&&meta.sourceFolderName?meta.sourceFolderName:sourceFolderName;
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
  const redrawFonts=()=>{fontVersion++;pngCache.clear();clearGlyphCache();pages.forEach(drawPage);pages.forEach(p=>scheduleThumbnailRefresh(p,true));};
  document.fonts.addEventListener('loadingdone',redrawFonts);
  document.fonts.load('900 64px MangaBold').then(redrawFonts).catch(()=>{});
}
