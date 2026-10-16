import {beginLetteringGesture,moveLetteringGesture,endLetteringGesture,drawLetteringOverlay,advancedLetteringPanel,sceneFor,strokeHandles} from './sfx-editor.js';
import {glyphSelection,selectGlyph,freezeGlyphOrigins,copyLetteringSelection,pasteLetteringSelection,duplicateSelectedGlyphs,transformGlyphSelection,rotateLetteringOrientation,scaleLetteringData} from './sfx-edit-operations.js';
import {strokeFrame,strokeWidthScale} from './sfx-stroke-geometry.js';
import { graphemes } from './typography.js';
import { sfxVisibleIndices } from './sfx-lettering-model.js';
import {projectFileMatchesSnapshot,projectConflictChoice} from './project-conflict.js';
import {validProjectId} from './project-identity.js';
import {createSfxTemplate,applySfxTemplate,mergeSfxTemplates,encodeSfxTemplates,decodeSfxTemplates,SFX_TEMPLATE_KEY,validateStrokePresets} from './sfx-lettering-templates.js';
import { textGlyphs,sfxScene,sfxItemHit,layerBounds } from './renderer.js';
import { draftFileName,parseAnnotationDraft,createDraftLayers,layoutDraftLayers } from './annotation-drafts.js';
import { startLettering, defaultGlyph, replaceLetteringText, duplicateLetteringGlyphs, removeLetteringGlyphs } from './sfx-lettering-model.js';
import { newLayer, draw, hit, handleAt, localPoint, clamp, EFFECTS, WARP_CHOICES, clearGlyphCache, paintOrder, dialogueColor } from './renderer.js';
import { BALLOON_LIMITS, BALLOON_SHAPES } from './balloons.js';
import { BRUSH_LIMITS, BRUSH_MODES } from './brush-stroke.js';
import { PLACEMENT_LIMITS } from './glyph-layout.js';
import { CAPTION_LIMITS, CAPTION_ALIGNMENTS, captionLayout } from './captions.js';
import { PROJECT_VERSION, normalizeLayers, normalizeMaskEffects, reorderPageObjects, checkpoint, restore, duplicateLayer, dragPlacement, copyLayers, pasteSelectedLayers, selectedLayers, setSelection, syncSelection, hasEdits, scaledCopy, EFFECT_LIMITS, THICKNESS_LIMIT, defaultMaskEffect, normalizeMaskEffect, pruneMaskAssets } from './model.js';
import { normalizeImageEdit, imageSize, imageMatrix, imagePoint, rotateImage, cropImage, cropHandles, cropModeAt, dragCropRectangle, uncroppedImageEdit, cropInFullView } from './image-edit.js';
import { openFullPreview, previewIsOpen } from './preview-modal.js';
import { toggleMagnifier, refreshMagnifier, closeMagnifier } from './preview-magnifier.js';
import { normalizePreviewFocusZoom, previewFocusPanForPoint, previewFocusPointAtCenter, previewFocusPointFromClient, previewFocusPanForAnchor, previewFocusScale } from './preview-focus.js';
import { exportName } from './renderer.js';
import { pageExportName, textExport } from './export.js';
import { PREFS_KEY, defaultPreferences, normalizePreferences, createPreset, applyPreset, PRESET_KINDS, MAX_USER_PRESETS } from './presets.js';
import { getDraftMeta, getDraftImages, getDraftMasks, clearDraft as forgetDraft } from './storage.js';
import {saveProjectSnapshot,projectImageIds,readProjectBundle,latestProjectSnapshot,activeProjectSnapshot,activateStoredProject,listProjectHistories,listStoredProjects,getStoredSnapshot,projectSnapshotImages,projectSnapshotMasks,restoreProjectHistory,deleteProjectHistory,collectUnusedProjectAssets,projectStorageReport,deleteStoredProject,migrateLegacyDraft} from './project-history.js';
import {claimProjectLease,releaseProjectLease,signalProjectActivity,tabIdentity} from './project-lock.js';
import { BulkTask, boundedResults, checkAbort, awaitWithAbort, yieldToBrowser, prepareLayers } from './bulk-task.js';
import { ZipArchive } from './zip.js';
import { imageDimensions } from './image-metadata.js';
import { ImagePool } from './bulk-pool.js';
import { ExportCache, exportKey } from './export-cache.js';
import { originalBlob, projectParts, projectBlob, readProject, writeParts, MAX_PROJECT_MASK_DECODED_BYTES } from './project-io.js';
import { safeFilenamePart, filenameTimestamp, projectFileName, uploadedFolderName, projectFolderName } from './project-filenames.js';
import { FONT_CATALOG, FONT_STYLES, fontLoadQueries,registerSessionFont,hasSessionFont,missingLayerFonts,sessionFontChoices } from './fonts.js';
import { Sam3Client } from './sam3-client.js';
import { createSam3UI, createMaskEffectCard, renderMaskEffectSummary } from './sam3-ui.js';
import { enhanceColorInput, syncColorInput, colorInputValue } from './colors.js';

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
let projectId=crypto.randomUUID(),projectLease=null,readOnly=false,needLeaseReload=false,appliedReadOnly=false;
const rememberProject=()=>{try{sessionStorage.setItem('serifu.active-project',projectId);}catch{}};
const rememberedProject=()=>{try{return sessionStorage.getItem('serifu.active-project');}catch{return null;}};
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
Object.defineProperty(window,'serifuLiveMetrics',{get:()=>({visibility:document.visibilityState,focused:document.hasFocus(),task:currentTask?{...currentTask.data,metrics:structuredClone(currentTask.metrics)}:null,workers:imagePool.workers.map(s=>({ready:s.ready,busy:s.busy,job:s.currentJob})),starting:!!imagePool.starting,pool:structuredClone(imagePool.metrics)})});
const editLocked=()=>readOnly||(busy&&currentTask?.data.kind!=='画像追加');
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
let sfxTemplates=[];
try{sfxTemplates=decodeSfxTemplates(localStorage.getItem(SFX_TEMPLATE_KEY)||'{"format":"serifu-sfx-templates","version":1,"templates":[]}');}
catch{sfxTemplates=[];}
function saveSfxTemplates(){
  try{localStorage.setItem(SFX_TEMPLATE_KEY,encodeSfxTemplates(sfxTemplates));return true;}
  catch(error){status('テンプレートの保存に失敗: '+error.message);return false;}
}
let revision=0, lastSavedRevision=-1, draftMeta=null, draftTask=null,activeDraftTask=null, autosaveTimer=null,historyTimer=null,latestSaveTimer=null,autosaveQuotaPaused=false;
function dirty() {
  changed=true;revision++;
  if(preferences?.autosave?.enabled&&!autosaveQuotaPaused){
    clearTimeout(latestSaveTimer);
    latestSaveTimer=setTimeout(()=>{if(!readOnly&&!busy&&!pages.some(p=>p.glyphDrag))void temporarySave(false).catch(error=>status('自動保存を開始できない: '+error.message));},750);
  }
}
const editing = new WeakSet(),composing=new WeakSet();
$('deck').addEventListener('compositionstart',event=>composing.add(event.target));
$('deck').addEventListener('compositionend',event=>composing.delete(event.target));
$('deck').addEventListener('keydown',event=>{const input=event.target;if(event.isComposing||composing.has(input)||!input.matches('textarea[data-field=text]'))return;const p=pageFrom(input),l=p?.layers.find(l=>l.id===input.closest('.layer-card')?.dataset.layerId);if(!l?.lettering?.enabled)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();input.value=l.text;drawPage(p);}else if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();input.blur();}});
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
  return { id, name, src, thumbnailSrc:thumbnailBaseSrc, thumbnailBaseSrc, thumbnailRenderedSignature:layers.length||imageEdit||maskEffects.length?null:thumbnailSignature({layers,imageEdit,maskEffects}), thumbnailGeneration:0, img, file, directory, layers, done, imageEdit, maskEffects, maskAssets, selectedMaskId:maskEffects.some(effect=>effect.id===selectedMaskId)?selectedMaskId:null, sam3Draft:null, edited:layers.length>0||!!imageEdit||maskEffects.length>0, selectedId: layers[0]?.id || null, selectedIds: layers.slice(0,1).map(l=>l.id), previewFocus:{enabled:false,panMode:false,zoomPercent:100,panX:0,panY:0,centerPoint:null,fitWidth:null,fitHeight:null,frameHeight:null}, undo: [], redo: [] };
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
  $('deck').inert = busy&&currentTask?.data.kind!=='画像追加';
  if(readOnly||appliedReadOnly)for(const input of $('deck').querySelectorAll('textarea,input:not([data-page-destination]),select:not([data-page-destination])')){if(readOnly)input.setAttribute('data-viewer-disabled','true');if(readOnly)input.disabled=true;else if(input.hasAttribute('data-viewer-disabled')){input.disabled=false;input.removeAttribute('data-viewer-disabled');}}
  appliedReadOnly=readOnly;
  $('thumbnailList').inert = viewLocked();
  for (const id of ['pageSize', 'toggleThumbnails', 'thumbnailScale']) $(id).disabled = viewLocked();
  const batchEnd = view.pageSize === 'all' ? displayed.length : Math.min(displayed.length, batchStart + view.pageSize);
  $('viewRange').textContent = displayed.length ? `${batchStart + 1}–${batchEnd} / ${displayed.length}枚` : '0 / 0枚';
  $('previousBatch').disabled = viewLocked() || batchStart === 0;
  $('nextBatch').disabled = viewLocked() || batchEnd >= displayed.length;
  const pageIndex = pages.findIndex(p => p.id === activeId);
  $('thumbnailProgress').textContent = `現在 ${pageIndex < 0 ? 0 : pageIndex + 1} / ${pages.length} · 確認済み ${pages.filter(p=>p.done).length}`;
  $('temporarySave').disabled=readOnly||busy||!!draftTask||!pages.length;
  $('savePreset').disabled=busy||!active()||!selected(active())||!PRESET_KINDS.includes(selected(active()).kind);
  for(const id of [...presetControls.map(([id])=>id),'autosaveEnabled','autosaveMinutes','restoreDraft','clearDraft'])$(id).disabled=busy||(readOnly&&id!=='restoreDraft');
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
    const rowState=JSON.stringify([busy,readOnly,currentTask?.data.kind,p.id===activeId,i,p.done,p.edited,p.undo.length,p.redo.length,p.layers.length,p.maskEffects.length,p.selectedId,p.selectedMaskId,preferences.fontSizePreset,!!p.cropDraft,!!p.imageEdit,!!p.directory,pageClipboard?.name,pageClipboard?.layers.length,displayed.at(-1)?.id===p.id]);
    const pageDestination=p.row.querySelector('[data-page-destination]');if(pageDestination.max!==String(pages.length))pageDestination.max=String(pages.length);
    if(p.globalUIState===rowState)return;p.globalUIState=rowState;
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
  const current=selected(p),glyphMode=activeGlyphEdit(p,current);
  if(glyphMode&&!p.cropDraft){
    const scene=sceneFor(p,current);
    ctx.save();ctx.setTransform(scale,0,0,scale,0,0);
    if(imageEdit)ctx.transform(...imageMatrix(p.img.width,p.img.height,imageEdit));
    ctx.translate(current.x,current.y);ctx.rotate(current.rotation*Math.PI/180);
    drawLetteringOverlay(ctx,current,glyphMode,scene,Math.max(.01,displayScale),p.glyphDrag);ctx.restore();
    const overflow=scene.items.some(item=>{const b=item.bounds;return [{x:b.minX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY},{x:b.maxX,y:b.minY}].some(point=>{const angle=current.rotation*Math.PI/180,x=current.x+point.x*Math.cos(angle)-point.y*Math.sin(angle),y=current.y+point.x*Math.sin(angle)+point.y*Math.cos(angle);const crop=p.imageEdit?.crop??{x:0,y:0,width:p.img.width,height:p.img.height};return x<crop.x||y<crop.y||x>crop.x+crop.width||y>crop.y+crop.height;});});
    const warning=p.row?.querySelector('.sfx-overflow');if(warning){warning.hidden=!overflow;warning.textContent='画像外の文字・線はPNGでクリップされる。編集データと画像原寸は維持。';}
  }

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
  let value=input.type==='color'?colorInputValue(input):input.value;
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
  if(field==='text'&&layer.lettering?.enabled){if(composing.has(input))return;const next=replaceLetteringText(layer,value,activeGlyphEdit(p,layer)?.inherit??'position');edit(p,()=>Object.assign(layer,next));return;}
  checkpoint(p);if(field==='vertical'&&layer.lettering?.enabled)Object.assign(layer,rotateLetteringOrientation(layer,value));else layer[field]=value;if(field==='borderStyle'||field==='brushSeed'||Object.hasOwn(BRUSH_LIMITS,field))layer.brushEngine='pressure';if(field!=='text')layer.presetId=null;
  if(field==='text'){fitTextInput(input);const summary=card.querySelector('.layer-summary');if(summary)renderLayerSummary(layer,summary);}
  markChanged(p);
  drawPage(p);
  updateControls(p);if(field!=='text')refreshPresetMenus(p);
}

function persistPageControl(p) {
  if(p?.row?.contains(document.activeElement))persistControlValue(p,document.activeElement);
}

function previewFocusTarget(p) {
  const imageEdit=previewImageEdit(p),points=[];
  const toPreview=(layer,point)=>{
    const angle=(layer.rotation||0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
    return imagePoint({x:layer.x+point.x*cos-point.y*sin,y:layer.y+point.x*sin+point.y*cos},p.img.width,p.img.height,imageEdit);
  };
  const mask=p.maskEffects.find(effect=>effect.id===p.selectedMaskId);
  if(mask)return imagePoint({x:mask.x+mask.w/2,y:mask.y+mask.h/2},p.img.width,p.img.height,imageEdit);
  for(const layer of selectedLayers(p)){
    const mode=activeGlyphEdit(p,layer);
    if(mode){
      const scene=sceneFor(p,layer),indices=new Set(glyphSelection(mode)),runs=new Set(mode.strokeRuns||[]);
      const chosen=scene.items.filter(item=>item.type==='glyph'?indices.has(item.index):runs.has(item.stroke.runStart));
      for(const item of chosen){const b=item.bounds;for(const point of [{x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}])points.push(toPreview(layer,point));}
      if(chosen.length)continue;
    }
    const w=layer.w||0,h=layer.h||0;
    for(const point of [{x:-w/2,y:-h/2},{x:w/2,y:-h/2},{x:w/2,y:h/2},{x:-w/2,y:h/2}])points.push(toPreview(layer,point));
  }
  if(!points.length)return null;
  return {x:(Math.min(...points.map(point=>point.x))+Math.max(...points.map(point=>point.x)))/2,
    y:(Math.min(...points.map(point=>point.y))+Math.max(...points.map(point=>point.y)))/2};
}

function applyPreviewFocusTransform(p) {
  const focus=p.previewFocus;if(!focus?.enabled||!p.canvas)return;
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p));
  const scale=previewFocusScale(focus.fitWidth||parseFloat(p.canvas.style.width),size.width,focus.zoomPercent);
  p.canvas.style.transform=`translate3d(${focus.panX||0}px,${focus.panY||0}px,0) scale(${scale})`;
}

