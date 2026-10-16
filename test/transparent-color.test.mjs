import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,dialogueColor} from '../src/renderer.js';
import {normalizeLayer,scaledCopy,checkpoint,restore} from '../src/model.js';
import {createPreset,applyPreset,normalizePreferences,defaultPreferences} from '../src/presets.js';
import {startLettering,normalizeLettering} from '../src/sfx-lettering-model.js';
import {createSfxTemplate,applySfxTemplate,validateSfxTemplate} from '../src/sfx-lettering-templates.js';

test('transparent text and outlines survive project data, copies, presets and undo for every kind',()=>{
  for(const kind of ['dialogue','balloon','caption','sfx']){
    const field=kind==='sfx'?'color':'textColor';
    const original={...newLayer(kind,1000,750),text:'透明', [field]:'transparent',textOutlineColor:'transparent'};
    const restored=normalizeLayer(JSON.parse(JSON.stringify(original)));
    assert.equal(restored[field],'transparent',kind);
    assert.equal(restored.textOutlineColor,'transparent',kind);
    assert.equal(scaledCopy(restored,1000,750,500,1000)[field],'transparent',kind);
    if(['dialogue','balloon'].includes(kind))assert.equal(dialogueColor(restored),'transparent');
    const preset=createPreset('透明文字',original,1000,750),preferences=defaultPreferences();
    preferences.presets.push(preset);
    const saved=normalizePreferences(JSON.parse(JSON.stringify(preferences))).presets.find(p=>p.id===preset.id);
    const applied=applyPreset(newLayer(kind,1000,750),saved,1000,750);
    assert.equal(applied[field],'transparent',kind);
    assert.equal(applied.textOutlineColor,'transparent',kind);
    const page={layers:[original],undo:[],redo:[],selectedId:original.id};
    checkpoint(page);original[field]='#123456';restore(page,'undo');
    assert.equal(page.layers[0][field],'transparent',kind);
    restore(page,'redo');assert.equal(page.layers[0][field],'#123456',kind);
    for(const value of ['red','#fff','#00000000',['transparent'],{},null]){
      if(value===null&&['dialogue','balloon'].includes(kind))continue;
      assert.throws(()=>normalizeLayer({...original,[field]:value}),kind);
    }
  }
});

test('transparent SFX glyph, stroke and group overrides survive templates and normalization',()=>{
  const layer={...newLayer('sfx',1000,750),text:'ボーーン',color:'transparent',textOutlineColor:'transparent'};
  layer.lettering=startLettering(layer);
  layer.lettering.glyphs[0].overrides.fill='transparent';
  layer.lettering.glyphs[0].overrides.outlineColor='transparent';
  for(const stroke of layer.lettering.strokes)stroke.lookOverride={fill:'transparent',outlineColor:'transparent'};
  layer.lettering.outlineGroups=[{members:[0,1],mode:'manual',locked:true,styleOverride:{color:'transparent',width:6}}];
  const restored=normalizeLayer(JSON.parse(JSON.stringify(layer)));
  assert.equal(restored.lettering.glyphs[0].overrides.fill,'transparent');
  assert.ok(restored.lettering.strokes.length>0);
  assert.equal(restored.lettering.strokes[0].lookOverride.fill,'transparent');
  assert.equal(restored.lettering.outlineGroups[0].styleOverride.color,'transparent');
  const template=createSfxTemplate(restored,'透明SFX'),saved=validateSfxTemplate(JSON.parse(JSON.stringify(template)));
  const target=applySfxTemplate(newLayer('sfx',1000,750),saved);
  assert.equal(target.color,'transparent');
  assert.equal(target.lettering.glyphs[0].overrides.fill,'transparent');
  assert.equal(target.lettering.outlineGroups[0].styleOverride.color,'transparent');
  const invalid=structuredClone(layer.lettering);invalid.glyphs[0].overrides.fill=['transparent'];
  assert.throws(()=>normalizeLettering(invalid,layer.text,{size:layer.size}));
});
