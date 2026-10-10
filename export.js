// 一覧全体のページ番号を使用する。編集済みだけの出力でも欠番を詰めない。
export function pageExportName(name, index, pageCount) {
  const digits = String(pageCount).length;
  const basename = name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return `p${String(index + 1).padStart(digits, '0')}_${basename}.png`;
}

export function textExport(pages, target = 'female') {
  const lines = [];
  for (const page of pages) {
    for (const layer of page.layers) {
      if (!['dialogue', 'caption', 'sfx'].includes(layer.kind) || !layer.text?.trim()) continue;
      const matches = target === 'all' || target === layer.kind
        || (layer.kind === 'dialogue' && target === layer.speaker);
      if (matches) lines.push(layer.kind === 'dialogue' ? `「${layer.text}」` : layer.text);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
