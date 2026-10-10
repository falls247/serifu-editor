import test from 'node:test';
import assert from 'node:assert/strict';
import { filenameTimestamp, projectFileName, projectFolderName, safeFilenamePart, uploadedFolderName } from '../project-filenames.js';

test('編集データ名はフォルダ名とローカル日時を使い、編集済みでも末尾を変えない', () => {
  const date = new Date(2026, 9, 10, 8, 7, 6, 5);
  assert.equal(filenameTimestamp(date), '20261010_080706_005');
  assert.equal(projectFileName('serifu', date, '章1'), '章1_20261010_080706_005.serifu');
  assert.equal(projectFileName('serifu', date, '章1', '_edited'), '章1_20261010_080706_005.serifu');
  assert.equal(projectFileName('json', date, '章1'), 'serifu-project.json');
});

test('フォルダ名は選択フォルダまたは相対パスの先頭から取得する', () => {
  assert.equal(uploadedFolderName([{ file: { name: 'page.png' }, directory: { name: 'chapter' } }]), 'chapter');
  assert.equal(uploadedFolderName([
    { file: { name: 'page.png', webkitRelativePath: 'chapter/sub/page.png' } },
  ]), 'chapter');
  assert.equal(uploadedFolderName([{ file: { name: 'page.png', webkitRelativePath: '' } }]), null);
});

test('編集データ名から読込元フォルダを復元し、安全なファイル名部分に整える', () => {
  assert.equal(projectFolderName('chapter_20261010_080706_005.serifu'), 'chapter');
  assert.equal(projectFolderName('chapter_20261010_080706_005_edited.serifu'), 'chapter');
  assert.equal(projectFolderName('serifu-project.json'), null);
  assert.equal(safeFilenamePart(' a/b. '), 'a_b');
  assert.equal(safeFilenamePart(''), 'serifu');
});
