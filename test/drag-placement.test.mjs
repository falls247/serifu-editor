import test from 'node:test';
import assert from 'node:assert/strict';
import { dragPlacement, duplicateLayer, checkpoint, restore } from '../src/model.js';

test('drag placement preserves the pointer offset and rounds to source pixels', () => {
  const start={x:250,y:300},anchor={x:270,y:319};
  assert.deepEqual(dragPlacement(start,{x:315.7,y:275.9},anchor),{x:296,y:257,axis:null});
  assert.deepEqual(start,{x:250,y:300},'the source object must not be mutated');
});

test('Ctrl+Shift drag chooses the horizontal or vertical axis for all four directions',()=>{
  const start={x:250,y:300},anchor={x:265,y:320};
  for(const [delta,expected] of [
    [{x:80,y:12},{x:330,y:300,axis:'horizontal'}],
    [{x:-80,y:12},{x:170,y:300,axis:'horizontal'}],
    [{x:12,y:-80},{x:250,y:220,axis:'vertical'}],
    [{x:-12,y:80},{x:250,y:380,axis:'vertical'}],
  ])assert.deepEqual(dragPlacement(start,{x:anchor.x+delta.x,y:anchor.y+delta.y},anchor,true),expected);
});

test('constrained placement can change axes as the pointer changes direction',()=>{
  const s={x:100,y:200},a={x:100,y:200};
  assert.deepEqual(dragPlacement(s,{x:80,y:220},a,true),{x:80,y:200,axis:'horizontal'},'ties prefer horizontal');
  assert.deepEqual(dragPlacement(s,{x:95,y:270},a,true),{x:100,y:270,axis:'vertical'});
  assert.deepEqual(dragPlacement(s,{x:95,y:270},a,false),{x:95,y:270,axis:null},'releasing Shift removes the axis lock');
  assert.deepEqual(dragPlacement(s,a,a,true),{x:100,y:200,axis:'horizontal'},'no movement must not trigger a duplicate');
});

test('a preview duplicate retains style, owns a new ID and is a single undoable edit',()=>{
  const original={id:crypto.randomUUID(),kind:'sfx',x:100,y:200,w:200,h:160,text:'ドン',effect:'taper',brushSeed:123,rotation:27};
  const page={layers:[original],done:true,edited:false,selectedId:original.id,undo:[],redo:[]};
  const next=dragPlacement(original,{x:150,y:207},{x:100,y:200},true);
  checkpoint(page);
  const copy=duplicateLayer(original);copy.x=next.x;copy.y=next.y;page.layers.push(copy);page.selectedId=copy.id;
  assert.notEqual(copy.id,original.id);
  assert.deepEqual({...copy,id:original.id,x:original.x,y:original.y},original);
  assert.equal(page.layers[0].x,100);
  assert.equal(page.undo.length,1);
  assert.equal(restore(page,'undo'),true);assert.equal(page.layers.length,1);assert.equal(page.done,true);
  assert.equal(restore(page,'redo'),true);assert.equal(page.layers.length,2);
});
