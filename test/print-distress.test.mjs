import test from 'node:test';
import assert from 'node:assert/strict';
import { inkSeed, printDistressMask } from '../ink.js';

const width=160,height=180;
const source=new Uint8ClampedArray(width*height);
for(let y=45;y<140;y++)for(let x=48;x<110;x++)source[y*width+x]=255;
const mass=a=>a.reduce((sum,v)=>sum+v,0);
const options={size:110,grungeAmount:70,scratchLength:60,scratchAngle:90,spatterAmount:70,seed:inkSeed('ザ:0')};

test('print texture cuts real alpha, retains readable body and scatters only near glyph',()=>{
  const before=new Uint8ClampedArray(source),a=printDistressMask(source,width,height,options);
  assert.deepEqual(source,before);
  assert.ok(mass(a.body)<mass(source),'missing ink is transparent');
  assert.ok(mass(a.body)>mass(source)*.55,'glyph must retain ink mass');
  assert.ok(mass(a.knockout)>0);
  assert.ok(mass(a.speckles)>0,'spatter must attach to glyph');
  assert.ok(a.speckles.every((v,i)=>!v||!source[i]),'external flecks do not overwrite solid body');
  assert.deepEqual(a,printDistressMask(source,width,height,{...options}));
  assert.notDeepEqual(a.body,printDistressMask(source,width,height,{...options,seed:inkSeed('ザ:1')}).body);
});

test('texture zero settings are no-op, and higher grunge strength increases defects',()=>{
  const zero=printDistressMask(source,width,height,{...options,grungeAmount:0,spatterAmount:0});
  assert.deepEqual(zero.body,source);
  assert.equal(mass(zero.knockout),0);assert.equal(mass(zero.speckles),0);
  const weak=printDistressMask(source,width,height,{...options,grungeAmount:20,spatterAmount:0});
  const strong=printDistressMask(source,width,height,{...options,grungeAmount:80,spatterAmount:0});
  assert.ok(mass(strong.body)<mass(weak.body));
  assert.equal(mass(strong.speckles),0);
  const noStreak=printDistressMask(source,width,height,{...options,scratchLength:0});
  assert.notDeepEqual(noStreak.body,strong.body);
});

test('empty glyphs never generate texture and changing scratch axis changes the pattern',()=>{
  const empty=printDistressMask(new Uint8ClampedArray(source.length),width,height,options);
  assert.equal(mass(empty.body)+mass(empty.speckles)+mass(empty.knockout),0);
  const vertical=printDistressMask(source,width,height,options);
  const horizontal=printDistressMask(source,width,height,{...options,scratchAngle:0});
  assert.notDeepEqual(vertical.body,horizontal.body);
});
