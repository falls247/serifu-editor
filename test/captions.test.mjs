import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,hit,paintOrder} from '../renderer.js';
import {captionLayout} from '../captions.js';
import {normalizeLayer,copySelection,pasteSelection,copyLayers,pasteLayers,cutLayers,restore,swapText} from '../model.js';

const page=layers=>({layers,edited:false,done:false,selectedId:layers[0]?.id||null,undo:[],redo:[]});
const context=()=>({font:'',save(){this.saved=this.font;},restore(){this.font=this.saved;},measureText(char){const size=Number(this.font.match(/([\d.]+)px/)[1]),width=size*(/^[\x00-\x7f]+$/.test(char)?.6:1);return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width,actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};}});

test('new captions contain an independent white box, black frame and editable text with fitting off',()=>{
  const layer=newLayer('caption',1000,750);
  assert.equal(layer.text,'');assert.equal(layer.color,'#ffffff');assert.equal(layer.transparency,25);
  assert.equal(layer.borderColor,'#000000');assert.equal(layer.textColor,'#111111');assert.equal(layer.autoFit,false);assert.equal(layer.vertical,true);
  const restored=normalizeLayer(JSON.parse(JSON.stringify(layer)),5);assert.notEqual(restored.id,layer.id);assert.deepEqual({...restored,id:layer.id},layer);
  const rotated={...layer,x:100,y:100,w:200,h:40,rotation:90};assert.equal(hit(rotated,100,180),true);assert.equal(hit(rotated,180,100),false);
});

test('manual caption font size remains fixed when its box changes, and overflow is detectable',()=>{
  const layer={...newLayer('caption',1000,750),text:'あいうえおかきくけこ'.repeat(3),size:40,w:140,h:120,padding:8};
  const small=captionLayout(context(),layer),large=captionLayout(context(),{...layer,w:500,h:500});
  assert.equal(small.size,40);assert.equal(large.size,40);assert.equal(small.fits,false);assert.equal(large.fits,true);assert.equal(layer.size,40);
});

test('automatic fitting finds the largest fitting half-pixel font for vertical and horizontal text',()=>{
  for(const vertical of [true,false]){
    const layer={...newLayer('caption',1000,750),text:'遠くの街へ向かう。\nLONG caption with spaces'.repeat(2),w:260,h:230,padding:14,autoFit:true,vertical,size:40};
    const fitted=captionLayout(context(),layer),larger=captionLayout(context(),{...layer,w:520,h:460});
    assert.equal(fitted.fits,true);assert.ok(fitted.width<=fitted.innerWidth);assert.ok(fitted.height<=fitted.innerHeight);
    assert.ok(larger.size>fitted.size);assert.equal(layer.size,40,'automatic fitting must retain the manual value for switching off');
    assert.equal(captionLayout(context(),layer,fitted.size+.5).fits,false,'the next half-pixel size must exceed the available area');
    assert.equal(fitted.glyphs.length,Array.from(layer.text.replaceAll('\n','')).length);
  }
});

test('caption layout preserves blank lines and grapheme clusters, and handles exhausted content space',()=>{
  const layer={...newLayer('caption',1000,750),text:'あ\u3099\n\nう',vertical:false,w:300,h:300,size:30,padding:5};
  const layout=captionLayout(context(),layer);assert.equal(layout.glyphs.length,2);assert.equal(layout.glyphs[0].char,'あ\u3099');
  assert.ok(layout.glyphs[1].y-layout.glyphs[0].y>layer.size*2);
  const tiny=captionLayout(context(),{...layer,text:'本文が多すぎる'.repeat(10),autoFit:true,w:30,h:30,padding:2000});
  assert.equal(tiny.size,1);assert.equal(tiny.fits,false);assert.ok(Number.isFinite(tiny.innerWidth));assert.ok(Number.isFinite(tiny.height));
});

test('caption validation rejects malformed styles while retaining all existing project versions',()=>{
  const layer={...newLayer('caption',1000,750),autoFit:true,font:'gekifude',text:'ドン！',textColor:'#aa3377'};
  for(const invalid of [{autoFit:'true'},{text:5},{vertical:null},{font:'missing'},{transparency:101},{padding:-1},{borderColor:'black'},{textColor:'pink'},{size:501},{x:NaN},{w:0}])assert.throws(()=>normalizeLayer({...layer,...invalid},5));
  assert.throws(()=>normalizeLayer(layer,4));
  for(const version of [2,3,4,5])assert.equal(normalizeLayer(newLayer('dialogue',1000,750),version).kind,'dialogue');
  assert.equal(normalizeLayer(newLayer('balloon',1000,750),4).kind,'balloon');
  const p=page([layer,newLayer('dialogue',1000,750)]);assert.equal(swapText(p,layer.id,p.layers[1].id),false);assert.equal(p.undo.length,0);
});

test('caption copying across aspect ratios preserves colors, fitting mode and independent text through cut undo',()=>{
  const original={...newLayer('caption',1000,500),text:'遠い街',autoFit:true,font:'hand',textColor:'#aa1155',borderColor:'#2233ff',size:40,padding:12,borderWidth:4};
  const source=page([original]),clipboard=cutLayers(source,1000,500),target=page([]),[copy]=pasteLayers(clipboard,target,500,1000);
  assert.equal(copy.x,original.x*.5);assert.equal(copy.y,original.y*2);assert.equal(copy.w,original.w*.5);assert.equal(copy.h,original.h*2);
  assert.equal(copy.size,20);assert.equal(copy.padding,6);assert.equal(copy.borderWidth,2);assert.equal(copy.textColor,original.textColor);assert.equal(copy.borderColor,original.borderColor);assert.equal(copy.autoFit,true);
  const single=pasteSelection(copySelection(original,1000,500),500,1000,0);assert.deepEqual({...single,id:copy.id},copy);
  assert.doesNotThrow(()=>normalizeLayer(copy,5));copy.text='貼付け先だけ変更';assert.equal(clipboard.layers[0].text,'遠い街');
  restore(source,'undo');assert.deepEqual(source.layers,[original]);restore(source,'redo');assert.equal(source.layers.length,0);
  restore(target,'undo');assert.equal(target.layers.length,0);restore(target,'redo');assert.equal(target.layers[0].text,'貼付け先だけ変更');
  assert.equal(copyLayers([original],1000,500).layers[0].text,'遠い街');
});

test('a front balloon never drops or covers a caption when the layer order changes',()=>{
  const caption={id:'c',kind:'caption'},dialogue={id:'d',kind:'dialogue'},sfx={id:'s',kind:'sfx'},balloon={id:'b',kind:'balloon',sfxOrder:'above'};
  const permutations=items=>items.length?items.flatMap((item,i)=>permutations(items.filter((_,j)=>i!==j)).map(rest=>[item,...rest])):[[]];
  for(const layers of permutations([caption,dialogue,sfx,balloon])){
    const ordered=paintOrder(layers);assert.equal(ordered.length,4);assert.ok(ordered.indexOf(sfx)<ordered.indexOf(balloon));assert.ok(ordered.indexOf(balloon)<ordered.indexOf(caption));assert.ok(ordered.indexOf(balloon)<ordered.indexOf(dialogue));
  }
});