function setPreviewFocusZoom(p,value,{anchorClient=null,sourcePoint=null,recenter=true}={}) {
  const focus=p.previewFocus;if(!focus?.enabled)return false;
  const zoom=normalizePreviewFocusZoom(value);if(zoom===null)return false;
  focus.zoomPercent=zoom;
  const input=p.row?.querySelector('[data-focus-zoom]');if(input)input.value=String(zoom);
  const frame=p.row?.querySelector('.preview-frame');if(!frame)return true;
  const dimensions={width:frame.clientWidth,height:frame.clientHeight};
  if(anchorClient&&sourcePoint){
    const rect=frame.getBoundingClientRect(),origin={x:rect.left+frame.clientLeft,y:rect.top+frame.clientTop};
    const pan=previewFocusPanForAnchor({x:anchorClient.x-origin.x,y:anchorClient.y-origin.y},sourcePoint,zoom);
    focus.panX=pan.x;focus.panY=pan.y;
    focus.centerPoint=previewFocusPointAtCenter(dimensions,{x:focus.panX,y:focus.panY},zoom);
  }else if(recenter){
    const size=imageSize(p.img.width,p.img.height,previewImageEdit(p));
    focus.centerPoint=previewFocusTarget(p)??{x:size.width/2,y:size.height/2};
    const pan=previewFocusPanForPoint(dimensions,focus.centerPoint,zoom);focus.panX=pan.x;focus.panY=pan.y;
  }
  applyPreviewFocusTransform(p);return true;
}

function syncPreviewFocusUI(p) {
  const enabled=!!p.previewFocus?.enabled,panMode=enabled&&!!p.previewFocus?.panMode,button=p.row?.querySelector('[data-action=preview-focus]'),zoom=p.row?.querySelector('.preview-focus-zoom'),handle=p.row?.querySelector('[data-focus-pan]');
  if(button)button.setAttribute('aria-pressed',String(enabled));if(zoom)zoom.hidden=!enabled;if(handle){handle.hidden=!enabled;handle.setAttribute('aria-pressed',String(panMode));handle.title=panMode?'クリックで手のひら移動を終了。プレビューをドラッグして移動':'クリックで手のひら移動を開始。ボタンの直接ドラッグでも移動';}
  const frame=p.row?.querySelector('.preview-frame');frame?.classList.toggle('preview-focus-mode',enabled);frame?.classList.toggle('preview-pan-mode',panMode);
}

function togglePreviewFocus(p) {
  const focus=p.previewFocus,frame=p.row.querySelector('.preview-frame');
  if(!focus.enabled){
    focus.enabled=true;focus.pendingFrameHeight=frame.getBoundingClientRect().height;focus.previousFrameHeightStyle=frame.style.height;
    focus.fitWidth=null;focus.fitHeight=null;focus.centerPoint=previewFocusTarget(p);
    if(!focus.centerPoint){const size=imageSize(p.img.width,p.img.height,previewImageEdit(p));focus.centerPoint={x:size.width/2,y:size.height/2};}
    frame.scrollLeft=0;frame.scrollTop=0;
  }else{
    p.cancelPreviewFocusPan?.();focus.enabled=false;focus.panMode=false;focus.pendingFrameHeight=null;focus.fitWidth=null;focus.fitHeight=null;focus.frameHeight=null;focus.restoreFrameHeightOnce=true;
    p.canvas.style.removeProperty('transform');frame.style.height=focus.previousFrameHeightStyle||'';focus.previousFrameHeightStyle='';
  }
  syncPreviewFocusUI(p);sizePreview(p);
}

function previewFocusPointAtClient(p,client) {
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p)),rect=p.canvas.getBoundingClientRect();
  if(!rect.width||!rect.height)return null;
  return previewFocusPointFromClient(client,rect,size);
}

function connectPreviewFocusPan(p) {
  const handle=p.row.querySelector('[data-focus-pan]'),frame=p.row.querySelector('.preview-frame');
  let framePanDrag=null;
  const updatePan=(drag,event)=>{
    const focus=p.previewFocus;
    focus.panX=drag.panX+event.clientX-drag.x;focus.panY=drag.panY+event.clientY-drag.y;
    focus.centerPoint=previewFocusPointAtCenter({width:frame.clientWidth,height:frame.clientHeight},{x:focus.panX,y:focus.panY},focus.zoomPercent);
    applyPreviewFocusTransform(p);
  };
  const cancelPanDrags=()=>{
    const frameDrag=framePanDrag;framePanDrag=null;
    if(frameDrag&&frame.hasPointerCapture(frameDrag.pointerId))frame.releasePointerCapture(frameDrag.pointerId);
    const handleDrag=p.focusPanDrag;p.focusPanDrag=null;
    if(handleDrag?.moved){p.focusPanSuppressClick=true;setTimeout(()=>{p.focusPanSuppressClick=false;},0);}
    if(handleDrag&&handle.hasPointerCapture(handleDrag.pointerId))handle.releasePointerCapture(handleDrag.pointerId);
  };
  p.cancelPreviewFocusPan=cancelPanDrags;
  frame.addEventListener('pointerdown',event=>{
    if(!p.previewFocus.enabled||!p.previewFocus.panMode)return;
    if(event.target.closest?.('[data-focus-pan]'))return;
    if(event.pointerType==='touch'&&!event.isPrimary){event.preventDefault();event.stopPropagation();return;}
    if(!event.isPrimary||event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    handle.focus({preventScroll:true});
    framePanDrag={pointerId:event.pointerId,x:event.clientX,y:event.clientY,panX:p.previewFocus.panX,panY:p.previewFocus.panY};
    frame.setPointerCapture(event.pointerId);
  },true);
  frame.addEventListener('pointermove',event=>{
    if(event.pointerType==='touch'&&!event.isPrimary&&p.previewFocus.panMode){event.preventDefault();event.stopPropagation();return;}
    const drag=framePanDrag;if(!drag||drag.pointerId!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();updatePan(drag,event);
  },true);
  frame.addEventListener('dblclick',event=>{
    if(!p.previewFocus.enabled||!p.previewFocus.panMode)return;
    event.preventDefault();event.stopPropagation();
  },true);
  const endFramePan=event=>{if(framePanDrag?.pointerId===event.pointerId)framePanDrag=null;};
  for(const type of ['pointerup','pointercancel','lostpointercapture'])frame.addEventListener(type,endFramePan,true);
  p.row.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||(!p.previewFocus.panMode&&!framePanDrag&&!p.focusPanDrag)||!event.target.closest?.('.preview-pane'))return;
    event.preventDefault();event.stopPropagation();cancelPanDrags();p.previewFocus.panMode=false;syncPreviewFocusUI(p);
  });
  handle.addEventListener('click',event=>{
    if(p.focusPanSuppressClick&&event.detail!==0){p.focusPanSuppressClick=false;event.preventDefault();event.stopImmediatePropagation();return;}
    if(!p.previewFocus.enabled)return;
    p.previewFocus.panMode=!p.previewFocus.panMode;if(!p.previewFocus.panMode)cancelPanDrags();syncPreviewFocusUI(p);
  });
  handle.addEventListener('keydown',event=>{
    const vector={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!vector||!p.previewFocus.enabled)return;
    event.preventDefault();event.stopPropagation();
    const step=event.shiftKey?10:1,focus=p.previewFocus,frame=p.row.querySelector('.preview-frame');
    focus.panX+=vector[0]*step;focus.panY+=vector[1]*step;
    focus.centerPoint=previewFocusPointAtCenter({width:frame.clientWidth,height:frame.clientHeight},{x:focus.panX,y:focus.panY},focus.zoomPercent);
    applyPreviewFocusTransform(p);
  });
  handle.addEventListener('pointermove',event=>{
    const drag=p.focusPanDrag;if(!drag||drag.pointerId!==event.pointerId)return;
    event.preventDefault();event.stopPropagation();
    if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>3)drag.moved=true;
    updatePan(drag,event);
  });
  handle.addEventListener('pointerdown',event=>{
    if(!p.previewFocus.enabled||!event.isPrimary||event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    handle.focus({preventScroll:true});
    p.focusPanDrag={pointerId:event.pointerId,x:event.clientX,y:event.clientY,panX:p.previewFocus.panX,panY:p.previewFocus.panY,moved:false};
    handle.setPointerCapture(event.pointerId);
  });
  const end=event=>{
    const drag=p.focusPanDrag;if(drag?.pointerId!==event.pointerId)return;
    if(event.type==='pointerup'&&drag.moved){
      p.focusPanSuppressClick=true;
      setTimeout(()=>{p.focusPanSuppressClick=false;},0);
    }
    p.focusPanDrag=null;
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,end);
}

