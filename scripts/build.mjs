import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('_site/', root);
const assets = ['index.html', 'app.js', 'renderer.js', 'style.css'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const asset of assets) {
  await copyFile(new URL(asset, root), new URL(asset, output));
}
await writeFile(new URL('.nojekyll', output), '');
console.log(`GitHub Pages用の静的ファイル ${assets.length} 件を _site/ に出力した`);
