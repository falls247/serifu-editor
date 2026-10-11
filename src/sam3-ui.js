import { assetFromEncoded, verifyMaskAsset } from './mask-codec.js';
import { createSam3RequestNamespace, LatestSam3Request, Sam3ApiError } from './sam3-client.js';
import { MAX_PROJECT_MASK_DECODED_BYTES } from './project-io.js';

const PALETTE = ['#c8ee91', '#ef4b91', '#74c8ef', '#ffc66d', '#ba9bff', '#54d7b0', '#ff8c6b', '#d2dc6a'];
const EFFECTS = [['pixelate', 'ピクセレート'], ['blur', 'ぼかし'], ['fill-black', '黒塗り'], ['fill-white', '白塗り']];
const STATUS = { idle: '待機中', uploading: '元画像を送信中', queued: '推論待ち', loading: 'モデル読込中', running: 'SAM3推論中', ready: '候補を確認可能', failed: '推論に失敗', cancelled: 'キャンセル済み', superseded: '新しい入力に置換' };

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function selectedCandidates(draft) { return (draft.candidates || []).filter(candidate => candidate.selected); }
function roundedScore(score) { return `${(Number(score) * 100).toFixed(1)}%`; }

function createPanel(panel) {
  panel.innerHTML = `
    <header class="sam3-panel-header"><div><span class="sam3-kicker">LOCAL SEGMENTATION</span><strong>SAM3 マスク</strong></div><button type="button" data-sam3-action="health">接続確認</button></header>
    <p class="sam3-connection" data-sam3-connection role="status">ローカル推論APIに接続中…</p>
    <div class="sam3-prompt-row"><label>テキストで対象を検出<input data-sam3-prompt maxlength="500" placeholder="例：赤い傘を持つ人物" autocomplete="off"></label><button type="button" class="primary" data-sam3-action="detect">検出</button></div>
    <div class="sam3-input-tools"><label>信頼度 <output data-sam3-threshold-value>0.50</output><input data-sam3-threshold type="range" min="0" max="1" step="0.05" value="0.5"></label><span data-sam3-request-status role="status">待機中</span></div>
    <div class="sam3-point-tools" role="group" aria-label="元画像での操作"><span>元画像クリック</span><button type="button" data-interaction="candidate" aria-pressed="true">候補選択</button><button type="button" data-interaction="include" aria-pressed="false">＋ 前景点</button><button type="button" data-interaction="exclude" aria-pressed="false">− 背景点</button><button type="button" data-sam3-action="clear-points">点を全消去</button></div>
    <p class="sam3-help" data-sam3-help>候補選択でマスクを確認。前景・背景点は複数追加でき、入力ごとに最新結果を待つ。</p>
    <div class="sam3-points" data-sam3-points aria-label="指定ポイント"></div>
    <div class="sam3-candidate-heading"><strong>検出候補</strong><div><button type="button" data-sam3-action="all">全選択</button><button type="button" data-sam3-action="none">全解除</button><label class="sam3-display-toggle"><input data-sam3-display type="checkbox" checked>重ねて表示</label></div></div>
    <div class="sam3-candidates" data-sam3-candidates><p class="sam3-empty">検出結果はまだない。</p></div>
    <div class="sam3-effect-settings"><label>選択候補の効果<select data-sam3-effect></select></label><label data-sam3-block-wrap>ブロック幅（px）<input data-sam3-block type="number" min="1" max="200" step="1" value="20"></label><label data-sam3-blur-wrap hidden>ぼかし半径（px）<input data-sam3-blur type="number" min="0" max="100" step="1" value="12"></label></div>
    <p class="sam3-warning sam3-response-warning" data-sam3-warning role="status" hidden></p>
    <p class="sam3-warning">ピクセレートとぼかしは匿名化を保証しない。SAM3へは127.0.0.1のローカルAPI経由で画像を送る。</p>
    <p class="sam3-warning">文字の一括コピー／ペーストは文字専用。SAM3マスクは対象外。</p>
    <p class="sam3-error" data-sam3-error role="alert" hidden></p>
    <div class="sam3-actions"><button type="button" data-sam3-action="cancel">キャンセル</button><button type="button" class="primary" data-sam3-action="commit" disabled>選択候補を加工に追加</button></div>`;
  const effect = panel.querySelector('[data-sam3-effect]');
  for (const [value, label] of EFFECTS) { const option = element('option', '', label); option.value = value; effect.append(option); }
}

