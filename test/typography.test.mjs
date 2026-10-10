import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,glyphFontSize,textGlyphs,EFFECTS} from '../renderer.js';
import {verticalPunctuationOffset,verticalRotation,graphemes} from '../typography.js';
import {captionLayout} from '../captions.js';
import {normalizeLayer,copySelection,pasteSelection,checkpoint,restore} from '../model.js';
import {createPreset,applyPreset,defaultPreferences,normalizePreferences} from '../presets.js';
const context=()=>({font:'',save(){this.saved=this.font;},restore(){this.font=this.saved;},measureText(char){const size=Number(this.font.match(/([\d.]+)px/)[1]);return {width:size,actualBoundingBoxLeft:0,actualBoundingBoxRight:size,actualBoundingBoxAscent:size*.8,actualBoundingBoxDescent:size*.2};}});

test('midline ellipsis and box-drawing line rotate only in vertical text across every layer',()=>{
  for(const char of ['⋯','─']){
    assert.equal(verticalRotation(char),Math.PI/2);
    for(const vertical of [true,false]){
      for(const kind of ['dialogue','balloon','sfx'])for(const kerningMode of kind==='sfx'?['standard','optical']:['standard']){
        const layer={...newLayer(kind,1000,750),text:char,vertical,kerningMode,kerningStrength:85,sizeVariation:0,horizontalJitter:0,rotationJitter:0};
        assert.equal(textGlyphs(context(),layer)[0].angle,vertical?Math.PI/2:0);
      }
      const caption={...newLayer('caption',1000,750),text:char,vertical,autoFit:false};assert.equal(captionLayout(context(),caption).glyphs[0].rotate,vertical);
    }
  }
  assert.equal(verticalRotation('あ'),0);assert.equal(verticalRotation('♥'),0);
});

test('vertical Japanese punctuation uses actual font bearings to place ink in the upper-right',()=>{
  for(const char of ['、','。','，','．','､','｡']){
    for(const m of [{width:80,actualBoundingBoxLeft:36,actualBoundingBoxRight:-15,actualBoundingBoxAscent:-8,actualBoundingBoxDescent:33},{width:80,actualBoundingBoxLeft:12,actualBoundingBoxRight:9,actualBoundingBoxAscent:3,actualBoundingBoxDescent:21}]){
      const offset=verticalPunctuationOffset({measureText:()=>m},char,80,true);
      assert.ok(Math.abs(offset.x+m.actualBoundingBoxRight-80*.43)<.00001);
      assert.ok(Math.abs(offset.y-m.actualBoundingBoxAscent+80*.43)<.00001);
      assert.deepEqual(verticalPunctuationOffset({measureText:()=>m},char,80,false),{x:0,y:0});
    }
  }
  assert.deepEqual(verticalPunctuationOffset({},'あ',80,true),{x:0,y:0});
  assert.deepEqual(graphemes('あ\u3099、'),['あ\u3099','、']);
});

test('caption physical alignment defaults to the center and moves each line or column to any edge',()=>{
  for(const vertical of [true,false]){
    const base={...newLayer('caption',1000,750),text:'あい\nう',w:300,h:300,size:30,padding:10,vertical,autoFit:false};
    const middle=captionLayout(context(),base);assert.equal(base.alignX,'center');assert.equal(base.alignY,'center');
    for(const alignX of ['left','center','right'])for(const alignY of ['top','center','bottom']){
      const layout=captionLayout(context(),{...base,alignX,alignY});assert.equal(layout.size,30);assert.equal(layout.fits,true);
      const first=layout.glyphs[0];if(alignX==='left')assert.ok(first.x<middle.glyphs[0].x);if(alignX==='right')assert.ok(first.x>middle.glyphs[0].x);
      if(alignY==='top')assert.ok(first.y<middle.glyphs[0].y);if(alignY==='bottom')assert.ok(first.y>middle.glyphs[0].y);
      const fitted=captionLayout(context(),{...base,alignX,alignY,autoFit:true});assert.equal(fitted.size,captionLayout(context(),{...base,autoFit:true}).size);
    }
    const caption=normalizeLayer(base,6);assert.equal(caption.alignX,'center');assert.equal(caption.alignY,'center');
    const old={...base};delete old.alignX;delete old.alignY;const legacy=normalizeLayer(old,5);assert.equal(legacy.alignX,'right');assert.equal(legacy.alignY,'top');
    for(const invalid of [{alignX:'top'},{alignY:'left'},{alignX:'missing'}])assert.throws(()=>normalizeLayer({...base,...invalid},6));
  }
});

