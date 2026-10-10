import test from 'node:test';
import assert from 'node:assert/strict';
import { newLayer,hit,handleAt } from '../renderer.js';
import { balloonGeometry,paintOrder } from '../balloons.js';
import { normalizeLayer,checkpoint,restore,copyLayers,pasteLayers,copySelection,pasteSelection,cutLayers,swapText } from '../model.js';
const page=layers=>({layers,done:false,edited:layers.length>0,selectedId:layers[0]?.id||null,undo:[],redo:[]});

test('new balloons are white at 25% transparency, without a tail, and cross the top and right image edges',()=>{
  const b=newLayer('balloon',300,425);
  assert.equal(b.color,'#ffffff');assert.equal(b.transparency,25);assert.equal(b.tail,false);assert.equal(b.sfxOrder,'behind');
  assert.ok(b.x+b.w/2>300);assert.ok(b.y-b.h/2<0);assert.ok(b.borderWidth>0);
  assert.equal(balloonGeometry(b).hasTail,false);
});

test('ellipse and tail hit testing use rotated shape geometry instead of empty bounding-box corners',()=>{
  const b={...newLayer('balloon',400,400),x:200,y:200,w:200,h:100,rotation:90,tailX:0,tailY:100,tailWidth:30};
  assert.equal(hit(b,200,200),true);assert.equal(hit(b,152,295),false);assert.equal(hit(b,120,200),false);
  b.tail=true;
  assert.equal(balloonGeometry(b).hasTail,true);assert.equal(hit(b,120,200),true);assert.equal(handleAt(b,100,200),'tail');
  b.tailY=20;assert.equal(balloonGeometry(b).hasTail,false,'an inside tip must not carve a hole through the ellipse');
});

test('every drawing order keeps balloons below dialogue and on their configured side of sound effects',()=>{
  const d={id:'dialogue',kind:'dialogue'},s={id:'sfx',kind:'sfx'},back={id:'back',kind:'balloon',sfxOrder:'behind'},front={id:'front',kind:'balloon',sfxOrder:'above'};
  const permutations=items=>items.length?items.flatMap((item,i)=>permutations(items.filter((_,j)=>j!==i)).map(rest=>[item,...rest])):[[]];
  for(const layers of permutations([d,s,back,front])){
    const before=[...layers],ordered=paintOrder(layers);
    assert.ok(ordered.indexOf(back)<ordered.indexOf(s));assert.ok(ordered.indexOf(s)<ordered.indexOf(front));
    assert.ok(ordered.indexOf(back)<ordered.indexOf(d));assert.ok(ordered.indexOf(front)<ordered.indexOf(d));assert.deepEqual(layers,before);
  }
  assert.deepEqual(paintOrder([d,s]),[d,s]);assert.deepEqual(paintOrder([s,d]),[s,d]);
  assert.deepEqual(paintOrder([d,back,s]),[back,d,s],'background balloons must preserve the existing text order');
});

test('balloon projects validate their geometry, colors, transparency and tail settings without becoming dialogue',()=>{
  const original={...newLayer('balloon',1000,750),tail:true,tailX:-50,tailY:440,tailAngle:100,sfxOrder:'above'};
  const restored=normalizeLayer(JSON.parse(JSON.stringify(original)),4);
  assert.notEqual(restored.id,original.id);assert.deepEqual({...restored,id:original.id},original);
  for(const invalid of [{transparency:101},{borderWidth:-1},{tail:'true'},{sfxOrder:'other'},{tailX:NaN},{tailWidth:0},{color:'white'},{w:0},{rotation:181}])assert.throws(()=>normalizeLayer({...original,...invalid},4));
  assert.throws(()=>normalizeLayer(original,3));
  const p=page([original,newLayer('dialogue',1000,750)]);assert.equal(swapText(p,original.id,p.layers[1].id),false);assert.equal(p.undo.length,0);
});

test('balloons copy across aspect ratios with their alpha, layering and tail independently preserved',()=>{
  const b={...newLayer('balloon',1000,500),tail:true,tailX:50,tailY:200,tailWidth:80,borderWidth:3,transparency:40,sfxOrder:'above'};
  const target=page([]),clipboard=copyLayers([b,newLayer('dialogue',1000,500)],1000,500);
  const [copy]=pasteLayers(clipboard,target,500,1000);
  assert.equal(copy.x,b.x*.5);assert.equal(copy.y,b.y*2);assert.equal(copy.w,b.w*.5);assert.equal(copy.h,b.h*2);
  assert.equal(copy.tailX,25);assert.equal(copy.tailY,400);assert.equal(copy.tailWidth,40);assert.equal(copy.borderWidth,1.5);
  assert.equal(copy.transparency,40);assert.equal(copy.sfxOrder,'above');assert.notEqual(copy.id,b.id);
  const single=pasteSelection(copySelection(b,1000,500),500,1000,0);assert.deepEqual({...single,id:copy.id},copy);
  copy.tailY=800;assert.equal(clipboard.layers[0].tailY,200);assert.equal(b.tailY,200);
  assert.doesNotThrow(()=>normalizeLayer(copy,4));
});

test('edited status follows visual edits and undo, while a confirmed empty image stays unedited',()=>{
  const p=page([]);p.done=true;assert.equal(p.edited,false);
  checkpoint(p);p.layers.push(newLayer('balloon',1000,750));assert.equal(p.edited,true);
  restore(p,'undo');assert.equal(p.layers.length,0);assert.equal(p.edited,false);assert.equal(p.done,true);
  restore(p,'redo');assert.equal(p.layers.length,1);assert.equal(p.edited,true);
  cutLayers(p,1000,750);assert.equal(p.layers.length,0);assert.equal(p.edited,true,'removing authored overlays is also an edit');
  restore(p,'undo');assert.equal(p.layers.length,1);assert.equal(p.edited,true);
});
