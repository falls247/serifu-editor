import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';

async function selectedGlyphCenter(page,layer,index=0){
 return page.evaluate(async({layer,index})=>{
  const {sfxScene}=await import('/src/renderer.js');
  const canvas=document.createElement('canvas'),scene=sfxScene(canvas.getContext('2d'),layer);
  const items=scene.items.filter(item=>item.type==='glyph'&&item.index===index);
  if(!items.length)throw new Error('selected glyph missing from scene');
  const points=items.flatMap(item=>[{x:item.bounds.minX,y:item.bounds.minY},{x:item.bounds.maxX,y:item.bounds.minY},{x:item.bounds.maxX,y:item.bounds.maxY},{x:item.bounds.minX,y:item.bounds.maxY}]);
  const local={x:(Math.min(...points.map(p=>p.x))+Math.max(...points.map(p=>p.x)))/2,y:(Math.min(...points.map(p=>p.y))+Math.max(...points.map(p=>p.y)))/2};
  const a=layer.rotation*Math.PI/180;
  return {x:layer.x+local.x*Math.cos(a)-local.y*Math.sin(a),y:layer.y+local.x*Math.sin(a)+local.y*Math.cos(a)};
 },{layer,index});
}

async function hitPoint(page,layer,index=0){
 return page.evaluate(async({layer,index})=>{
  const {sfxScene,sfxItemHit}=await import('/src/renderer.js');
  const canvas=document.createElement('canvas'),scene=sfxScene(canvas.getContext('2d'),layer),item=scene.items.find(item=>item.type==='glyph'&&item.index===index);
  if(!item)throw new Error('selected glyph missing from scene');
  const b=item.bounds;
  for(let row=1;row<10;row++)for(let col=1;col<10;col++){
   const point={x:b.minX+(b.maxX-b.minX)*col/10,y:b.minY+(b.maxY-b.minY)*row/10};
   if(sfxItemHit(item,point))return {x:layer.x+point.x,y:layer.y+point.y};
  }
  throw new Error('no hit point found inside selected glyph');
 },{layer,index});
}

async function strokeHitPoint(page,layer){
 return page.evaluate(async layer=>{
  const {sfxScene,sfxItemHit}=await import('/src/renderer.js');
  const scene=sfxScene(document.createElement('canvas').getContext('2d'),layer),item=scene.items.find(item=>item.type==='stroke');
  if(!item)throw new Error('continuous stroke missing from scene');
  const b=item.bounds;
  for(let row=1;row<20;row++)for(let col=1;col<20;col++){
   const point={x:b.minX+(b.maxX-b.minX)*col/20,y:b.minY+(b.maxY-b.minY)*row/20};
   if(sfxItemHit(item,point))return {x:layer.x+point.x,y:layer.y+point.y};
  }
  throw new Error('no hit point found inside continuous stroke');
 },layer);
}

async function curveHandle(page,layer){
 return page.evaluate(async layer=>{
  const {sfxScene}=await import('/src/renderer.js'),{strokeHandles}=await import('/src/sfx-editor.js');
  const scene=sfxScene(document.createElement('canvas').getContext('2d'),layer),run=layer.lettering.strokes.find(item=>item.mode==='continuous');
  if(!run)throw new Error('continuous stroke missing from model');
  const handle=strokeHandles(scene,layer,{editMode:'curve',strokeRun:run.runStart})[1];
  if(!handle)throw new Error('curve handle missing from selected stroke');
  return {runStart:run.runStart,index:handle.index,local:{x:handle.x,y:handle.y},image:{x:layer.x+handle.x,y:layer.y+handle.y}};
 },layer);
}

async function geometry(page,point){
 return page.locator('canvas.preview').first().evaluate((canvas,point)=>{
  const frame=canvas.parentElement,frameRect=frame.getBoundingClientRect(),rect=canvas.getBoundingClientRect();
  return {frame:{x:frameRect.x,y:frameRect.y,width:frameRect.width,height:frameRect.height,clientWidth:frame.clientWidth,clientHeight:frame.clientHeight,clientLeft:frame.clientLeft,clientTop:frame.clientTop},canvas:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},target:{x:rect.x+point.x*rect.width/1000,y:rect.y+point.y*rect.height/750}};
 },point);
}