test('taper decreases by a percentage of the base size and stops at eight pixels',()=>{
  const layer={...newLayer('sfx',1000,750),effect:'taper',size:100};assert.equal(layer.taperRate,10);assert.equal(EFFECTS.none,'なし');assert.equal(EFFECTS.taper,'先細り');
  assert.deepEqual([0,1,2,3,10,10000].map(i=>Math.round(glyphFontSize(layer,i)*100)/100),[100,90,80,70,8,8]);
  assert.equal(glyphFontSize({...layer,taperRate:0},10000),100);assert.equal(glyphFontSize({...layer,taperRate:100},1),8);assert.equal(glyphFontSize({...layer,taperRate:12.5},2),75);
  assert.equal(glyphFontSize({...layer,effect:'none'},10000),100);assert.equal(glyphFontSize({...layer,kind:'dialogue'},3),100);
});

test('taper packs shrinking glyphs in both directions and continues through wraps and newlines',()=>{
  for(const vertical of [true,false]){
    const layer={...newLayer('sfx',1000,750),effect:'taper',taperRate:10,size:100,text:'ドド\nドドド',w:180,h:240,vertical,stretchX:100,stretchY:100,sizeVariation:0,horizontalJitter:0};
    const glyphs=textGlyphs(context(),layer);assert.deepEqual(glyphs.map(g=>Math.round(g.size)),[100,90,80,70,60]);assert.deepEqual(glyphs.map(g=>g.index),[0,1,2,3,4]);
    if(vertical){assert.equal(glyphs[2].x,glyphs[3].x,'two consecutive shrinking glyphs share their column');assert.ok(glyphs[3].y>glyphs[2].y);assert.notEqual(glyphs[4].x,glyphs[0].x);}
    else assert.notEqual(glyphs[1].y,glyphs[0].y,'horizontal wrapping should use the actual changing advances');
    const tiny=textGlyphs(context(),{...layer,size:8,taperRate:100,text:'ド'.repeat(100)});assert.ok(tiny.every(g=>g.size===8&&Number.isFinite(g.x)&&Number.isFinite(g.y)));
  }
});

test('new typography survives presets, portrait copies, project recovery and undo without scaling percentages',()=>{
  const source={...newLayer('sfx',1000,500),font:'chikara',effect:'taper',taperRate:12.5,text:'ドドド',sizeVariation:0};
  const restored=normalizeLayer(JSON.parse(JSON.stringify(source)),6);assert.equal(restored.font,'chikara');assert.equal(restored.taperRate,12.5);assert.equal(restored.effect,'taper');
  const copy=pasteSelection(copySelection(source,1000,500),500,1000,0);assert.equal(copy.taperRate,12.5);assert.equal(copy.size,source.size*.5);
  const c={...newLayer('caption',1000,500),alignX:'left',alignY:'bottom'};const copied=pasteSelection(copySelection(c,1000,500),500,1000,0);assert.equal(copied.alignX,'left');assert.equal(copied.alignY,'bottom');
  const p={layers:[source,c],done:false,edited:false,undo:[],redo:[]};checkpoint(p);p.layers[0].taperRate=50;p.layers[1].alignX='right';restore(p,'undo');assert.equal(p.layers[0].taperRate,12.5);assert.equal(p.layers[1].alignX,'left');
  const preset=createPreset('先細り',p.layers[0],1000,500),prefs=defaultPreferences();prefs.presets.push(preset);prefs.defaults.sfx=preset.id;
  const remembered=normalizePreferences(JSON.parse(JSON.stringify(prefs))),target=newLayer('sfx',500,1000);applyPreset(target,remembered.presets.find(p=>p.id===preset.id),500,1000);assert.equal(target.taperRate,12.5);assert.equal(target.font,'chikara');assert.equal(target.effect,'taper');
  delete preset.style.taperRate;applyPreset(target,preset,500,1000);assert.equal(target.taperRate,10);
  const legacy={...source};delete legacy.taperRate;assert.equal(normalizeLayer(legacy,3).taperRate,10);
  for(const taperRate of [-1,101,NaN])assert.throws(()=>normalizeLayer({...source,taperRate},6));
});
