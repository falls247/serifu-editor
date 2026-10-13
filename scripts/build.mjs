import { copyFile, mkdir, rm, writeFile, cp, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const output = new URL('_site/', root);
const assets = ['index.html', 'favicon-32.png', 'apple-touch-icon.png', 'src/app.js', 'src/export.js', 'src/project-identity.js','src/project-history.js','src/project-lock.js','src/project-conflict.js','src/sfx-lettering-templates.js','src/sfx-outline-groups.js','src/sfx-lettering-model.js','src/sfx-stroke-geometry.js','src/sfx-edit-operations.js','src/sfx-editor.js','src/renderer.js','src/glyph-layout.js','src/brush-stroke.js', 'src/balloons.js', 'src/captions.js', 'src/typography.js', 'src/ink.js', 'src/fonts.js', 'src/model.js','src/image-edit.js','src/preview-modal.js','src/preview-render.js','src/preview-magnifier.js', 'src/presets.js', 'src/storage.js','src/bulk-task.js','src/bulk-pool.js','src/image-worker.js','src/image-metadata.js','src/export-cache.js','src/project-io.js','src/project-filenames.js','src/project-worker.js','src/zip.js', 'src/mask-codec.js', 'src/mask-geometry.js', 'src/mask-effects.js', 'src/sam3-client.js', 'src/sam3-ui.js', 'style.css'];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(new URL('src/', output), { recursive: true });
for (const asset of assets) {
  await copyFile(new URL(asset, root), new URL(asset, output));
}
await writeFile(new URL('.nojekyll', output), '');
console.log(`GitHub Pages用の静的ファイル ${assets.length} 件を _site/ に出力した`);

try { await access(new URL('assets/fonts/DelaGothicOne-Regular.ttf',root)); await cp(new URL('assets/fonts/',root),new URL('assets/fonts/',output),{recursive:true}); } catch { console.log('ローカル書体なし。端末の日本語書体を使用（npm run fontsで準備可能）'); }
