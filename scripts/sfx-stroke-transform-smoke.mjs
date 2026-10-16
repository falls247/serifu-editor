import assert from 'node:assert/strict';
import {sfxTest,exportJson,exportPng,pointPosition,assertPng} from './sfx-test-support.mjs';

const boundsAndGlyphs=(page,layer)=>page.evaluate(async layer=>{
 const {sfxScene}=await import('/src/renderer.js'),canvas=document.querySelector('canvas.preview'),scene=sfxScene(canvas.getContext('2d'),layer),stroke=scene.items.find(item=>item.type==='stroke');
 return {bounds:stroke?.bounds,glyphs:scene.glyphs.map(({index,x,y})=>({index,x,y})),displayScale:canvas.getBoundingClientRect().width/1000};
},layer);
const samePoints=(before,after,message)=>{
 assert.equal(after.length,before.length,message);
 for(const glyph of before){const moved=after.find(item=>item.index===glyph.index);assert.ok(moved,`${message}: glyph ${glyph.index} remains present`);assert.ok(Math.hypot(moved.x-glyph.x,moved.y-glyph.y)<.02,`${message}: glyph ${glyph.index} stays in place`);}
};

await sfxTest(5320,async({page,row,card})=>{
 const canvas=row.locator('canvas.preview');
 await card.locator('.sfx-advanced-panel summary').click();
 await card.locator('[data-sfx-editor=editMode]').selectOption('curve');
 await card.locator('[data-glyph-index="0"]').click();
 assert.equal(await card.locator('[data-sfx-editor=editMode]').inputValue(),'glyph','choosing another character leaves point editing');
 await card.locator('[data-glyph-index="1"]').click();

 const before=await exportJson(page),layer=before.pages[0].layers[0];
 const initialVisual=await boundsAndGlyphs(page,layer),initialStroke=layer.lettering.strokes[0];
 assert.ok(initialVisual.bounds,'stroke selection keeps its BOX after leaving point-edit mode');
 assert.ok(initialVisual.bounds.maxX>initialVisual.bounds.minX&&initialVisual.bounds.maxY>initialVisual.bounds.minY);

 const center={x:(initialVisual.bounds.minX+initialVisual.bounds.maxX)/2,y:(initialVisual.bounds.minY+initialVisual.bounds.maxY)/2};
 const scaleFrom={x:initialVisual.bounds.maxX,y:initialVisual.bounds.maxY};
 const scaleTo={x:center.x+(scaleFrom.x-center.x)*1.28,y:center.y+(scaleFrom.y-center.y)*1.28};
 const from=await pointPosition(page,layer,scaleFrom),to=await pointPosition(page,layer,scaleTo);
 await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:6});await page.mouse.up();
 const scaled=await exportJson(page),scaledLayer=scaled.pages[0].layers[0],scaledStroke=scaledLayer.lettering.strokes[0],scaledVisual=await boundsAndGlyphs(page,scaledLayer);
 assert.equal(scaledStroke.start.detached,true,'scaling detaches the transformed start endpoint');assert.equal(scaledStroke.end.detached,true,'scaling detaches the transformed end endpoint');
 assert.ok(Math.hypot(scaledStroke.start.fixedPosition.x-initialStroke.start.fixedPosition?.x,scaledStroke.start.fixedPosition.y-initialStroke.start.fixedPosition?.y)>1||!initialStroke.start.fixedPosition,'scaling transforms stroke endpoints');
 assert.ok(scaledStroke.widths.reduce((sum,knot)=>sum+knot.w,0)>initialStroke.widths.reduce((sum,knot)=>sum+knot.w,0),'scaling updates stroke thickness');
 samePoints(initialVisual.glyphs,scaledVisual.glyphs,'stroke scale leaves all unselected glyphs unchanged');

 const rotationScale=scaledVisual.displayScale,rotationCenter={x:(scaledVisual.bounds.minX+scaledVisual.bounds.maxX)/2,y:(scaledVisual.bounds.minY+scaledVisual.bounds.maxY)/2};
 const rotationFrom={x:rotationCenter.x,y:scaledVisual.bounds.minY-25/rotationScale},angle=35*Math.PI/180;
 const offset={x:rotationFrom.x-rotationCenter.x,y:rotationFrom.y-rotationCenter.y};
 const rotationTo={x:rotationCenter.x+offset.x*Math.cos(angle)-offset.y*Math.sin(angle),y:rotationCenter.y+offset.x*Math.sin(angle)+offset.y*Math.cos(angle)};
 const rotateStart=await pointPosition(page,scaledLayer,rotationFrom),rotateEnd=await pointPosition(page,scaledLayer,rotationTo);
 await page.mouse.move(rotateStart.x,rotateStart.y);await page.mouse.down();await page.mouse.move(rotateEnd.x,rotateEnd.y,{steps:6});await page.mouse.up();
 const rotated=await exportJson(page),rotatedLayer=rotated.pages[0].layers[0],rotatedStroke=rotatedLayer.lettering.strokes[0],rotatedVisual=await boundsAndGlyphs(page,rotatedLayer);
 const expectedStart={x:rotationCenter.x+(scaledStroke.start.fixedPosition.x-rotationCenter.x)*Math.cos(angle)-(scaledStroke.start.fixedPosition.y-rotationCenter.y)*Math.sin(angle),y:rotationCenter.y+(scaledStroke.start.fixedPosition.x-rotationCenter.x)*Math.sin(angle)+(scaledStroke.start.fixedPosition.y-rotationCenter.y)*Math.cos(angle)};
 assert.ok(Math.hypot(rotatedStroke.start.fixedPosition.x-expectedStart.x,rotatedStroke.start.fixedPosition.y-expectedStart.y)<.25,'rotation applies the requested 35 degree angle around the displayed BOX center');
 samePoints(scaledVisual.glyphs,rotatedVisual.glyphs,'stroke rotation leaves all unselected glyphs unchanged');
 await assertPng(page,rotated,await exportPng(page,row));

 await row.locator('[data-action=undo]').click();
 assert.deepEqual((await exportJson(page)).pages[0].layers[0].lettering.strokes[0],scaledStroke,'undo restores the exact scaled stroke after rotation');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual((await exportJson(page)).pages[0].layers[0].lettering.strokes[0],initialStroke,'second undo restores the original stroke');

 const originalVisual=await boundsAndGlyphs(page,layer),cancelFrom=await pointPosition(page,layer,{x:originalVisual.bounds.maxX,y:originalVisual.bounds.maxY}),cancelTo=await pointPosition(page,layer,{x:center.x+(originalVisual.bounds.maxX-center.x)*1.2,y:center.y+(originalVisual.bounds.maxY-center.y)*1.2});
 await page.mouse.move(cancelFrom.x,cancelFrom.y);await page.mouse.down();await page.mouse.move(cancelTo.x,cancelTo.y,{steps:3});
 await canvas.evaluate(node=>node.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1,pointerType:'mouse',button:0})));
 await page.mouse.up();
 assert.deepEqual((await exportJson(page)).pages[0].layers[0].lettering.strokes[0],initialStroke,'pointer cancel rolls the stroke transform back');
 samePoints(initialVisual.glyphs,(await boundsAndGlyphs(page,layer)).glyphs,'cancel leaves glyph placement unchanged');
 console.log('SFX stroke BOX: scale, rotate, undo, cancel and PNG PASS');
});
