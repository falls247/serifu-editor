import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';

await sfxTest(5319,async({page,card})=>{
 await card.locator('.sfx-advanced-panel summary').click();
 await card.locator('[data-sfx-editor=editMode]').selectOption('curve');
 await card.locator('.sfx-stroke-panel summary').click();
 await card.locator('[data-glyph-stroke-point]').selectOption('1');
 const project=await exportJson(page),layer=project.pages[0].layers[0];
 const result=await page.evaluate(async layer=>{
  const {sfxScene}=await import('/src/renderer.js'),{strokeHandles,drawLetteringOverlay}=await import('/src/sfx-editor.js');
  const preview=document.querySelector('canvas.preview'),scene=sfxScene(preview.getContext('2d'),layer),run=layer.lettering.strokes[0];
  const mode={strokeRun:run.runStart,editMode:'curve',strokePoint:1,pointSelection:[{kind:'curve',index:1,run:run.runStart}]};
  const handles=strokeHandles(scene,layer,mode).filter(h=>h.kind==='curve');
  const makeCanvas=()=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800;return [canvas,canvas.getContext('2d')];};
  const paint=(ctx,m,target=layer)=>{ctx.translate(600,400);drawLetteringOverlay(ctx,target,m,scene,1,null);};
  const pixelsNear=(canvas,point,color,radius=6)=>{
   const ctx=canvas.getContext('2d'),center={x:Math.round(point.x+600),y:Math.round(point.y+400)},size=radius*2+1,data=ctx.getImageData(center.x-radius,center.y-radius,size,size).data,found=[];
   for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const offset=(y*size+x)*4;if(data[offset]===color[0]&&data[offset+1]===color[1]&&data[offset+2]===color[2]&&data[offset+3]===255)found.push({x:center.x-radius+x,y:center.y-radius+y});
   }
   return found;
  };
  const selectedCanvas=makeCanvas();paint(selectedCanvas[1],{...mode,pointSelection:[1,2].map(index=>({kind:'curve',index,run:run.runStart}))});
  const pinkCount=[1,2].map(index=>pixelsNear(selectedCanvas[0],handles[index],[239,75,145]).length);
  const overlapLayer=structuredClone(layer),overlapRun=overlapLayer.lettering.strokes[0];
  overlapRun.path.points[1]={x:.5,y:0};overlapRun.path.points[2]={x:.5,y:0};
  const overlapHandles=strokeHandles(scene,overlapLayer,{strokeRun:run.runStart,editMode:'curve'}).filter(h=>h.kind==='curve');
  const overlapCanvas=makeCanvas();paint(overlapCanvas[1],{strokeRun:run.runStart,editMode:'curve',pointSelection:[{kind:'curve',index:1,run:run.runStart}]},overlapLayer);
  const overlapPinkCount=pixelsNear(overlapCanvas[0],overlapHandles[1],[239,75,145]).length;
  const angle=layer.rotation*Math.PI/180,selectedHandle=handles[1],pageX=layer.x+selectedHandle.x*Math.cos(angle)-selectedHandle.y*Math.sin(angle),pageY=layer.y+selectedHandle.x*Math.sin(angle)+selectedHandle.y*Math.cos(angle);
  const previewCtx=preview.getContext('2d'),pixelCenter={x:Math.round(pageX*preview.width/1000),y:Math.round(pageY*preview.height/750)};
  const sample=previewCtx.getImageData(pixelCenter.x-8,pixelCenter.y-8,17,17).data;let visiblePinkCount=0;
  for(let i=0;i<sample.length;i+=4)if(sample[i]===239&&sample[i+1]===75&&sample[i+2]===145&&sample[i+3]===255)visiblePinkCount++;
  const smallCanvas=makeCanvas();paint(smallCanvas[1],{...mode,pointSelection:[]});
  const cyan=pixelsNear(smallCanvas[0],handles[0],[0,191,255],8),extent=cyan.length?{
   width:Math.max(...cyan.map(p=>p.x))-Math.min(...cyan.map(p=>p.x))+1,
   height:Math.max(...cyan.map(p=>p.y))-Math.min(...cyan.map(p=>p.y))+1,
  }:null;
  const boxCanvas=makeCanvas(),boxCtx=boxCanvas[1],rects=[];
  const wrapped=new Proxy(boxCtx,{get(target,key){if(key==='strokeRect')return(...args)=>{rects.push(args);return target.strokeRect(...args);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},set(target,key,value){return Reflect.set(target,key,value,target);}});
  paint(wrapped,{strokeRun:run.runStart,strokeRuns:[run.runStart],indices:[],editMode:'glyph',pointSelection:[]});
  const stroke=scene.items.find(item=>item.type==='stroke');
  return {pinkCount,overlapPinkCount,visiblePinkCount,extent,rects,expectedKnob:[stroke.bounds.maxX-7,stroke.bounds.maxY-7,14,14],menuMode:document.querySelector('[data-sfx-editor=editMode]').value,
   menuPoint:Number(document.querySelector('[data-glyph-stroke-point]').value)};
 },layer);
 assert.equal(result.menuMode,'curve','choosing a curve point enables curve handles');
 assert.equal(result.menuPoint,1);
 assert.ok(result.visiblePinkCount>0,'the menu-selected point is pink on the rendered preview');
 assert.ok(result.pinkCount.every(count=>count>0),'multiple selected curve points render in pink');
 assert.ok(result.overlapPinkCount>0,'a selected point stays pink when a later unselected point overlaps it');
 assert.ok(result.extent&&result.extent.width<=8&&result.extent.height<=8,'curve handle marker uses half-size radius');
 assert.equal(result.rects.length,2,'glyph mode draws a manipulation knob for the selected stroke');
 for(let i=0;i<4;i++)assert.ok(Math.abs(result.rects[1][i]-result.expectedKnob[i])<.01,'glyph-mode knob bounds include the selected stroke');
 console.log('SFX point overlay: pink selection, half-size handles and stroke bounds PASS');
});
