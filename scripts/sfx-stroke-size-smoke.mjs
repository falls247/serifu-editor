import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';

const firstWidth=async(page,layer)=>page.evaluate(async({stroke,size})=>{
 const {strokeGeometry}=await import('/src/sfx-stroke-geometry.js');
 const start=stroke.runStart,end=start+stroke.runLength-1;
 return strokeGeometry(stroke,new Map([[start,{x:0,y:0}],[end,{x:80,y:0}]]),{size})[0].w;
},{stroke:layer.lettering.strokes[0],size:layer.size});
const change=async(locator,value)=>{await locator.fill(String(value));await locator.evaluate(input=>input.dispatchEvent(new Event('change',{bubbles:true})));};

await sfxTest(5324,async({page,row,card})=>{
 const panel=card.locator('.sfx-stroke-panel');await panel.locator('summary').click();
 const frame=row.locator('.preview-frame'),beforeFrame=await frame.boundingBox();
 await row.locator('[data-action=preview-focus]').click();
 await change(row.locator('[data-focus-zoom]'),'175.5');
 assert.ok(Math.abs(await row.locator('canvas.preview').evaluate(canvas=>canvas.getBoundingClientRect().width)-1755)<1,'fractional FOCUS zoom is available while adjusting stroke widths');
 let project=await exportJson(page),layer=project.pages[0].layers[0],stroke=layer.lettering.strokes[0];
 assert.equal(stroke.sizeReference,80);assert.equal(stroke.widthMultiplier,1);
 assert.equal(await firstWidth(page,layer),24,'default stroke uses default width at its reference size');

 await change(panel.locator('[data-glyph-stroke-width-scale]'),'200');
 project=await exportJson(page);layer=project.pages[0].layers[0];stroke=layer.lettering.strokes[0];
 assert.equal(stroke.widthMultiplier,2,'per-run thickness multiplier persists');
 assert.equal(await firstWidth(page,layer),48,'per-run thickness multiplier changes rendered width');

 await change(row.locator('.position-controls [data-field=size]'),'160');
 project=await exportJson(page);layer=project.pages[0].layers[0];stroke=layer.lettering.strokes[0];
 assert.equal(layer.size,160);assert.equal(stroke.sizeReference,80);
 assert.equal(await firstWidth(page,layer),96,'line width follows text size changes');
 assert.equal(Number(await panel.locator('[data-glyph-stroke-width=start]').inputValue()),96,'endpoint control shows effective width');

 const advanced=card.locator('.sfx-advanced-panel');await advanced.locator('summary').click();
 assert.equal(Number(await advanced.locator('[data-sfx-editor=widthW]').inputValue()),96,'advanced width control refreshes to effective width after resizing');
 await change(advanced.locator('[data-sfx-editor=widthW]'),'72');
 project=await exportJson(page);layer=project.pages[0].layers[0];stroke=layer.lettering.strokes[0];
 assert.ok(Math.abs(stroke.widths[0].w-18)<1e-8,'advanced width input stores reference width');
 assert.equal(await firstWidth(page,layer),72,'advanced width input edits rendered width');

 await change(panel.locator('[data-glyph-stroke-width=start]'),'60');
 project=await exportJson(page);layer=project.pages[0].layers[0];stroke=layer.lettering.strokes[0];
 assert.ok(Math.abs(stroke.widths[0].w-15)<1e-8,'endpoint input is converted to saved reference width');
 assert.equal(await firstWidth(page,layer),60,'endpoint width can be adjusted individually');
 const handle=await page.evaluate(async layer=>{
  const {sfxScene}=await import('/src/renderer.js'),{strokeFrame,pathToLocal,bezierPoint,strokeWidthScale}=await import('/src/sfx-stroke-geometry.js'),{strokeHandles}=await import('/src/sfx-editor.js');
  const run=layer.lettering.strokes[0],scene=sfxScene(document.querySelector('canvas.preview').getContext('2d'),layer),mode={strokeRun:run.runStart,editMode:'width'},point=pathToLocal(strokeFrame(run,scene.positions,{vertical:layer.vertical,size:layer.size}),bezierPoint(run.path.points,run.widths[0].t)),selected=strokeHandles(scene,layer,mode)[0];
  return {distance:Math.hypot(selected.x-point.x,selected.y-point.y),expected:run.widths[0].w*strokeWidthScale(run,layer.size)/2};
 },layer);
 assert.ok(Math.abs(handle.distance-handle.expected)<1e-8,'width handle position uses effective width');

 await change(row.locator('.position-controls [data-field=size]'),'80');
 project=await exportJson(page);layer=project.pages[0].layers[0];
 assert.equal(await firstWidth(page,layer),30,'individual endpoint width keeps following later size changes');
 await row.locator('[data-action=apply-font-size]').click();
 project=await exportJson(page);layer=project.pages[0].layers[0];
 assert.equal(layer.size,70,'remembered font-size action updates SFX size');
 assert.equal(await firstWidth(page,layer),26.25,'remembered font-size action also scales line width');
 const afterFrame=await frame.boundingBox();
 assert.ok(Math.abs(beforeFrame.width-afterFrame.width)<1&&Math.abs(beforeFrame.height-afterFrame.height)<1,'stroke and text-size edits keep the FOCUS frame size fixed');
 console.log('SFX stroke size: text-size tracking, per-run/endpoint widths and fractional FOCUS integration PASS');
});
