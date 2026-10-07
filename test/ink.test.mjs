import test from 'node:test';
import assert from 'node:assert/strict';
import { directionalBlur, distressMask, dilateMask, inkSeed } from '../ink.js';

test('vertical blur spreads ink only vertically and preserves left-right edges',()=>{
  const width=81,height=81,source=new Uint8ClampedArray(width*height);
  for(let y=38;y<=42;y++)for(let x=38;x<=42;x++)source[y*width+x]=255;
  const vertical=directionalBlur(source,width,height,0,10),horizontal=directionalBlur(source,width,height,10,0);
  assert.ok(vertical[24*width+40]>0);
  assert.equal(vertical[40*width+24],0);
  assert.ok(horizontal[40*width+24]>0);
  assert.equal(horizontal[24*width+40],0);
  assert.deepEqual(directionalBlur(source,width,height,0,0),source);
});
test('dry brush removes ink, extends actual tips and remains deterministic after restoration',()=>{
  const width=140,height=180,source=new Uint8ClampedArray(width*height);
  for(let y=55;y<=120;y++)for(let x=56;x<=68;x++)source[y*width+x]=255;
  const settings={size:100,roughness:60,dryInk:90,brushTails:80,seed:inkSeed('ゾワッ')};
  const first=distressMask(source,width,height,settings),restored=distressMask(source,width,height,JSON.parse(JSON.stringify(settings)));
  assert.deepEqual(first,restored);
  assert.ok(first.some((value,index)=>source[index]>0&&value<source[index]),'texture must cut actual letter ink');
  assert.ok(first.some((value,index)=>value>0&&(Math.floor(index/width)<55||Math.floor(index/width)>120)),'tapered tips must extend the silhouette');
  assert.ok(first.reduce((sum,v)=>sum+v,0)>source.reduce((sum,v)=>sum+v,0)*.35,'letter body must remain visible');
  assert.equal(source[80*width+62],255,'source must stay unmodified');
  assert.ok(distressMask(new Uint8ClampedArray(source.length),width,height,settings).every(v=>v===0),'whitespace must not acquire random marks');
});
test('white keyline dilation does not fill the entire glyph surface',()=>{
  const source=new Uint8ClampedArray(49);source[24]=255;
  const edge=dilateMask(source,7,7,1);
  assert.equal(edge.filter(v=>v===255).length,9);
  assert.equal(edge[0],0);assert.equal(edge[24],255);
});
