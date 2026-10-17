import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.env.SERIFU_PROFILE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SERIFU_INTERACTION_PORT || 5289);
const samples = Math.max(1, Math.min(20, Number(process.env.SERIFU_BENCH_SAMPLES || 5)));
const presetFixture=process.env.SERIFU_BENCH_PRESET_FIXTURE||null;
if(presetFixture&&!['small','dense'].includes(presetFixture))throw new Error('SERIFU_BENCH_PRESET_FIXTURE must be small or dense');
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
const artifactDir = process.env.SERIFU_BENCH_OUTPUT || join(tmpdir(), 'serifu-interaction-investigation');
const errors = [], results = { environment: {}, presetSamples: [], pageSelections: [], staleSelection: null };
let browser, context, page;

const summarize = values => {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  return sorted.length ? { n: sorted.length, median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) } : { n: 0, median: null, max: null };
};

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
    const response = await route.fetch(), source = await response.text();
    await route.fulfill({ response, body: `${source}\n{
      const benchmarkDrawPage=drawPage;
      drawPage=function(...args){
        const probe=window.__interactionBench,start=probe.draws.length;
        const result=benchmarkDrawPage(...args),completedAt=performance.now();
        for(let i=start;i<probe.draws.length;i++)probe.draws[i].completedAt=completedAt;
        return result;
      };
    }` });
  });
  await page.addInitScript(() => {
    const probe = window.__interactionBench = { draws: [], starts: [], rowAdded: 0, rowRemoved: 0, cardRemoved: 0, longTasks: [] };
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.matches?.('canvas.preview')) probe.draws.push({ at: performance.now(), pageId: this.canvas.closest('.image-row')?.dataset.pageId || null });
      return clearRect.apply(this, args);
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (record.target.id === 'deck') {
          probe.rowAdded += [...record.addedNodes].filter(node => node.matches?.('.image-row')).length;
          probe.rowRemoved += [...record.removedNodes].filter(node => node.matches?.('.image-row')).length;
        }
        if (record.target.matches?.('.layer-cards')) probe.cardRemoved += [...record.removedNodes].filter(node => node.matches?.('.layer-card')).length;
      }
    }).observe(document, { subtree: true, childList: true });
    document.addEventListener('click', event => {
      const thumbnail = event.target.closest?.('.thumbnail');
      if (thumbnail) probe.starts.push({ at: performance.now(), pageId: thumbnail.dataset.pageId });
    }, true);
    new PerformanceObserver(list => probe.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, ms: entry.duration })))).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async presetFixture => {
    const { newLayer } = await import('./src/renderer.js');
    const { PROJECT_VERSION } = await import('./src/model.js');
    const { startLettering } = await import('./src/sfx-lettering-model.js');
    const { defaultPreferences } = await import('./src/presets.js');
    const makeSource = (width, height, color) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/jpeg', .82);
    };
    if(presetFixture){
      const width=1200,height=900,src=makeSource(width,height,'#d8e0db');
      const kinds=['dialogue','sfx','balloon','caption'],texts=['その先に何がある？','ゴゴゴゴゴッ!!','吹き出し内の計測用セリフ','夜が明けた'];
      const repeats=presetFixture==='dense'?2:1,pageCount=presetFixture==='dense'?6:1;
      const pages=Array.from({length:pageCount},(_,pi)=>({name:`測定-${pi+1}.png`,src,imageWidth:width,imageHeight:height,
        layers:Array.from({length:repeats*4},(_,i)=>{
          const kind=kinds[i%4],layer={...newLayer(kind,width,height),text:texts[i%4]+(i>=4?' '+i:''),
            x:150+(i%4)*270,y:155+Math.floor(i/4)*220,w:230,h:250,
            glyphSeed:12345,textureSeed:23456,brushSeed:34567,shapeSeed:45678};
          if(kind==='dialogue')Object.assign(layer,{font:'sans',size:46,outline:4});
          if(kind==='sfx')Object.assign(layer,{font:'comic',size:84,effect:'burst',outline:6,distortion:25,roughness:20,dryInk:25,brushTails:20});
          if(kind==='balloon')Object.assign(layer,{font:'sans',size:38,shape:'ellipse',borderStyle:'solid',borderWidth:4});
          if(kind==='caption')Object.assign(layer,{font:'sans',size:40,autoFit:false,borderStyle:'solid',borderWidth:3});
          return layer;
        })}));
      return {version:PROJECT_VERSION,preferences:defaultPreferences(),pages};
    }
    const small = makeSource(900, 600, '#b9c3c8'), large = makeSource(3000, 2000, '#d2c9bb'), tiny = makeSource(320, 240, '#c9c4b9');
    const create = (kind, text, width, height) => ({
      ...newLayer(kind, width, height, 'male'), text, size: 70, x: width / 2, y: height / 2,
      w: width * .76, h: height * .62, font: kind === 'sfx' ? 'comic' : 'round', presetId: null,
      glyphSeed:12345,textureSeed:23456,brushSeed:34567,shapeSeed:45678,
      ...(kind === 'caption' ? { autoFit: false } : {}),
    });
    const sfx = create('sfx', 'バキッ！ドン！', 900, 600); sfx.lettering = startLettering(sfx);
    const firstLayers = [create('dialogue', '短いセリフ', 900, 600), sfx, create('balloon', '吹き出し', 900, 600), create('caption', '短い説明', 900, 600)];
    const pages = Array.from({ length: 51 }, (_, index) => ({
      name: `${String(index + 1).padStart(3, '0')}.png`, src: index === 50 ? large : index === 0 ? small : tiny,
      imageWidth: index === 50 ? 3000 : index === 0 ? 900 : 320, imageHeight: index === 50 ? 2000 : index === 0 ? 600 : 240,
      layers: index === 0 ? firstLayers : index === 50 ? [{
        ...create('sfx', 'ドォォン！衝撃音', 3000, 2000),size:280,effect:'burst',outline:18,
        distortion:45,roughness:25,dryInk:35,brushTails:35,
      }] : [create('dialogue', `ページ${index + 1}`, 320, 240)],
    }));
    return { version: PROJECT_VERSION, preferences: defaultPreferences(), pages };
  },presetFixture);
  await page.locator('#projectInput').setInputFiles({ name: 'editor-interaction-benchmark.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(count => document.querySelectorAll('.thumbnail').length === count && !document.querySelector('#projectLoad').disabled,fixture.pages.length);
  await page.waitForFunction(() => [...document.querySelectorAll('.image-row')].every(row => row.querySelector('.layer-cards').children.length > 0), null, { timeout: 60000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const { fontLoadQueries } = await import('./src/fonts.js');
    await Promise.all(fontLoadQueries({ font: 'comic', text: 'バキッ！ドン！衝撃音' }).map(query => document.fonts.load(query)));
    await document.fonts.ready;
    window.__interactionBench.draws.length = 0;
    window.__interactionBench.longTasks.length = 0;
  });
  results.environment = {
    root, chromium: browser.version(), platform: process.platform, viewport: '1440x1000', pages: fixture.pages.length, pageSize: 50, samples,
    instrumentation: 'preview clearRect start + app-response drawPage completion wrapper + DOM MutationObserver + Long Task PerformanceObserver',
    presetInputPrecondition:'select target object and focus its preset control before timing; capture current card identities for every operation',
    fixture: presetFixture?{name:presetFixture,image:'1200x900',pages:fixture.pages.length,objectsPerPage:presetFixture==='dense'?8:4,sfx:'legacy SFX 84px; return through sfx-handwritten before each cleared-cache impact apply',seeds:{glyph:12345,texture:23456,brush:34567,shape:45678}}:{ firstPage: '900x600; four mixed objects; edited SFX 70px', otherPages: '320x240; one dialogue', lastPage: '3000x2000; one SFX 280px/burst/outline18/roughness25/dryInk35/tails35', seeds:{glyph:12345,texture:23456,brush:34567,shape:45678} },
    cacheDefinitions: {
      first: 'initial SFX preset after fixture render and font readiness; no cache clear',
      cold: 'clearGlyphCache() immediately before dispatch, then measure dispatch and draw',
      warm: 'repeat after preceding cleared-cache SFX apply and preview draw; no cache clear',
    },
  };
  async function apply(kind, id, cacheMode) {
    const card=page.locator(`.image-row.active .layer-card[data-kind="${kind}"]`).first();
    if(!await card.evaluate(node=>node.classList.contains('selected')))await card.locator('.layer-summary').click();
    await card.locator('[data-preset-select]').focus();
    await page.evaluate(()=>{
      window.__benchCards=[...document.querySelectorAll('.image-row.active .layer-card')];
    });
    if (cacheMode === 'cold') await page.evaluate(async () => (await import('./src/renderer.js')).clearGlyphCache());
    const measured = await page.evaluate(async ({ kind, id }) => {
      const renderer=await import('./src/renderer.js'),cacheBefore=renderer.glyphCacheStats?.()??null;
      const probe = window.__interactionBench, row = document.querySelector('.image-row.active');
      probe.draws.length = 0; probe.cardRemoved = 0; probe.longTasks.length = 0; const before = performance.now();
      const select = row.querySelector(`.layer-card[data-kind="${kind}"] [data-preset-select]`);
      select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
      const syncMs=performance.now()-before,cacheAfter=renderer.glyphCacheStats?.()??null;
      const cacheDelta=cacheBefore&&cacheAfter?Object.fromEntries(['hits','misses','evictions','uncached'].map(key=>[key,cacheAfter[key]-cacheBefore[key]])):null;
      return { syncMs, syncDraws: probe.draws.length, selected: select.value,cacheBefore,cacheAfter,cacheDelta };
    }, { kind, id });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return {
      ...measured, kind, preset: id, cacheMode,
      drawsAfterTwoFrames: await page.evaluate(() => window.__interactionBench.draws.length),
      removedCards: await page.evaluate(() => window.__interactionBench.cardRemoved),
      retainedCards: await page.evaluate(() => window.__benchCards.filter(card => card.isConnected).length),
      longTasks: await page.evaluate(() => window.__interactionBench.longTasks.map(task => task.ms)),
    };
  }

  results.presetSamples.push(await apply('sfx', 'sfx-impact', 'first-after-load-cache-retained'));
  for (let index = 0; index < samples; index++) {
    if(presetFixture){await apply('sfx','sfx-handwritten','setup');await page.evaluate(()=>document.fonts.ready);}
    results.presetSamples.push(await apply('sfx', 'sfx-impact', 'cold'));
    results.presetSamples.push(await apply('sfx', 'sfx-impact', 'warm'));
  }
  for (const [kind, id] of presetFixture?[]:[['dialogue', 'dialogue-standard'], ['balloon', 'balloon-standard'], ['caption', 'caption-standard']]) {
    results.presetSamples.push(await apply(kind, id, 'first-for-kind-cache-retained'));
    for (let index = 0; index < samples; index++) results.presetSamples.push(await apply(kind, id, 'warm'));
  }

  async function selectThumbnail(index, label, trial) {
    await page.evaluate(() => {
      const probe = window.__interactionBench;
      probe.draws.length = 0; probe.starts.length = 0; probe.rowAdded = 0; probe.rowRemoved = 0;
    });
    await page.locator('.thumbnail').nth(index).click();
    const start = await page.evaluate(() => window.__interactionBench.starts.at(-1));
    assert.ok(start, `${label}: click capture timestamp missing`);
    await page.waitForFunction(({ pageId, at }) => window.__interactionBench.draws.some(draw => draw.pageId === pageId && draw.completedAt >= at), { pageId: start.pageId, at: start.at }, { timeout: 30000 });
    const afterFramesAt=await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(()=>resolve(performance.now())))));
    const draw = await page.evaluate(({ pageId, at }) => window.__interactionBench.draws.find(item => item.pageId === pageId && item.completedAt >= at), { pageId: start.pageId, at: start.at });
    const rowStats = await page.evaluate(() => ({ added: window.__interactionBench.rowAdded, removed: window.__interactionBench.rowRemoved }));
    const pixelOk = await page.locator(`.image-row[data-page-id="${start.pageId}"] canvas.preview`).evaluate(canvas => {
      try { return canvas.width > 1 && canvas.height > 1 && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0; } catch { return false; }
    });
    const targetDraws=await page.evaluate(pageId=>window.__interactionBench.draws.filter(draw=>draw.pageId===pageId&&Number.isFinite(draw.completedAt)).length,start.pageId);
    results.pageSelections.push({ label, trial, from: index === 50 ? '001.png' : '051.png', to: index === 50 ? '051.png' : '001.png', inputMs: draw.completedAt - start.at, drawStartMs: draw.at - start.at, firstDrawMs: draw.completedAt-draw.at, inputToTwoFramesMs:afterFramesAt-start.at, targetDrawsAfterTwoFrames: targetDraws, successfulCanvasDraw: pixelOk, rowAdded: rowStats.added, rowRemoved: rowStats.removed });
  }
  if(!presetFixture){
  for(let trial=1;trial<=samples;trial++){
    await selectThumbnail(50, 'boundary-forward',trial);
    await selectThumbnail(0, 'boundary-return',trial);
  }
  await page.evaluate(() => {
    window.__interactionBench.draws.length = 0; window.__interactionBench.starts.length = 0;
    document.querySelector('.thumbnail:nth-child(51)').click();
    document.querySelector('.thumbnail:first-child').click();
    window.__rapidFinishedAt = performance.now();
  });
  await page.waitForFunction(() => document.querySelector('.image-row.active .page-name')?.textContent === '001.png');
  await page.waitForTimeout(100);
  results.staleSelection = await page.evaluate(() => ({
    active: document.querySelector('.image-row.active .page-name')?.textContent,
    targetDrawAfterFinalSelection: window.__interactionBench.draws.some(draw => draw.pageId === document.querySelector('.thumbnail:nth-child(51)').dataset.pageId && draw.at > window.__rapidFinishedAt),
    mountedRows: document.querySelectorAll('.image-row').length,
    starts: window.__interactionBench.starts,
  }));
  assert.equal(results.staleSelection.active, '001.png');
  assert.equal(results.staleSelection.mountedRows, 50);
  assert.equal(results.staleSelection.targetDrawAfterFinalSelection, false, 'stale page work must not draw after latest selection');
  }
  assert.deepEqual(errors, []);

  results.summary = Object.fromEntries([...new Set(results.presetSamples.map(sample => `${sample.kind}/${sample.cacheMode}`))].map(key => {
    const [kind, cacheMode] = key.split('/'), group = results.presetSamples.filter(sample => sample.kind === kind && sample.cacheMode === cacheMode);
    return [key, { syncMs: summarize(group.map(sample => sample.syncMs)), draws: summarize(group.map(sample => sample.drawsAfterTwoFrames)), removedCards: summarize(group.map(sample => sample.removedCards)), retainedCards: summarize(group.map(sample => sample.retainedCards)) }];
  }));
  results.pageSummary=Object.fromEntries(['boundary-forward','boundary-return'].map(label=>[label,summarize(results.pageSelections.filter(sample=>sample.label===label).map(sample=>sample.inputMs))]));
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `editor-interaction-benchmark-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ artifact: path, environment: results.environment, summary: results.summary, pageSummary: results.pageSummary, pageSelections: results.pageSelections, staleSelection: results.staleSelection }, null, 2));
} catch (error) {
  await mkdir(artifactDir, { recursive: true });
  if (page) await page.screenshot({ path: join(artifactDir, 'editor-interaction-benchmark-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
}
