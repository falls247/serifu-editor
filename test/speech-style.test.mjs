import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,dialogueColor} from '../renderer.js';
import {normalizeLayer,scaledCopy,checkpoint,restore} from '../model.js';
import {createPreset,applyPreset,normalizePreferences,defaultPreferences} from '../presets.js';
import {balloonBoundaryPoint,defaultSpikeCount} from '../balloons.js';

test('speech colors and zero outlines validate, survive copies, presets and undo',()=>{
  for(const kind of ['dialogue','balloon']){
    const original={...newLayer(kind,1000,750,'female'),text:'指定色のセリフ',textColor:'#2468aa',textOutlineColor:'#cc3300',outline:0};
    const restored=normalizeLayer(JSON.parse(JSON.stringify(original)));
    assert.equal(restored.textColor,original.textColor);assert.equal(restored.textOutlineColor,original.textOutlineColor);assert.equal(restored.outline,0);
    const copy=scaledCopy(restored,1000,750,500,1000);
    assert.equal(copy.textColor,original.textColor);assert.equal(copy.textOutlineColor,original.textOutlineColor);assert.equal(copy.outline,0);
    const preset=createPreset('文字色',original,1000,750),target=applyPreset(newLayer(kind,2000,1500),preset,2000,1500);
    assert.equal(target.textColor,original.textColor);assert.equal(target.textOutlineColor,original.textOutlineColor);assert.equal(target.outline,0);
    assert.equal(dialogueColor({...target,speaker:'female'}),original.textColor);
    const page={layers:[original],done:false,edited:false,undo:[],redo:[],selectedId:original.id};checkpoint(page);original.textOutlineColor='#123456';
    restore(page,'undo');assert.equal(page.layers[0].textOutlineColor,'#cc3300');restore(page,'redo');assert.equal(page.layers[0].textOutlineColor,'#123456');
    for(const change of [{textColor:'red'},{textColor:['#ffffff']},{textOutlineColor:null},{textOutlineColor:'#bad'},{outline:-1},{outline:81}])assert.throws(()=>normalizeLayer({...original,...change}));
  }
});

test('missing speech colors follow the speaker and older presets preserve new settings',()=>{
  for(const kind of ['dialogue','balloon']){
    const old=newLayer(kind,1000,750,'female');delete old.textColor;delete old.textOutlineColor;
    const restored=normalizeLayer(old,7);assert.equal(restored.textColor,null);assert.equal(restored.textOutlineColor,'#ffffff');assert.equal(dialogueColor(restored),'#ef4b91');
    restored.speaker='male';assert.equal(dialogueColor(restored),'#111111');
    const preset=createPreset('旧書式',restored,1000,750);delete preset.style.textColor;delete preset.style.textOutlineColor;
    restored.textColor='#13579b';restored.textOutlineColor='#abcdef';applyPreset(restored,preset,1000,750);
    assert.equal(restored.textColor,'#13579b');assert.equal(restored.textOutlineColor,'#abcdef');
  }
});

test('spike count changes the number of visible tips and seed changes both balloon shapes',()=>{
  const layer={...newLayer('balloon',1000,750),shapeSeed:0,w:2,h:2,distortion:85,shape:'spiky'};
  for(const spikeCount of [6,12,24,60]){
    const b={...layer,spikeCount},count=16384,radii=Array.from({length:count},(_,i)=>{const p=balloonBoundaryPoint(b,i*Math.PI*2/count);return Math.hypot(p.x,p.y);});
    const peaks=radii.filter((r,i)=>r>radii[(i+count-1)%count]&&r>radii[(i+1)%count]);
    assert.equal(peaks.length,spikeCount);
    assert.ok(radii.every(radius=>Number.isFinite(radius)&&radius>0));
  }
  for(const shape of ['spiky','distorted-rect']){
    const b={...layer,shape},first=balloonBoundaryPoint(b,.4);assert.deepEqual(first,balloonBoundaryPoint(b,.4));
    const next=balloonBoundaryPoint({...b,shapeSeed:1},.4);assert.ok(Math.hypot(first.x-next.x,first.y-next.y)>.01);
  }
});

test('balloon shape settings round-trip including seed zero and legacy tip count',()=>{
  const original={...newLayer('balloon',1000,750),shape:'spiky',shapeSeed:0,spikeCount:24};
  const restored=normalizeLayer(JSON.parse(JSON.stringify(original))),copy=scaledCopy(restored,1000,750,500,1000);
  for(const layer of [restored,copy]){assert.equal(layer.shapeSeed,0);assert.equal(layer.spikeCount,24);}
  const preset=createPreset('尖り24',original,1000,750),prefs=defaultPreferences();prefs.presets.push(preset);
  const remembered=normalizePreferences(JSON.parse(JSON.stringify(prefs))).presets.find(p=>p.id===preset.id);
  const target=applyPreset(newLayer('balloon',2000,1500),remembered,2000,1500);assert.equal(target.shapeSeed,0);assert.equal(target.spikeCount,24);
  delete original.spikeCount;assert.equal(normalizeLayer(original,7).spikeCount,defaultSpikeCount(0));
  for(const change of [{shapeSeed:-1},{shapeSeed:4294967296},{shapeSeed:.5},{spikeCount:5},{spikeCount:61},{spikeCount:12.5},{spikeCount:null}])assert.throws(()=>normalizeLayer({...original,...change}));
});