function sizePreview(p) {
  if (!p.row) return;
  const frame=p.row.querySelector('.preview-frame'),originalFrame=p.row.querySelector('.original-frame');
  const size=imageSize(p.img.width,p.img.height,previewImageEdit(p)),maxHeight=parseFloat(getComputedStyle(p.row.querySelector('.row-columns')).getPropertyValue('--image-max-height'))||620;
  const focus=p.previewFocus,focused=!!focus?.enabled,previousFitWidth=focus?.fitWidth,previousFitHeight=focus?.fitHeight;
  frame.classList.toggle('preview-focus-mode',focused);
  for(const image of [p.canvas,p.row.querySelector('.original')]){
    const aspect=image===p.canvas?size.width/size.height:p.img.width/p.img.height;
    const imageFrame=image===p.canvas?frame:originalFrame;
    const width=Math.max(1,Math.min(imageFrame.clientWidth-2,maxHeight*aspect));
    const zoom=image===p.canvas&&!focused&&activeGlyphEdit(p,selected(p))?p.sfxZoom||1:1;image.style.width=`${width*zoom}px`;image.style.height=`${width/aspect*zoom}px`;
    if(image===p.canvas){
      if(focused){
        focus.fitWidth=width;focus.fitHeight=width/aspect;
        const minFrameHeight=parseFloat(getComputedStyle(frame).minHeight)||0;
        if(focus.pendingFrameHeight!=null){focus.frameHeight=Math.max(minFrameHeight,focus.pendingFrameHeight);focus.pendingFrameHeight=null;}
        else if(focus.frameHeight==null||previousFitWidth==null||Math.abs(previousFitWidth-width)>.5||Math.abs(previousFitHeight-width/aspect)>.5)focus.frameHeight=Math.max(minFrameHeight,width/aspect+2);
        frame.style.height=`${focus.frameHeight}px`;
        focus.centerPoint??=previewFocusTarget(p)??{x:size.width/2,y:size.height/2};
        const pan=previewFocusPanForPoint({width:frame.clientWidth,height:frame.clientHeight},focus.centerPoint,focus.zoomPercent);focus.panX=pan.x;focus.panY=pan.y;
        applyPreviewFocusTransform(p);
      }else if(focus?.restoreFrameHeightOnce){focus.restoreFrameHeightOnce=false;}
      else if(zoom!==1||imageFrame.style.height)imageFrame.style.height=activeGlyphEdit(p,selected(p))?`${Math.min(maxHeight,width/aspect)}px`:'';
    }
  }
  syncPreviewFocusUI(p);
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
      if(layer.lettering?.enabled&&layer.lettering.strokes.length){
        const requestedRun=Number(card.querySelector('[data-glyph-stroke-run]')?.value),run=layer.lettering.strokes.find(item=>item.runStart===requestedRun)??layer.lettering.strokes[0],widthScale=strokeWidthScale(run,layer.size);
        for(const [field,index] of [['start',0],['end',run.widths.length-1]]){
          const input=card.querySelector(`[data-glyph-stroke-width=${field}]`);if(input&&input!==document.activeElement){input.max=String(500*widthScale);input.value=strokeWidthControlDisplay(run,index,layer.size);}
        }
        const multiplier=card.querySelector('[data-glyph-stroke-width-scale]');if(multiplier&&multiplier!==document.activeElement)multiplier.value=String(Number((run.widthMultiplier*100).toFixed(4)));
        const mode=activeGlyphEdit(p,layer),advancedWidth=card.querySelector('[data-sfx-editor=widthW]');
        if(mode&&advancedWidth&&advancedWidth!==document.activeElement){
          const selectedIndex=Number(card.querySelector('[data-sfx-editor=widthIndex]')?.value??mode.widthIndex??0),knot=run.widths[Math.min(Math.max(0,selectedIndex),run.widths.length-1)];
          advancedWidth.max=String(500*widthScale);advancedWidth.value=String(Number((knot.w*widthScale).toFixed(4)));
        }
      }
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

function addTextColorControls(root,p,layer) {
  for(const input of root.querySelectorAll('input[type=color][data-field]')){
    const field=input.dataset.field;
    if(!['textColor','textOutlineColor'].includes(field)&&!(field==='color'&&layer?.kind==='sfx'))continue;
    enhanceColorInput(input,layerFieldValue(layer,field),value=>{
      const target=p.layers.find(item=>item.id===(input.closest('.layer-card')?.dataset.layerId||p.selectedId));
      if(!target)return;
      edit(p,()=>{target[field]=value;target.presetId=null;},false);refreshPresetMenus(p);
    });
  }
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
  if(input.type==='color'){syncColorInput(input,value);return;}
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


let sfxClipboard=null,strokeClipboard=null;
let strokePresets=[];
try{strokePresets=validateStrokePresets(JSON.parse(localStorage.getItem('serifu.sfx.strokes.v1')||'[]'));}catch{}
function mergeStrokePresets(records){
  const names=new Set(strokePresets.map(p=>p.name));strokePresets.push(...records.filter(p=>!names.has(p.name)).slice(0,100-strokePresets.length));
  try{localStorage.setItem('serifu.sfx.strokes.v1',JSON.stringify(strokePresets));}catch{}
}
function pasteStrokeLook(p,l,run,part,source=strokeClipboard?.run){
  if(!source){status('線をコピーまたは登録してから適用する。');return;}
  edit(p,()=>{
    if(part==='all'||part==='shape'){run.path=structuredClone(source.path);run.shape=source.shape;run.start=structuredClone(source.start);run.end=structuredClone(source.end);for(const side of ['start','end']){run[side].detached=false;delete run[side].fixedPosition;}}
    if(part==='all'||part==='width'){run.widths=structuredClone(source.widths);run.sizeReference=source.sizeReference??l.size;run.widthMultiplier=source.widthMultiplier??1;}
    if(part==='all'||part==='look')run.lookOverride=structuredClone(source.lookOverride);
  });
}
function saveStrokePreset(run){
  const name=prompt('線プリセット名','新しい線');if(!name?.trim())return;
  if(strokePresets.some(p=>p.name===name)&&!confirm('同名の線プリセットを上書きする？'))return;
  strokePresets=strokePresets.filter(p=>p.name!==name);strokePresets.push({name:name.slice(0,100),value:structuredClone(run)});
  if(strokePresets.length>100){strokePresets.pop();status('線プリセットは100件まで。');return;}
  try{localStorage.setItem('serifu.sfx.strokes.v1',JSON.stringify(strokePresets));status('線プリセットを登録した。');}catch(error){status('線プリセットの記憶に失敗: '+error.message);}
}
function loadStrokePreset(p,l,run){
  const name=prompt('線プリセット名（'+strokePresets.map(p=>p.name).join('、')+'）',strokePresets[0]?.name||'');
  const preset=strokePresets.find(p=>p.name===name);if(preset)pasteStrokeLook(p,l,run,'all',preset.value);
}
function pasteSfxClipboard(p,l,mode,clipboard){
  if(editLocked()||!clipboard)return;
  edit(p,()=>{const scene=sceneFor(p,l);freezeGlyphOrigins(l,scene);const base=scene.glyphs.find(g=>g.index===mode.selected),result=pasteLetteringSelection(l,clipboard,{after:mode.selected,position:base?{x:base.x+20,y:base.y+20}:{x:0,y:0}});Object.assign(l,result.layer);mode.indices=result.indices;mode.selected=result.indices[0]??null;});
}
function plainSfxClipboard(text){const chars=graphemes(text.replace(/\r\n?/g,'\n'));return {sourceId:null,text:chars.join(''),glyphs:chars.flatMap((char,index)=>char==='\n'?[]:[defaultGlyph(index)]),strokes:[]};}
function deleteSfxSelection(p,l,mode){
  const indices=new Set(glyphSelection(mode));for(const run of l.lettering.strokes)if((mode.strokeRuns||[]).includes(run.runStart))for(let i=0;i<run.runLength;i++)indices.add(run.runStart+i);
  edit(p,()=>{freezeGlyphOrigins(l,sceneFor(p,l));Object.assign(l,removeLetteringGlyphs(l,[...indices]));});mode.selected=l.lettering.glyphs[0]?.index??null;mode.indices=mode.selected==null?[]:[mode.selected];mode.strokeRuns=[];renderCards(p);drawPage(p);
}
const letteringFields={dx:['横位置',-30000,30000],dy:['縦位置',-30000,30000],
  rotation:['回転',-3600,3600],scaleX:['横倍率',.01,20],scaleY:['縦倍率',.01,20],
  shear:['せん断',-5,5],z:['重なり順',-100000,100000]};
const activeGlyphEdit=(p,l)=>l?.kind==='sfx'&&l.lettering?.enabled&&p.glyphEdit?.id===l.id?p.glyphEdit:null;
const strokeWidthControlDisplay=(run,index,size)=>{
  const scale=strokeWidthScale(run,size),max=Math.floor((500*scale+1e-8)*10)/10;
  return Math.min(Number((run.widths[index].w*scale).toFixed(1)),max).toFixed(1);
};
function connectStrokeNumericDrag(input,p,l,run,field,index=null){
  let gesture=null,suppressClick=false;
  const isMultiplier=field==='scale';
  const currentValue=()=>isMultiplier?run.widthMultiplier*100:run.widths[index].w*strokeWidthScale(run,l.size);
  const displayValue=value=>isMultiplier?String(Number(value.toFixed(4))):value.toFixed(1);
  const rollback=drag=>{
    if(!drag.checkpointed)return;
    if(!restore(p,'undo'))return;
    p.undo=drag.undoBefore;p.redo=drag.redoBefore;
    dirty();scheduleThumbnailRefresh(p);renderCards(p);drawPage(p);updateGlobal();
  };
  input.addEventListener('pointerdown',event=>{
    if(editLocked()||!event.isPrimary||event.button!==0||gesture)return;
    const entered=Number(input.value),startValue=input.value.trim()!==''&&Number.isFinite(entered)?entered:currentValue();
    gesture={pointerId:event.pointerId,startY:event.clientY,startValue,checkpointed:false};
    input.setPointerCapture(event.pointerId);
  });
  input.addEventListener('pointermove',event=>{
    const drag=gesture;if(!drag||drag.pointerId!==event.pointerId)return;
    if(editLocked())return;
    const verticalDelta=drag.startY-event.clientY;
    if(!drag.active){if(Math.abs(verticalDelta)<4)return;drag.active=true;input.classList.add('stroke-numeric-dragging');}
    event.preventDefault();
    const max=isMultiplier?500:Math.floor((500*strokeWidthScale(run,l.size)+1e-8)*10)/10;
    const increment=isMultiplier?Math.round(verticalDelta):Number((verticalDelta*.1).toFixed(1));
    const bounded=clamp(drag.startValue+increment,isMultiplier?1:0,max);
    const next=isMultiplier?bounded:Math.min(Number(bounded.toFixed(1)),max);
    if(next===Number(input.value))return;
    if(!drag.checkpointed){drag.undoBefore=p.undo.slice();drag.redoBefore=p.redo.slice();checkpoint(p);drag.checkpointed=true;}
    if(isMultiplier)run.widthMultiplier=next/100;
    else run.widths[index].w=next/strokeWidthScale(run,l.size);
    input.value=displayValue(next);
    markChanged(p);drawPage(p);updateControls(p);
  });
  const finish=event=>{
    const drag=gesture;if(drag?.pointerId!==event.pointerId)return;
    gesture=null;input.classList.remove('stroke-numeric-dragging');
    if(event.type==='pointerup'&&drag.active){
      suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
      if(drag.checkpointed&&Math.abs(currentValue()-drag.startValue)<1e-6)rollback(drag);
      else if(drag.checkpointed){updateControls(p);drawPage(p);updateGlobal();}
    }else if(drag.checkpointed)rollback(drag);
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])input.addEventListener(type,finish);
  input.addEventListener('click',event=>{
    if(!suppressClick)return;
    suppressClick=false;event.preventDefault();event.stopPropagation();
  });
}

function sfxLetteringPanel(p,l){
  const panel=element('section','sfx-lettering-panel'),mode=activeGlyphEdit(p,l);
  panel.append(button(mode?'sfx-glyph-exit':'sfx-glyph-enter',mode?'文字編集を終了':'文字単位編集'));
  if(!mode)return panel;
  const inherit=element('label','','本文変更時の継承'),choice=element('select');choice.dataset.glyphInherit='true';
  for(const [id,title] of [['position','位置優先'],['character','同じ文字を優先'],['reset','全リセット']]){
    const option=element('option','',title);option.value=id;choice.append(option);
  }
  choice.value=mode.inherit;inherit.append(choice);panel.append(inherit);
  const buttons=element('div','sfx-glyph-list'),chars=graphemes(l.text);
  for(const g of l.lettering.glyphs){
    const b=button('sfx-glyph-select',chars[g.index]);b.dataset.glyphIndex=String(g.index);
    b.title='文字 '+(g.index+1)+'／Z '+g.z+(g.manual.position?'／手動配置':'');
    b.setAttribute('aria-pressed',String(glyphSelection(mode).includes(g.index)));buttons.append(b);
  }
  panel.append(buttons,button('sfx-text-apply','本文を確定'));
  const templateControls=element('details','sfx-template-panel');
  templateControls.append(element('summary','','SFXデザインテンプレート'));
  const templateLabel=element('label','','テンプレート'),templateSelect=element('select');
  templateSelect.dataset.sfxTemplateSelect='true';
  templateSelect.append(new Option('テンプレートを選択',''));
  for(const template of sfxTemplates)templateSelect.append(new Option(template.name,template.id));
  templateLabel.append(templateSelect);templateControls.append(templateLabel);
  const applyLabel=element('label','','適用する範囲'),applyMode=element('select');
  applyMode.dataset.sfxTemplateApplyMode='true';
  for(const [value,title] of [['all','すべて'],['style','スタイルのみ'],['layout','レイアウトのみ']])applyMode.append(new Option(title,value));
  applyLabel.append(applyMode);templateControls.append(applyLabel);
  const seedLabel=element('label','','テンプレートの乱数'),seedPolicy=element('select');seedPolicy.dataset.sfxTemplateSeed='true';seedPolicy.append(new Option('新規生成','new'),new Option('現在の模様を維持','same'));seedLabel.append(seedPolicy);templateControls.append(seedLabel);
  templateControls.append(button('sfx-template-save','デザインを登録'),button('sfx-template-apply','適用'),button('sfx-template-export','JSON出力'),button('sfx-template-import','JSON読込'),button('sfx-template-rename','名前変更'),button('sfx-template-delete','削除'));
  panel.append(templateControls);
  const glyph=l.lettering.glyphs.find(g=>g.index===mode.selected);
  if(glyph){
    const fields=element('div','effect-grid');
    for(const [key,[title,min,max]] of Object.entries(letteringFields)){
      const label=element('label','',title),input=element('input');input.type='number';
      input.dataset.glyphField=key;input.min=String(min);input.max=String(max);input.step=key==='z'?'1':'0.1';
      const values=l.lettering.glyphs.filter(g=>glyphSelection(mode).includes(g.index)).map(g=>g[key]);input.value=values.every(v=>v===values[0])?String(glyph[key]):'';input.placeholder=values.every(v=>v===values[0])?'':'混在';label.append(input);fields.append(label);
    }
    panel.append(fields,button('sfx-glyph-duplicate','文字を複製'),button('sfx-glyph-delete','文字を削除'),button('sfx-glyph-reset','位置・変形をリセット'));
  }
  panel.append(advancedLetteringPanel(p,l,mode,{edit:fn=>edit(p,fn),render:()=>{renderCards(p);drawPage(p);},fonts:{...FONT_CATALOG,...sessionFontChoices()},copyStroke:(run,part)=>{strokeClipboard={run:structuredClone(run),part};status('線の'+part+'をコピーした。');},pasteStroke:(run,part)=>pasteStrokeLook(p,l,run,part),saveStroke:run=>saveStrokePreset(run),loadStroke:run=>loadStrokePreset(p,l,run)}));
  const warning=element('p','sfx-overflow');warning.setAttribute('role','status');warning.hidden=true;panel.append(warning);
  const groups=element('details','sfx-outline-group-panel');
  groups.append(element('summary','','外側輪郭の結合'));
  const groupSelect=element('select');groupSelect.dataset.sfxOutlineGroupSelect='true';
  groupSelect.append(new Option('輪郭グループなし',''));
  for(let i=0;i<l.lettering.outlineGroups.length;i++){
    const g=l.lettering.outlineGroups[i];groupSelect.append(new Option('グループ '+(i+1)+' · '+g.members.length+'字',String(i)));
  }
  mode.outlineGroup=Math.min(mode.outlineGroup??0,Math.max(0,l.lettering.outlineGroups.length-1));
  if(l.lettering.outlineGroups.length)groupSelect.value=String(mode.outlineGroup);
  groups.append(groupSelect,button('sfx-outline-group-all','全文字を結合'),button('sfx-outline-group-new','選択文字から作成'));
  const currentGroup=l.lettering.outlineGroups[mode.outlineGroup];
  if(currentGroup){
    groups.append(button('sfx-outline-group-toggle','選択文字を追加／除外'),button('sfx-outline-group-remove','グループ削除'),button('sfx-outline-group-unlock','自動追従へ戻す'));
    const width=element('input');width.type='number';width.min='0';width.max='80';width.step='0.5';
    width.dataset.sfxGroupWidth='true';width.value=String(currentGroup.styleOverride?.width??l.outline);
    const color=element('input');color.type='color';color.dataset.sfxGroupColor='true';color.value=currentGroup.styleOverride?.color??l.textOutlineColor??'#ffffff';
    const widthLabel=element('label','','輪郭の太さ'),colorLabel=element('label','','輪郭の色');
    widthLabel.append(width);colorLabel.append(color);groups.append(widthLabel,colorLabel);
    enhanceColorInput(color,currentGroup.styleOverride?.color??l.textOutlineColor??'#ffffff',value=>edit(p,()=>{
      currentGroup.locked=true;currentGroup.mode='manual';
      currentGroup.styleOverride={...currentGroup.styleOverride,color:value,width:currentGroup.styleOverride?.width??l.outline};
    }));
  }
  panel.append(groups);
  if(l.lettering.strokes.length){
    const fieldset=element('details','sfx-stroke-panel');fieldset.append(element('summary','','連続「ー」の調整'));
    const run=l.lettering.strokes.find(s=>s.runStart===mode.strokeRun)??l.lettering.strokes[0];
    mode.strokeRun=run.runStart;
    const runLabel=element('label','','対象の線'),runSelect=element('select');runSelect.dataset.glyphStrokeRun='true';
    for(const item of l.lettering.strokes){const option=element('option','',String(item.runStart+1)+'文字目／'+item.runLength+'連続');option.value=String(item.runStart);runSelect.append(option);}
    runSelect.value=String(run.runStart);runLabel.append(runSelect);fieldset.append(runLabel);
    const modeLabel=element('label','','線の表示'),select=element('select');
    select.dataset.glyphStrokeMode=String(run.runStart);
    for(const [name,title] of [['continuous','連続線'],['font','フォント文字']]){const option=element('option','',title);option.value=name;select.append(option);}
    select.value=run.mode;modeLabel.append(select);fieldset.append(modeLabel);
    for(const [field,title,index] of [['start','始点の線幅',0],['end','終点の線幅',run.widths.length-1]]){
      const label=element('label','',title),input=element('input');input.type='number';input.min='0';input.max='500';
      input.step='0.1';input.dataset.glyphStrokeWidth=field;input.max=String(500*strokeWidthScale(run,l.size));input.value=strokeWidthControlDisplay(run,index,l.size);input.title='上下にドラッグして線幅を調整。上で太く、下で細く。';label.append(input);fieldset.append(label);connectStrokeNumericDrag(input,p,l,run,field,index);
    }
    const widthScaleLabel=element('label','','長音の太さ倍率（%）'),widthScale=element('input');widthScale.type='number';widthScale.min='1';widthScale.max='500';widthScale.step='1';widthScale.dataset.glyphStrokeWidthScale='true';widthScale.value=String(Number((run.widthMultiplier*100).toFixed(4)));widthScale.title='上下にドラッグして倍率を調整。上で増加、下で減少。';widthScaleLabel.append(widthScale);fieldset.append(widthScaleLabel);connectStrokeNumericDrag(widthScale,p,l,run,'scale');
    const label=element('label','','曲線'),shape=element('select');shape.dataset.glyphStrokeShape='true';
    for(const [name,title] of [['straight','直線'],['arc','円弧'],['s','S字'],['wave','波形']]){const option=element('option','',title);option.value=name;shape.append(option);}
    shape.value=run.shape;label.append(shape);fieldset.append(label);
    for(const side of ['start','end']){
      const sideName=side==='start'?'始点':'終点';
      const capLabel=element('label','',sideName+'の先端形状'),capSelect=element('select');
      capSelect.dataset.glyphStrokeCap=side;
      for(const [value,title] of [['round','丸'],['flat','平'],['taper','先細り'],['brush','筆先']]){
        const opt=element('option','',title);opt.value=value;capSelect.append(opt);
      }
      capSelect.value=run[side].cap;capLabel.append(capSelect);fieldset.append(capLabel);
      const detached=element('label','tail-toggle',sideName+'を文字から切り離す'),check=element('input');
      check.type='checkbox';check.dataset.glyphStrokeDetach=side;check.checked=run[side].detached;detached.prepend(check);fieldset.append(detached);
    }
    const pointLabel=element('label','','曲線の制御点'),pointSelect=element('select');pointSelect.dataset.glyphStrokePoint='true';
    for(let i=0;i<run.path.points.length;i++){const opt=element('option','',String(i+1)+'番');opt.value=String(i);pointSelect.append(opt);}
    mode.strokePoint=Math.min(mode.strokePoint??1,run.path.points.length-1);pointSelect.value=String(mode.strokePoint);
    pointLabel.append(pointSelect);fieldset.append(pointLabel);
    const point=run.path.points[mode.strokePoint];
    for(const axis of ['x','y']){
      const label=element('label','',axis==='x'?'制御点の進行方向位置':'制御点の横方向位置'),input=element('input');
      input.type='number';input.min='-10';input.max='10';input.step='0.01';
      input.dataset.glyphStrokePointAxis=axis;input.value=String(point[axis]);label.append(input);fieldset.append(label);
    }
    panel.append(fieldset);
  }
  for(const details of panel.querySelectorAll(':scope > details')){
    const grid=element('div','sfx-control-grid');
    grid.append(...[...details.children].filter(child=>child.tagName!=='SUMMARY'));
    details.append(grid);
  }
  return panel;
}
const strokeShapePoints=shape=>shape==='arc'?[{x:0,y:0},{x:.33,y:.22},{x:.67,y:.22},{x:1,y:0}]
  :shape==='s'?[{x:0,y:0},{x:.33,y:.35},{x:.67,y:-.35},{x:1,y:0}]
  :shape==='wave'?[{x:0,y:0},{x:.16,y:.25},{x:.33,y:.25},{x:.5,y:0},{x:.67,y:-.25},{x:.83,y:-.25},{x:1,y:0}]
  :[{x:0,y:0},{x:.33,y:0},{x:.67,y:0},{x:1,y:0}];

function captureCardViewport(p) {
  if(!p.row)return null;
  const pane=p.row.querySelector('.dialogue-pane'),active=document.activeElement,container=p.row.querySelector('.layer-cards');
  const card=active?.closest('.layer-card');
  const focus=card&&container.contains(active)?{
    layerId:card.dataset.layerId,
    tag:active.tagName,
    identity:[...active.attributes].filter(attribute=>attribute.name.startsWith('data-')||attribute.name==='class').map(({name,value})=>[name,value]),
    selection:typeof active.selectionStart==='number'?{start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}:null,
  }:null;
  return {
    windowX:window.scrollX,windowY:window.scrollY,
    paneLeft:pane.scrollLeft,paneTop:pane.scrollTop,
    glyphLists:[...container.querySelectorAll('.sfx-glyph-list')].map(list=>({layerId:list.closest('.layer-card')?.dataset.layerId,left:list.scrollLeft,top:list.scrollTop})),
    focus,
  };
}

function restoreCardViewport(p,view) {
  if(!view||!p.row)return;
  const pane=p.row.querySelector('.dialogue-pane'),container=p.row.querySelector('.layer-cards');
  const cards=new Map([...container.querySelectorAll('.layer-card')].map(card=>[card.dataset.layerId,card]));
  pane.scrollLeft=view.paneLeft;pane.scrollTop=view.paneTop;
  for(const saved of view.glyphLists){
    const list=cards.get(saved.layerId)?.querySelector('.sfx-glyph-list');
    if(list){list.scrollLeft=saved.left;list.scrollTop=saved.top;}
  }
  if(view.focus){
    const card=cards.get(view.focus.layerId);
    const target=[...(card?.querySelectorAll(view.focus.tag.toLowerCase())||[])].find(element=>
      view.focus.identity.every(([name,value])=>element.getAttribute(name)===value));
    if(target){
      target.focus({preventScroll:true});
      if(view.focus.selection)try{target.setSelectionRange(view.focus.selection.start,view.focus.selection.end,view.focus.selection.direction);}catch{}
    }
  }
  pane.scrollLeft=view.paneLeft;pane.scrollTop=view.paneTop;
  for(const saved of view.glyphLists){
    const list=cards.get(saved.layerId)?.querySelector('.sfx-glyph-list');
    if(list){list.scrollLeft=saved.left;list.scrollTop=saved.top;}
  }
  document.scrollingElement.scrollLeft=view.windowX;document.scrollingElement.scrollTop=view.windowY;
}

function renderCards(p) {
  if(p.renderingCards)return;p.renderingCards=true;
  try{
  const viewport=captureCardViewport(p);
  syncSelection(p);p.row?.classList.toggle('sfx-editing',!!activeGlyphEdit(p,selected(p)));
  updateImageView(p);
  if (!p.row) return;
  rememberCardDetails(p);
  const container = p.row.querySelector('.layer-cards'); container.replaceChildren();
  p.row.querySelector('.no-layers').hidden = p.layers.length > 0 || p.maskEffects.length > 0;
  const appendCard=(card,layer)=>{
    addNumericControls(card,p);
    addTextColorControls(card,p,layer);
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
      card.append(sfxLetteringPanel(p,l),placementControls(l));
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
  refreshPresetMenus(p); updateControls(p);restoreCardViewport(p,viewport);
  }finally{p.renderingCards=false;}
}

function mountPage(p) {
  const row = $('pageTemplate').content.firstElementChild.cloneNode(true); row.dataset.pageId = p.id; p.row = row;delete p.globalUIState;
  row.querySelector('[data-page-destination]').value=p.moveAfterPage??'';
  addNumericControls(row.querySelector('.position-controls'),p);
  addTextColorControls(row.querySelector('.position-controls'),p);
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
  connectPreviewFocusPan(p);
  const focusZoom=row.querySelector('[data-focus-zoom]');
  focusZoom.value=String(p.previewFocus.zoomPercent);
  focusZoom.addEventListener('change',()=>{
    if(!p.previewFocus.enabled)return;
    const zoom=normalizePreviewFocusZoom(focusZoom.value);
    if(zoom===null){focusZoom.value=String(p.previewFocus.zoomPercent);return;}
    setPreviewFocusZoom(p,zoom,{recenter:true});
  });
  focusZoom.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();focusZoom.blur();}});
  let focusZoomDrag=null,focusZoomSuppressClick=false;
  focusZoom.addEventListener('pointerdown',event=>{
    if(!p.previewFocus.enabled||!event.isPrimary||event.button!==0)return;
    focusZoomDrag={pointerId:event.pointerId,startY:event.clientY,startZoom:normalizePreviewFocusZoom(focusZoom.value)??p.previewFocus.zoomPercent,active:false};
    focusZoom.setPointerCapture(event.pointerId);
  });
  focusZoom.addEventListener('pointermove',event=>{
    const drag=focusZoomDrag;if(!drag||drag.pointerId!==event.pointerId)return;
    const verticalDelta=drag.startY-event.clientY;
    if(!drag.active){if(Math.abs(verticalDelta)<4)return;drag.active=true;focusZoom.classList.add('focus-zoom-dragging');}
    event.preventDefault();
    const zoom=normalizePreviewFocusZoom(drag.startZoom+Math.round(verticalDelta));
    if(zoom!==null&&zoom!==p.previewFocus.zoomPercent)setPreviewFocusZoom(p,zoom,{recenter:true});
  });
  const finishFocusZoomDrag=event=>{
    const drag=focusZoomDrag;if(drag?.pointerId!==event.pointerId)return;
    focusZoomDrag=null;focusZoom.classList.remove('focus-zoom-dragging');
    if(event.type==='pointerup'&&drag.active){
      focusZoomSuppressClick=true;setTimeout(()=>{focusZoomSuppressClick=false;},0);
    }else if(drag.active&&p.previewFocus.enabled)setPreviewFocusZoom(p,drag.startZoom,{recenter:true});
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])focusZoom.addEventListener(type,finishFocusZoomDrag);
  focusZoom.addEventListener('click',event=>{
    if(!focusZoomSuppressClick)return;
    focusZoomSuppressClick=false;event.preventDefault();
  });
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
  const letter=selected(p);if(letter?.lettering?.enabled){const scene=sceneFor(p,letter);letter.w=clamp(Math.max(letter.w,...scene.items.map(i=>Math.max(Math.abs(i.bounds.minX),Math.abs(i.bounds.maxX))*2+8)),30,30000);letter.h=clamp(Math.max(letter.h,...scene.items.map(i=>Math.max(Math.abs(i.bounds.minY),Math.abs(i.bounds.maxY))*2+8)),30,30000);}
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
  checkpoint(p); fn();
  markChanged(p);
  if (rebuild) renderCards(p);else updateControls(p);
  drawPage(p);
}