async function panPointToFrameCenter(page,row,point){
 const before=await geometry(page,point),dx=before.frame.x+before.frame.clientLeft+before.frame.clientWidth/2-before.target.x,dy=before.frame.y+before.frame.clientTop+before.frame.clientHeight/2-before.target.y;
 if(Math.hypot(dx,dy)<1)return;
 const handle=row.locator('[data-focus-pan]'),box=await handle.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:3});await page.mouse.up();
}

async function dragPreview(page,start,dx,dy){
 await page.mouse.move(start.x,start.y);await page.mouse.down();
 await page.mouse.move(start.x+dx,start.y+dy,{steps:4});await page.mouse.up();
}

function assertPan(before,after,dx,dy,message){
 const relative=g=>({x:g.canvas.x-g.frame.x,y:g.canvas.y-g.frame.y});
 const start=relative(before),end=relative(after);
 assert.ok(Math.abs(end.x-start.x-dx)<2&&Math.abs(end.y-start.y-dy)<2,message);
 assert.ok(Math.abs(after.frame.width-before.frame.width)<1&&Math.abs(after.frame.height-before.frame.height)<1,'pan mode preserves preview frame size');
}

await sfxTest(5325,async({page,row})=>{
 const before=await exportJson(page),layer=before.pages[0].layers.find(item=>item.kind==='sfx');
 assert.ok(layer,'SFX fixture exists');
 const target=await selectedGlyphCenter(page,layer),frame=row.locator('.preview-frame'),canvas=row.locator('canvas.preview');
 const beforeFrame=await frame.boundingBox();
 await row.locator('[data-action=preview-focus]').click();
 await page.waitForFunction(()=>document.querySelector('.preview-frame')?.classList.contains('preview-focus-mode'));
 let focused=await geometry(page,target);
 assert.ok(Math.abs(focused.canvas.width-1000)<1,'100% renders source image at one CSS pixel per source pixel');
 assert.ok(Math.abs(focused.frame.width-beforeFrame.width)<1&&Math.abs(focused.frame.height-beforeFrame.height)<1,'FOCUS toggle preserves preview frame size');
 assert.ok(Math.abs(focused.target.x-(focused.frame.x+focused.frame.clientLeft+focused.frame.clientWidth/2))<1,'selected glyph is horizontally centered');
 assert.ok(Math.abs(focused.target.y-(focused.frame.y+focused.frame.clientTop+focused.frame.clientHeight/2))<1,'selected glyph is vertically centered');

 const zoom=row.locator('[data-focus-zoom]');await zoom.fill('200');await zoom.press('Tab');
 await page.waitForFunction(()=>Math.abs(document.querySelector('canvas.preview').getBoundingClientRect().width-2000)<1);
 focused=await geometry(page,target);
 assert.ok(Math.abs(focused.frame.width-beforeFrame.width)<1&&Math.abs(focused.frame.height-beforeFrame.height)<1,'numeric zoom preserves preview frame size');
 assert.ok(Math.abs(focused.target.x-(focused.frame.x+focused.frame.clientLeft+focused.frame.clientWidth/2))<1,'zoom change recenters selected glyph');
 assert.ok(Math.abs(focused.target.y-(focused.frame.y+focused.frame.clientTop+focused.frame.clientHeight/2))<1,'zoom change recenters selected glyph vertically');

 const handle=row.locator('[data-focus-pan]'),handleBox=await handle.boundingBox(),beforePan=focused;
 await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down();
 await page.mouse.move(handleBox.x+handleBox.width/2+45,handleBox.y+handleBox.height/2+28,{steps:2});await page.mouse.up();
 const afterPan=await geometry(page,target);
 assert.ok(Math.abs(afterPan.canvas.x-beforePan.canvas.x-45)<2&&Math.abs(afterPan.canvas.y-beforePan.canvas.y-28)<2,'dedicated handle pans the displayed image');
 assert.ok(Math.abs(afterPan.frame.width-beforeFrame.width)<1&&Math.abs(afterPan.frame.height-beforeFrame.height)<1,'pan preserves preview frame size');
 const afterView=await exportJson(page);
 assert.deepEqual(afterView.pages[0].layers,before.pages[0].layers,'FOCUS zoom and pan do not alter saved layer data');

 assert.equal(await handle.getAttribute('aria-pressed'),'false','dragging the dedicated handle does not toggle pan mode');
 await handle.click();
 assert.equal(await handle.getAttribute('aria-pressed'),'true','clicking the handle enables whole-preview pan mode');
 const point=await hitPoint(page,layer);
 let panGeometry=await geometry(page,point);
 await page.mouse.move(panGeometry.target.x,panGeometry.target.y);
 assert.equal(await canvas.evaluate(node=>getComputedStyle(node).cursor),'grab','pan mode shows a grab cursor over selected glyph ink');
 await dragPreview(page,panGeometry.target,38,-21);
 assertPan(panGeometry,await geometry(page,point),38,-21,'dragging glyph ink pans the view in pan mode');

 const touch=await page.context().newCDPSession(page);
 panGeometry=await geometry(page,point);
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[panGeometry.target]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:panGeometry.target.x+24,y:panGeometry.target.y+32}]});
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await touch.detach();
 assertPan(panGeometry,await geometry(page,point),24,32,'one-finger dragging pans the view in pan mode');

 await zoom.fill('25');await zoom.press('Tab');
 const blankFrame=await geometry(page,target),blankStart={x:blankFrame.frame.x+blankFrame.frame.clientLeft+8,y:blankFrame.frame.y+blankFrame.frame.clientTop+8};
 assert.ok(blankStart.x<blankFrame.canvas.x||blankStart.y<blankFrame.canvas.y,'blank-frame fixture is outside canvas');
 await dragPreview(page,blankStart,31,22);
 assertPan(blankFrame,await geometry(page,target),31,22,'blank frame margins can pan in pan mode');
 const afterModePan=await exportJson(page);
 assert.deepEqual(afterModePan.pages[0].layers,before.pages[0].layers,'whole-preview mouse and touch panning leave saved layers unchanged');

 await handle.focus();await handle.press('Enter');
 assert.equal(await handle.getAttribute('aria-pressed'),'false','keyboard activation returns to object editing');
 await handle.press('Enter');
 assert.equal(await handle.getAttribute('aria-pressed'),'true','keyboard activation can enter pan mode');
 await handle.press('Escape');
 assert.equal(await handle.getAttribute('aria-pressed'),'false','Escape leaves pan mode');
 assert.equal(await row.locator('[data-action=preview-focus]').getAttribute('aria-pressed'),'true','Escape keeps FOCUS enabled');
 await zoom.fill('200');await zoom.press('Tab');

 await page.locator('#projectSave').focus();await handle.click();
 assert.equal(await handle.getAttribute('aria-pressed'),'true','pan mode can start with focus previously outside the preview');
 await page.keyboard.press('Escape');
 assert.equal(await handle.getAttribute('aria-pressed'),'false','Escape exits pan mode after clicking its button');
 await handle.click();
 panGeometry=await geometry(page,point);
 await page.mouse.move(panGeometry.target.x,panGeometry.target.y);await page.mouse.down();
 await page.mouse.move(panGeometry.target.x+10,panGeometry.target.y+10,{steps:2});
 await page.keyboard.press('Escape');
 assert.equal(await handle.getAttribute('aria-pressed'),'false','Escape exits an active pan drag');
 const cancelledPan=await geometry(page,point);
 await page.mouse.move(panGeometry.target.x+30,panGeometry.target.y+30,{steps:2});await page.mouse.up();
 assertPan(cancelledPan,await geometry(page,point),0,0,'Escape stops an in-progress pan drag immediately');

 const rect=await canvas.boundingBox();
 const start={x:rect.x+point.x*rect.width/1000,y:rect.y+point.y*rect.height/750};
 await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+40,start.y+24,{steps:3});await page.mouse.up();
 const afterDrag=await exportJson(page),moved=afterDrag.pages[0].layers.find(item=>item.id===layer.id);
 assert.notEqual(moved.lettering.glyphs.find(glyph=>glyph.index===0).dx,layer.lettering.glyphs.find(glyph=>glyph.index===0).dx,'canvas hit mapping still moves a glyph while zoomed');

 const strokePoint=await strokeHitPoint(page,moved),canvasRect=await canvas.boundingBox();
 await panPointToFrameCenter(page,row,strokePoint);
 const centeredCanvas=await canvas.boundingBox(),strokeClient={x:centeredCanvas.x+strokePoint.x*centeredCanvas.width/1000,y:centeredCanvas.y+strokePoint.y*centeredCanvas.height/750};
 const panel=row.locator('.sfx-advanced-panel');await panel.locator('summary').click();
 await panel.locator('[data-sfx-editor=priority]').selectOption('stroke');
 await handle.click();
 await page.mouse.dblclick(strokeClient.x,strokeClient.y);
 assert.equal(await panel.locator('[data-sfx-editor=editMode]').inputValue(),'glyph','double-clicking a stroke in pan mode does not enter curve editing');
 await handle.click();
 await page.mouse.click(strokeClient.x,strokeClient.y);
 await panel.locator('[data-sfx-editor=editMode]').selectOption('curve');
 const curve=await curveHandle(page,moved);await panPointToFrameCenter(page,row,curve.image);
 await handle.click();
 const beforeCurvePan=await geometry(page,curve.image);
 await dragPreview(page,beforeCurvePan.target,23,13);
 assertPan(beforeCurvePan,await geometry(page,curve.image),23,13,'dragging a curve handle pans the view in pan mode');
 const afterCurvePan=await exportJson(page);
 assert.deepEqual(afterCurvePan.pages[0].layers,afterDrag.pages[0].layers,'pan mode does not edit curve points');
 await handle.click();
 const curveCanvas=await canvas.boundingBox(),curveStart={x:curveCanvas.x+curve.image.x*curveCanvas.width/1000,y:curveCanvas.y+curve.image.y*curveCanvas.height/750};
 await page.mouse.move(curveStart.x,curveStart.y);await page.mouse.down();await page.mouse.move(curveStart.x+30,curveStart.y+16,{steps:3});await page.mouse.up();
 const afterCurve=await exportJson(page),editedRun=afterCurve.pages[0].layers.find(item=>item.id===layer.id).lettering.strokes.find(run=>run.runStart===curve.runStart);
 assert.notDeepEqual(editedRun.path.points[curve.index],moved.lettering.strokes.find(run=>run.runStart===curve.runStart).path.points[curve.index],'curve point hit mapping still works while FOCUS is zoomed');

 await row.locator('[data-action=preview-magnifier]').click();await page.waitForSelector('.preview-magnifier');
 assert.equal(await row.locator('[data-action=preview-focus]').getAttribute('aria-pressed'),'true','magnifier coexists with FOCUS');
 const full=page.waitForFunction(()=>document.querySelector('#fullPreview')?.open===true);
 await row.locator('[data-action=preview-full]').click();await full;
 await page.locator('#fullPreviewClose').click();await page.waitForFunction(()=>document.querySelector('#fullPreview')?.open===false);
 assert.equal(await row.locator('[data-action=preview-focus]').getAttribute('aria-pressed'),'true','100% modal leaves FOCUS state intact');
 await handle.click();
 await row.locator('[data-action=preview-focus]').click();
 await row.locator('[data-action=preview-focus]').click();
 assert.equal(await handle.getAttribute('aria-pressed'),'false','leaving FOCUS clears pan mode for the next session');
},{onStage:stage=>process.stdout.write(stage+'\n')});

console.log('FOCUS preview smoke test passed');
