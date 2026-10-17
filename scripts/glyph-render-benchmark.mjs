import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const projectRoot = process.env.SERIFU_GLYPH_BENCH_ROOT || fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SERIFU_GLYPH_BENCH_PORT || 5384);
const server = spawn(process.execPath, ['server.mjs'], { cwd: projectRoot, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;

async function openContext() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

function summarize(values) {
  const latest = values.at(-1), sorted = [...values].sort((a, b) => a.ms - b.ms);
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)].ms,
    maxMs: sorted.at(-1).ms,
    cache: latest.cache,
  };
}

const cases = [
  { name: 'preset-small', width: 1200, height: 900, outputWidth: 1200, outputHeight: 900, size: 84, outline: 6 },
  { name: 'image-select-large', width: 3000, height: 2000, outputWidth: 1400, outputHeight: 933, size: 280, outline: 18 },
];
const results = [];

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Glyph benchmark server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
  });
  browser = await chromium.launch({ headless: true });

  for (const fixture of cases) {
    const cold = await openContext();
    const warm = await openContext();
    const setup = async page => page.evaluate(async ({ width, height, outputWidth, outputHeight, size, outline }) => {
      const renderer = await import('/src/renderer.js');
      const fonts = await import('/src/fonts.js');
      const source = document.createElement('canvas'); source.width = width; source.height = height;
      const sourceContext = source.getContext('2d'); sourceContext.fillStyle = '#556677'; sourceContext.fillRect(0, 0, width, height);
      const image = await createImageBitmap(source);
      const canvas = document.createElement('canvas'); canvas.width = outputWidth; canvas.height = outputHeight;
      const layer = {
        ...renderer.newLayer('sfx', width, height), text: 'ゴゴゴゴゴッ!!', x: width / 2, y: height / 2,
        w: width * .75, h: height * .72, font: 'comic', size, outline, effect: 'burst', distortion: 45,
        skew: -16, stretchX: 115, stretchY: 110, roughness: 25, dryInk: 35, brushTails: 35,
        sizeVariation: 5, horizontalJitter: 3, glyphSeed: 12345, textureSeed: 23456,
      };
      await Promise.all(fonts.fontLoadQueries(layer).map(query => document.fonts.load(query)));
      const context = canvas.getContext('2d'), scale = outputWidth / width;
      window.glyphBenchmark = {
        draw(clear) {
          if (clear) renderer.clearGlyphCache();
          const start = performance.now(); renderer.draw(context, image, [layer], null, scale, scale);
          return { ms: performance.now() - start, cache: renderer.glyphCacheStats?.() ?? null };
        },
        clear: () => renderer.clearGlyphCache(),
        stats: () => renderer.glyphCacheStats?.() ?? null,
      };
    }, fixture);
    await setup(cold.page); await setup(warm.page);

    const coldSamples = [];
    for (let i = 0; i < 5; i++) coldSamples.push(await cold.page.evaluate(() => window.glyphBenchmark.draw(true)));

    await warm.page.evaluate(() => window.glyphBenchmark.draw(true));
    const warmSamples = [];
    for (let i = 0; i < 5; i++) warmSamples.push(await warm.page.evaluate(() => window.glyphBenchmark.draw(false)));

    const entry = {
      fixture: { name: fixture.name, width: fixture.width, height: fixture.height, outputWidth: fixture.outputWidth, outputHeight: fixture.outputHeight, size: fixture.size, outline: fixture.outline },
      coldAfterClear: summarize(coldSamples),
      warmAfterOneDraw: summarize(warmSamples),
      browser: await cold.page.evaluate(() => navigator.userAgent),
    };

    if (process.argv.includes('--profile')) {
      const session = await cold.context.newCDPSession(cold.page);
      await session.send('Profiler.enable'); await session.send('Profiler.start');
      const drawMs = await cold.page.evaluate(() => window.glyphBenchmark.draw(true).ms);
      const { profile } = await session.send('Profiler.stop'); await session.detach();
      const names = new Map(profile.nodes.map(node => [node.id, node.callFrame.functionName || '(anonymous)'])),
        totals = new Map();
      for (let index = 0; index < profile.samples.length; index++) {
        const name = names.get(profile.samples[index]);
        totals.set(name, (totals.get(name) || 0) + profile.timeDeltas[index]);
      }
      entry.profile = {
        drawMs,
        topFunctions: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, microseconds]) => ({ name, cpuMs: +(microseconds / 1000).toFixed(2) })),
      };
    }
    results.push(entry);
    await cold.context.close(); await warm.context.close();
  }
  console.log(JSON.stringify({ root: projectRoot, results }, null, 2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
