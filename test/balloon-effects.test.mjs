import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer} from '../renderer.js';
import {balloonBoundaryPoint,balloonHit,balloonSeedFromId} from '../balloons.js';
import {normalizeLayer,scaledCopy} from '../model.js';

test('spiky balloons have reproducible peaks around a roomy text core',()=>{
  const b={...newLayer('balloon',1000,750),shape:'spiky',w:380,h:560,distortion:90,tail:false,shapeSeed:balloonSeedFromId('reference-shape')};
  const radii=Array.from({length:720},(_,index)=>{
    const angle=index*Math.PI/360,p=balloonBoundaryPoint(b,angle);
    return Math.hypot(p.x/(b.w/2),p.y/(b.h/2));
  });
  assert.ok(Math.max(...radii)>1.15,'spikes extend beyond nominal ellipse');
  assert.ok(Math.min(...radii)>.70,'inner core remains large enough for inset dialogue');
  assert.ok(Math.max(...radii)-Math.min(...radii)>.2,'points and valleys must be distinct');
  assert.deepEqual(radii,Array.from({length:720},(_,index)=>{
    const angle=index*Math.PI/360,p=balloonBoundaryPoint(b,angle);
    return Math.hypot(p.x/(b.w/2),p.y/(b.h/2));
  }));
  assert.equal(balloonHit(b,{x:0,y:0}),true);
});

test('legacy balloon style defaults stay off and new styles validate and scale',()=>{
  const original=newLayer('balloon',1000,750),old={...original};
  for(const key of ['shadowEnabled','shadowColor','shadowBlur','shadowOffsetX','shadowOffsetY','shadowOpacity','borderStyle','brushRoughness'])delete old[key];
  const restored=normalizeLayer(old,4);
  assert.equal(restored.shadowEnabled,false);
  assert.equal(restored.borderStyle,'solid');
  const styled={...original,shadowEnabled:true,shadowColor:'#551122',shadowBlur:22,shadowOffsetX:10,shadowOffsetY:-4,shadowOpacity:80,borderStyle:'brush',brushRoughness:72};
  const normalized=normalizeLayer(styled,7);
  for(const key of ['shadowEnabled','shadowColor','shadowBlur','shadowOffsetX','shadowOffsetY','shadowOpacity','borderStyle','brushRoughness'])assert.equal(normalized[key],styled[key]);
  for(const change of [{shadowOpacity:101},{borderStyle:'other'},{shadowColor:'red'},{brushRoughness:NaN},{shadowEnabled:'true'}])assert.throws(()=>normalizeLayer({...styled,...change},7));
  const copy=scaledCopy(styled,1000,750,500,1500);
  assert.equal(copy.shadowBlur,11);assert.equal(copy.shadowOffsetX,5);assert.equal(copy.shadowOffsetY,-8);
  assert.equal(copy.borderStyle,'brush');assert.equal(copy.shadowEnabled,true);
});