function createMaskField(field, title, value, min, max, step = '1') {
  const label = element('label', '', title), input = element('input');
  input.type = 'number'; input.dataset.maskField = field; input.min = String(min); input.max = String(max); input.step = step; input.value = String(value);
  label.append(input); return label;
}

export function renderMaskEffectSummary(effect, summary) {
  const label = EFFECTS.find(([value]) => value === effect.effect)?.[1] ?? effect.effect;
  summary.textContent = `▧ ${effect.name}：${label}${effect.visible === false ? '（非表示）' : ''}`;
}

export function createMaskEffectCard(effect, asset, index, selected = false, imageWidth = 30000, imageHeight = 30000) {
  const card = element('article', 'mask-effect-card'); card.dataset.maskId = effect.id; card.classList.toggle('selected', selected);
  const summary = element('button', 'mask-effect-summary'); summary.type = 'button';
  summary.title = 'クリックして編集'; summary.setAttribute('aria-pressed', String(selected)); renderMaskEffectSummary(effect, summary); card.append(summary);
  const heading = element('div', 'mask-effect-heading'), select = element('button', 'mask-effect-name', effect.name || `マスク加工 ${index + 1}`);
  select.type = 'button'; select.dataset.maskAction = 'select'; select.setAttribute('aria-pressed', String(selected));
  const actions = element('div', 'card-mini-actions');
  const visibility = element('label', 'mask-visibility', '表示'); const toggle = element('input'); toggle.type = 'checkbox'; toggle.dataset.maskField = 'visible'; toggle.checked = effect.visible !== false; visibility.prepend(toggle);
  const remove = element('button', 'danger', '削除'); remove.type = 'button'; remove.dataset.maskAction = 'delete'; remove.title = 'このマスク加工を削除';
  actions.append(visibility, remove); heading.append(select, actions); card.append(heading);
  const info = element('p', 'mask-asset-summary', asset ? `元マスク ${asset.bbox.width} × ${asset.bbox.height}px · ${asset.codec}` : 'マスクデータが見つからない');
  card.append(info);
  const grid = element('div', 'mask-effect-grid');
  const effectLabel = element('label', '', '加工方式'), effectSelect = element('select'); effectSelect.dataset.maskField = 'effect';
  for (const [value, label] of EFFECTS) { const option = element('option', '', label); option.value = value; effectSelect.append(option); }
  effectSelect.value = effect.effect; effectLabel.append(effectSelect); grid.append(effectLabel);
  const blockSize = createMaskField('blockSize', 'ブロック幅（px）', effect.blockSize, 1, 200);
  const blurRadius = createMaskField('blurRadius', 'ぼかし半径（px）', effect.blurRadius, 0, 100);
  blockSize.hidden = effect.effect !== 'pixelate'; blurRadius.hidden = effect.effect !== 'blur';
  grid.append(blockSize, blurRadius);
  grid.append(createMaskField('marginPx', '輪郭補正（px）', effect.marginPx, -100, 100));
  grid.append(createMaskField('x', 'X（px）', effect.x, 0, imageWidth - 1));
  grid.append(createMaskField('y', 'Y（px）', effect.y, 0, imageHeight - 1));
  grid.append(createMaskField('w', '幅（px）', effect.w, 1, imageWidth - effect.x));
  grid.append(createMaskField('h', '高さ（px）', effect.h, 1, imageHeight - effect.y));
  card.append(grid);
  const order=element('div','layer-actions');
  for(const [action,label] of [['backmost','最背面へ'],['backward','背面へ'],['forward','前面へ'],['frontmost','最前面へ']]){
    const button=element('button','',label);button.type='button';button.dataset.maskAction=action;order.append(button);
  }
  card.append(order);
  return card;
}

export function renderMaskEffectCards(container, page) {
  if (!container) return;
  container.replaceChildren();
  for (let index = 0; index < (page.maskEffects || []).length; index++) {
    const effect = page.maskEffects[index], asset = page.maskAssets?.[effect.assetId];
    container.append(createMaskEffectCard(effect, asset, index, page.selectedMaskId === effect.id,page.img.width,page.img.height));
  }
  container.hidden = !(page.maskEffects || []).length;
}

