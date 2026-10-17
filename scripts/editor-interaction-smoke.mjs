import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.env.SERIFU_PROFILE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SERIFU_INTERACTION_PORT || 5288);
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
let browser, context, page;
const errors = [];
const artifactDir = join(tmpdir(), 'serifu-interaction-investigation');

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/app.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: `${source}
window.__interactionSnapshot=()=>({activeId,pendingMounts:pageMountQueue.length,navigationAnchor:thumbnailNavigationAnchor&&{pageId:thumbnailNavigationAnchor.pageId,generation:thumbnailNavigationAnchor.generation},pages:pages.map(p=>({id:p.id,selectedId:p.selectedId,ready:!!p.mountReady,currentSrc:p.img.currentSrc,naturalWidth:p.img.naturalWidth,layers:p.layers.map(layer=>({id:layer.id,kind:layer.kind,speaker:layer.speaker,size:layer.size}))}))});
window.__forceUnpreparedShell=id=>{const p=pages.find(page=>page.id===id);if(!p)throw new Error('page not found');if(p.row)unmountPage(p);mountPage(p);return p.id;};
window.__pausePageMountQueue=()=>{const pending=pageMountQueue.length;if(pageMountTimer!==null){clearTimeout(pageMountTimer);pageMountTimer=null;}return pending;};
window.__resumePageMountQueue=()=>{if(pageMountQueue.length)schedulePageMounts(pageMountQueue,pageMountGeneration);};
window.__forceObservedRowGrowth=id=>{const p=pages.find(page=>page.id===id),target=active()?.row;if(!p?.row||!target)throw new Error('page row not mounted');const frame=p.row.querySelector('.preview-frame'),before=frame.getBoundingClientRect().height,rowHeight=p.row.getBoundingClientRect().height,targetTop=target.getBoundingClientRect().top,overflowAnchor=document.documentElement.style.overflowAnchor;document.documentElement.style.overflowAnchor='none';frame.style.minHeight=(before+80)+'px';p.row.style.minHeight=(rowHeight+80)+'px';return {before,overflowAnchor,growth:target.getBoundingClientRect().top-targetTop};};
window.__forceFocusedInputUnmount=id=>{const p=pages.find(page=>page.id===id);if(!p?.row||!p.mountReady)throw new Error('target page is not prepared');const layer=p.layers.find(item=>item.id===p.selectedId),input=p.row.querySelector('.position-controls [data-field=size]');if(!layer||!input)throw new Error('selected size input not found');const before=layer.size;input.value=String(before+11);input.focus();activeId=pages[0].id;view.pageSize=50;$('pageSize').value='50';syncVisiblePages();return {before,pending:Number(input.value),after:layer.size,ready:!!p.mountReady,mounted:!!p.row};};` });
  });
  await page.addInitScript(() => {
    const probe = window.__editorProbe = { draws: [], starts: [] };
    probe.wheels=[];
    window.addEventListener('wheel',event=>probe.wheels.push({trusted:event.isTrusted,deltaY:event.deltaY,at:performance.now()}),true);
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.matches?.('canvas.preview')) {
        probe.draws.push({ at: performance.now(), pageId: this.canvas.closest('.image-row')?.dataset.pageId || null });
      }
      return clearRect.apply(this, args);
    };
    document.addEventListener('click', event => {
      const thumbnail = event.target.closest?.('.thumbnail');
      if (thumbnail) probe.starts.push({ at: performance.now(), pageId: thumbnail.dataset.pageId });
    }, true);
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const { PROJECT_VERSION } = await import('./src/model.js');
    const { startLettering } = await import('./src/sfx-lettering-model.js');
    const { defaultPreferences, createPreset } = await import('./src/presets.js');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d9d5cb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const source = canvas.toDataURL('image/png');
    const create = (kind, text, speaker = 'male') => ({
      ...newLayer(kind, 320, 240, speaker), text, size: 55, x: 160, y: kind === 'sfx' ? 145 : 90,
      w: 250, h: 100, font: kind === 'sfx' ? 'comic' : 'round', presetId: null,
      ...(kind === 'caption' ? { autoFit: false } : {}),
    });
    const sfx = create('sfx', 'バキッ！'); sfx.lettering = startLettering(sfx);
    const first = [create('dialogue', '選択保持テスト'), sfx, create('balloon', '吹き出しテスト'), create('caption', '説明テスト')];
    Object.assign(first[0], { x: 80, y: 60, w: 110, h: 48 });
    Object.assign(sfx, { x: 240, y: 180, w: 120, h: 48 });
    Object.assign(first[2], { x: 80, y: 180, w: 110, h: 48 });
    Object.assign(first[3], { x: 240, y: 60, w: 110, h: 48 });
    const preferences = defaultPreferences();
    for (const kind of ['dialogue', 'balloon']) for (const speaker of ['male', 'female']) {
      const layer = newLayer(kind, 320, 240, speaker);
      const preset = createPreset(`${kind}-${speaker}`, layer, 320, 240);
      preset.id = `test-${kind}-${speaker}`;
      preferences.presets.push(preset);
    }
    return {
      version: PROJECT_VERSION,
      preferences,
      pages: Array.from({ length: 55 }, (_, index) => ({
        name: `${String(index + 1).padStart(3, '0')}.png`, src: source,
        imageWidth: 320, imageHeight: 240,
        layers: index === 0 ? first : [create(index === 50 ? 'sfx' : 'dialogue', index === 50 ? '選択優先テスト！' : `台詞${index + 1}`)],
      })),
    };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'interaction-smoke.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 55 && !document.querySelector('#projectLoad').disabled);
  await page.waitForFunction(() => document.querySelector('.image-row.active .layer-cards').children.length === 4);
  await page.evaluate(() => document.fonts.ready);

  const row = page.locator('.image-row.active');
  const card = kind => row.locator(`.layer-card[data-kind="${kind}"]`).first();
  const builtin = { dialogue: 'dialogue-standard', sfx: 'sfx-impact', balloon: 'balloon-standard', caption: 'caption-standard' };
  for (const kind of ['dialogue', 'sfx', 'balloon', 'caption']) {
    const target = card(kind), select = target.locator('[data-preset-select]');
    if (!await target.evaluate(node => node.classList.contains('selected'))) await target.locator('.layer-summary').click();
    const sizeInput = row.locator('.position-controls [data-field=size]');
    const beforeSize = await sizeInput.inputValue();
    const beforeXY = await Promise.all(['x', 'y'].map(field => row.locator(`.position-controls [data-field=${field}]`).inputValue()));
    const paneScroll = await row.locator('.dialogue-pane').evaluate(pane => {
      pane.scrollTop = Math.max(0, Math.min(48, pane.scrollHeight - pane.clientHeight));
      return pane.scrollTop;
    });
    if (kind === 'sfx') await target.locator('details.effect-details:not(.placement-settings):not(.brush-settings)').evaluate(node => { node.open = true; });
    await target.evaluate(node => {
      window.__retainedCard = node;
      window.__retainedCards = [...node.closest('.image-row').querySelectorAll('.layer-card')]
        .map(card => [card.dataset.layerId, card]);
    });
    const focusResult=await page.evaluate(id=>{
      const card=[...document.querySelectorAll('.layer-card')].find(node=>node.dataset.layerId===id);
      const menu=card.querySelector('[data-preset-select]');menu.blur();window.__editorProbe.draws.length=0;menu.focus();
      return {draws:window.__editorProbe.draws.length,focused:document.activeElement===menu};
    },await target.getAttribute('data-layer-id'));
    assert.equal(focusResult.focused,true,`${kind}: preset select receives focus`);
    assert.equal(focusResult.draws, 0, `${kind}: opening an already-selected preset menu does not redraw the preview`);
    await select.selectOption(builtin[kind]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await target.evaluate(node => node === window.__retainedCard
      && window.__retainedCards.every(([id, previous]) => previous.isConnected
        && node.closest('.image-row').querySelector(`.layer-card[data-layer-id="${id}"]`) === previous)), true,
    `${kind}: active page card DOM must be retained`);
    assert.equal(await page.evaluate(() => window.__editorProbe.draws.filter(draw => draw.pageId === document.querySelector('.image-row.active').dataset.pageId).length), 1, `${kind}: preset must draw live preview once`);
    assert.equal(await select.inputValue(), builtin[kind], `${kind}: applied preset remains selected`);
    assert.equal(await select.evaluate(node => node === document.activeElement), true, `${kind}: preset select retains focus`);
    assert.equal(await row.locator('.dialogue-pane').evaluate(pane => pane.scrollTop), paneScroll, `${kind}: pane scroll position remains`);
    assert.equal(await page.evaluate(kind => JSON.parse(localStorage.getItem('serifu.preferences.v1')).defaults[kind], kind), builtin[kind], `${kind}: default preset persisted`);
    assert.deepEqual(await Promise.all(['x', 'y'].map(field => row.locator(`.position-controls [data-field=${field}]`).inputValue())), beforeXY, `${kind}: preset preserves placement`);
    if (kind === 'sfx') assert.equal(await target.locator('details.effect-details:not(.placement-settings):not(.brush-settings)').evaluate(node => node.open), true, 'SFX detail panel remains open');
    const afterSize = await sizeInput.inputValue();
    await row.locator('[data-action=undo]').click();
    assert.equal(await sizeInput.inputValue(), beforeSize, `${kind}: Undo restores size`);
    await row.locator('[data-action=redo]').click();
    assert.equal(await sizeInput.inputValue(), afterSize, `${kind}: Redo reapplies size`);
    if (['dialogue', 'balloon'].includes(kind)) {
      for (const speaker of ['female', 'male']) {
        await target.evaluate(node => { window.__speakerCard = node; });
        await select.focus();
        await page.evaluate(() => { window.__editorProbe.draws.length = 0; });
        await select.selectOption(`test-${kind}-${speaker}`);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await target.evaluate(node => node === window.__speakerCard), true, `${kind}/${speaker}: card remains mounted`);
        assert.equal(await select.inputValue(), `test-${kind}-${speaker}`);
        assert.equal(await page.evaluate(() => window.__editorProbe.draws.filter(draw => draw.pageId === document.querySelector('.image-row.active').dataset.pageId).length), 1, `${kind}/${speaker}: speaker preset draws once`);
        const rendered = await target.evaluate(card => ({
          speaker: card.dataset.speaker,
          label: card.querySelector('.kind-label').textContent,
          activeRole: card.querySelector('.role-switch [aria-pressed=true]')?.dataset.action,
          textLabel: card.querySelector('textarea[data-field=text]').getAttribute('aria-label'),
          summary: card.querySelector('.layer-summary').textContent,
        }));
        assert.equal(rendered.speaker, speaker, `${kind}/${speaker}: card speaker dataset updates`);
        assert.equal(rendered.activeRole, `speaker-${speaker}`, `${kind}/${speaker}: role switch updates`);
        assert.match(rendered.textLabel, speaker === 'female' ? /女性/ : /男性/);
        assert.match(rendered.summary, speaker === 'female' ? /女性/ : /男性/);
        if (kind === 'dialogue') assert.match(rendered.label, speaker === 'female' ? /女性/ : /男性/);
        assert.equal(await page.evaluate(({id, speaker}) => window.__interactionSnapshot().pages.flatMap(page => page.layers).find(layer => layer.id === id)?.speaker === speaker,
          { id: await target.getAttribute('data-layer-id'), speaker }), true, `${kind}/${speaker}: preset updates model speaker`);
      }
    }
  }

  const sfx = card('sfx');
  await sfx.locator('.layer-summary').click();
  const sharedSize = row.locator('.position-controls [data-field=size]');
  const initialSize = await sharedSize.inputValue();
  const preview = row.locator('canvas.preview');
  const center = await preview.evaluate(canvas => {
    const r = canvas.getBoundingClientRect(); return { x: r.x + r.width * .75, y: r.y + r.height * .75 };
  });
  const sfxLayerId = await sfx.getAttribute('data-layer-id');
  const modelSize = () => page.evaluate(id => window.__interactionSnapshot().pages.flatMap(p => p.layers).find(layer => layer.id === id)?.size, sfxLayerId);
  const initialModelSize = await modelSize();
  await page.mouse.click(center.x, center.y);
  assert.equal(await row.locator('.layer-card.selected').getAttribute('data-kind'), 'sfx', 'preview click targets isolated SFX object');
  assert.equal(await modelSize(), initialModelSize, 'ordinary preview click keeps SFX model size');
  assert.equal(await sharedSize.inputValue(), initialSize, 'ordinary preview click keeps selected SFX size');
  await page.mouse.move(center.x, center.y); await page.mouse.down();
  await page.mouse.move(center.x + .5, center.y + .5, { steps: 1 }); await page.mouse.up();
  assert.equal(await modelSize(), initialModelSize, 'subpixel pointer move keeps SFX model size');
  assert.equal(await sharedSize.inputValue(), initialSize, 'subpixel pointer move keeps displayed SFX size');
  await sfx.locator('[data-action=sfx-glyph-enter]').click();
  assert.equal(await modelSize(), initialModelSize, 'entering glyph edit keeps SFX model size');
  await page.mouse.click(center.x, center.y);
  assert.equal(await modelSize(), initialModelSize, 'glyph-edit click keeps SFX model size');

  const assertNavigationStable=async(index,name,label,{click=true,initialTop=null,probeLateResize=false}={})=>{
    if(click)initialTop=await page.evaluate(index=>{document.querySelectorAll('.thumbnail')[index].click();return document.querySelector('.image-row.active')?.getBoundingClientRect().top;},index);
    await page.waitForFunction(expected=>document.querySelector('.image-row.active .page-name')?.textContent===expected,name);
    const target=page.locator('.image-row.active'),start=initialTop??await target.evaluate(row=>row.getBoundingClientRect().top);
    await page.waitForFunction(()=>[...document.querySelectorAll('.image-row')].every(row=>{
      const state=window.__interactionSnapshot().pages.find(page=>page.id===row.dataset.pageId);
      return state?.ready&&state.naturalWidth>0;
    }),{timeout:30000});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const end=await target.evaluate(row=>row.getBoundingClientRect().top);
    assert.ok(Math.abs(end-start)<=8,`${label} keeps the selected row stable during preparation (${start.toFixed(1)}px -> ${end.toFixed(1)}px)`);
    const toolbarBottom=await page.locator('.collection-bar').evaluate(bar=>bar.getBoundingClientRect().bottom);
    assert.ok(Math.abs(end-toolbarBottom)<=1,`${label} aligns the selected row below the toolbar (${end.toFixed(1)}px vs ${toolbarBottom.toFixed(1)}px)`);
    const retained=await page.evaluate(()=>window.__interactionSnapshot().navigationAnchor?.pageId);
    assert.equal(retained,await target.getAttribute('data-page-id'),`${label} keeps its anchor after the background queue and image loads finish`);
    if(probeLateResize){
      const priorId=await page.locator('.thumbnail').nth(index-1).getAttribute('data-page-id');
      const resize=await page.evaluate(id=>window.__forceObservedRowGrowth(id),priorId);
      assert.ok(resize.growth>40,`${label} actually shifts the target before the resize callback (${resize.growth.toFixed(1)}px)`);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const afterResize=await target.evaluate(row=>row.getBoundingClientRect().top);
      assert.ok(Math.abs(afterResize-end)<=2,`${label} stays pinned through a late ResizeObserver layout change (${end.toFixed(1)}px -> ${afterResize.toFixed(1)}px)`);
      await page.evaluate(value=>{document.documentElement.style.overflowAnchor=value;},resize.overflowAnchor);
    }
    return end;
  };
  await assertNavigationStable(39,'040.png','50-page view navigation');
  await page.locator('#pageSize').selectOption('100');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===55);
  const firstFortyIds=await page.locator('.thumbnail').evaluateAll(nodes=>nodes.slice(0,40).map(node=>node.dataset.pageId));
  const mediumNavigation=await page.evaluate(ids=>{for(const id of ids)window.__forceUnpreparedShell(id);document.querySelector(`.thumbnail[data-page-id="${ids.at(-1)}"]`).click();return {...window.__interactionSnapshot(),top:document.querySelector('.image-row.active').getBoundingClientRect().top};},firstFortyIds);
  assert.ok(mediumNavigation.pendingMounts>0,'100-page view click leaves background page preparation pending');
  assert.equal(mediumNavigation.navigationAnchor?.pageId,firstFortyIds.at(-1),'100-page view retains its clicked page anchor');
  await assertNavigationStable(39,'040.png','100-page view navigation',{click:false,initialTop:mediumNavigation.top});
  await page.locator('#pageSize').selectOption('50');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===50);
  await page.locator('#pageSize').selectOption('all');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===55);
  const lastBatchIds=await page.locator('.thumbnail').evaluateAll(nodes=>nodes.slice(50).map(node=>node.dataset.pageId));
  const allNavigation=await page.evaluate(ids=>{for(const id of ids)window.__forceUnpreparedShell(id);document.querySelector(`.thumbnail[data-page-id="${ids.at(-1)}"]`).click();return {...window.__interactionSnapshot(),top:document.querySelector('.image-row.active').getBoundingClientRect().top};},lastBatchIds);
  assert.ok(allNavigation.pendingMounts>0,'all-pages click leaves background page preparation pending');
  assert.equal(allNavigation.navigationAnchor?.pageId,lastBatchIds.at(-1),'all-pages view retains its clicked page anchor');
  await assertNavigationStable(54,'055.png','all-pages navigation',{click:false,initialTop:allNavigation.top,probeLateResize:true});
  await page.locator('#pageSize').selectOption('50');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===5);
  await assertNavigationStable(53,'054.png','reused-ready-row navigation after page-size generation change',{probeLateResize:true});

  const startCount = await page.evaluate(() => window.__editorProbe.draws.length);
  const boundaryIds=await page.locator('.thumbnail').evaluateAll(nodes=>nodes.slice(50).map(node=>node.dataset.pageId));
  const boundaryNavigation=await page.evaluate(ids=>{
    for(const id of ids)window.__forceUnpreparedShell(id);
    document.querySelector(`.thumbnail[data-page-id="${ids[0]}"]`).click();
    const pending=window.__pausePageMountQueue();
    const active=document.querySelector('.image-row.active'),menu=active.querySelector('.layer-card[data-kind="sfx"] [data-preset-select]');
    const start=window.__editorProbe.draws.length;menu.focus();
    return {state:window.__interactionSnapshot(),pending,focused:document.activeElement===menu,focusDraws:window.__editorProbe.draws.length-start};
  },boundaryIds);
  assert.ok(boundaryNavigation.pending>0,'boundary click leaves neighboring page preparation pending');
  assert.equal(boundaryNavigation.state.pendingMounts,boundaryNavigation.pending,'page preparation is paused with its queue intact');
  assert.equal(boundaryNavigation.state.navigationAnchor?.pageId,boundaryIds[0],'boundary click anchors its selected page during preparation');
  assert.equal(boundaryNavigation.focused,true,'selected SFX preset menu receives focus during neighboring preparation');
  assert.equal(boundaryNavigation.focusDraws,0,'selected SFX menu focus does not draw while neighboring pages prepare');
  await page.waitForFunction(() => document.querySelector('.image-row.active .page-name')?.textContent === '051.png');
  const boundaryRow=page.locator('.image-row.active'),boundaryPosition=await boundaryRow.evaluate(row=>row.getBoundingClientRect().top);
  const boundaryBeforeWheel=await page.evaluate(()=>({scrollTop:document.scrollingElement.scrollTop,maxScroll:document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight}));
  const wheelDirection=boundaryBeforeWheel.scrollTop<boundaryBeforeWheel.maxScroll-10?1:-1;
  await page.locator('main').hover();
  await page.mouse.wheel(0,wheelDirection*120);
  let boundaryAfterWheel=await boundaryRow.evaluate(row=>row.getBoundingClientRect().top);
  let wheelWasTrusted=await page.evaluate(()=>window.__editorProbe.wheels.at(-1)?.trusted===true);
  const nativeWheelMoved=wheelWasTrusted&&Math.abs(boundaryAfterWheel-boundaryPosition)>40;
  let manualScrollEvent=await page.evaluate(()=>({anchor:window.__interactionSnapshot().navigationAnchor,top:document.querySelector('.image-row.active').getBoundingClientRect().top}));
  if(Math.abs(boundaryAfterWheel-boundaryPosition)<40){
    await page.evaluate(direction=>{window.dispatchEvent(new WheelEvent('wheel',{deltaY:direction*120,bubbles:true}));window.scrollBy({top:direction*120,behavior:'instant'});},wheelDirection);
    boundaryAfterWheel=await boundaryRow.evaluate(row=>row.getBoundingClientRect().top);
    manualScrollEvent=await page.evaluate(()=>({anchor:window.__interactionSnapshot().navigationAnchor,top:document.querySelector('.image-row.active').getBoundingClientRect().top}));
  }
  assert.ok(Math.abs(boundaryAfterWheel-boundaryPosition)>40,`manual wheel/scroll input moves the selected row (${boundaryPosition.toFixed(1)}px -> ${boundaryAfterWheel.toFixed(1)}px)`);
  assert.equal(manualScrollEvent.anchor,null,'manual wheel input cancels automatic position correction');
  await page.evaluate(()=>window.__resumePageMountQueue());
  await page.waitForFunction(() => [...document.querySelectorAll('.image-row')].every(row => {
    const state=window.__interactionSnapshot().pages.find(page=>page.id===row.dataset.pageId);
    return state?.ready&&state.naturalWidth>0;
  }), { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(Math.abs(await boundaryRow.evaluate(row=>row.getBoundingClientRect().top)-boundaryAfterWheel)<=2,
    'background preparation does not undo an external scroll position change');
  await page.waitForFunction(() => window.__editorProbe.draws.slice().some(draw => draw.pageId === document.querySelector('.image-row.active').dataset.pageId), { timeout: 10000 });
  assert.equal(await page.locator('.thumbnail[aria-current=page] .thumbnail-name').textContent(), '051.png');
  assert.equal(await page.locator('.image-row').count(), 5, 'boundary navigation retains the selected 50-page batch');
  assert.ok(await page.evaluate(start => window.__editorProbe.draws.length > start, startCount));
  await page.evaluate(() => {
    document.querySelector('.thumbnail:nth-child(1)')?.click();
    document.querySelector('.thumbnail:nth-child(51)')?.click();
  });
  await page.waitForFunction(() => document.querySelector('.image-row.active .page-name')?.textContent === '051.png');
  assert.equal(await page.locator('.thumbnail[aria-current=page] .thumbnail-name').textContent(), '051.png', 'rapid selection settles on latest page');
  await page.locator('.thumbnail').first().click();
  await page.waitForFunction(() => document.querySelector('.image-row.active .page-name')?.textContent === '001.png');
  assert.equal(await page.locator('.image-row').count(), 50, 'return restores the default batch size');
  await page.locator('[data-page-filter=unedited]').click();
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 0);
  assert.match(await page.locator('#thumbnailFilterCount').textContent(), /^0 \/ 55枚/);
  await page.locator('[data-page-filter=all]').click();
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 50);
  await page.locator('#pageSize').selectOption('100');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 55);
  await page.locator('#pageSize').selectOption('all');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 55);
  await page.waitForFunction(() => window.__interactionSnapshot().pages.every(page => page.ready));
  const unmountPageId = await page.locator('.thumbnail').nth(54).getAttribute('data-page-id');
  const unmountFlush = await page.evaluate(id => window.__forceFocusedInputUnmount(id), unmountPageId);
  assert.equal(unmountFlush.pending,unmountFlush.before+11,'test leaves a focused size edit pending without dispatching input');
  assert.equal(unmountFlush.after,unmountFlush.pending,'unmount flushes a focused control before disabling the ready guard');
  assert.equal(unmountFlush.ready,false);
  assert.equal(unmountFlush.mounted,false);
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 50);
  await page.locator('.thumbnail').first().click();
  await page.waitForFunction(() => document.querySelector('.image-row.active .page-name')?.textContent === '001.png');
  await page.locator('#pageSize').selectOption('50');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 50);
  const shellPageId = await page.locator('.thumbnail').nth(1).getAttribute('data-page-id');
  const shellBefore = await page.evaluate(id => {
    const state=window.__interactionSnapshot().pages.find(p=>p.id===id);
    return {ready:state.ready,size:state.layers.find(layer=>layer.kind==='dialogue').size};
  },shellPageId);
  await page.evaluate(id => window.__forceUnpreparedShell(id),shellPageId);
  const shellFocus = await page.evaluate(id => {
    const row=document.querySelector(`.image-row[data-page-id="${id}"]`),input=row.querySelector('.position-controls [data-field=size]');
    const state=window.__interactionSnapshot().pages.find(p=>p.id===id),size=state.layers.find(layer=>layer.kind==='dialogue').size;
    input.value=String(size+26);input.focus();
    const after=window.__interactionSnapshot().pages.find(p=>p.id===id);
    return {ready:after.ready,size:after.layers.find(layer=>layer.kind==='dialogue').size,control:input.value,blurred:document.activeElement!==input};
  },shellPageId);
  assert.equal(shellBefore.ready,true,'test page starts mounted before resetting to a raw shell');
  assert.equal(shellFocus.ready,true,'focusing a raw shell prepares it synchronously');
  assert.equal(shellFocus.blurred,true,'preparation moves and blurs the raw control');
  assert.equal(shellFocus.size,shellBefore.size,'raw template value must not overwrite the page model during preparation');
  assert.equal(Number(shellFocus.control),shellBefore.size,'preparation restores the model value into the now-ready control');
  await page.locator('.thumbnail').first().click();
  await page.waitForFunction(() => document.querySelector('.image-row.active .page-name')?.textContent === '001.png');
  await page.evaluate(id => window.__forceUnpreparedShell(id),shellPageId);
  const rawImage = await page.evaluate(id => {
    const state=window.__interactionSnapshot().pages.find(p=>p.id===id);
    return {ready:state.ready,currentSrc:state.currentSrc,naturalWidth:state.naturalWidth};
  },shellPageId);
  assert.equal(rawImage.ready,false,'full-preview test starts from an unprepared shell');
  assert.equal(rawImage.currentSrc,'','unmount releases the decoded image before preview selection');
  assert.equal(rawImage.naturalWidth,0);
  await page.locator(`.image-row[data-page-id="${shellPageId}"] [data-action=preview-full]`).click();
  await page.waitForFunction(() => {
    const dialog=document.querySelector('#fullPreview'),canvas=document.querySelector('#fullPreviewCanvas');
    return dialog.open&&(!canvas.hidden||document.querySelector('#fullPreviewStatus').textContent.includes('表示できなかった'));
  });
  const fullPreview = await page.evaluate(() => ({
    open:document.querySelector('#fullPreview').open,hidden:document.querySelector('#fullPreviewCanvas').hidden,
    size:[document.querySelector('#fullPreviewCanvas').width,document.querySelector('#fullPreviewCanvas').height],
    status:document.querySelector('#fullPreviewStatus').textContent,
  }));
  assert.equal(fullPreview.open,true);
  assert.equal(fullPreview.hidden,false,'100% preview renders after activating and preparing the shell');
  assert.deepEqual(fullPreview.size,[320,240]);
  assert.equal(fullPreview.status,'');
  await page.locator('#fullPreviewClose').click();
  assert.deepEqual(errors, []);
  console.log(`Editor interaction smoke passed: four preset kinds retain cards, focused preset menus avoid redraws, single preview draw, Undo/Redo/defaults, selection/model-size checks, 50/100/all navigation holds the selected row through preparation and image load plus late ResizeObserver reflow, pending-preparation wheel preserves manual position${nativeWheelMoved?' (trusted browser wheel)':' (synthetic scroll fallback)'}, filtered views, stale raw-control protection, focused-control unmount flush, unprepared full preview, and rapid boundary navigation.`);
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  if (page) await page.screenshot({ path: join(artifactDir, 'editor-interaction-smoke-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
}