function moveObjects(p,action) {
  const ids=p.selectedMaskId?[p.selectedMaskId]:selectedLayers(p).map(layer=>layer.id);
  const ordered=reorderPageObjects(p,ids,action);
  if(ordered)edit(p,()=>Object.assign(p,ordered));
}

$('deck').addEventListener('focusin', event => {
  if ((busy&&currentTask?.data.kind!=='画像追加')||event.target.closest('button[data-action], .layer-summary, .mask-effect-summary')) return;
  const p = pageFrom(event.target); if (!p) return;
  const maskCard=event.target.closest('.mask-effect-card');if(maskCard){if(p.id!==activeId||p.selectedMaskId!==maskCard.dataset.maskId)selectMask(p,maskCard.dataset.maskId);return;}
  const id = event.target.closest('.layer-card')?.dataset.layerId;
  activate(p, id || p.selectedId);
});
$('deck').addEventListener('focusout', event => {
  editing.delete(event.target);
  const p = pageFrom(event.target);
  if(p?.renderingCards)return;
  if(event.target.matches('[data-mask-field]'))return;
  if(p&&event.target.matches('[data-field="text"]')){
    if(composing.has(event.target))return;
    const input=event.target,layer=p.layers.find(l=>l.id===input.closest('.layer-card')?.dataset.layerId);
    if(layer?.kind==='sfx'&&layer.lettering?.enabled){
      if(layer.text!==input.value){
        try{const next=replaceLetteringText(layer,input.value,activeGlyphEdit(p,layer)?.inherit??'position');
          edit(p,()=>Object.assign(layer,next));
        }catch(error){status('効果音テキストを確定できない: '+error.message);input.value=layer.text;}
      }
      return;
    }
  }
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
  if(field==='text'&&l.kind==='sfx'&&l.lettering?.enabled){
    try {
      const next=replaceLetteringText(l,input.value,activeGlyphEdit(p,l)?.inherit??'position');
      const originalText=l.text,originalLettering=l.lettering;
      try{l.text=next.text;l.lettering=next.lettering;drawPage(p);}
      finally{l.text=originalText;l.lettering=originalLettering;}
    }catch(error){status('効果音テキストのプレビューに失敗: '+error.message);}
    return; // IME/未確定テキストは正本を更新しない。
  }
  let value = input.type==='color'?colorInputValue(input):input.value;
  const limits = { size: [8, 500], thickness: THICKNESS_LIMIT, rotation: [-180, 180], w: [30, 30000], h: [30, 30000], outline: [0, 80], shapeSeed:[0,4294967295],brushSeed:[0,4294967295],glyphSeed:[0,4294967295],...BRUSH_LIMITS, ...EFFECT_LIMITS,...BALLOON_LIMITS,...CAPTION_LIMITS };
  if (['x', 'y', ...Object.keys(limits)].includes(field)) {
    if (value === '' || !Number.isFinite(Number(value))) return;
    value = numericValue(Number(value),field);
    if (limits[field]) value = clamp(value, ...limits[field]);
  } else if (field === 'vertical') value = value === 'true';
  else if(field==='tail'||field==='autoFit'||field==='shadowEnabled')value=input.checked;
  if (l[field] === value) return;
  if (!editing.has(input)) { checkpoint(p); editing.add(input); }
  if(field==='vertical'&&l.kind==='sfx'&&l.lettering?.enabled)Object.assign(l,rotateLetteringOrientation(l,value));else l[field] = value;if(field==='borderStyle'||field==='brushSeed'||Object.hasOwn(BRUSH_LIMITS,field))l.brushEngine='pressure';if(field!=='text')l.presetId=null;
  if(field==='text'){const summary=input.closest('.layer-card')?.querySelector('.layer-summary');if(summary)renderLayerSummary(l,summary);}
  markChanged(p);drawPage(p);updateControls(p);if(field!=='text')refreshPresetMenus(p);
});
$('deck').addEventListener('change',event=>{
  const input=event.target;
  if(input.matches('[data-glyph-inherit],[data-glyph-field],[data-glyph-stroke-mode],[data-glyph-stroke-width],[data-glyph-stroke-width-scale],[data-glyph-stroke-shape],[data-glyph-stroke-run],[data-glyph-stroke-cap],[data-glyph-stroke-detach],[data-glyph-stroke-point],[data-glyph-stroke-point-axis],[data-sfx-outline-group-select],[data-sfx-group-width],[data-sfx-group-color]')){
    const p=pageFrom(input),l=p?.layers.find(l=>l.id===input.closest('.layer-card')?.dataset.layerId);
    const mode=activeGlyphEdit(p,l);if(!mode)return;
    if(input.matches('[data-sfx-outline-group-select]')){
      mode.outlineGroup=Math.max(0,Number(input.value)||0);renderCards(p);return;
    }
    if(input.matches('[data-sfx-group-width],[data-sfx-group-color]')){
      const group=l.lettering.outlineGroups[mode.outlineGroup];if(!group)return;
      const numeric=Number(input.value);
      if(input.matches('[data-sfx-group-width]')&&(!input.value||!Number.isFinite(numeric)||numeric<0||numeric>80))return;
      edit(p,()=>{group.locked=true;group.mode='manual';group.styleOverride={...group.styleOverride,color:group.styleOverride?.color??l.textOutlineColor??'#ffffff',
        width:group.styleOverride?.width??l.outline,
        ...(input.matches('[data-sfx-group-color]')?{color:input.value}:{width:numeric})};});return;
    }
    if(input.matches('[data-glyph-inherit]')){mode.inherit=input.value;return;}
    if(input.matches('[data-glyph-field]')){
      const field=input.dataset.glyphField,limit=letteringFields[field],value=Number(input.value);
      if(!limit||!input.value||!Number.isFinite(value)||value<limit[1]||value>limit[2])return;
      edit(p,()=>{
        const indices=glyphSelection(mode),scene=sceneFor(p,l);freezeGlyphOrigins(l,scene);
        const targets=l.lettering.glyphs.filter(g=>indices.includes(g.index));
        if(targets.length>1&&['rotation','scaleX','scaleY'].includes(field)){
          const before=new Map(targets.map(g=>[g.index,g[field]])),mean=targets.reduce((n,g)=>n+g[field],0)/targets.length,kind=mode.valueMode||'absolute',target=kind==='absolute'?value:kind==='add'?mean+value:mean*value;
          transformGlyphSelection(l,indices,scene,field==='rotation'?{rotation:target-mean}:{[field]:Math.max(.01,target/(mean||1))});
          for(const g of targets)g[field]=clamp(kind==='absolute'?value:kind==='add'?before.get(g.index)+value:before.get(g.index)*value,limit[1],limit[2]);
        }else for(const g of targets){const next=mode.valueMode==='add'?g[field]+value:mode.valueMode==='multiply'?g[field]*value:value;g[field]=field==='z'?Math.round(clamp(next,limit[1],limit[2])):clamp(next,limit[1],limit[2]);g.manual[field==='dx'||field==='dy'?'position':field==='z'?'z':'transform']=true;}
      });return;
    }
    if(input.matches('[data-glyph-stroke-run]')){
      mode.strokeRun=Number(input.value);mode.strokePoint=1;mode.pointSelection=[{kind:'curve',index:1,run:mode.strokeRun}];renderCards(p);return;
    }
    const run=l.lettering.strokes.find(s=>s.runStart===mode.strokeRun)??l.lettering.strokes[0];if(!run)return;
    if(input.matches('[data-glyph-stroke-point]')){mode.strokePoint=Number(input.value);mode.pointSelection=[{kind:'curve',index:mode.strokePoint,run:run.runStart}];if(mode.editMode!=='both')mode.editMode='curve';renderCards(p);return;}
    if(input.matches('[data-glyph-stroke-point-axis]')&&(!input.value||!Number.isFinite(Number(input.value))||Math.abs(Number(input.value))>10))return;
    if(input.matches('[data-glyph-stroke-width]')&&(!Number.isFinite(Number(input.value))||Number(input.value)<0||Number(input.value)>500*strokeWidthScale(run,l.size)))return;
    if(input.matches('[data-glyph-stroke-width-scale]')&&(!Number.isFinite(Number(input.value))||Number(input.value)<1||Number(input.value)>500))return;
    if(input.matches('[data-glyph-stroke-width]')){
      const index=input.dataset.glyphStrokeWidth==='start'?0:run.widths.length-1,scale=strokeWidthScale(run,l.size),max=500*scale;
      const effective=Math.min(Number(Number(input.value).toFixed(1)),Math.floor((max+1e-8)*10)/10);
      if(run.widths[index].w===effective/scale){input.value=effective.toFixed(1);return;}
    }
    if(input.matches('[data-glyph-stroke-width-scale]')&&run.widthMultiplier===Number(input.value)/100)return;
    edit(p,()=>{
      if(input.matches('[data-glyph-stroke-cap]'))run[input.dataset.glyphStrokeCap].cap=input.value;
      if(input.matches('[data-glyph-stroke-detach]')){const side=input.dataset.glyphStrokeDetach,frame=strokeFrame(run,sceneFor(p,l).positions,{vertical:l.vertical,size:l.size});if(input.checked&&frame)run[side].fixedPosition={...(side==='start'?frame.start:frame.end)};else delete run[side].fixedPosition;run[side].detached=input.checked;}
      if(input.matches('[data-glyph-stroke-point-axis]')){
        run.path.points[mode.strokePoint][input.dataset.glyphStrokePointAxis]=Number(input.value);
        run.shape='custom';
      }
      if(input.matches('[data-glyph-stroke-mode]'))run.mode=input.value;
      if(input.matches('[data-glyph-stroke-shape]')){run.shape=input.value;run.path.points=strokeShapePoints(input.value);}
      if(input.matches('[data-glyph-stroke-width]')){
        const index=input.dataset.glyphStrokeWidth==='start'?0:run.widths.length-1,max=500*strokeWidthScale(run,l.size),effective=Math.min(Number(Number(input.value).toFixed(1)),Math.floor((max+1e-8)*10)/10);
        run.widths[index].w=effective/strokeWidthScale(run,l.size);
      }
      if(input.matches('[data-glyph-stroke-width-scale]'))run.widthMultiplier=Number(input.value)/100;
    });return;
  }

  if(event.target.matches('[data-mask-field]')){const p=pageFrom(event.target);updateMaskEffectField(p,event.target);editing.delete(event.target);return;}
  editing.delete(event.target);if(event.target.matches('input[type=number][data-field],input[type=number][data-numeric-field]')){const p=pageFrom(event.target),l=p?.layers.find(l=>l.id===(event.target.closest('.layer-card')?.dataset.layerId||p.selectedId));if(l)syncControlValue(event.target,l[controlField(event.target)],p);}
});

