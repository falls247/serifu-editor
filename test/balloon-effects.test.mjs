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

test('spiky tips have irregular spacing and length and every connecting curve bends inward',()=>{
  const b={...newLayer('balloon',1000,750),shape:'spiky',w:380,h:560,distortion:90,tail:false,shapeSeed:balloonSeedFromId('reference-shape')};
  const count=4096,points=Array.from({length:count},(_,index)=>{
    const p=balloonBoundaryPoint(b,index*Math.PI*2/count);return {x:p.x/(b.w/2),y:p.y/(b.h/2)};
  }),radii=points.map(p=>Math.hypot(p.x,p.y));
  const peaks=radii.flatMap((radius,index)=>radius>radii[(index+count-1)%count]&&radius>radii[(index+1)%count]?[index]:[]);
  assert.ok(peaks.length>=10&&peaks.length<=14);
  const gaps=peaks.map((index,i)=>(peaks[(i+1)%peaks.length]-index+count)%count);
  assert.ok(Math.max(...gaps)/Math.min(...gaps)>1.5,'tip spacing must be visibly irregular');
  assert.ok(Math.max(...peaks.map(i=>radii[i]))-Math.min(...peaks.map(i=>radii[i]))>.08,'tip lengths must vary');
  for(let i=0;i<peaks.length;i++){
    const a=points[peaks[i]],b=points[peaks[(i+1)%peaks.length]],mid=points[(peaks[i]+Math.floor(gaps[i]/2))%count];
    const inward=((b.x-a.x)*(mid.y-a.y)-(b.y-a.y)*(mid.x-a.x))/Math.hypot(b.x-a.x,b.y-a.y);
    assert.ok(inward>.08,'curve midpoint must lie inward of its tip-to-tip chord');
  }
  assert.notDeepEqual(balloonBoundaryPoint(b,.4),balloonBoundaryPoint({...b,shapeSeed:(b.shapeSeed+1)>>>0},.4));
  for(const shapeSeed of [0,1,b.shapeSeed,4294967295])for(const distortion of [0,50,100]){
    const layer={...b,shapeSeed,distortion};
    for(let i=0;i<360;i++){
      const angle=i*Math.PI/180,p=balloonBoundaryPoint(layer,angle),radius=Math.hypot(p.x/(b.w/2),p.y/(b.h/2));
      assert.ok(Number.isFinite(radius)&&radius>.7);
      assert.equal(balloonHit(layer,{x:p.x*.99,y:p.y*.99}),true);
      assert.equal(balloonHit(layer,{x:p.x*1.01,y:p.y*1.01}),false);
    }
  }
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
