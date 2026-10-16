import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';
import {strokeWidthScale} from '../src/sfx-stroke-geometry.js';

const change=async(input,value)=>{
 await input.fill(String(value));
 await input.evaluate(node=>node.dispatchEvent(new Event('change',{bubbles:true})));
};
const layers=async page=>(await exportJson(page)).pages[0].layers;
const stroke=items=>items.find(layer=>layer.kind==='sfx').lettering.strokes[0];
const effectiveWidth=(items,end=false)=>{
 const layer=items.find(layer=>layer.kind==='sfx'),run=stroke(items);
 return run.widths[end?run.widths.length-1:0].w*strokeWidthScale(run,layer.size);
};
const point=async input=>{
 await input.scrollIntoViewIfNeeded();
 const box=await input.boundingBox();
 return {x:box.x+box.width*.35,y:box.y+box.height/2};
};
const drag=async(page,input,dx,dy)=>{
 const start=await point(input);
 await page.mouse.move(start.x,start.y);await page.mouse.down();
 await page.mouse.move(start.x+dx,start.y+dy,{steps:5});await page.mouse.up();
};
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-8,`${message}: ${actual} vs ${expected}`);

await sfxTest(5328,async({page,row,card})=>{
 const panel=card.locator('.sfx-stroke-panel');await panel.locator('summary').click();
 const start=panel.locator('[data-glyph-stroke-width=start]'),end=panel.locator('[data-glyph-stroke-width=end]'),multiplier=panel.locator('[data-glyph-stroke-width-scale]');
 const frame=row.locator('.preview-frame'),canvas=row.locator('canvas.preview'),beforeFrame=await frame.boundingBox();
 await row.locator('[data-action=preview-focus]').click();
 await change(row.locator('[data-focus-zoom]'),'175.5');
 for(const input of [start,end])assert.equal(await input.getAttribute('step'),'0.1','endpoint width uses tenths');

 await change(start,'12.345');await change(end,'23.456');
 let saved=await layers(page);
 near(effectiveWidth(saved),12.3,'typed start width is rounded to one decimal');
 near(effectiveWidth(saved,true),23.5,'typed end width is rounded to one decimal');
 assert.equal(await start.inputValue(),'12.3');assert.equal(await end.inputValue(),'23.5');
 await change(start,'12.3009');
 assert.equal(await start.inputValue(),'12.3','same-value typed input also normalizes its displayed decimal precision');
 await change(multiplier,'125');
 assert.equal(await start.inputValue(),'15.4');assert.equal(await end.inputValue(),'29.4');
 saved=await layers(page);
 near(effectiveWidth(saved),15.375,'display rounding preserves stored reference precision');
 await change(row.locator('.position-controls [data-field=size]'),'82');
 assert.equal(await start.inputValue(),'15.8','font-size refresh also displays only one decimal');
 await change(row.locator('.position-controls [data-field=size]'),'80');await change(multiplier,'100');

 const beforePendingInput=await layers(page);
 await start.fill('12.345');await drag(page,start,0,-10);
 near(effectiveWidth(await layers(page)),13.3,'dragging an uncommitted decimal input normalizes stored effective width');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),beforePendingInput,'dragging an uncommitted input still uses one Undo entry');

 const beforeDrag=await layers(page),dragStart=await point(start);
 await start.evaluate(input=>{input.dataset.dragTestMarker='original';});
 const scrollBefore=await row.locator('.dialogue-pane').evaluate(node=>node.scrollTop),imageBefore=await canvas.evaluate(node=>node.toDataURL());
 await page.mouse.move(dragStart.x,dragStart.y);await page.mouse.down();
 await page.mouse.move(dragStart.x,dragStart.y-25,{steps:5});
 assert.equal(await start.inputValue(),'14.8','upward start-width drag updates in tenths before release');
 assert.equal(await start.evaluate(input=>input.dataset.dragTestMarker),'original','live drag preserves the input and pointer capture');
 assert.notEqual(await canvas.evaluate(node=>node.toDataURL()),imageBefore,'live width drag updates rendered pixels');
 await page.mouse.up();
 const afterDrag=await layers(page);
 near(effectiveWidth(afterDrag),14.8,'start-width drag persists its effective width');
 near(effectiveWidth(afterDrag,true),23.5,'start drag leaves the other endpoint unchanged');
 assert.ok(Math.abs(await row.locator('.dialogue-pane').evaluate(node=>node.scrollTop)-scrollBefore)<1,'drag preserves card scrolling');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),beforeDrag,'one Undo reverts the whole multi-event drag');
 await row.locator('[data-action=redo]').click();
 assert.deepEqual(await layers(page),afterDrag,'one Redo restores the drag');
 await drag(page,start,60,0);await drag(page,start,0,-2);
 assert.deepEqual(await layers(page),afterDrag,'horizontal movement and tiny vertical jitter do not edit widths');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),beforeDrag,'no-op drags do not consume Undo entries');
 await row.locator('[data-action=redo]').click();

 await drag(page,end,0,30);
 saved=await layers(page);
 near(effectiveWidth(saved,true),20.5,'downward end-width drag reduces the value');
 near(effectiveWidth(saved),14.8,'end drag leaves start width unchanged');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),afterDrag,'end-width drag also uses one Undo entry');
 await drag(page,multiplier,0,-25);
 saved=await layers(page);
 near(stroke(saved).widthMultiplier,1.25,'multiplier drag uses one percentage point per pixel');
 assert.deepEqual(stroke(saved).widths,stroke(afterDrag).widths,'multiplier drag preserves reference width knots');
 assert.equal(await start.inputValue(),'18.5');assert.equal(await end.inputValue(),'29.4');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),afterDrag,'multiplier drag also uses one Undo entry');

 await change(multiplier,'495');await drag(page,multiplier,0,-15);
 near(stroke(await layers(page)).widthMultiplier,5,'multiplier drag respects 500% maximum');
 await change(multiplier,'5');await drag(page,multiplier,0,15);
 near(stroke(await layers(page)).widthMultiplier,.01,'multiplier drag respects 1% minimum');
 await change(multiplier,'125');await change(start,'624.9');await drag(page,start,0,-10);
 near(effectiveWidth(await layers(page)),625,'width drag respects dynamically scaled maximum');
 await change(multiplier,'123.45');await change(start,'617.2');await drag(page,start,0,-10);
 near(effectiveWidth(await layers(page)),617.2,'a fractional scaled maximum respects one-decimal precision');
 assert.equal(await start.inputValue(),'617.2');
 await change(start,'0.4');await drag(page,start,0,10);
 near(effectiveWidth(await layers(page)),0,'width drag stops at zero');

 const beforeTouchEdit=await layers(page);
 await change(end,'12.3');
 const beforeTouchDrag=await layers(page);
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),beforeTouchEdit,'typed endpoint edit establishes one Undo entry before touch');
 await row.locator('[data-action=redo]').click();
 assert.deepEqual(await layers(page),beforeTouchDrag);
 await change(end,'13.3');
 const beforeFreshTouchEdit=await layers(page);
 await change(end,'12.3');
 const touchStart=await point(end),touch=await page.context().newCDPSession(page);
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touchStart]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchStart.x,y:touchStart.y-15}]});
 assert.equal(await end.inputValue(),'13.8','touch can adjust endpoint widths in real time');
 await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await touch.detach();
 assert.equal(await end.inputValue(),'12.3','cancelled touch drag restores its original value');
 await page.mouse.move(touchStart.x,touchStart.y-30);
 assert.deepEqual(await layers(page),beforeTouchDrag,'cancelled drag does not leave a live edit');
 await row.locator('[data-action=undo]').click();
 assert.deepEqual(await layers(page),beforeFreshTouchEdit,'cancelled drag does not leave an Undo entry');
 const afterFrame=await frame.boundingBox();
 assert.ok(Math.abs(beforeFrame.width-afterFrame.width)<1&&Math.abs(beforeFrame.height-afterFrame.height)<1,'numeric drags keep FOCUS frame dimensions');
 assert.equal(Number(await row.locator('[data-focus-zoom]').inputValue()),175.5,'stroke numeric drags leave FOCUS zoom unchanged');
 console.log('SFX stroke numeric drag: decimal precision, live endpoint/multiplier drags, limits, Undo/Redo, touch cancellation and FOCUS PASS');
});
