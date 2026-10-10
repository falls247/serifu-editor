import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,textGlyphs} from '../renderer.js';
import {captionLayout} from '../captions.js';
import {normalizeLayer,scaledCopy,checkpoint,restore} from '../model.js';
import {createPreset,applyPreset,defaultPreferences,normalizePreferences} from '../presets.js';

const context=()=>({font:'',save(){},restore(){},measureText(){
  const size=Number(this.font.match(/([\d.]+)px/)[1]);
  return {width:size,actualBoundingBoxLeft:0,actualBoundingBoxRight:size,actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};
}});
const layout=layer=>layer.kind==='caption'?captionLayout(context(),layer):{glyphs:textGlyphs(context(),layer)};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('吹き出しは枠の内側全体で折り返し、余白を増やすと改行が早まる',()=>{
  const layer={...newLayer('balloon',1000,750),w:140,h:140,size:20,borderWidth:0,outline:0,text:'あいうえおか',vertical:true};
  const full=textGlyphs(context(),layer);
  assert.equal(new Set(full.map(g=>g.x)).size,1,'6文字（134.4px）は140pxの高さに収まる');
  assert.equal(new Set(textGlyphs(context(),{...layer,padding:10}).map(g=>g.x)).size,2);
  const horizontal={...layer,vertical:false,text:'あいうえおかき'};
  assert.equal(new Set(textGlyphs(context(),horizontal).map(g=>g.y)).size,1,'7文字（140px）は140pxの幅に収まる');
  assert.equal(new Set(textGlyphs(context(),{...horizontal,padding:10}).map(g=>g.y)).size,2);
  assert.equal(new Set(textGlyphs(context(),{...horizontal,borderWidth:4,outline:2}).map(g=>g.y)).size,2,'枠線と文字輪郭の余地を確保する');
  const explicit=textGlyphs(context(),{...layer,text:'あい\nうえ'});
  assert.equal(new Set(explicit.map(g=>g.x)).size,2,'本文に入力した改行を保持する');
});

test('吹き出しの上付きは縦書き・横書きとも1行から効く',()=>{
  const layer={...newLayer('balloon',1000,750),w:140,h:140,size:20,borderWidth:0,outline:0,text:'あ'};
  for(const vertical of [true,false]){
    const top=textGlyphs(context(),{...layer,vertical})[0],center=textGlyphs(context(),{...layer,vertical,lineAlign:'center'})[0];
    assert.ok(top.y<-50);near(center.y,0);
  }
});

test('正負の文字位置調整は改行・文字サイズ・揃え方を保って本文だけ移動する',()=>{
  for(const kind of ['balloon','caption'])for(const vertical of [true,false])for(const autoFit of [true,false]){
    const layer={...newLayer(kind,1000,750),text:'位置調整の本文\n二行目',size:32,w:170,h:210,vertical,autoFit,padding:8,alignX:'right',alignY:'bottom'};
    const original=layout(layer);
    for(const [textOffsetX,textOffsetY] of [[23.5,-17],[-23.5,17]]){
      const shifted=layout({...layer,textOffsetX,textOffsetY});
      assert.equal(shifted.size,original.size);assert.equal(shifted.fits,original.fits);assert.equal(shifted.glyphs.length,original.glyphs.length);
      original.glyphs.forEach((glyph,i)=>{assert.equal(shifted.glyphs[i].char,glyph.char);near(shifted.glyphs[i].x,glyph.x+textOffsetX);near(shifted.glyphs[i].y,glyph.y+textOffsetY);});
    }
  }
});

test('新規・旧データでは文字位置0、保存値と不正値の検証に対応する',()=>{
  for(const kind of ['balloon','caption']){
    const layer=newLayer(kind,1000,750);assert.equal(layer.textOffsetX,0);assert.equal(layer.textOffsetY,0);
    const original={...layer,textOffsetX:-23.5,textOffsetY:17.25,padding:12.5};
    const restored=normalizeLayer(JSON.parse(JSON.stringify(original)));assert.deepEqual({...restored,id:original.id},original);
    const legacy={...original};delete legacy.textOffsetX;delete legacy.textOffsetY;if(kind==='balloon')delete legacy.padding;
    const normalized=normalizeLayer(legacy,kind==='balloon'?4:5);assert.equal(normalized.textOffsetX,0);assert.equal(normalized.textOffsetY,0);if(kind==='balloon')assert.equal(normalized.padding,0);
    for(const field of ['textOffsetX','textOffsetY']){
      for(const value of [-30000,30000])assert.equal(normalizeLayer({...layer,[field]:value})[field],value);
      for(const value of [-30001,30001,NaN,Infinity,null,'1'])assert.throws(()=>normalizeLayer({...layer,[field]:value}));
    }
    for(const padding of [-1,2001,NaN])assert.throws(()=>normalizeLayer({...layer,padding}));
  }
});

test('文字位置をコピー・プリセットで各軸の画像寸法に合わせ、旧プリセットも読める',()=>{
  for(const kind of ['balloon','caption']){
    const original={...newLayer(kind,1000,500),textOffsetX:-40.5,textOffsetY:30.25,padding:12.5};
    const copy=scaledCopy(original,1000,500,500,1000);assert.equal(copy.textOffsetX,-20.25);assert.equal(copy.textOffsetY,60.5);assert.equal(copy.padding,6.25);
    const preset=createPreset('文字位置',original,1000,500),prefs=defaultPreferences();prefs.presets.push(preset);
    const saved=normalizePreferences(JSON.parse(JSON.stringify(prefs))).presets.find(p=>p.id===preset.id);assert.ok(saved);
    const target=newLayer(kind,500,1000);applyPreset(target,saved,500,1000);assert.equal(target.textOffsetX,copy.textOffsetX);assert.equal(target.textOffsetY,copy.textOffsetY);assert.equal(target.padding,original.padding,'余白プリセットは画像の短辺に対する比率を使う');
    delete preset.style.textOffsetXRatio;delete preset.style.textOffsetYRatio;if(kind==='balloon')delete preset.style.paddingRatio;
    applyPreset(target,preset,500,1000);assert.equal(target.textOffsetX,copy.textOffsetX);assert.equal(target.textOffsetY,copy.textOffsetY);if(kind==='balloon')assert.equal(target.padding,original.padding);
    const bounded=scaledCopy({...original,textOffsetX:30000,textOffsetY:-30000},1000,500,2000,1000);assert.equal(bounded.textOffsetX,30000);assert.equal(bounded.textOffsetY,-30000);
  }
});

test('文字位置と余白はUndo・Redoで復元する',()=>{
  for(const kind of ['balloon','caption']){
    const layer=newLayer(kind,1000,750),page={layers:[layer],undo:[],redo:[],done:false,selectedId:layer.id};
    checkpoint(page);Object.assign(layer,{textOffsetX:-30,textOffsetY:24,padding:10});
    restore(page,'undo');assert.equal(page.layers[0].textOffsetX,0);assert.equal(page.layers[0].textOffsetY,0);assert.equal(page.layers[0].padding,0);
    restore(page,'redo');assert.equal(page.layers[0].textOffsetX,-30);assert.equal(page.layers[0].textOffsetY,24);assert.equal(page.layers[0].padding,10);
  }
});
