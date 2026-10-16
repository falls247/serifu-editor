import test from 'node:test';
import assert from 'node:assert/strict';
import {createSfxTemplate,applySfxTemplate,mergeSfxTemplates,encodeSfxTemplates,decodeSfxTemplates,validateStrokePresets} from '../src/sfx-lettering-templates.js';
import {strokeGeometry} from '../src/sfx-stroke-geometry.js';
import {defaultStroke} from '../src/sfx-lettering-model.js';
const layer={kind:'sfx',text:'ザーーーッ',id:'original',x:210,y:240,w:400,h:320,size:80,vertical:false,font:'hand',color:'#123456',outline:2};
test('templates retain position/text invariants and adapt to different glyph counts',()=>{
  const template=createSfxTemplate(layer,'密集');
  assert.equal(JSON.stringify(template).includes('ザーーーッ'),false);
  assert.equal(JSON.stringify(template).includes('"x":210'),false);
  const input={...layer,text:'ボコッ',id:'target',x:560,y:120};
  const result=applySfxTemplate(input,template);
  assert.equal(result.text,'ボコッ');assert.equal(result.x,560);assert.equal(result.y,120);assert.equal(result.id,'target');
  assert.equal(result.lettering.glyphs.length,3);
  assert.equal(result.lettering.strokes.length,0);
  assert.ok(result.lettering.layoutSeed!==undefined);
  assert.equal(applySfxTemplate(input,template,{mode:'style'}).w,400);
});
test('template JSON validates and conflicts support three explicit policies',()=>{
  const template=createSfxTemplate(layer,'name');
  const encoded=encodeSfxTemplates([template]);
  assert.deepEqual(decodeSfxTemplates(encoded),[template]);
  assert.equal(mergeSfxTemplates([template],[template],{conflict:'skip'}).length,1);
  assert.equal(mergeSfxTemplates([template],[template],{conflict:'overwrite'}).length,1);
  const renamed=mergeSfxTemplates([template],[template],{conflict:'rename'});
  assert.equal(renamed.length,2);assert.notEqual(renamed[0].id,renamed[1].id);
  assert.throws(()=>decodeSfxTemplates('{"version":999}'),/未対応/);
});
test('テンプレート適用後も長音幅倍率が文字サイズ比で追従',()=>{
  const source={...layer,text:'ーー',lettering:undefined};
  const template=createSfxTemplate(source,'太さ');template.design.strokes[0].value.widthMultiplier=2;
  const target={...layer,text:'ーー',size:40,id:'target'};
  const result=applySfxTemplate(target,template,{mode:'layout'}),stroke=result.lettering.strokes[0];
  const widths=strokeGeometry(stroke,new Map([[0,{x:0,y:0}],[1,{x:80,y:0}]]),{size:result.size});
  assert.equal(stroke.sizeReference,80);assert.equal(stroke.widthMultiplier,2);
  assert.equal(widths[0].w,24);
});
test('旧線プリセットは適用先の文字サイズを基準に移行',()=>{
  const legacy=defaultStroke(0,2,80);delete legacy.sizeReference;delete legacy.widthMultiplier;
  const validated=validateStrokePresets([{name:'legacy',value:legacy}])[0].value;
  assert.equal(validated.sizeReference,undefined);assert.equal(validated.widthMultiplier,1);
});
