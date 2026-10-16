import test from 'node:test';
import assert from 'node:assert/strict';
import {startLettering} from '../src/sfx-lettering-model.js';
import {strokeGeometry,strokeFrame} from '../src/sfx-stroke-geometry.js';
import {transformStrokeSelection} from '../src/sfx-edit-operations.js';
import {nearestStrokeHandle} from '../src/sfx-editor.js';

const transformPoint=(point,{center,dx=0,dy=0,rotation=0,scaleX=1,scaleY=1})=>{
  const angle=rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),x=(point.x-center.x)*scaleX,y=(point.y-center.y)*scaleY;
  return {x:center.x+x*c-y*s+dx,y:center.y+x*s+y*c+dy};
};

test('長音BOX変形は曲線・線幅・端点を同じaffine変換で保持する',()=>{
  const layer={id:'stroke-transform',kind:'sfx',text:'ザーーッ',size:80,w:800,h:600,vertical:false,glyphSeed:2,textureSeed:3};
  layer.lettering=startLettering(layer);
  const run=layer.lettering.strokes[0];
  run.shape='custom';
  run.path.points=[{x:0,y:0},{x:.25,y:.48},{x:.75,y:-.36},{x:1,y:0}];
  run.start={...run.start,detached:true,fixedPosition:{x:10,y:20},cap:'flat',length:0};
  run.end={...run.end,detached:true,fixedPosition:{x:190,y:45},cap:'flat',length:0};
  run.widths=[{t:0,w:12,interpolation:'smooth'},{t:.5,w:30,interpolation:'smooth',fixed:true,distance:90},{t:1,w:18,interpolation:'smooth'}];
  run.manualLengthLocked=true;run.lockedLength=185;
  const positions=new Map([[0,{x:-70,y:0}],[1,{x:0,y:0}],[2,{x:120,y:0}],[3,{x:220,y:0}]]),scene={positions};
  const before=strokeGeometry(run,positions,{vertical:false,size:layer.size,samples:128});
  const original=structuredClone(run),transform={center:{x:95,y:30},dx:7,dy:-11,rotation:31,scaleX:1.4,scaleY:.72};
  transformStrokeSelection(layer,[run.runStart],scene,transform);
  const afterRun=layer.lettering.strokes[0],after=strokeGeometry(afterRun,positions,{vertical:false,size:layer.size,samples:128});

  assert.equal(afterRun.shape,'custom');
  assert.equal(afterRun.start.detached,true);assert.equal(afterRun.end.detached,true);
  assert.deepEqual(afterRun.start.fixedPosition,transformPoint(original.start.fixedPosition,transform));
  assert.deepEqual(afterRun.end.fixedPosition,transformPoint(original.end.fixedPosition,transform));
  assert.ok(after.every((point,i)=>{
    const expected=transformPoint(before[i],transform);
    return Math.hypot(point.x-expected.x,point.y-expected.y)<1e-6;
  }),'every sampled centerline coordinate follows affine transform');

  const ratio=Math.hypot((afterRun.end.fixedPosition.x-afterRun.start.fixedPosition.x),(afterRun.end.fixedPosition.y-afterRun.start.fixedPosition.y))/Math.hypot(180,25);
  assert.ok(Math.abs(afterRun.lockedLength-original.lockedLength*ratio)<1e-8);
  assert.ok(Math.abs(afterRun.widths[1].distance-original.widths[1].distance*ratio)<1e-8);
  for(const knot of original.widths){
    const i=Math.round(knot.t*(before.length-1)),a=before[Math.max(0,i-1)],b=before[Math.min(before.length-1,i+1)],length=Math.hypot(b.x-a.x,b.y-a.y)||1;
    const nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length,expected=knot.w*Math.hypot(transform.scaleX*nx,transform.scaleY*ny);
    const afterKnot=afterRun.widths.find(candidate=>candidate.t===knot.t);
    assert.ok(Math.abs(afterKnot.w-expected)<.02,`width at t=${knot.t} scales along local normal`);
  }
});

test('長音の平行移動は形状・線幅を変えず端点だけを移す',()=>{
  const layer={id:'stroke-move',kind:'sfx',text:'ザーーッ',size:80,w:800,h:600,vertical:false,glyphSeed:2,textureSeed:3};
  layer.lettering=startLettering(layer);const run=layer.lettering.strokes[0];run.shape='wave';
  const positions=new Map([[0,{x:-70,y:0}],[1,{x:0,y:0}],[2,{x:120,y:0}],[3,{x:220,y:0}]]),scene={positions};
  const oldPath=structuredClone(run.path),oldWidths=structuredClone(run.widths),frame=strokeFrame(run,positions,{vertical:false,size:layer.size});
  transformStrokeSelection(layer,[run.runStart],scene,{dx:14,dy:-9});
  assert.equal(run.shape,'wave');assert.deepEqual(run.path,oldPath);assert.deepEqual(run.widths,oldWidths);
  assert.equal(run.start.detached,true);assert.equal(run.end.detached,true);
  assert.ok(Math.abs(run.start.fixedPosition.x-(frame.start.x+14))<1e-8&&Math.abs(run.start.fixedPosition.y-(frame.start.y-9))<1e-8);
  assert.ok(Math.abs(run.end.fixedPosition.x-(frame.end.x+14))<1e-8&&Math.abs(run.end.fixedPosition.y-(frame.end.y-9))<1e-8);
});

test('縦書きの曲線長音もBOX回転・異方拡縮に追従する',()=>{
  const layer={id:'vertical-stroke',kind:'sfx',text:'ザーーッ',size:80,w:800,h:600,vertical:true,glyphSeed:2,textureSeed:3};
  layer.lettering=startLettering(layer);const run=layer.lettering.strokes[0];
  run.path.points=[{x:0,y:0},{x:.35,y:.42},{x:.72,y:-.28},{x:1,y:0}];
  run.start={...run.start,detached:true,fixedPosition:{x:36,y:18},cap:'flat',length:0};
  run.end={...run.end,detached:true,fixedPosition:{x:52,y:218},cap:'flat',length:0};
  const positions=new Map([[0,{x:0,y:-80}],[1,{x:30,y:0}],[2,{x:45,y:120}],[3,{x:80,y:250}]]),scene={positions};
  const before=strokeGeometry(run,positions,{vertical:true,size:layer.size,samples:128}),transform={center:{x:46,y:120},dx:-4,dy:8,rotation:-19,scaleX:.86,scaleY:1.22};
  transformStrokeSelection(layer,[run.runStart],scene,transform);
  const after=strokeGeometry(run,positions,{vertical:true,size:layer.size,samples:128});
  assert.ok(after.every((point,i)=>{const expected=transformPoint(before[i],transform);return Math.hypot(point.x-expected.x,point.y-expected.y)<1e-6;}));
});

test('近接するstrokeハンドルはヒット半径内の最寄りを選ぶ',()=>{
  const handles=[{kind:'curve',index:1,x:10,y:0},{kind:'width',index:0,x:4,y:0}];
  assert.equal(nearestStrokeHandle(handles,{x:3,y:0},10),handles[1]);
  assert.equal(nearestStrokeHandle(handles,{x:0,y:0},3),null);
});
