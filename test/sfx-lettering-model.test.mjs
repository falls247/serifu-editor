import test from 'node:test';
import assert from 'node:assert/strict';
import {startLettering,normalizeLettering,replaceLetteringText,duplicateLetteringGlyphs,removeLetteringGlyphs,sfxRuns,sfxVisibleIndices} from '../src/sfx-lettering-model.js';
const layer=(text='ザーーーーッ')=>({kind:'sfx',text,size:80,vertical:true,glyphSeed:31,textureSeed:41});
test('遅延移行: 旧SFXを変更せず新letteringだけ生成',()=>{
  const old=layer();const lettering=startLettering(old);
  assert.equal(old.lettering,undefined);assert.equal(lettering.glyphs.length,6);
  assert.deepEqual(lettering.strokes.map(x=>[x.runStart,x.runLength]),[[1,4]]);
  assert.deepEqual(sfxRuns('ーー\nー\nーー').map(x=>[x.runStart,x.runLength]),[[0,2],[5,2]]);
});
test('grapheme indexはUTF-16長ではなく結合文字を1文字として数える',()=>{
  const text='あ👨‍👩‍👧‍👦か\u3099\nッ';assert.deepEqual(sfxVisibleIndices(text),[0,1,2,4]);
  assert.equal(startLettering(layer(text)).glyphs.length,4);
});
test('不正な入力を描画前に拒否し既存オブジェクトは破壊しない',()=>{
  const old=layer('ドン');const l=startLettering(old);l.glyphs[0].dx=Infinity;
  assert.throws(()=>normalizeLettering(l,old.text,old),/dx/);
  const dup=startLettering(old);dup.glyphs.push(dup.glyphs[0]);
  assert.throws(()=>normalizeLettering(dup,old.text,old),/文字index/);
  assert.equal(old.lettering,undefined);
});
test('位置基準は文字が変わっても手動位置を保ち文字一致では一致文字だけ保つ',()=>{
  const base=layer('ザクッ');base.lettering=startLettering(base);
  base.lettering.glyphs[0].dx=23;base.lettering.glyphs[0].manual.position=true;
  base.lettering.glyphs[2].dx=19;
  const byPosition=replaceLetteringText(base,'ボコッ','position');
  assert.equal(byPosition.lettering.glyphs[0].dx,23);assert.equal(byPosition.lettering.glyphs[2].dx,19);
  const byCharacter=replaceLetteringText(base,'ボコッ','character');
  assert.equal(byCharacter.lettering.glyphs[0].dx,0);assert.equal(byCharacter.lettering.glyphs[2].dx,19);
  const reset=replaceLetteringText(base,'ボコッ','reset');
  assert.equal(reset.lettering.glyphs[2].dx,0);
});
test('連続長音線の長さとstyleを本文変更後も継承',()=>{
  const base=layer();base.lettering=startLettering(base);
  base.lettering.strokes[0].shape='s';base.lettering.strokes[0].widths[0].w=35;
  const next=replaceLetteringText(base,'ザーーーーーッ','character');
  assert.deepEqual(next.lettering.strokes.map(s=>s.runLength),[5]);
  assert.equal(next.lettering.strokes[0].shape,'s');
  assert.equal(next.lettering.strokes[0].widths[0].w,35);
});
test('文字複製/削除は原文とglyphs数を同時更新、複製seed継承',()=>{
  const base=layer('ドン');base.lettering=startLettering(base);
  const duplicate=duplicateLetteringGlyphs(base,[0],{offset:0});
  assert.equal(duplicate.text,'ドドン');
  assert.equal(duplicate.lettering.glyphs[0].inkVariantSeed,duplicate.lettering.glyphs[1].inkVariantSeed);
  assert.equal(removeLetteringGlyphs(duplicate,[1]).text,'ドン');
});
test('異常なrun、幅点順序、循環対象外参照を拒否',()=>{
  const base=layer();const l=startLettering(base);
  l.strokes[0].widths[1].t=0;assert.throws(()=>normalizeLettering(l,base.text,base),/線幅点/);
  l.strokes[0].widths[1].t=1;l.outlineGroups=[{members:[12],mode:'manual',locked:true}];
  assert.throws(()=>normalizeLettering(l,base.text,base),/輪郭member/);
});