$('deck').addEventListener('click', async event => {
  if(busy&&currentTask?.data.kind!=='画像追加')return;
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
  const toggle=event.shiftKey&&!!event.target.closest('.layer-summary,.kind-label')&&!event.target.closest('.sfx-lettering-panel');
  if(cardId)selectObject(p,cardId,toggle,!toggle);
  activate(p, toggle?p.selectedId:cardId || p.selectedId);
  if(toggle){p.canvas.focus({preventScroll:true});return;}
  if(readOnly&&action&&!['preview-full','preview-focus','preview-magnifier','copy-all','save-image'].includes(action))return;
  if (!action || (busy&&['move-up','move-down','move-after','remove','delete','duplicate-image','complete','copy-next','copy-all','cut-all','paste-all','save-image','crop-image','apply-crop','cancel-crop','rotate-left','rotate-right','reset-image'].includes(action))) return;
  const l = selected(p);
  if(action==='sfx-glyph-enter'&&l?.kind==='sfx'){
    if(!l.lettering?.enabled)edit(p,()=>{l.lettering=startLettering(l);},false);
    p.glyphEdit={id:l.id,selected:l.lettering.glyphs[0]?.index??null,indices:l.lettering.glyphs.slice(0,1).map(g=>g.index),strokeRuns:[],inherit:'position',editMode:'glyph'};
    renderCards(p);drawPage(p);return;
  }
  if(action==='sfx-glyph-exit'){p.glyphEdit=null;renderCards(p);drawPage(p);return;}
  const glyphMode=activeGlyphEdit(p,l);
  if(glyphMode){
    if(action==='sfx-text-apply'){card?.querySelector('textarea[data-field=text]')?.blur();return;}
    if(action==='sfx-outline-group-all'||action==='sfx-outline-group-new'){
      const members=action==='sfx-outline-group-all'?l.lettering.glyphs.map(g=>g.index):glyphSelection(glyphMode);
      if(members.length)edit(p,()=>{l.lettering.outlineGroups.push({members,mode:action==='sfx-outline-group-all'?'auto':'manual',
        locked:action!=='sfx-outline-group-all',styleOverride:null});if(action==='sfx-outline-group-all')l.lettering.outlineMode='union';glyphMode.outlineGroup=l.lettering.outlineGroups.length-1;});return;
    }
    if(action==='sfx-outline-group-toggle'){
      const group=l.lettering.outlineGroups[glyphMode.outlineGroup];if(!group)return;
      const next=new Set(group.members);
      if(next.has(glyphMode.selected)){if(next.size===1)return;next.delete(glyphMode.selected);}
      else next.add(glyphMode.selected);
      edit(p,()=>{group.members=[...next].sort((a,b)=>a-b);group.mode='manual';group.locked=true;});return;
    }
    if(action==='sfx-outline-group-unlock'){const group=l.lettering.outlineGroups[glyphMode.outlineGroup];if(group)edit(p,()=>{group.locked=false;group.mode='auto';l.lettering.outlineMode='union';});return;}
    if(action==='sfx-outline-group-remove'){
      if(!l.lettering.outlineGroups[glyphMode.outlineGroup])return;
      edit(p,()=>{l.lettering.outlineGroups.splice(glyphMode.outlineGroup,1);
        glyphMode.outlineGroup=Math.max(0,Math.min(glyphMode.outlineGroup,l.lettering.outlineGroups.length-1));});return;
    }
    if(action==='sfx-template-save'){
      const name=prompt('テンプレート名','新しいSFXデザイン');if(!name)return;
      try{sfxTemplates=mergeSfxTemplates(sfxTemplates,[createSfxTemplate(l,name)],{conflict:'rename'});saveSfxTemplates();dirty();renderCards(p);status('SFXデザインテンプレートを登録した。');}
      catch(error){status('テンプレート登録失敗: '+error.message);}return;
    }
    if(action==='sfx-template-apply'){
      const template=sfxTemplates.find(x=>x.id===card?.querySelector('[data-sfx-template-select]')?.value);
      if(!template){status('テンプレートを選択してください。');return;}
      try{const mode=card.querySelector('[data-sfx-template-apply-mode]')?.value||'all',candidate=applySfxTemplate(l,template,{mode,reuseSeed:card.querySelector('[data-sfx-template-seed]')?.value==='same'});if(!await resolveMissingFonts([candidate]))return;
        edit(p,()=>Object.assign(l,candidate));status('原文とページ座標を保持して適用した。');}
      catch(error){status('テンプレート適用失敗: '+error.message);}return;
    }
    if(action==='sfx-template-rename'||action==='sfx-template-delete'){const t=sfxTemplates.find(x=>x.id===card?.querySelector('[data-sfx-template-select]')?.value);if(!t)return;if(action==='sfx-template-delete'){if(!confirm('テンプレート「'+t.name+'」を削除する？'))return;sfxTemplates=sfxTemplates.filter(x=>x.id!==t.id);}else{const name=prompt('新しいテンプレート名',t.name);if(!name?.trim()||name.length>100||sfxTemplates.some(x=>x.id!==t.id&&x.name===name))return;t.name=name.trim();}saveSfxTemplates();dirty();renderCards(p);return;}
    if(action==='sfx-template-export'){
      try{download(new Blob([encodeSfxTemplates(sfxTemplates)],{type:'application/json'}),'serifu-sfx-templates.json');}
      catch(error){status('テンプレート書出しに失敗: '+error.message);}return;
    }
    if(action==='sfx-template-import'){
      const input=document.createElement('input');input.type='file';input.accept='application/json,.json';
      input.onchange=async()=>{const file=input.files?.[0];if(!file)return;
        try{const incoming=decodeSfxTemplates(await file.text());
          const policy=prompt('ID/名前競合: skip（スキップ）/ overwrite（上書き）/ rename（名前変更）','skip')||'skip';
          sfxTemplates=mergeSfxTemplates(sfxTemplates,incoming,{conflict:policy});saveSfxTemplates();dirty();renderCards(p);}
        catch(error){status('テンプレート読込失敗: '+error.message);}};
      input.click();return;
    }
    if(action==='sfx-glyph-select'){
      selectGlyph(glyphMode,Number(event.target.closest('[data-glyph-index]').dataset.glyphIndex),{toggle:event.shiftKey,range:event.shiftKey&&event.altKey,visible:l.lettering.glyphs.map(g=>g.index)});
      glyphMode.editMode='glyph';glyphMode.pointSelection=[];
      const indices=glyphSelection(glyphMode);
      glyphMode.strokeRuns=l.lettering.strokes.filter(run=>run.mode==='continuous'&&indices.some(index=>index>=run.runStart&&index<run.runStart+run.runLength)).map(run=>run.runStart);
      if(glyphMode.strokeRuns.length)glyphMode.strokeRun=glyphMode.strokeRuns.at(-1);
      renderCards(p);drawPage(p);return;
    }
    if(action==='sfx-glyph-duplicate'){
      const indices=glyphSelection(glyphMode);edit(p,()=>Object.assign(l,duplicateSelectedGlyphs(l,indices,sceneFor(p,l))));
      glyphMode.indices=indices.sort((a,b)=>a-b).map((i,n)=>i+n+1);glyphMode.selected=glyphMode.indices[0]??null;renderCards(p);drawPage(p);return;
    }
    if(action==='sfx-glyph-delete'){deleteSfxSelection(p,l,glyphMode);return;}
    if(action==='sfx-glyph-reset'){
      edit(p,()=>{for(const g of l.lettering.glyphs.filter(g=>glyphSelection(glyphMode).includes(g.index))){
        Object.assign(g,{dx:0,dy:0,rotation:0,scaleX:1,scaleY:1,shear:0});
        g.manual.position=false;g.manual.transform=false;
      }});return;
    }
  }
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
  } else if(action==='preview-focus'){
    togglePreviewFocus(p);
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
    guard(task=>bulkLayers(action,p,task),'レイヤー一括操作',3,{waitForDraft:false});
  } else if (action === 'remove') {
    if (p.layers.length && !confirm(`「${p.name}」を一覧から外す？ 未保存の編集は失われる。元ファイルは残る。`)) return;
    removePage(p);
  } else if (action === 'delete') {
    if (!p.directory || !confirm(`元画像「${p.name}」をフォルダから完全に削除する？\nゴミ箱には移動しない。未保存の編集も失われる。`)) return;
    guard(async () => {
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
  p.canvas.addEventListener('paste',event=>{const l=selected(p),mode=activeGlyphEdit(p,l);if(!mode||editLocked())return;const text=event.clipboardData?.getData('text/plain');if(!text)return;event.preventDefault();pasteSfxClipboard(p,l,mode,sfxClipboard?.text===text?sfxClipboard:plainSfxClipboard(text));});
  p.canvas.addEventListener('dblclick',event=>{
    if(editLocked()||p.cropDraft)return;
    const pos=coords(event,p),l=paintOrder(p.layers).reverse().find(l=>l.kind==='sfx'&&hit(l,pos.x,pos.y));
    if(!l)return;
    selectObject(p,l.id);activate(p);
    if(!activeGlyphEdit(p,l))p.row.querySelector(`[data-layer-id="${l.id}"] [data-action=sfx-glyph-enter]`)?.click();
    const mode=activeGlyphEdit(p,l);if(!mode)return;
    const point=localPoint(l,pos.x,pos.y),scene=sceneFor(p,l);
    const item=scene.items.filter(item=>sfxItemHit(item,point)).at(-1);
    if(item?.type!=='stroke')return;
    event.preventDefault();
    mode.editMode='curve';mode.strokeRun=item.stroke.runStart;mode.strokeRuns=[item.stroke.runStart];mode.indices=[];mode.selected=null;
    const nearest=strokeHandles(scene,l,mode).reduce((closest,handle)=>
      !closest||Math.hypot(handle.x-point.x,handle.y-point.y)<Math.hypot(closest.x-point.x,closest.y-point.y)?handle:closest,null);
    mode.strokePoint=nearest.index;mode.pointSelection=[{kind:'curve',index:nearest.index,run:item.stroke.runStart}];
    renderCards(p);drawPage(p);p.canvas.focus({preventScroll:true});
  });
  p.canvas.addEventListener('pointerdown', event => {
    if(editLocked()||event.button!==0||drag)return;
    const letter=selected(p),mode=activeGlyphEdit(p,letter);
    if(mode){event.preventDefault();mode.touch=event.pointerType==='touch';activate(p);beginLetteringGesture(p,letter,mode,event,localPoint(letter,...Object.values(coords(event,p))),p.canvas.getBoundingClientRect().width/imageSize(p.img.width,p.img.height,p.imageEdit).width,{render:()=>drawPage(p),magnify:()=>toggleMagnifier(p,p.row.querySelector('[data-action=preview-magnifier]')||p.canvas),focusZoom:(value,options)=>setPreviewFocusZoom(p,value,options),focusPoint:client=>previewFocusPointAtClient(p,client)});return;}
    if(!event.isPrimary)return;
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
    const letter=selected(p),mode=activeGlyphEdit(p,letter);
    if(mode&&moveLetteringGesture(p,letter,mode,event,localPoint(letter,...Object.values(coords(event,p))),{checkpoint:()=>checkpoint(p),render:()=>drawPage(p),focusZoom:(value,options)=>setPreviewFocusZoom(p,value,options)}))return;
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
    }else{if(drag.mode==='resize'&&target.lettering?.enabled)scaleLetteringData(target,updates.w/target.w,updates.h/target.h);Object.assign(target, updates);target.presetId=null;}
    dirty(); p.done = false;p.edited=true;scheduleThumbnailRefresh(p);
    if(firstCopy)renderCards(p);
    drawPage(p); updateControls(p); updateGlobal();
  });
  const end = event => {
    const letter=selected(p),mode=activeGlyphEdit(p,letter);
    if(mode&&endLetteringGesture(p,letter,mode,event,{commit:()=>markChanged(p),render:()=>{renderCards(p);drawPage(p);}}))return;
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
  p.canvas.addEventListener('lostpointercapture', event=>{if(p.glyphDrag?.id===event.pointerId||p.cropPointer?.id===event.pointerId||drag?.maskId&&drag.page===p&&drag.id===event.pointerId)end(event);});
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
  const activeLetter=activeGlyphEdit(p,selected(p));
  if(activeLetter&&command&&!event.altKey&&['c','v','d'].includes(key)){
    event.preventDefault();const l=selected(p),scene=sceneFor(p,l);
    if(key==='c'){sfxClipboard=copyLetteringSelection(l,activeLetter,scene);if(sfxClipboard)void navigator.clipboard?.writeText(sfxClipboard.text).catch(()=>{});}
    if(key==='v'){
      const currentId=projectId;
      const fallback=()=>{if(projectId===currentId&&activeGlyphEdit(p,l)===activeLetter)pasteSfxClipboard(p,l,activeLetter,sfxClipboard);};
      if(navigator.clipboard?.readText)void navigator.clipboard.readText().then(text=>{if(projectId===currentId&&activeGlyphEdit(p,l)===activeLetter)pasteSfxClipboard(p,l,activeLetter,text&&text!==sfxClipboard?.text?plainSfxClipboard(text):sfxClipboard);}).catch(fallback);else fallback();
    }
    if(key==='d'){const indices=glyphSelection(activeLetter);edit(p,()=>Object.assign(l,duplicateSelectedGlyphs(l,indices,scene)));activeLetter.indices=indices.sort((a,b)=>a-b).map((i,n)=>i+n+1);activeLetter.selected=activeLetter.indices[0];renderCards(p);drawPage(p);}
    return;
  }
  if(activeLetter&&!command&&!event.altKey){
    if(key==='escape'){event.preventDefault();p.glyphEdit=null;renderCards(p);drawPage(p);return;}
    if(key==='delete'||key==='backspace'){
      event.preventDefault();const l=selected(p);
      deleteSfxSelection(p,l,activeLetter);return;
    }
    const vector={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
    if(vector){
      event.preventDefault();const l=selected(p),step=event.shiftKey?10:1;
      edit(p,()=>transformGlyphSelection(l,glyphSelection(activeLetter),sceneFor(p,l),{dx:vector[0]*step,dy:vector[1]*step}));return;
    }
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

async function guard(fn,kind='処理',stageCount=1,{waitForDraft=true}={}) {
  if(busy)return;busy=true;drag=null;
  const task=new BulkTask(kind,{stageCount,onProgress:displayTask});task.metrics.poolStart=structuredClone(imagePool.metrics);currentTask=task;updateGlobal();let failure;
  try {if(waitForDraft&&draftTask){task.data.stageCount++;task.stage('一時保存の完了待ち');await awaitWithAbort(draftTask.catch(()=>{}),task.signal);}await fn(task);}
  catch(error){failure=error;if(error.name!=='AbortError')status(`処理できなかった: ${error.message}`);else status(`処理を中断した。${task.data.succeeded}件完了。${task.data.currentName}`);}
  finally{imagePool.resize(2);const poolDelta={jobs:imagePool.metrics.jobs-task.metrics.poolStart.jobs,fallbackJobs:imagePool.metrics.fallbackJobs-task.metrics.poolStart.fallbackJobs,timings:Object.fromEntries(Object.entries(imagePool.metrics.timings).map(([key,value])=>[key,value-(task.metrics.poolStart.timings[key]||0)]))};window.serifuMetrics={...task.finish(failure),poolDelta,pool:structuredClone(imagePool.metrics),cache:{bytes:pngCache.bytes,hits:pngCache.hits,misses:pngCache.misses}};currentTask=null;busy=false;updateGlobal();if(preferences.autosave.enabled&&revision!==lastSavedRevision)setTimeout(()=>temporarySave(false),0);}
}
function decode(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('画像を読み込めない')); img.src = src; });
}
async function addFiles(entries,task) {
  entries=entries.filter(e=>/\.(png|jpe?g|webp|gif|avif)$/i.test(e.file?.name||e.handle?.name));
  sourceFolderName=uploadedFolderName(entries)||sourceFolderName;
  let count=0,failures=0,draftCount=0,first=null,lastFlush=performance.now(),unflushed=0;
  const draftWarnings=[],draftFontLoads=new Map(),measureCanvas=document.createElement('canvas'),measureContext=measureCanvas.getContext('2d');
  const flush=()=>{if(!unflushed)return;if(!activeId&&first)activeId=first.id;dirty();const flushed=performance.now();refreshJump();task.metrics.flushMs=(task.metrics.flushMs||0)+performance.now()-flushed;if(task.metrics.firstEditableMs===null){task.metrics.firstEditableMs=performance.now()-task.started;}unflushed=0;lastFlush=performance.now();};
  if(entries.length>=4)imagePool.resize(4);task.stage('画像準備と表示反映',entries.length);
  try{for(let start=0;start<entries.length;start+=20){
    const batch=entries.slice(start,start+20),ready=[];
    for await(const result of boundedResults(batch,async entry=>{task.metrics.metadataRequested=(task.metrics.metadataRequested||0)+1;const file=entry.file||await entry.handle.getFile();const expectedSize=await imageDimensions(file);task.metrics.metadataCompleted=(task.metrics.metadataCompleted||0)+1;return {...entry,file,expectedSize};},{signal:task.signal,concurrency:2})){
      ready.push(result.error?{...batch[result.index],metadataError:result.error}:result.value);
    }
    for await(const result of boundedResults(ready,async entry=>{if(entry.metadataError)throw entry.metadataError;return {...entry,prepared:await prepareImage(entry.file,task,entry.expectedSize)};},queueOptions(task,true))){
      checkAbort(task.signal);const entry=ready[result.index],name=entry.file?.name||entry.handle?.name;
      if(result.error){failures++;task.result(name,false);(task.metrics.failures ||= []).push({name,reason:result.error.message});task.update({errorMessage:`${name}: ${result.error.message}`},true);continue;}
      const {file,directory=null,prepared}=result.value,draft=await readImageDraft(result.value,task,measureContext,draftFontLoads);
      checkAbort(task.signal);draftCount+=draft.layers.length;draftWarnings.push(...draft.warnings);
      const p=createPage({name:file.name,src:URL.createObjectURL(file),file,directory,prepared,layers:draft.layers});pages.push(p);first ||= p;count++;unflushed++;if(directory)sourceDirectory=directory;
      task.result(name);if(unflushed>=10||(count===1&&pages.length===1)||performance.now()-lastFlush>=250){flush();await yieldToBrowser();}
    }
    flush();await yieldToBrowser();
  }}finally{flush();measureCanvas.width=measureCanvas.height=1;}

  task.metrics.draftLayers=draftCount;task.metrics.draftWarnings=draftWarnings;
  status(`${count} 枚を追加。画像ごとに下へスクロールして編集${draftCount?` · 下書き${draftCount}件を生成`:''}${failures?` · ${failures} 枚は読込失敗`:''}${draftWarnings.length?` · 下書きの注意: ${draftWarnings.join(' / ')}`:''}`);
}
async function readImageDraft(entry,task,context,fontPreparations) {
  if(!entry.draftFile&&!entry.draftHandle)return {layers:[],warnings:[]};
  const name=entry.draftFile?.webkitRelativePath||entry.draftFile?.name||entry.draftHandle.name;
  try{
    checkAbort(task.signal);
    const file=entry.draftFile||await awaitWithAbort(entry.draftHandle.getFile(),task.signal);
    const parsed=parseAnnotationDraft(await awaitWithAbort(file.text(),task.signal),entry.file.name);
    const layers=createDraftLayers(parsed.annotations,entry.prepared.width,entry.prepared.height,makeLayer);
    const queries=[...new Set(layers.flatMap(fontLoadQueries))].filter(Boolean);
    if(document.fonts)for(const query of queries){
      checkAbort(task.signal);
      if(!fontPreparations.has(query))fontPreparations.set(query,document.fonts.load(query).then(faces=>{if(!faces.length)throw new Error(`書体を読込できない: ${query}`);fontErrors.delete(query);clearGlyphCache();}));
      await awaitWithAbort(fontPreparations.get(query),task.signal);
    }
    checkAbort(task.signal);
    const placed=layoutDraftLayers(layers,entry.prepared.width,entry.prepared.height,layer=>layerBounds(context,layer),{signal:task.signal});
    const warnings=parsed.warnings.map(warning=>`${name}: ${warning}`);
    if(placed.overflow)warnings.push(`${name}: 最小サイズでも収まらず画像外へ配置した。画像外の部分はPNGに出力されないため位置調整が必要`);
    return {layers:placed.layers,warnings};
  }catch(error){if(error.name==='AbortError'||task.signal.aborted)throw error;return {layers:[],warnings:[`${name}: 下書きを生成できなかった (${error.message})`]};}
}
$('open').onclick = () => {
  if(busy)return;if (!window.showDirectoryPicker) { $('folderInput').click(); status('フォルダ内の画像を読み込める。直接保存と元画像削除はPC版Chrome / Edgeが対象。'); return; }
  const picked=window.showDirectoryPicker({mode:'readwrite'}).then(parent=>({parent}),error=>({error}));
  guard(async task=>{const selection=await picked;if(selection.error)throw selection.error;const directory=selection.parent,entries=[],drafts=new Map();let scanned=0;task.stage('フォルダ列挙');
    for await(const entry of directory.values()){checkAbort(task.signal);if(entry.kind==='file'){if(/\.(png|jpe?g|webp|gif|avif)$/i.test(entry.name)){entries.push({handle:entry,directory});task.result(entry.name);}else if(/\.json$/i.test(entry.name))drafts.set(entry.name,entry);}if(++scanned%20===0)await yieldToBrowser();}
    for(const entry of entries)entry.draftHandle=drafts.get(draftFileName(entry.handle.name));
    entries.sort((a,b)=>a.handle.name.localeCompare(b.handle.name,'ja',{numeric:true}));await addFiles(entries,task);
  },'画像追加',2);
};
$('files').onclick = () => {if(!busy)$('fileInput').click();};
function addImageFiles(files,{withDrafts=false}={}) {
  if(readOnly){status('閲覧専用のプロジェクトには画像を追加できない。');return;}
  if (busy) return;
  const images = [...files].filter(file => /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  if (!images.length) { status('追加できる画像がない。PNG / JPEG / WebP / GIF / AVIFを選択してほしい。'); return; }
  const drafts=withDrafts?new Map([...files].map(file=>[file.webkitRelativePath||file.name,file])):new Map();
  return guard(task => addFiles(images.map(file => ({file,draftFile:drafts.get(draftFileName(file.webkitRelativePath||file.name))})), task), '画像追加');
}
for (const id of ['fileInput', 'folderInput']) $(id).onchange = event => {
  const files = [...event.target.files]; event.target.value = '';
  addImageFiles(files,{withDrafts:id==='folderInput'});
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
  const custom=p.layers.some(l=>[l.font,...(l.lettering?.glyphs||[]).map(g=>g.overrides.font)].some(hasSessionFont));
  const blob=custom?await imageBlobFallback(p):await imagePool.run('render-png',{blob:await originalBlob(p),width:p.img.width,height:p.img.height,layers:p.layers,imageEdit:p.imageEdit,maskEffects:p.maskEffects,maskAssets:p.maskAssets},task,()=>imageBlobFallback(p));
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
    await writeParts(directory,projectName,projectParts(snapshot,prefs,{format,task,sourceFolderName:folderName,projectId}),task.signal,bytes=>task.update({writtenBytes:task.data.writtenBytes+bytes}),()=>task.stage('編集データの書込み確定',1));projectSaved=true;task.result(projectName);task.metrics.pngWritten=completed;task.metrics.projectSaved=true;
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
  const project=await projectBlob(snapshot,prefs,{format,task,sourceFolderName:folderName,projectId});task.stage('ZIP作成',1);await archive.add(projectName,project,task.signal);const blob=archive.blob(task.signal);task.result(name);task.stage('ダウンロード準備',1);checkAbort(task.signal);download(blob,name);task.metrics.archiveEntries=archive.entries.length;task.result(name);status(`${snapshot.length} 枚と編集データをまとめた「${name}」のダウンロードを開始した。展開して利用できる。`);
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
  if(!pages.length){task.stage('対象なし',0);return;}task.stage('メタ情報準備',pages.length);const snapshot=snapshotPages(),prefs={...structuredClone(preferences),sfxTemplates:structuredClone(sfxTemplates),sfxStrokePresets:structuredClone(strokePresets)},format=$('projectFormat').value,folderName=sourceFolderName,startedAt=new Date(),name=projectFileName(format,startedAt,folderName);task.update({processed:snapshot.length,succeeded:snapshot.length});const blob=await projectBlob(snapshot,prefs,{format,task,sourceFolderName:folderName,projectId});checkAbort(task.signal);task.stage('ダウンロード準備',1);download(blob,name);task.result(name,true,blob.size);status(`編集データ「${name}」のダウンロードを開始した`);
},'編集データ保存',3);
async function resolveMissingFonts(layers){
  const missing=[...new Set(layers.flatMap(missingLayerFonts))];if(!missing.length)return true;
  const modal=element('dialog','missing-font-dialog');modal.setAttribute('aria-label','不足フォントの解決');modal.append(element('h2','','必要な書体が見つからない'),element('p','',missing.join('、')));
  const select=element('select');select.dataset.fontFallback='true';for(const [key,font] of Object.entries(FONT_CATALOG))select.add(new Option(font.label,key));select.value='comic';modal.append(select);
  const note=element('p','','アップロードした書体はこのタブで使用。編集データに書体ファイルは含まれず、再度開く際は再アップロードが必要。使用権を確認したファイルを選ぶ。');modal.append(note);
  const upload=element('input');upload.type='file';upload.accept='.ttf,.otf,.woff,.woff2';upload.dataset.fontUpload='true';modal.append(upload);
  const result=await new Promise(resolve=>{
    const apply=element('button','','代替書体を使用');apply.onclick=()=>{for(const layer of layers){if(missing.includes(layer.font)){layer.originalFont=layer.font;layer.font=select.value;layer.fontResolvedNow=true;}for(const g of layer.lettering?.glyphs||[])if(missing.includes(g.overrides.font)){g.overrides.originalFont=g.overrides.font;g.overrides.font=select.value;layer.fontResolvedNow=true;}}resolve(true);modal.close();};
    upload.onchange=async()=>{const file=upload.files?.[0];if(!file)return;try{for(const key of missing)await registerSessionFont(key,file);for(const select of [...document.querySelectorAll('[data-field=font]'),...$('pageTemplate').content.querySelectorAll('[data-field=font]')])for(const key of missing)if(![...select.options].some(o=>o.value===key))select.add(new Option(key+'（アップロード）',key));clearGlyphCache();pngCache.clear();resolve(true);modal.close();}catch(error){note.textContent=error.message;}};
    const cancel=element('button','','中止');cancel.onclick=()=>{resolve(false);modal.close();};modal.oncancel=()=>resolve(false);modal.append(apply,cancel);document.body.append(modal);modal.showModal();
  });modal.remove();return result;
}
async function openStoredProject(identity,task,{snapshotId=null,restoreHistory=false}={}){
  const bundle=await readProjectBundle(identity,{snapshotId});if(!bundle)throw new Error('正常保存済みのプロジェクトがない');
  const meta=bundle.snapshot.meta,byImage=new Map(bundle.images.map(x=>[x.id,x.blob])),byMask=new Map(meta.pages.map(p=>[p.id,{}]));
  for(const record of bundle.masks)byMask.get(record.pageId)[record.id]=record.asset;
  const importedStrokes=validateStrokePresets(meta.preferences?.sfxStrokePresets??[]);
  const templates=Array.isArray(meta.preferences?.sfxTemplates)?mergeSfxTemplates(sfxTemplates,meta.preferences.sfxTemplates,{conflict:'skip'}):sfxTemplates;
  const loaded=await prepareProjectPages(meta.pages.map(p=>({...p,blob:byImage.get(p.id),maskAssets:byMask.get(p.id)})),meta.version,task,{restoreIds:true});
  let claim;
  try{
    checkAbort(task.signal);await signalProjectActivity(identity,tabIdentity,{interaction:true});claim=await claimProjectLease(identity,tabIdentity);
    const fence=claim.held?{owner:tabIdentity,token:claim.token}:null;
    if(restoreHistory){if(!claim.held)throw new Error('別タブが編集中のため履歴を復元できない');await restoreProjectHistory(identity,snapshotId,{fence});}
    else await activateStoredProject(identity,{fence});
  }catch(error){loaded.forEach(releasePage);if(claim?.held&&identity!==projectId)await releaseProjectLease(identity,tabIdentity);throw error;}
  const oldId=projectId;if(oldId!==identity)await releaseProjectLease(oldId,tabIdentity);
  projectId=identity;projectLease=claim.held?{owner:tabIdentity,token:claim.token,ownerEpoch:claim.ownerEpoch}:null;readOnly=!claim.held;
  loaded.forEach(p=>p.imageSaved=true);pages.forEach(releasePage);pages=loaded;$('deck').replaceChildren();activeId=loaded[0]?.id||null;batchStart=0;drag=null;pngCache.clear();
  sourceFolderName=meta.sourceFolderName||null;mergePresets(meta.preferences);sfxTemplates=templates;saveSfxTemplates();mergeStrokePresets(importedStrokes);
  revision++;lastSavedRevision=loaded.some(p=>p.fontsChanged)?-1:revision;changed=loaded.some(p=>p.fontsChanged);draftMeta=meta;needLeaseReload=false;rememberProject();configureAutosave();refreshJump();if(active())activate(active());updateDraftUI();updateLeaseAccess();void refreshProjectHistories();
  status(restoreHistory?'選択世代を復元した。既存履歴は維持。':'保存済みプロジェクトを開いた。');
}
async function prepareProjectPages(records,version,task,{restoreIds=false}={}){
  if(!await resolveMissingFonts(records.flatMap(p=>p.layers)))throw new DOMException('フォント選択を中止','AbortError');
  task.stage('検証',records.length);const validated=[];
  for(const p of records){checkAbort(task.signal);try{const normalized=normalizeLayers(p.layers,version);validated.push({...p,fontsChanged:p.layers.some(l=>l.fontResolvedNow),layers:restoreIds?normalized:normalized.map(layer=>({...layer,id:crypto.randomUUID()}))});task.result(p.name);}catch(error){task.result(p.name,false);throw new Error(`${p.name}: ${error.message}`);}if(validated.length%20===0)await yieldToBrowser();}
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
      const page=createPage({id:restoreIds&&validProjectId(p.id)?p.id:undefined,name:p.name,layers:p.layers,done:p.done===true,imageEdit,maskEffects,maskAssets,selectedMaskId:p.selectedMaskId,src:URL.createObjectURL(p.blob),file:p.blob,prepared});loaded.push(page);
      page.fontsChanged=p.fontsChanged===true;
      if(hasEdits(page)){requestPageFonts(page);await renderPageThumbnail(page,task.signal);}
      task.result(p.name);
    }
    await yieldToBrowser();
  }

    checkAbort(task.signal);return loaded;
  }catch(error){loaded.forEach(releasePage);throw error;}
}
$('projectLoad').onclick = () => {if(!busy&&!readOnly)$('projectInput').click();};
$('projectManage').onclick=async()=>{
  if(busy)return;
  const modal=element('dialog','stored-project-dialog');
  const header=element('h2','','プロジェクトと復元履歴の管理'),description=element('p','',
    '論理サイズは最新と履歴の共有素材を重複せず合計する。回収可能容量は他プロジェクトに必要な素材を除く概算です。');
  modal.append(header,description);
  const list=element('section','stored-project-list');modal.append(list);
  const quota=element('p','storage-estimate');
  try{
    const estimate=await navigator.storage?.estimate?.();
    if(estimate)quota.textContent='サイト全体の使用量（推定）: '+(estimate.usage/(1024*1024)).toFixed(1)+' MiB / '+(estimate.quota/(1024*1024)).toFixed(1)+' MiB';
  }catch{}
  modal.append(quota);
  const close=element('button','','閉じる');close.onclick=()=>modal.close();modal.append(close);
  document.body.append(modal);
  const refresh=async()=>{
    const projects=await projectStorageReport();
    list.replaceChildren();
    if(!projects.length)list.append(element('p','','保存済みのプロジェクトはありません。'));
    for(const p of projects){
      const item=element('article','stored-project-item');
      item.append(element('strong','',p.name+'  '+p.projectId.slice(0,8)));
      item.append(element('p','', '最終保存 '+(p.latest?new Date(p.latest.savedAt).toLocaleString('ja-JP'):'なし')
        +' · 履歴 '+p.history.length+'世代'));
      item.append(element('p','', '論理 '+(p.logicalBytes/1048576).toFixed(1)+' MiB / 素材の回収可能容量（概算） '+
        (p.reclaimableBytes/1048576).toFixed(1)+' MiB'));
      const open=element('button','','このプロジェクトを開く');
      open.disabled=!p.latest||p.projectId===projectId;
      open.onclick=()=>guard(async task=>{
        if(changed&&pages.length&&!confirm('現在の保存前の変更は失われます。プロジェクトを切り替える？'))return;
        await openStoredProject(p.projectId,task);modal.close();
      },'保存プロジェクトを開く',5);
      const remove=element('button','danger','プロジェクトを削除');
      remove.onclick=async()=>{
        if(!confirm('プロジェクト「'+p.name+'」と復元履歴'+p.history.length+'世代を削除する？ 元に戻せません。共有素材は維持します。'))return;
        try{
          await deleteStoredProject(p.projectId,{fence:p.projectId===projectId?projectLease:null});
          await collectUnusedProjectAssets();
          if(p.projectId===projectId){
            clearTimeout(latestSaveTimer);
            pages.forEach(releasePage);pages=[];activeId=null;drag=null;pngCache.clear();$('deck').replaceChildren();
            projectId=crypto.randomUUID();projectLease=null;readOnly=false;draftMeta=null;
            changed=false;lastSavedRevision=-1;refreshJump();syncVisiblePages();updateDraftUI();updateLeaseAccess();
          }
          await refresh();status('保存済みプロジェクトを削除した。共有素材は保護した。');
        }catch(error){status('プロジェクト削除に失敗: '+error.message);}
      };
      item.append(open,remove);
      const histories=element('details','stored-history');histories.append(element('summary','','復元履歴 '+p.history.length+'世代'));
      for(const history of p.history){const row=element('p','',new Date(history.createdAt).toLocaleString('ja-JP')+' · 論理 '+(history.logicalBytes/1048576).toFixed(2)+' MiB / 回収可能（概算） '+(history.reclaimableBytes/1048576).toFixed(2)+' MiB');const restoreGeneration=element('button','','この世代を復元');restoreGeneration.onclick=()=>guard(async task=>{if(!confirm('現在の編集をこの世代へ置き換える？ 現在の状態は自動退避されない。'))return;await openStoredProject(p.projectId,task,{snapshotId:history.snapshotId,restoreHistory:true});modal.close();},'履歴を復元',5);row.append(restoreGeneration);const removeHistory=element('button','danger','この1世代を削除');removeHistory.onclick=async()=>{if(!confirm('この日時の復元履歴1世代を削除する？'))return;try{await deleteProjectHistory(p.projectId,history.historyId,{fence:p.projectId===projectId?projectLease:null});await collectUnusedProjectAssets();await refresh();}catch(error){status(error.message);}};row.append(removeHistory);histories.append(row);}item.append(histories);list.append(item);
    }
  };
  try{await refresh();modal.showModal();}
  catch(error){modal.remove();status('保存プロジェクト一覧を読めない: '+error.message);return;}
  modal.addEventListener('close',()=>modal.remove(),{once:true});
};
$('projectOpen').onclick=()=>{if(!busy)$('projectOpenInput').click();};
$('projectOpenInput').onchange=event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  guard(async task=>{
    task.stage('プロジェクトファイルを解析',1);
    const fileData=await readProject(file,{signal:task.signal});task.result(file.name);
    let data=fileData,identity=data.projectId||crypto.randomUUID();
    const projects=await listStoredProjects();
    const saved=projects.find(p=>p.projectId===identity)?.latest;
    let snapshot=saved?await getStoredSnapshot(saved.snapshotId):null;
    let option='file';
    if(snapshot){
      const same=await projectFileMatchesSnapshot(fileData,snapshot,{signal:task.signal});
      if(!same)option=await projectConflictChoice();
      if(option==='cancel')return;
    }
    if(option==='copy')identity=crypto.randomUUID();
    if(option==='autosave'){
      if(!snapshot)throw new Error('自動保存の正常な内容が存在しない');
      const ids=snapshot.meta.pages.map(p=>p.id);
      const [images,masks]=await Promise.all([projectSnapshotImages(snapshot,ids),projectSnapshotMasks(snapshot,ids)]);
      const byId=new Map(images.map(x=>[x.id,x.blob])),byMask=new Map(ids.map(id=>[id,{}]));
      for(const item of masks)byMask.get(item.pageId)[item.id]=item.asset;
      data={version:snapshot.meta.version,projectId:identity,pages:snapshot.meta.pages.map(page=>({...page,blob:byId.get(page.id),maskAssets:byMask.get(page.id)})),preferences:snapshot.meta.preferences,sourceFolderName:snapshot.meta.sourceFolderName};
    }
    const importedStrokes=validateStrokePresets(data.preferences?.sfxStrokePresets??[]);
    const templates=Array.isArray(data.preferences?.sfxTemplates)?mergeSfxTemplates(sfxTemplates,data.preferences.sfxTemplates,{conflict:'skip'}):sfxTemplates;
    const loaded=await prepareProjectPages(data.pages,data.version,task,{restoreIds:true});
    checkAbort(task.signal);
    const oldId=projectId;
    let claimed;try{await signalProjectActivity(identity,tabIdentity,{interaction:true});claimed=await claimProjectLease(identity,tabIdentity);}catch(error){loaded.forEach(releasePage);throw error;}
    if(oldId!==identity)await releaseProjectLease(oldId,tabIdentity);
    projectId=identity;
    projectLease=claimed.held?{owner:tabIdentity,token:claimed.token,ownerEpoch:claimed.ownerEpoch}:null;readOnly=!claimed.held;
    pages.forEach(releasePage);$('deck').replaceChildren();pages=loaded;
    activeId=loaded[0]?.id||null;drag=null;pngCache.clear();batchStart=0;
    sourceFolderName=data.sourceFolderName||projectFolderName(file.name)||sourceFolderName;
    const presetNotice=mergePresets(data.preferences);
    if(Array.isArray(data.preferences?.sfxTemplates)){
      sfxTemplates=templates;saveSfxTemplates();mergeStrokePresets(importedStrokes);
    }
    task.stage('プロジェクト切替',loaded.length);
    refreshJump();if(active())activate(active());
    dirty();
    if(option==='autosave'){lastSavedRevision=loaded.some(p=>p.fontsChanged)?-1:revision;changed=loaded.some(p=>p.fontsChanged);draftMeta=snapshot.meta;}
    else {lastSavedRevision=-1;draftMeta=null;}
    rememberProject();needLeaseReload=false;
    updateDraftUI();updateLeaseAccess();void refreshProjectHistories();
    task.update({processed:loaded.length,succeeded:loaded.length},true);
    status(option==='copy'?'別プロジェクトとして開いた。旧プロジェクトの自動保存と履歴はそのまま保持した。':
      option==='autosave'?'既存の最新自動保存からプロジェクトを開いた。'+presetNotice:
      'ファイルの内容でプロジェクトを開いた。旧履歴は維持する。'+presetNotice);
  },'プロジェクトを開く',6);
};
$('projectInput').onchange = event => {
  if(readOnly){event.target.value='';status('閲覧専用のプロジェクトには追加できない。');return;}
  const file=event.target.files[0];event.target.value='';if(!file)return;
  guard(async task=>{task.stage('ファイル解析',1);let data;try{data=await readProject(file,{signal:task.signal});task.result(file.name);}catch(error){if(error.name!=='AbortError')task.result(file.name,false);throw error;}const importedStrokes=validateStrokePresets(data.preferences?.sfxStrokePresets??[]);
    const templates=Array.isArray(data.preferences?.sfxTemplates)?mergeSfxTemplates(sfxTemplates,data.preferences.sfxTemplates,{conflict:'skip'}):sfxTemplates;const loaded=await prepareProjectPages(data.pages,data.version,task);checkAbort(task.signal);
    sourceFolderName=data.sourceFolderName||projectFolderName(file.name)||sourceFolderName;
    pages.push(...loaded);const presetNotice=mergePresets(data.preferences);
    if(Array.isArray(data.preferences?.sfxTemplates)){
      sfxTemplates=templates;saveSfxTemplates();mergeStrokePresets(importedStrokes);
    }
    dirty();task.stage('一覧反映',loaded.length);refreshJump();activate(loaded[0],loaded[0].selectedId,true);task.update({processed:loaded.length,succeeded:loaded.length},true);
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

async function refreshProjectHistories(){
  const selector=$('historySelect');if(!selector)return;
  const previous=selector.value;
  try{
    const histories=await listProjectHistories(draftMeta?.projectId||projectId);
    selector.replaceChildren(new Option('復元履歴を選択', ''));
    for(const h of histories)selector.add(new Option(new Date(h.createdAt).toLocaleString('ja-JP'),h.historyId));
    if(histories.some(h=>h.historyId===previous))selector.value=previous;
    $('restoreHistory').disabled=!selector.value||readOnly;
    $('deleteHistory').disabled=!selector.value||readOnly;
    $('projectHistory').hidden=!histories.length;
  }catch(error){selector.replaceChildren(new Option('履歴の読込に失敗', ''));$('projectHistory').hidden=true;status(error.message);}
}
function updateLeaseAccess(){
  const banner=$('projectAccess');
  if(banner){banner.textContent=readOnly?'閲覧専用：別タブに編集権があります。編集権の解放・期限切れ後に最新保存データを読み直します。':'編集可能';banner.dataset.readonly=String(readOnly);}
  updateGlobal();
}
let activitySent=0;
function recordProjectActivity(){
  const now=Date.now();if(now-activitySent<500)return;activitySent=now;
  void signalProjectActivity(projectId,tabIdentity,{interaction:true}).catch(()=>{});
}
document.addEventListener('pointerdown',recordProjectActivity,{capture:true});
document.addEventListener('keydown',recordProjectActivity,{capture:true});
let pollingLease=false;
async function pollProjectLease(){
  if(pollingLease||busy)return;
  pollingLease=true;const identity=projectId;
  try{
    await signalProjectActivity(identity,tabIdentity);
    const claim=await claimProjectLease(identity,tabIdentity);
    if(projectId!==identity)return;
    if(!claim.held){
      projectLease=null;
      if(!readOnly){readOnly=true;clearTimeout(latestSaveTimer);clearInterval(autosaveTimer);activeDraftTask?.cancel();updateLeaseAccess();}
      return;
    }
    if(projectLease&&projectLease.ownerEpoch!==claim.ownerEpoch&&!readOnly){
      readOnly=true;clearTimeout(latestSaveTimer);clearInterval(autosaveTimer);activeDraftTask?.cancel();updateLeaseAccess();
    }
    projectLease={owner:tabIdentity,token:claim.token,ownerEpoch:claim.ownerEpoch};
    if(readOnly&&pages.length){
      // A former viewer MUST reload the committed latest before it may edit.
      if(!needLeaseReload&&!busy&&!draftTask){needLeaseReload=true;void activateStoredProject(identity,{fence:projectLease}).then(()=>{if(projectId===identity&&!busy&&!draftTask)$('restoreDraft').click();else needLeaseReload=false;}).catch(error=>{needLeaseReload=false;status('編集権の引継ぎに失敗: '+error.message);});}
      return;
    }
    if(readOnly){readOnly=false;configureAutosave();updateLeaseAccess();}
  }catch(error){
    if(!readOnly){readOnly=true;updateLeaseAccess();}
    $('draftStatus').textContent='編集権の検証に失敗: '+error.message;
  }finally{pollingLease=false;}
}
window.addEventListener('pagehide',()=>{try{sessionStorage.setItem('serifu.reload-owner',tabIdentity);}catch{}clearTimeout(latestSaveTimer);activeDraftTask?.cancel();void releaseProjectLease(projectId,tabIdentity).catch(()=>{});});
window.addEventListener('pageshow',event=>{try{sessionStorage.removeItem('serifu.reload-owner');}catch{}if(event.persisted){readOnly=true;clearTimeout(latestSaveTimer);clearInterval(autosaveTimer);clearInterval(historyTimer);updateLeaseAccess();void pollProjectLease();}});
setInterval(()=>{void pollProjectLease();},4000);
void pollProjectLease();

function savedTime(timestamp) {return new Date(timestamp).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});}
function updateDraftUI() {
  $('draftNotice').hidden=!draftMeta;
  if(draftMeta)$('draftSummary').textContent=`一時保存：${new Date(draftMeta.savedAt).toLocaleString('ja-JP')} · ${draftMeta.pages.length} 枚`;
  $('restoreDraft').disabled=busy||!!draftTask;$('clearDraft').disabled=readOnly||busy||!!draftTask;
  if(draftTask){if(!$('draftStatus').textContent.startsWith('自動保存'))$('draftStatus').textContent='一時保存中…';return;}
  if($('draftStatus').dataset.error)return;
  $('draftStatus').textContent=draftMeta?`${savedTime(draftMeta.savedAt)} 保存済${revision!==lastSavedRevision&&pages.length?' · 保存後の変更あり':''}`:'まだ一時保存なし';
}
const storageReady=(async()=>{
  try {
    try{await migrateLegacyDraft();}
    catch(error){$('draftStatus').dataset.error='true';$('draftStatus').textContent='旧保存の移行を完了できない: '+error.message;}
    const identity=rememberedProject(),own=validProjectId(identity)?await latestProjectSnapshot(identity):null;
    draftMeta=own?.meta||await getDraftMeta();updateDraftUI();
  }
  catch(error){$('draftStatus').dataset.error='true';$('draftStatus').textContent=`一時保存を利用できない: ${error.message}`;}
})();
async function temporarySave(manual=false) {
  if(!pages.length||busy||readOnly||(!manual&&autosaveQuotaPaused)||pages.some(p=>p.glyphDrag))return;
  if(draftTask){if(!manual)return;await draftTask.catch(()=>{});return temporarySave(true);}
  const snapshot=snapshotPages(),captured=revision,savingId=projectId,prefs={...structuredClone(preferences),sfxTemplates:structuredClone(sfxTemplates),sfxStrokePresets:structuredClone(strokePresets)};
  const meta={version:PROJECT_VERSION,projectId:savingId,revision:captured,savedAt:Date.now(),preferences:prefs,...(sourceFolderName?{sourceFolderName}:{}),pages:snapshot.map(p=>({id:p.id,name:p.name,layers:p.layers,done:p.done,edited:p.edited===true,maskEffects:p.maskEffects,...(p.selectedMaskId?{selectedMaskId:p.selectedMaskId}:{}),...(p.imageEdit?{imageEdit:p.imageEdit}:{})}))};
  const masks=snapshot.flatMap(page=>[...new Set(page.maskEffects.map(effect=>effect.assetId))].map(id=>{
    const asset=page.maskAssets?.[id];if(!asset)throw new Error(`「${page.name}」のマスク素材がない`);
    return {pageId:page.id,id,asset};
  }));
  const task=new BulkTask(manual?'一時保存':'自動保存',{stageCount:3,onProgress:data=>{if(manual&&currentTask?.data.operationId===data.operationId)displayTask(data);else if(!manual)$('draftStatus').textContent=`自動保存 · ${data.stage} ${data.processed}/${data.total??'未確定'}`;}});
  if(manual){currentTask=task;task.emit(true);}activeDraftTask=task;delete $('draftStatus').dataset.error;
  const saving=(async()=>{await storageReady;checkAbort(task.signal);
    if(projectId!==savingId)return;
    if(!manual&&captured===lastSavedRevision){const history=await listProjectHistories(savingId);if(history[0]&&Date.now()-history[0].createdAt<300000)return;}
    const claim=await claimProjectLease(savingId,tabIdentity);
    if(!claim.held){readOnly=true;updateGlobal();throw new Error('他のタブが編集権を保持しています');}
    if(projectLease&&projectLease.ownerEpoch!==claim.ownerEpoch){readOnly=true;updateLeaseAccess();throw new Error('別のタブの保存内容を読み直してから保存してください');}
    const savingFence={owner:tabIdentity,token:claim.token,ownerEpoch:claim.ownerEpoch};
    projectLease=savingFence;
    const ids=await projectImageIds(savingId),missing=snapshot.filter(p=>!ids.has(p.id)||!pages.find(original=>original.id===p.id)?.imageSaved),images=[];task.stage('画像差分準備',missing.length);
    for(const p of missing){checkAbort(task.signal);const blob=await originalBlob(p),original=pages.find(page=>page.id===p.id);if(original)original.assetBlob=blob;images.push({id:p.id,blob});task.result(p.name);if(images.length%20===0)await yieldToBrowser();}
    task.metrics.newImages=images.length;task.stage('DB要求',images.length);if(!images.length)task.stage('コミット',1);
    // Hashing and WebKit byte conversion can outlive the lease. Renew only after
    // that preparation, preserving ownership lineage and strict transaction fencing.
    await saveProjectSnapshot(meta,images,{signal:task.signal,masks,fence:savingFence,beforeCommit:async()=>{
      checkAbort(task.signal);
      if(projectId!==savingId)throw new DOMException('保存対象のプロジェクトが変わった','AbortError');
      const renewed=await claimProjectLease(savingId,tabIdentity);
      if(!renewed.held||renewed.ownerEpoch!==savingFence.ownerEpoch){readOnly=true;updateLeaseAccess();throw new Error('保存準備中に別のタブが編集権を取得したため保存できない');}
      return projectLease={owner:tabIdentity,token:renewed.token,ownerEpoch:renewed.ownerEpoch};
    }});
    task.stage('コミット',1);
    task.result('一時保存');
    if(projectId!==savingId)return;
    for(const saved of snapshot){const original=pages.find(p=>p.id===saved.id);if(original&&original.src===saved.src)original.imageSaved=true;}
    autosaveQuotaPaused=false;rememberProject();draftMeta=meta;lastSavedRevision=captured;changed=revision!==captured;
    void refreshProjectHistories();
    void collectUnusedProjectAssets().catch(error=>status('不要素材の整理を延期: '+error.message));
  })();draftTask=saving;updateDraftUI();let failure;
  try{await saving;if(manual)status('画像・文字・位置・設定をこのブラウザに一時保存した。');}
  catch(error){failure=error;if(error.name==='QuotaExceededError'){autosaveQuotaPaused=true;clearTimeout(latestSaveTimer);clearInterval(autosaveTimer);clearInterval(historyTimer);}if(error.name!=='AbortError')task.result('一時保存',false);$('draftStatus').dataset.error='true';$('draftStatus').textContent=error.name==='AbortError'?'一時保存を中断。前回の保存を維持。':error.name==='QuotaExceededError'?'保存容量不足。編集データを書き出して保管。':`一時保存に失敗: ${error.message}`;if(manual)status($('draftStatus').textContent);}
  finally{const metrics=task.finish(failure);if(currentTask===task){currentTask=null;window.serifuDraftMetrics=metrics;}if(activeDraftTask===task)activeDraftTask=null;if(draftTask===saving)draftTask=null;if(!failure&&manual&&preferences.autosave.enabled)configureAutosave();updateDraftUI();updateGlobal();if(!failure&&savingId===projectId&&preferences.autosave.enabled&&!readOnly&&!autosaveQuotaPaused&&revision!==lastSavedRevision)void temporarySave(false).catch(error=>status('追加編集の自動保存に失敗: '+error.message));}
}
$('temporarySave').onclick=()=>temporarySave(true);
function configureAutosave() {
  if(autosaveTimer)clearInterval(autosaveTimer);if(historyTimer)clearInterval(historyTimer);
  historyTimer=preferences.autosave.enabled&&!readOnly&&!autosaveQuotaPaused?setInterval(()=>{void temporarySave(false).catch(error=>status(error.message));},300000):null;
  autosaveTimer=preferences.autosave.enabled&&!readOnly&&!autosaveQuotaPaused?setInterval(()=>{void temporarySave(false).catch(error=>status('自動保存を開始できない: '+error.message));},preferences.autosave.minutes*60000):null;
  $('autosaveEnabled').checked=preferences.autosave.enabled;$('autosaveMinutes').value=String(preferences.autosave.minutes);
}
$('autosaveEnabled').onchange=()=>{preferences.autosave.enabled=$('autosaveEnabled').checked;autosaveQuotaPaused=false;persistPreferences();configureAutosave();dirty();updateGlobal();};
$('autosaveMinutes').onchange=()=>{
  const value=Number($('autosaveMinutes').value);
  if(!Number.isFinite(value)||value<.1||value>1440){$('autosaveMinutes').setCustomValidity('0.1〜1440分で指定');$('autosaveMinutes').reportValidity();return;}
  $('autosaveMinutes').setCustomValidity('');preferences.autosave.minutes=value;persistPreferences();configureAutosave();dirty();updateGlobal();
};
$('restoreDraft').onclick=()=>guard(async task=>{
  await storageReady;task.stage('メタ情報');const versioned=await latestProjectSnapshot(needLeaseReload?projectId:draftMeta?.projectId||rememberedProject()||projectId)||await activeProjectSnapshot();const meta=versioned?.meta||await getDraftMeta();if(!meta)return;
  if(pages.length&&!needLeaseReload&&!confirm('現在の一覧を一時保存の内容に置き換える？ 保存後の変更は失われる。'))return;
  if(!Number.isInteger(meta.version)||meta.version<3||meta.version>PROJECT_VERSION||!Array.isArray(meta.pages))throw new Error('未対応の一時保存データ');
  task.stage('画像取得',meta.pages.length);const ids=meta.pages.map(p=>p.id),bundle=versioned?await readProjectBundle(versioned.projectId,{snapshotId:versioned.id}):null,[images,storedMasks]=bundle?[bundle.images,bundle.masks]:await Promise.all([getDraftImages(ids),getDraftMasks(ids)]);checkAbort(task.signal);
  const masksByPage=new Map(meta.pages.map(p=>[p.id,{}]));for(const {pageId,id,asset} of storedMasks)masksByPage.get(pageId)[id]=asset;
  const importedStrokes=validateStrokePresets(meta.preferences?.sfxStrokePresets??[]);
  const templates=Array.isArray(meta.preferences?.sfxTemplates)?mergeSfxTemplates(sfxTemplates,meta.preferences.sfxTemplates,{conflict:'skip'}):sfxTemplates;
  const loaded=await prepareProjectPages(meta.pages.map((p,i)=>({...p,maskAssets:masksByPage.get(p.id),blob:images[i].blob})),meta.version,task,{restoreIds:true});checkAbort(task.signal);
  const nextId=validProjectId(meta.projectId)?meta.projectId:crypto.randomUUID(),oldId=projectId;
  await signalProjectActivity(nextId,tabIdentity,{interaction:true});
  const claim=await claimProjectLease(nextId,tabIdentity);
  if(oldId!==nextId)await releaseProjectLease(oldId,tabIdentity);
  projectId=nextId;projectLease=claim.held?{owner:tabIdentity,token:claim.token,ownerEpoch:claim.ownerEpoch}:null;readOnly=!claim.held;
  loaded.forEach(p=>p.imageSaved=true);pages.forEach(releasePage);$('deck').replaceChildren();pages=loaded;activeId=loaded[0]?.id||null;drag=null;pngCache.clear();
  sourceFolderName=typeof meta.sourceFolderName==='string'&&meta.sourceFolderName?meta.sourceFolderName:sourceFolderName;
  batchStart=0;const presetNotice=mergePresets(meta.preferences);
  if(Array.isArray(meta.preferences?.sfxTemplates)){
    sfxTemplates=templates;saveSfxTemplates();mergeStrokePresets(importedStrokes);
  }
  task.stage('一覧置換',loaded.length);refreshJump();if(active())activate(active());task.update({processed:loaded.length,succeeded:loaded.length},true);
  dirty();lastSavedRevision=loaded.some(p=>p.fontsChanged)?-1:revision;changed=loaded.some(p=>p.fontsChanged);draftMeta=meta;rememberProject();needLeaseReload=false;configureAutosave();updateDraftUI();updateLeaseAccess();void refreshProjectHistories();status('一時保存を復元した。元ファイルへの接続はないため、元画像削除は無効。'+presetNotice);
},'一時保存復元',5);
$('clearDraft').onclick=()=>guard(async()=>{
  if(!confirm('このブラウザの一時保存を消去する？ 編集中の画像は残る。'))return;
  const target=draftMeta?.projectId||projectId,claim=await claimProjectLease(target,tabIdentity);if(!claim.held)throw new Error('別タブが編集中のため一時保存を消去できない');await forgetDraft({projectId:target,fence:{owner:tabIdentity,token:claim.token}});draftMeta=null;lastSavedRevision=-1;delete $('draftStatus').dataset.error;updateDraftUI();
  status('一時保存を消去した。自動保存がONなら次の周期で再保存する。');
});

$('historySelect').onchange=()=>{
  const disabled=!$('historySelect').value||readOnly;
  $('restoreHistory').disabled=disabled;$('deleteHistory').disabled=disabled;
};
$('restoreHistory').onclick=async()=>{
  const histories=await listProjectHistories(draftMeta?.projectId||projectId),h=histories.find(h=>h.historyId===$('historySelect').value);
  if(!h||readOnly||busy)return;
  if(!confirm('選択した日時の編集状態へ上書きする？ 現在の状態は自動退避されません。履歴5世代は維持します。'))return;
  try{
    await guard(task=>openStoredProject(h.projectId,task,{snapshotId:h.snapshotId,restoreHistory:true}),'履歴を復元',5);
  }catch(error){status('履歴の復元に失敗: '+error.message);}
};
$('deleteHistory').onclick=async()=>{
  const histories=await listProjectHistories(draftMeta?.projectId||projectId),h=histories.find(h=>h.historyId===$('historySelect').value);
  if(!h||readOnly||busy||!confirm('この復元履歴1世代を削除する？ 他の世代と共有する画像・マスクは残します。'))return;
  try{
    await deleteProjectHistory(h.projectId,h.historyId,{fence:projectLease});
    await collectUnusedProjectAssets();await refreshProjectHistories();
    status('選択した履歴を削除した。共有素材は参照がある限り保持。');
  }catch(error){status('履歴削除に失敗: '+error.message);}
};
applyViewSettings();refreshPresetMenus();configureAutosave();updateGlobal();
if(document.fonts){
  const redrawFonts=()=>{fontVersion++;pngCache.clear();clearGlyphCache();pages.forEach(drawPage);pages.forEach(p=>scheduleThumbnailRefresh(p,true));};
  document.fonts.addEventListener('loadingdone',redrawFonts);
  document.fonts.load('900 64px MangaBold').then(redrawFonts).catch(()=>{});
}
