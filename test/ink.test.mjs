import test from 'node:test';
import assert from 'node:assert/strict';
import { directionalBlur, distressMask, dilateMask, inkSeed, adjustInkThickness, glyphVariation } from '../src/ink.js';

function legacyExtremeMask(source,width,height,radius,expand) {
  radius=Math.ceil(radius);if(!radius)return new Uint8ClampedArray(source);
  let input=source;
  for(const vertical of [false,true]){
    const out=new Uint8ClampedArray(input.length),length=vertical?height:width,lines=vertical?width:height,stride=vertical?width:1,queue=new Int32Array(length);
    for(let line=0;line<lines;line++){
      const start=vertical?line:line*width;let head=0,tail=0,next=0;
      for(let k=0;k<length;k++){
        while(next<length&&next<=k+radius){
          while(tail>head&&(expand?input[start+queue[tail-1]*stride]<=input[start+next*stride]:input[start+queue[tail-1]*stride]>=input[start+next*stride]))tail--;
          queue[tail++]=next++;
        }
        while(tail>head&&queue[head]<k-radius)head++;
        out[start+k*stride]=!expand&&(k<radius||k>=length-radius)?0:input[start+queue[head]*stride];
      }
    }
    input=out;
  }
  return input;
}

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
test('cropped morphology preserves full-canvas dilation and ink-thickness pixels',()=>{
  let seed=123456789;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;};
  for(const [width,height] of [[1,11],[8,7],[29,18],[101,5]]){
    for(let sample=0;sample<4;sample++){
      const source=new Uint8ClampedArray(width*height);
      for(let i=0;i<source.length;i++)source[i]=random()<((sample+1)*29)?random():0;
      for(const radius of [0,.1,1,2.8,12]){
        assert.deepEqual(dilateMask(source,width,height,radius),legacyExtremeMask(source,width,height,radius,true),`dilation ${width}x${height} r=${radius}`);
      }
      for(const amount of [-5,-1.5,-.25,0,.25,1.5,5]){
        const whole=Math.floor(Math.abs(amount)),fraction=Math.abs(amount)-whole,expand=amount>=0;
        const base=legacyExtremeMask(source,width,height,whole,expand);
        if(!fraction)assert.deepEqual(adjustInkThickness(source,width,height,amount),base,`thickness ${width}x${height} a=${amount}`);
        else{
          const next=legacyExtremeMask(source,width,height,whole+1,expand);
          for(let i=0;i<base.length;i++)base[i]=base[i]*(1-fraction)+next[i]*fraction;
          assert.deepEqual(adjustInkThickness(source,width,height,amount),base,`thickness ${width}x${height} a=${amount}`);
        }
      }
    }
  }
});
test('numeric ink thickness expands and erodes the body, including fractional values, without moving it',()=>{
  const width=21,height=21,source=new Uint8ClampedArray(width*height);
  for(let y=7;y<=13;y++)for(let x=7;x<=13;x++)source[y*width+x]=255;
  const mass=alpha=>alpha.reduce((sum,v)=>sum+v,0);
  const thin=adjustInkThickness(source,width,height,-1),thick=adjustInkThickness(source,width,height,1),half=adjustInkThickness(source,width,height,.5);
  assert.equal(mass(thin),25*255);assert.equal(mass(thick),81*255);assert.ok(mass(source)<mass(half)&&mass(half)<mass(thick));
  assert.equal(thin[10*width+10],255);assert.equal(thick[0],0);assert.equal(source[7*width+7],255);
  assert.deepEqual(adjustInkThickness(source,width,height,0),source);
  assert.ok(adjustInkThickness(new Uint8ClampedArray(source.length),width,height,30).every(v=>v===0));
  const full=new Uint8ClampedArray(25).fill(255),eroded=adjustInkThickness(full,5,5,-1);
  assert.equal(eroded[0],0);assert.equal(eroded[12],255,'erosion must treat pixels beyond the surface as transparent');
});
test('handwritten variation is bounded per letter, independent in each control, and repeatable',()=>{
  const seed=123456,values=Array.from({length:50},(_,i)=>glyphVariation(seed,i,5,3));
  for(const value of values){assert.ok(value.scale>=.95&&value.scale<=1.05);assert.ok(value.shift>=-.03&&value.shift<=.03);}
  assert.ok(values.some(v=>v.scale<1)&&values.some(v=>v.scale>1),'letters must vary both above and below the base size');
  assert.ok(values.some(v=>v.shift<0)&&values.some(v=>v.shift>0),'letters must shift in both horizontal directions');
  assert.deepEqual(values,Array.from({length:50},(_,i)=>glyphVariation(seed,i,5,3)));
  assert.notDeepEqual(values,Array.from({length:50},(_,i)=>glyphVariation(seed+1,i,5,3)));
  assert.deepEqual(glyphVariation(seed,4,0,0),{scale:1,shift:0});
  assert.equal(glyphVariation(seed,4,5,0).scale,values[4].scale);assert.equal(glyphVariation(seed,4,0,3).shift,values[4].shift);
});
