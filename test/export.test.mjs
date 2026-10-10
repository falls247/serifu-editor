import test from 'node:test';
import assert from 'node:assert/strict';
import { pageExportName, textExport } from '../export.js';

test('一括PNGの桁数は一覧枚数に追従し、抽出後もページ番号を保つ', () => {
  for (const [count, first, last] of [
    [1, 'p1_', 'p1_'], [9, 'p1_', 'p9_'], [10, 'p01_', 'p10_'],
    [99, 'p01_', 'p99_'], [100, 'p001_', 'p100_'],
    [999, 'p001_', 'p999_'], [1000, 'p0001_', 'p1000_'],
  ]) {
    assert.equal(pageExportName('元画像.jpg', 0, count), `${first}元画像.png`);
    assert.equal(pageExportName('元画像.jpg', count - 1, count), `${last}元画像.png`);
  }
  assert.equal(pageExportName('a:b.jpg', 4, 120), 'p005_a_b.png');
  assert.notEqual(pageExportName('image.jpg', 0, 2), pageExportName('image.png', 1, 2));
});

const pages = [
  { layers: [
    { kind: 'dialogue', speaker: 'female', text: '女性1' },
    { kind: 'dialogue', speaker: 'male', text: '男性1' },
    { kind: 'caption', text: '説明1\n説明2' },
    { kind: 'dialogue', speaker: 'female', text: '女性2\n続き' },
    { kind: 'dialogue', speaker: 'female', text: ' \n ' },
    { kind: 'sfx', text: 'ドン' },
    { kind: 'balloon', text: '' },
  ] },
  { layers: [] },
  { layers: [{ kind: 'dialogue', speaker: 'female', text: '女性3' }] },
];

test('既定の女性台詞は1件ごとに括弧を付け、本文の改行とページ順を保つ', () => {
  assert.equal(textExport(pages), '「女性1」\n「女性2\n続き」\n「女性3」\n');
  assert.equal(textExport([...pages].reverse()), '「女性3」\n「女性1」\n「女性2\n続き」\n');
});

test('対象別に本文を抽出し、キャプションと効果音は括弧を付けない', () => {
  assert.equal(textExport(pages, 'male'), '「男性1」\n');
  assert.equal(textExport(pages, 'dialogue'), '「女性1」\n「男性1」\n「女性2\n続き」\n「女性3」\n');
  assert.equal(textExport(pages, 'caption'), '説明1\n説明2\n');
  assert.equal(textExport(pages, 'sfx'), 'ドン\n');
  assert.equal(textExport(pages, 'all'), '「女性1」\n「男性1」\n説明1\n説明2\n「女性2\n続き」\nドン\n「女性3」\n');
  assert.equal(textExport([]), '');
  assert.equal(textExport([{ layers: [{ kind: 'caption', text: '' }] }], 'caption'), '');
});

test('吹き出し内の台詞も話者別と全台詞の出力へ含める', () => {
  const pages = [{ layers: [
    { kind: 'balloon', speaker: 'female', text: '吹き出し女性～' },
    { kind: 'balloon', speaker: 'male', text: '吹き出し男性' },
    { kind: 'balloon', text: '既定の男性' },
    { kind: 'balloon', speaker: 'female', text: ' \n ' },
  ] }];
  assert.equal(textExport(pages, 'female'), '「吹き出し女性～」\n');
  assert.equal(textExport(pages, 'male'), '「吹き出し男性」\n「既定の男性」\n');
  assert.equal(textExport(pages, 'dialogue'), '「吹き出し女性～」\n「吹き出し男性」\n「既定の男性」\n');
  assert.equal(textExport(pages, 'all'), textExport(pages, 'dialogue'));
  assert.equal(textExport(pages, 'caption'), '');
});
