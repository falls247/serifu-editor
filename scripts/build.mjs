import { copyFile, mkdir, rm, writeFile, cp, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('_site/', root);
const assets = ['index.html', 'app.js', 'export.js', 'renderer.js', 'balloons.js', 'captions.js', 'typography.js', 'ink.js', 'fonts.js', 'model.js', 'presets.js', 'storage.js','bulk-task.js','bulk-pool.js','image-worker.js','image-metadata.js','export-cache.js','project-io.js','project-worker.js','zip.js', 'style.css'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) {
  await copyFile(new URL(asset, root), new URL(asset, output));
}
await writeFile(new URL('.nojekyll', output), '');
console.log(`GitHub Pages用の静的ファイル ${assets.length} 件を _site/ に出力した`);

try { await access(new URL('assets/fonts/DelaGothicOne-Regular.ttf',root)); await cp(new URL('assets/fonts/',root),new URL('assets/fonts/',output),{recursive:true}); } catch { console.log('ローカル書体なし。端末の日本語書体を使用（npm run fontsで準備可能）'); }