function maskAt(candidate, x, y) {
  const { bbox, decoded } = candidate.mask;
  if (!decoded || x < bbox.x || y < bbox.y || x >= bbox.x + bbox.width || y >= bbox.y + bbox.height) return false;
  return decoded[(y - bbox.y) * bbox.width + x - bbox.x] === 1;
}

function maskColor(index) { return PALETTE[index % PALETTE.length]; }

export function createSam3UI({ page, panel, overlay, image, client, getOriginalBlob, getRetainedMaskDecodedBytes = () => 0, onPreview = () => {}, onCommit = () => {}, onCancel = () => {} }) {
  createPanel(panel);
  // The backend remembers the latest sequence by the prefix before the final colon.
  // Include a per-mount nonce so reload/remount never restarts a page at sequence 1.
  const events = new AbortController(), requestState = new LatestSam3Request(createSam3RequestNamespace(page.id));
  const draft = page.sam3Draft ||= {
    imageId: null, requestSeq: 0, mode: 'text', prompt: '', threshold: 0.5, points: [], candidates: [], status: 'idle',
    effect: 'pixelate', blockSize: 20, blurRadius: 12, displayCandidates: true, interaction: 'candidate',
    lastInput: null, lastGoodInput: null, error: null, connection: 'checking',
  };
  const root = panel, query = selector => root.querySelector(selector), signal = events.signal;
  const candidateCanvas = element('canvas', 'sam3-mask-raster');
  const thresholdInput = query('[data-sam3-threshold]'), promptInput = query('[data-sam3-prompt]');
  let hoverId = null, thresholdTimer = null, disposed = false;

  promptInput.value = draft.prompt || '';
  thresholdInput.value = String(draft.threshold ?? 0.5);
  query('[data-sam3-effect]').value = draft.effect || 'pixelate';
  query('[data-sam3-block]').value = String(draft.blockSize ?? 20);
  query('[data-sam3-blur]').value = String(draft.blurRadius ?? 12);
  query('[data-sam3-display]').checked = draft.displayCandidates !== false;

  function setStatus(value) {
    const text = STATUS[value] || value || '待機中';
    query('[data-sam3-request-status]').textContent = text;
    root.setAttribute('aria-busy', String(['uploading', 'queued', 'loading', 'running'].includes(value)));
  }

  function showError(error) {
    const node = query('[data-sam3-error]');
    node.textContent = error?.message || 'SAM3との通信に失敗した'; node.hidden = false;
    draft.error = { code: error?.code || 'SAM3_ERROR', message: node.textContent, retryable: error?.retryable === true };
  }

  function hideError() { const node = query('[data-sam3-error]'); node.textContent = ''; node.hidden = true; draft.error = null; }

  function requestRunning() { return ['uploading', 'queued', 'loading', 'running'].includes(draft.status); }

  function inputMatchesLastGood() {
    const input = draft.lastGoodInput;
    if (!input) return false;
    if (input.mode === 'text') return String(draft.prompt || '').trim() === input.prompt && Number(draft.threshold) === input.threshold;
    const currentPoints = draft.points.map(({ x, y, positive }) => ({ x, y, positive }));
    return Number(draft.threshold) === input.threshold && JSON.stringify(currentPoints) === JSON.stringify(input.points);
  }

  function updateControls() {
    const selected = selectedCandidates(draft), canCommit = selected.length > 0 && inputMatchesLastGood() && !requestRunning();
    query('[data-sam3-action=commit]').disabled = !canCommit;
    query('[data-sam3-action=detect]').disabled = !['ready', 'error'].includes(draft.connection) || requestRunning() || !String(draft.prompt || '').trim() || !image.naturalWidth;
    query('[data-sam3-threshold-value]').value = Number(draft.threshold).toFixed(2);
    query('[data-sam3-block-wrap]').hidden = draft.effect !== 'pixelate';
    query('[data-sam3-blur-wrap]').hidden = draft.effect !== 'blur';
    query('[data-sam3-help]').textContent = draft.lastGoodInput && !inputMatchesLastGood()
      ? '最新の入力に対応する検出結果がない。検出を実行してから確定する。'
      : '候補選択でマスクを確認。前景・背景点は複数追加でき、入力ごとに最新結果を待つ。';
    updateOverlayEvents();
  }

  function setConnection(health) {
    draft.connection = 'ready';
    let message = 'ローカルAPI接続済み';
    if (health.status === 'ready') message += health.modelLoaded ? ' · SAM3準備完了' : ' · 次の推論でモデルをロード';
    else if (health.status === 'loading') message += ' · モデル読込中';
    else if (health.status === 'unloaded') message += ' · モデル未ロード';
    else if (health.status === 'error') {
      const detail = health.error, description = detail?.message || health.message || 'モデル読込エラー';
      message += ` · ${detail?.code ? `${detail.code}: ` : ''}${description}（検出で再試行）`; draft.connection = 'error';
    }
    if (health.gpuAvailable === false) message += ' · CUDA GPU未検出';
    query('[data-sam3-connection]').textContent = message;
    updateControls();
  }

  async function checkHealth(force = false) {
    if (disposed) return;
    const node = query('[data-sam3-connection]'); node.textContent = 'ローカル推論APIに接続中…';
    try {
      const health = await client.health({ force });
      if (disposed) return;
      setConnection(health);
    }
    catch (error) {
      if (disposed) return;
      draft.connection = 'unavailable';
      node.textContent = `ローカル推論APIを利用できない: ${error.message}。GitHub Pagesでは新規検出を使えない。保存済みマスクの編集・保存は続けられる。`;
      updateControls();
    }
  }

  function drawOverlay() {
    const rect = image.getBoundingClientRect(), width = Math.max(1, rect.width), height = Math.max(1, rect.height), dpr = Math.max(1, window.devicePixelRatio || 1);
    const backingWidth = Math.max(1, Math.round(width * dpr)), backingHeight = Math.max(1, Math.round(height * dpr));
    if (overlay.width !== backingWidth) overlay.width = backingWidth;
    if (overlay.height !== backingHeight) overlay.height = backingHeight;
    overlay.style.width = `${width}px`; overlay.style.height = `${height}px`;
    const ctx = overlay.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!image.naturalWidth || !image.naturalHeight) return;
    const scaleX = backingWidth / image.naturalWidth, scaleY = backingHeight / image.naturalHeight;
    for (let index = 0; draft.displayCandidates !== false && index < draft.candidates.length; index++) {
      const candidate = draft.candidates[index], { bbox, decoded } = candidate.mask;
      if (!decoded?.length) continue;
      const x = Math.round(bbox.x * scaleX), y = Math.round(bbox.y * scaleY);
      const w = Math.max(1, Math.round(bbox.width * scaleX)), h = Math.max(1, Math.round(bbox.height * scaleY));
      candidateCanvas.width = w; candidateCanvas.height = h;
      const maskCtx = candidateCanvas.getContext('2d'), pixels = maskCtx.createImageData(w, h), hex = maskColor(index);
      const color = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
      const selected = candidate.selected || candidate.id === hoverId;
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const mx = Math.min(bbox.width - 1, Math.floor(px * bbox.width / w)), my = Math.min(bbox.height - 1, Math.floor(py * bbox.height / h));
        if (!decoded[my * bbox.width + mx]) continue;
        const edge = mx === 0 || my === 0 || mx + 1 === bbox.width || my + 1 === bbox.height
          || !decoded[my * bbox.width + mx - 1] || !decoded[my * bbox.width + mx + 1]
          || !decoded[(my - 1) * bbox.width + mx] || !decoded[(my + 1) * bbox.width + mx];
        if (!edge && !selected) continue;
        const offset = (py * w + px) * 4;
        pixels.data[offset] = color[0]; pixels.data[offset + 1] = color[1]; pixels.data[offset + 2] = color[2]; pixels.data[offset + 3] = edge ? 235 : 88;
      }
      maskCtx.putImageData(pixels, 0, 0);
      ctx.drawImage(candidateCanvas, x, y, w, h);
      const badgeX = x + 5 * dpr, badgeY = y + 5 * dpr, badgeSize = 20 * dpr;
      ctx.fillStyle = hex; ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeSize, badgeSize, 5 * dpr); ctx.fill();
      ctx.fillStyle = '#101318'; ctx.font = `700 ${12 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(index + 1), badgeX + badgeSize / 2, badgeY + badgeSize / 2);
    }
    for (const point of draft.points) {
      const x = point.x * scaleX, y = point.y * scaleY, radius = 7 * dpr;
      ctx.beginPath(); ctx.fillStyle = point.positive ? '#7ee293' : '#ff7089'; ctx.strokeStyle = '#111318'; ctx.lineWidth = 2 * dpr;
      ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#111318'; ctx.font = `700 ${11 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(point.positive ? '+' : '−', x, y + .5 * dpr);
    }
  }

  function hitCandidate(event) {
    const rect = overlay.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * image.naturalWidth / rect.width), y = Math.floor((event.clientY - rect.top) * image.naturalHeight / rect.height);
    for (let index = draft.candidates.length - 1; index >= 0; index--) if (maskAt(draft.candidates[index], x, y)) return draft.candidates[index];
    return null;
  }

  function updateOverlayEvents() {
    overlay.style.pointerEvents = draft.interaction === 'candidate'
      ? (draft.displayCandidates !== false && draft.candidates.length ? 'auto' : 'none') : 'auto';
    overlay.style.cursor = draft.interaction === 'candidate' ? (hoverId ? 'pointer' : 'default') : 'crosshair';
  }

  function renderPoints() {
    const container = query('[data-sam3-points]'); container.replaceChildren();
    if (!draft.points.length) { container.hidden = true; return; }
    container.hidden = false;
    draft.points.forEach((point, index) => {
      const item = element('span', `sam3-point-chip ${point.positive ? 'positive' : 'negative'}`, `${point.positive ? '+' : '−'} ${Math.round(point.x)}, ${Math.round(point.y)}`);
      const remove = element('button', '', '×'); remove.type = 'button'; remove.dataset.pointIndex = String(index); remove.setAttribute('aria-label', `${Math.round(point.x)}, ${Math.round(point.y)}のポイントを削除`); item.append(remove); container.append(item);
    });
  }

  function renderCandidates() {
    const container = query('[data-sam3-candidates]'); container.replaceChildren();
    if (!draft.candidates.length) { container.append(element('p', 'sam3-empty', '検出結果はまだない。')); return; }
    draft.candidates.forEach((candidate, index) => {
      const label = element('label', `sam3-candidate ${candidate.selected ? 'selected' : ''}`); label.dataset.candidateId = candidate.id;
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = !!candidate.selected; checkbox.dataset.candidateId = candidate.id;
      const swatch = element('span', 'sam3-swatch'); swatch.style.setProperty('--candidate-color', maskColor(index));
      const name = element('strong', '', `候補 ${index + 1}`), score = element('span', 'sam3-score', roundedScore(candidate.score));
      label.append(checkbox, swatch, name, score); container.append(label);
    });
  }

  function renderWarnings() {
    const node = query('[data-sam3-warning]'), warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
    node.textContent = warnings.length ? `SAM3の応答に注意: ${warnings.join(' · ')}` : '';
    node.hidden = warnings.length === 0;
  }

  function render() {
    renderPoints(); renderCandidates(); renderWarnings(); setStatus(draft.status || 'idle'); updateControls(); drawOverlay(); onPreview(draft);
  }

  function setInteraction(interaction) {
    draft.interaction = interaction;
    for (const button of root.querySelectorAll('[data-interaction]')) button.setAttribute('aria-pressed', String(button.dataset.interaction === interaction));
    query('[data-sam3-help]').textContent = interaction === 'candidate' ? '候補の輪郭をクリックして確認。Shift+クリックで候補を追加選択。' : interaction === 'include' ? '元画像をクリックして前景点を追加。前景点を1つ以上置くと推論する。' : '元画像をクリックして背景点を追加。前景点も1つ以上必要。';
    updateOverlayEvents(); drawOverlay();
  }

  function chooseCandidate(id, checked, additive = false) {
    for (const candidate of draft.candidates) {
      if (candidate.id === id) candidate.selected = checked;
      else if (!additive && checked) candidate.selected = false;
    }
    renderCandidates(); updateControls(); drawOverlay(); onPreview(draft);
  }

  function currentPointInput() {
    const positives = draft.points.some(point => point.positive);
    if (!positives) throw new Error('前景点を1つ以上追加してから推論する');
    const selected = selectedCandidates(draft);
    if (draft.candidates.length && selected.length > 1) throw new Error('候補のポイント修正は1候補だけ選択して実行する');
    const common = { threshold: Number(draft.threshold), points: draft.points.map(point => ({ x: point.x, y: point.y, positive: point.positive })) };
    if (selected.length === 1) return { ...common, mode: 'refine', candidateId: selected[0].id };
    return { ...common, mode: 'points' };
  }

  async function parseCandidates(result, input, isCurrent) {
    if (!Array.isArray(result.candidates) || !result.candidates.length) throw new Sam3ApiError('有効なマスク候補が返らなかった', { code: 'EMPTY_CANDIDATES' });
    if(result.candidates.length>200)throw new Sam3ApiError('SAM3候補数が上限（200件）を超えた', { code: 'TOO_MANY_CANDIDATES' });
    if(input.mode==='refine'&&result.candidates.length!==1)throw new Sam3ApiError('候補修正の応答数が不正', { code: 'INVALID_CANDIDATE' });
    let incomingBytes=0;const incomingIds=new Set(),retainedBytes=getRetainedMaskDecodedBytes();
    for(const candidate of result.candidates){
      const id=String(candidate?.candidateId??(input.mode==='refine'?input.candidateId:''));
      if(!id||id.length>200||['__proto__','constructor','prototype'].includes(id)||incomingIds.has(id)
          ||!Number.isFinite(candidate.score)||candidate.score<0||candidate.score>1)throw new Sam3ApiError('候補IDまたは信頼度が不正', { code: 'INVALID_CANDIDATE' });
      if(input.mode==='refine'&&id!==input.candidateId)throw new Sam3ApiError('修正結果の候補IDが一致しない', { code: 'CANDIDATE_MISMATCH' });
      incomingIds.add(id);
      const box=candidate?.bbox;
      if(!box||![box.x,box.y,box.width,box.height].every(Number.isSafeInteger)||box.x<0||box.y<0||box.width<1||box.height<1
          ||box.x+box.width>(image.naturalWidth||page.img.width)||box.y+box.height>(image.naturalHeight||page.img.height))throw new Sam3ApiError('候補のbboxが元画像範囲外', { code: 'INVALID_CANDIDATE' });
      const area=box.width*box.height;
      if(!Number.isSafeInteger(area)||area>100_000_000)throw new Sam3ApiError('候補マスクの画素数が上限を超えた', { code: 'INVALID_CANDIDATE' });
      incomingBytes+=area;
      if(!Number.isSafeInteger(incomingBytes)||retainedBytes+incomingBytes>MAX_PROJECT_MASK_DECODED_BYTES){
        throw new Sam3ApiError('候補マスクの展開後合計が256MiB上限を超える。既存候補を確定するか、キャンセルしてから再試行する', { code: 'MASK_MEMORY_LIMIT' });
      }
    }
    const incoming = [];
    for (const [index, candidate] of result.candidates.entries()) {
      if (!isCurrent()) throw new DOMException('古いSAM3応答を破棄', 'AbortError');
      const id = String(candidate.candidateId ?? (input.mode === 'refine' ? input.candidateId : ''));
      if (!id || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1) throw new Sam3ApiError('候補IDまたは信頼度が不正', { code: 'INVALID_CANDIDATE' });
      const payload = candidate.mask;
      if (!payload || typeof payload !== 'object') throw new Sam3ApiError('候補マスクのpayloadが不正', { code: 'INVALID_CANDIDATE' });
      const mask = await assetFromEncoded({ id, imageWidth: image.naturalWidth || page.img.width, imageHeight: image.naturalHeight || page.img.height,
        bbox: candidate.bbox, codec: payload.codec, byteLength: payload.byteLength, dataBase64: payload.dataBase64, sha256: payload.sha256 });
      await verifyMaskAsset(mask, { imageWidth: image.naturalWidth || page.img.width, imageHeight: image.naturalHeight || page.img.height });
      incoming.push({ id, score: candidate.score, selected: false, mask, previewIndex: index });
    }
    if (input.mode !== 'refine') {
      const previous = new Map(draft.candidates.map(candidate => [candidate.id, candidate.selected]));
      return incoming.map(candidate => ({ ...candidate, selected: previous.get(candidate.id) || false }));
    }
    const replacement = incoming.find(candidate => candidate.id === input.candidateId) || { ...incoming[0], id: input.candidateId };
    let found = false;
    const merged = draft.candidates.map(candidate => {
      if (candidate.id !== input.candidateId) return candidate;
      found = true; return { ...replacement, selected: candidate.selected };
    });
    if (!found) throw new Sam3ApiError('修正対象の候補が見つからない', { code: 'CANDIDATE_NOT_FOUND' });
    return merged;
  }

  async function run(input) {
    if (!['ready', 'error'].includes(draft.connection)) { showError(new Error('ローカルSAM3 APIが利用できない')); return; }
    hideError();
    const snapshot = structuredClone(input), request = requestState.begin(snapshot);
    draft.requestSeq = request.requestSeq; draft.mode = snapshot.mode; draft.lastInput = snapshot; draft.status = 'uploading'; draft.warnings = [];
    renderWarnings();
    updateControls(); setStatus('uploading');
    let blob;
    try {
      if(!image.naturalWidth)await new Promise((resolve,reject)=>{
        const loaded=()=>{cleanup();resolve();},failed=()=>{cleanup();reject(new Error('元画像を読み込めない'));},aborted=()=>{cleanup();reject(request.signal.reason||new DOMException('中断','AbortError'));};
        const cleanup=()=>{image.removeEventListener('load',loaded);image.removeEventListener('error',failed);request.signal.removeEventListener('abort',aborted);};
        image.addEventListener('load',loaded,{once:true});image.addEventListener('error',failed,{once:true});request.signal.addEventListener('abort',aborted,{once:true});
        if(image.naturalWidth)loaded();
      });
      blob = await getOriginalBlob();
      if (!request.isCurrent()) return;
      const result = await client.infer({
        pageId: page.id, blob, width: image.naturalWidth || page.img.width, height: image.naturalHeight || page.img.height,
        requestId: request.requestId, ...snapshot,
      }, { signal: request.signal, onState: status => { if (request.isCurrent()) { draft.status = status; setStatus(status); updateControls(); } } });
      if (!request.isCurrent()) return;
      draft.candidates = await parseCandidates(result, snapshot, request.isCurrent);
      if (!request.isCurrent()) return;
      draft.warnings = Array.isArray(result.warnings)
        ? result.warnings.filter(warning => typeof warning === 'string' && warning.trim()).slice(0, 5).map(warning => warning.trim().slice(0, 400)) : [];
      draft.status = 'ready'; draft.lastGoodInput = snapshot; draft.imageId = page.id; draft.error = null;
      render();
    } catch (error) {
      if (!request.isCurrent() || error?.name === 'AbortError') return;
      draft.status = 'failed'; showError(error); updateControls(); setStatus('failed'); drawOverlay();
    }
  }

  function inferText() {
    const prompt = String(draft.prompt || '').trim();
    if (!prompt) { showError(new Error('検出するテキストを入力する')); promptInput.focus(); return; }
    draft.points = [];
    renderPoints(); drawOverlay();
    void run({ mode: 'text', prompt, threshold: Number(draft.threshold) });
  }

  function inferPoints() {
    try { void run(currentPointInput()); }
    catch (error) { showError(error); }
  }

  function scheduleThresholdInference() {
    if (!draft.lastInput) return;
    clearTimeout(thresholdTimer);
    thresholdTimer = setTimeout(() => {
      const last = draft.lastInput;
      if (last.mode === 'text') inferText();
      else inferPoints();
    }, 250);
  }

  function addPoint(event) {
    if(!image.naturalWidth||!image.naturalHeight)return;
    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(image.naturalWidth - 1, Math.max(0, (event.clientX - rect.left) * image.naturalWidth / rect.width));
    const y = Math.min(image.naturalHeight - 1, Math.max(0, (event.clientY - rect.top) * image.naturalHeight / rect.height));
    if (draft.interaction === 'candidate') {
      const candidate = hitCandidate(event); if (candidate) chooseCandidate(candidate.id, true, event.shiftKey);
      return;
    }
    draft.points.push({ x: Math.round(x), y: Math.round(y), positive: draft.interaction === 'include' });
    renderPoints(); drawOverlay();
    if (draft.points.some(point => point.positive)) inferPoints();
  }

  promptInput.addEventListener('keydown', event => {
    if(event.key!=='Enter'||event.isComposing||event.keyCode===229||event.repeat)return;
    event.preventDefault();query('[data-sam3-action=detect]').click();
  }, { signal });

  root.addEventListener('input', event => {
    if (event.target === promptInput) {
      draft.prompt = promptInput.value; updateControls(); return;
    }
    if (event.target === thresholdInput) {
      draft.threshold = Math.min(1, Math.max(0, Math.round(Number(thresholdInput.value) * 20) / 20));
      query('[data-sam3-threshold-value]').value = Number(draft.threshold).toFixed(2); updateControls(); scheduleThresholdInference(); return;
    }
    if (event.target.matches('[data-sam3-block]')) { draft.blockSize = Math.min(200, Math.max(1, Math.round(Number(event.target.value) || 1))); onPreview(draft); return; }
    if (event.target.matches('[data-sam3-blur]')) { draft.blurRadius = Math.min(100, Math.max(0, Math.round(Number(event.target.value) || 0))); onPreview(draft); }
  }, { signal });

  root.addEventListener('change', event => {
    if (event.target.matches('[data-candidate-id]') && event.target.type === 'checkbox') {
      chooseCandidate(event.target.dataset.candidateId, event.target.checked, true); return;
    }
    if (event.target.matches('[data-sam3-effect]')) { draft.effect = event.target.value; updateControls(); onPreview(draft); }
    if (event.target.matches('[data-sam3-display]')) { draft.displayCandidates = event.target.checked; updateOverlayEvents(); drawOverlay(); }
  }, { signal });

  root.addEventListener('click', event => {
    const interaction = event.target.closest('[data-interaction]');
    if (interaction) { setInteraction(interaction.dataset.interaction); return; }
    const pointRemove = event.target.closest('[data-point-index]');
    if (pointRemove) { draft.points.splice(Number(pointRemove.dataset.pointIndex), 1); renderPoints(); drawOverlay(); if (draft.lastInput?.mode !== 'text' && draft.points.some(point => point.positive)) inferPoints(); else updateControls(); return; }
    const action = event.target.closest('[data-sam3-action]')?.dataset.sam3Action;
    if (!action) return;
    if (action === 'health') { void checkHealth(true); return; }
    if (action === 'detect') { inferText(); return; }
    if (action === 'clear-points') { draft.points = []; renderPoints(); drawOverlay(); updateControls(); return; }
    if (action === 'all' || action === 'none') {
      draft.candidates.forEach(candidate => { candidate.selected = action === 'all'; }); renderCandidates(); updateControls(); onPreview(draft); drawOverlay(); return;
    }
    if (action === 'cancel') { discard(); return; }
    if (action === 'commit') {
      if (query('[data-sam3-action=commit]').disabled) return;
      onCommit(selectedCandidates(draft), { effect: draft.effect, blockSize: draft.blockSize, blurRadius: draft.blurRadius });
    }
  }, { signal });

  overlay.addEventListener('click', addPoint, { signal });
  overlay.addEventListener('pointermove', event => {
    if (draft.interaction !== 'candidate') return;
    const candidate = hitCandidate(event), next = candidate?.id || null;
    if (next !== hoverId) { hoverId = next; updateOverlayEvents(); drawOverlay(); }
  }, { signal });
  overlay.addEventListener('pointerleave', () => { hoverId = null; updateOverlayEvents(); drawOverlay(); }, { signal });
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(drawOverlay) : null;
  resizeObserver?.observe(image); window.addEventListener('resize', drawOverlay, { signal });

  function discard({ notify = true } = {}) {
    clearTimeout(thresholdTimer); requestState.cancel();
    draft.status = 'idle'; draft.mode = 'text'; draft.points = []; draft.candidates = [];
    draft.lastInput = null; draft.lastGoodInput = null; draft.imageId = null; draft.error = null; draft.warnings = []; hoverId = null;
    hideError(); render(); if (notify) onCancel();
  }

  function dispose() {
    if (disposed) return; disposed = true; clearTimeout(thresholdTimer); requestState.cancel(); page.sam3Draft = null;
    overlay.style.pointerEvents = 'none'; overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
    resizeObserver?.disconnect(); events.abort(); panel.replaceChildren();
  }

  render(); void checkHealth();
  return { draft, discard, dispose, redraw: drawOverlay, checkHealth: () => checkHealth(true) };
}

