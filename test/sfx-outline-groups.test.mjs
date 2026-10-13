import test from 'node:test';
import assert from 'node:assert/strict';
import {unionOuterContour,glyphGroupBounds} from '../src/sfx-outline-groups.js';
test('shared outside outline contains only pixels outside the union mask',()=>{
  const alpha=new Uint8ClampedArray(11*11);
  for(let y=3;y<8;y++)for(let x=2;x<6;x++)alpha[y*11+x]=255;
  for(let y=3;y<8;y++)for(let x=5;x<9;x++)alpha[y*11+x]=255;
  const edge=unionOuterContour(alpha,11,11,2);
  for(let i=0;i<alpha.length;i++)if(alpha[i])assert.equal(edge[i],0);
  assert.ok(edge.some(v=>v>0));
  assert.equal(edge[5*11+5],0,'overlapping interior must have no seam');
});
test('group canvas obeys five megapixel guard',()=>{
  assert.equal(glyphGroupBounds([{x:0,y:0,extent:100},{x:5000,y:5000,extent:100}]),null);
  assert.ok(glyphGroupBounds([{x:0,y:0,extent:100}]).width>0);
});
