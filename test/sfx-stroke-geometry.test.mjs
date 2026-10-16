import test from 'node:test';
import assert from 'node:assert/strict';
import {bezierPoint,strokeGeometry,strokePolygon,strokeBounds} from '../src/sfx-stroke-geometry.js';
import {defaultStroke} from '../src/sfx-lettering-model.js';
test('S字・テーパ輪郭は有限な座標と非ゼロ長を返す',()=>{
  const stroke=defaultStroke(1,4,80);stroke.path.points=[{x:0,y:0},{x:.3,y:.4},{x:.7,y:-.4},{x:1,y:0}];
  const p=strokeGeometry(stroke,new Map([[0,{x:0,y:0,size:80}],[1,{x:70,y:0}],[4,{x:260,y:0}],[5,{x:330,y:0,size:80}]]),{size:80});
  const polygon=strokePolygon(p),bounds=strokeBounds(polygon);
  assert.equal(p.length,41);assert.ok(bounds.maxX-bounds.minX>100);assert.ok(bounds.maxY-bounds.minY>20);
  assert.ok(polygon.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y)));
  assert.deepEqual(bezierPoint(stroke.path.points,0),{x:0,y:0});
});
test('幅制御点のstepとtaperは左端/右端の太さを制御',()=>{
  const s=defaultStroke(0,2,50);s.start.cap='taper';s.end.cap='taper';
  const p=strokeGeometry(s,new Map([[0,{x:0,y:0}],[1,{x:80,y:0}]]),{size:50});
  assert.equal(p[0].w,0);assert.equal(p.at(-1).w,0);assert.ok(p[20].w>0);
});
test('長音の幅は文字サイズと線ごとの倍率に追従',()=>{
  const s=defaultStroke(0,2,40),positions=new Map([[0,{x:0,y:0}],[1,{x:80,y:0}]]);
  s.widths=[{t:0,w:12,interpolation:'linear'},{t:1,w:8,interpolation:'linear'}];
  assert.equal(strokeGeometry(s,positions,{size:40})[0].w,12);
  assert.equal(strokeGeometry(s,positions,{size:80})[0].w,24);
  s.widthMultiplier=2;
  assert.equal(strokeGeometry(s,positions,{size:80})[0].w,48);
});
