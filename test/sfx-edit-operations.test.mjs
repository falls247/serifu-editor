import test from 'node:test';
import assert from 'node:assert/strict';
import {startLettering,replaceLetteringText} from '../src/sfx-lettering-model.js';
import {addCurvePoint,removeCurvePoint,splitCubic,bezierPoint,sliceStroke,joinStrokes,addWidthPoint} from '../src/sfx-stroke-geometry.js';
import {copyLetteringSelection,pasteLetteringSelection,rotateLetteringOrientation,duplicateSelectedGlyphs} from '../src/sfx-edit-operations.js';
const layer=text=>{const l={id:'sfx1',kind:'sfx',text,size:80,w:800,h:600,vertical:false,glyphSeed:2,textureSeed:3};l.lettering=startLettering(l);return l;};
test('ベジェ分割は全パラメータで原形状を保持、点追加/削除は有限',()=>{
 const l=layer('ザーーーーッ'),s=l.lettering.strokes[0];s.path.points=[{x:0,y:0},{x:.3,y:.4},{x:.7,y:-.4},{x:1,y:0}];
 const [left,right]=splitCubic(s.path.points,.5);
 for(let i=0;i<=100;i++){const t=i/100,p=bezierPoint(t<=.5?left:right,t<=.5?t*2:(t-.5)*2),expected=bezierPoint(s.path.points,t);assert.ok(Math.hypot(p.x-expected.x,p.y-expected.y)<1e-12);}
 assert.equal(addCurvePoint(s).path.points.length,7);assert.equal(removeCurvePoint(addCurvePoint(s),3).path.points.length,4);
 assert.equal(addWidthPoint(s).widths.length,3);
 assert.equal(joinStrokes(sliceStroke(s,0,.5),sliceStroke(s,.5,1)).path.points.length,7);
});
test('原文の長音分断/結合は前後の制御点と幅を残す、1本/0本を許容',()=>{
 const l=layer('ザーーーーッ');l.lettering.strokes[0].path.points[1].y=.3;
 const split=replaceLetteringText(l,'ザーークーーッ','character');assert.equal(split.lettering.strokes.length,2);assert.notEqual(split.lettering.strokes[1].path.points[1].y,0);
 const joined=replaceLetteringText(split,'ザーーーーッ','character');assert.equal(joined.lettering.strokes.length,1);assert.equal(joined.lettering.strokes[0].path.points.length,7);
 assert.equal(replaceLetteringText(joined,'ザーッ','character').lettering.strokes[0].mode,'font');assert.equal(replaceLetteringText(joined,'ザッ','character').lettering.strokes.length,0);
});
test('別SFXの文字貼付けは本文に挿入し変形を保持、外観は貼付け先',()=>{
 const source=layer('ドン'),target=layer('ガッ');target.id='sfx2';const g=source.lettering.glyphs[0];g.rotation=25;g.overrides.fill='#ff0000';g.overrides.font='comic';
 const scene={glyphs:source.lettering.glyphs.map(g=>({index:g.index,x:g.index*80,y:0,letter:{size:80}}))};
 const clip=copyLetteringSelection(source,{indices:[0],selected:0},scene),result=pasteLetteringSelection(target,clip,{after:0,position:{x:30,y:15}});
 assert.equal(result.layer.text,'ガドッ');const inserted=result.layer.lettering.glyphs[1];assert.equal(inserted.rotation,25);assert.equal(inserted.overrides.fill,null);assert.deepEqual(inserted.origin,{x:30,y:15});
 const duplicate=duplicateSelectedGlyphs(source,[0,1],scene,{offset:0});assert.equal(duplicate.text,'ドドンン');assert.equal(duplicate.lettering.glyphs[0].inkVariantSeed,duplicate.lettering.glyphs[1].inkVariantSeed);
});
test('縦横の往復は手動位置/回転/倍率と固定端点を保持',()=>{
 const l=layer('ドーーン');l.lettering.glyphs[0].origin={x:12,y:13};l.lettering.glyphs[0].dx=3;l.lettering.glyphs[0].dy=4;l.lettering.glyphs[0].rotation=18;l.lettering.strokes[0].start.fixedPosition={x:21,y:22};
 assert.deepEqual(rotateLetteringOrientation(rotateLetteringOrientation(l,true),false),l);
});
