import assert from 'node:assert/strict';
import {sfxTest,exportJson,pointPosition} from './sfx-test-support.mjs';

await sfxTest(5315,async({page,row,card})=>{
 await card.locator('textarea').fill('ボコッ');
 await card.locator('[data-action=sfx-text-apply]').click();
 const canvas=row.locator('canvas.preview');
 await card.locator('.sfx-advanced-panel summary').click();
 await card.locator('[data-sfx-editor=layoutMode]').selectOption('overlap');
 const overlap=card.locator('[data-sfx-editor=overlapIntensity]');await overlap.fill('80');await overlap.press('Tab');
 const glyph=card.locator('[data-glyph-index="0"]');
 await glyph.click();

 const positions=async layer=>page.evaluate(async layer=>{
  const {sfxScene}=await import('/src/renderer.js'),canvas=document.querySelector('canvas.preview');
  return sfxScene(canvas.getContext('2d'),layer).glyphs.map(({index,x,y})=>({index,x,y}));
 },layer);
 let project=await exportJson(page),layer=project.pages[0].layers[0],current=await positions(layer);
 const untouched=current.find(g=>g.index===1);
 const expected={ArrowLeft:[-1,0],ArrowUp:[0,-1],ArrowRight:[1,0],ArrowDown:[0,1]};
 for(const [key,[dx,dy]] of Object.entries(expected)){
  await canvas.focus();await page.keyboard.press(key);project=await exportJson(page);layer=project.pages[0].layers[0];
  const next=await positions(layer),moved=next.find(g=>g.index===0),other=next.find(g=>g.index===1),previous=current.find(g=>g.index===0);
  assert.ok(Math.abs(moved.x-previous.x-dx)<.01,`${key} changes glyph x in its expected direction`);
  assert.ok(Math.abs(moved.y-previous.y-dy)<.01,`${key} changes glyph y in its expected direction`);
  assert.ok(Math.abs(other.x-untouched.x)<.01&&Math.abs(other.y-untouched.y)<.01,`${key} leaves unselected glyph in place under overlap layout`);
  assert.equal(layer.lettering.glyphs[1].origin,null,`${key} does not freeze unselected glyph origin`);
  current=next;
 }
 const beforeRotation=layer.lettering.glyphs[0].rotation;

 // The old hit test placed the invisible rotation target 25 px below the top
 // edge, inside the glyph. Dragging from this point should move the glyph.
 const start=await page.evaluate(async layer=>{
  const {sfxScene,sfxItemHit}=await import('/src/renderer.js'),canvas=document.querySelector('canvas.preview');
  const scene=sfxScene(canvas.getContext('2d'),layer),item=scene.glyphs.find(g=>g.index===0),scale=canvas.getBoundingClientRect().width/canvas.width;
  const target={x:(item.bounds.minX+item.bounds.maxX)/2,y:item.bounds.minY+25/scale},radius=10/scale;
  let point=null,best=Infinity;
  for(let y=target.y-radius;y<=target.y+radius;y+=.5)for(let x=target.x-radius;x<=target.x+radius;x+=.5){
   const distance=Math.hypot(x-target.x,y-target.y);if(distance<=radius&&distance<best&&sfxItemHit(item,{x,y})){point={x,y};best=distance;}
  }
  if(!point)throw Error('no glyph ink near the previous rotation hit target');return point;
 },layer);
 await canvas.evaluate(c=>c.scrollIntoView({block:'center'}));
 const from=await pointPosition(page,layer,start),to=await pointPosition(page,layer,{x:start.x+12,y:start.y+4});
 const beforePositions=await positions(layer),before=beforePositions.find(g=>g.index===0),otherBefore=beforePositions.find(g=>g.index===1);
 await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:4});await page.mouse.up();
 project=await exportJson(page);layer=project.pages[0].layers[0];const moved=layer.lettering.glyphs[0],afterPositions=await positions(layer),after=afterPositions.find(g=>g.index===0),otherAfter=afterPositions.find(g=>g.index===1);
 assert.equal(moved.rotation,beforeRotation,'drag from the glyph top area does not rotate it');
 assert.ok(after.x-before.x>8,'drag from the glyph top area moves it horizontally');
 assert.ok(after.y-before.y>2,'drag from the glyph top area moves it vertically');
 assert.ok(Math.abs(otherAfter.x-otherBefore.x)<.01&&Math.abs(otherAfter.y-otherBefore.y)<.01,'drag leaves unselected glyph in place under overlap layout');
 console.log('SFX glyph movement: cardinal keys and drag near glyph top PASS');
});
