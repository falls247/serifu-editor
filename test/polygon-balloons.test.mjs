import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,hit} from '../src/renderer.js';
import {balloonOutline,balloonBoundaryPoint,balloonGeometry,balloonHit,randomPolygonCount} from '../src/balloons.js';
import {PROJECT_VERSION,normalizeLayer,scaledCopy,checkpoint,restore} from '../src/model.js';
import {createPreset,applyPreset,normalizePreferences} from '../src/presets.js';
import {projectBlob,readProject} from '../src/project-io.js';

const polygon=changes=>({...newLayer('balloon',800,600),shape:'polygon',shapeSeed:0,w:400,h:240,tail:false,...changes});
const near=(a,b)=>assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1e-8,`${JSON.stringify(a)} != ${JSON.stringify(b)}`);

test('多角形は指定した3〜60個の頂点と直線辺を持ち、描画輪郭と当たり判定が一致する',()=>{
  for(let polygonCount=3;polygonCount<=60;polygonCount++)for(const shapeSeed of [0,1,4294967295])for(const distortion of [0,50,100]){
    const layer=polygon({polygonCount,shapeSeed,distortion}),outline=balloonOutline(layer);
    assert.equal(outline.length,polygonCount+1);assert.deepEqual(outline[0],outline.at(-1));
    assert.equal(balloonHit(layer,{x:0,y:0}),true);
    for(let i=0;i<polygonCount;i++){
      const a=outline[i],b=outline[i+1],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const angle=Math.atan2(mid.y/(layer.h/2),mid.x/(layer.w/2));
      near(balloonBoundaryPoint(layer,angle),mid);
      assert.equal(balloonHit(layer,{x:mid.x*.999,y:mid.y*.999}),true);
      assert.equal(balloonHit(layer,{x:mid.x*1.001,y:mid.y*1.001}),false);
    }
  }
});

test('歪み0の頂点間隔は均等で、seedと歪み度は再現可能な多角形を生成する',()=>{
  const layer=polygon({polygonCount:6,distortion:0}),outline=balloonOutline(layer);
  const normalized=outline.map(p=>({x:p.x/(layer.w/2),y:p.y/(layer.h/2)}));
  for(let i=0;i<6;i++){
    assert.ok(Math.abs(Math.hypot(normalized[i].x,normalized[i].y)-1)<1e-10);
    assert.ok(Math.abs(Math.hypot(normalized[i+1].x-normalized[i].x,normalized[i+1].y-normalized[i].y)-1)<1e-10);
  }
  const distorted=polygon({polygonCount:6,distortion:100});
  assert.notDeepEqual(balloonOutline(distorted),outline);
  assert.deepEqual(balloonOutline(distorted),balloonOutline(JSON.parse(JSON.stringify(distorted))));
  assert.notDeepEqual(balloonOutline(distorted),balloonOutline({...distorted,shapeSeed:1}));
  for(const angle of [-9,-Math.PI,0,.7,Math.PI,12])near(balloonBoundaryPoint(distorted,angle),balloonBoundaryPoint(distorted,angle+Math.PI*4));
});

test('回転した多角形の選択とテールは直線辺の境界を使用する',()=>{
  const layer=polygon({polygonCount:4,distortion:0,x:200,y:200,rotation:90,w:200,h:100});
  assert.equal(hit(layer,200,200),true);assert.equal(hit(layer,249,299),false);
  const tailed={...layer,tail:true,tailAngle:90,tailX:0,tailY:150,tailWidth:20},geometry=balloonGeometry(tailed),outline=balloonOutline(tailed);
  assert.equal(geometry.hasTail,true);assert.deepEqual(outline[0],geometry.a);assert.deepEqual(outline.at(-3),geometry.b);assert.deepEqual(outline.at(-2),geometry.tip);assert.deepEqual(outline.at(-1),geometry.a);
  assert.equal(balloonHit(tailed,{x:0,y:140}),true);assert.equal(balloonHit(layer,{x:0,y:140}),false);
  assert.equal(balloonGeometry({...tailed,tailX:0,tailY:0}).hasTail,false);
  assert.deepEqual(balloonOutline({...tailed,tailX:0,tailY:0}),balloonOutline(layer));
});

test('ランダム頂点数は現在値と異なる3〜60の整数で、UndoとRedoで形状も復元する',()=>{
  for(let current=3;current<=60;current++)for(let i=0;i<20;i++){
    const count=randomPolygonCount(current);assert.ok(Number.isInteger(count)&&count>=3&&count<=60);assert.notEqual(count,current);
  }
  const layer=polygon({polygonCount:6}),page={layers:[layer],selectedId:layer.id,done:false,edited:true,undo:[],redo:[]},before=balloonOutline(layer);
  checkpoint(page);layer.polygonCount=randomPolygonCount(layer.polygonCount);const after=balloonOutline(layer);
  assert.notDeepEqual(after,before);restore(page,'undo');assert.deepEqual(balloonOutline(page.layers[0]),before);restore(page,'redo');assert.deepEqual(balloonOutline(page.layers[0]),after);
});

test('多角形の値を検証し、旧データの頂点数省略を補完し、コピーとプリセットに保持する',()=>{
  const layer=polygon({polygonCount:9,shapeSeed:4321,distortion:72}),normalized=normalizeLayer(layer);
  assert.equal(normalized.shape,'polygon');assert.equal(normalized.polygonCount,9);
  for(const polygonCount of [2,61,3.5,null,NaN,Infinity,'6'])assert.throws(()=>normalizeLayer({...layer,polygonCount}));
  const legacy={...newLayer('balloon',800,600)};delete legacy.polygonCount;
  const restored=normalizeLayer(legacy,14);assert.equal(restored.polygonCount,6);assert.deepEqual(balloonOutline(restored),balloonOutline(legacy));
  const copy=scaledCopy(layer,800,600,400,1200);assert.equal(copy.polygonCount,9);assert.equal(copy.shapeSeed,4321);assert.equal(copy.shape,'polygon');
  const preset=createPreset('多角形9',layer,800,600),prefs=normalizePreferences({version:1,presets:[preset]});
  assert.ok(prefs.presets.some(item=>item.id===preset.id));
  const applied=applyPreset(newLayer('balloon',800,600),preset,800,600);assert.deepEqual(balloonOutline(applied),balloonOutline(layer));
  delete preset.style.polygonCount;const target=polygon({polygonCount:7});applyPreset(target,preset,800,600);assert.equal(target.polygonCount,7);
});

test('JSONと高速編集データは多角形の形状と頂点数を保持する',async()=>{
  const layer=polygon({polygonCount:3,shapeSeed:4294967295,distortion:100,tail:true,tailY:300}),page={name:'polygon.png',src:'data:image/png;base64,aW1hZ2U=',img:{width:800,height:600},file:new Blob(['image'],{type:'image/png'}),layers:[layer],done:false,edited:true};
  for(const format of ['json','serifu']){
    const data=await readProject(await projectBlob([page],{}, {format}));assert.equal(data.version,PROJECT_VERSION);
    const restored=normalizeLayer(data.pages[0].layers[0],data.version);assert.equal(restored.polygonCount,3);assert.equal(restored.shape,'polygon');assert.deepEqual(balloonOutline(restored),balloonOutline(layer));
  }
});
