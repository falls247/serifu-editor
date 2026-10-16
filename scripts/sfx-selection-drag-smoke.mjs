import assert from 'node:assert/strict';
import {sfxTest,exportJson,pointPosition} from './sfx-test-support.mjs';

await sfxTest(5323,async({page,row,card})=>{
  const canvas=row.locator('canvas.preview');
  await card.locator('textarea').fill('ロロ');
  await card.locator('[data-action=sfx-text-apply]').click();
  await row.locator('.position-controls [data-field=font]').selectOption('sans');
  await card.locator('[data-field=effect]').selectOption('none');
  await card.locator('[data-glyph-index="0"]').click();
  await card.locator('[data-glyph-field=rotation]').fill('25');
  await card.locator('[data-glyph-field=rotation]').press('Tab');
  await card.locator('.sfx-advanced-panel summary').click();
  const sceneInfo=async(layer,multiple=false)=>page.evaluate(async({layer,multiple})=>{
    const {sfxScene,sfxItemHit}=await import('/src/renderer.js'),canvas=document.querySelector('canvas.preview');
    const scene=sfxScene(canvas.getContext('2d'),layer),items=multiple?scene.items:[scene.items.find(item=>item.index===0)];
    const b={minX:Math.min(...items.map(item=>item.bounds.minX)),maxX:Math.max(...items.map(item=>item.bounds.maxX)),
      minY:Math.min(...items.map(item=>item.bounds.minY)),maxY:Math.max(...items.map(item=>item.bounds.maxY))};
    const scale=canvas.getBoundingClientRect().width/1000,radius=10/scale;
    const center={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2};
    let hole=null,closest=Infinity;
    for(let y=b.minY+5;y<b.maxY-5;y+=.5)for(let x=b.minX+5;x<b.maxX-5;x+=.5){
      const distance=Math.hypot(x-center.x,y-center.y);
      if(distance<closest&&!scene.items.some(item=>sfxItemHit(item,{x,y}))&&
        Math.hypot(x-b.maxX,y-b.maxY)>radius&&Math.hypot(x-center.x,y-(b.minY-25/scale))>radius){hole={x,y};closest=distance;}
    }
    if(!hole)throw Error('fixture must contain a transparent point within the selection BOX');
    return {hole,bounds:b,positions:scene.glyphs.map(({index,x,y})=>({index,x,y}))};
  },{layer,multiple});
  const drag=async(layer,from,to)=>{
    await canvas.scrollIntoViewIfNeeded();
    const a=await pointPosition(page,layer,from),b=await pointPosition(page,layer,to);
    await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:5});await page.mouse.up();
  };
  for(const tool of ['click','rectangle','lasso']){
    await card.locator('[data-sfx-editor=selectionTool]').selectOption(tool);
    const layer=(await exportJson(page)).pages[0].layers[0],before=await sceneInfo(layer);
    await drag(layer,before.hole,{x:before.hole.x+14,y:before.hole.y+8});
    const afterLayer=(await exportJson(page)).pages[0].layers[0],after=await sceneInfo(afterLayer);
    for(const key of ['x','y']){
      assert.ok(Math.abs(after.positions[0][key]-before.positions[0][key]-(key==='x'?14:8))<.1,`${tool}: dragging transparent glyph area moves the selection`);
      assert.ok(Math.abs(after.positions[1][key]-before.positions[1][key])<.1,`${tool}: unselected glyph stays in place`);
    }
    assert.equal(afterLayer.lettering.glyphs[0].rotation,25,'dragging transparent area preserves rotation');
    assert.equal(await card.locator('[data-glyph-index="0"]').getAttribute('aria-pressed'),'true');
  }
  await card.locator('[data-glyph-index="1"]').click();
  await card.locator('[data-glyph-field=dx]').fill('100');await card.locator('[data-glyph-field=dx]').press('Tab');
  await card.locator('[data-glyph-index="0"]').click({modifiers:['Shift']});
  let layer=(await exportJson(page)).pages[0].layers[0],before=await sceneInfo(layer,true);
  await drag(layer,before.hole,{x:before.hole.x+10,y:before.hole.y+6});
  let afterLayer=(await exportJson(page)).pages[0].layers[0],after=await sceneInfo(afterLayer,true);
  for(let i=0;i<2;i++)assert.ok(Math.abs(after.positions[i].x-before.positions[i].x-10)<.1&&Math.abs(after.positions[i].y-before.positions[i].y-6)<.1,'empty space inside a multi-selection BOX drags the whole selection');
  await card.locator('[data-sfx-editor=selectionTool]').selectOption('rectangle');
  layer=afterLayer;before=after;
  const start={x:before.bounds.minX-30,y:before.bounds.minY-30},end={x:before.bounds.maxX+30,y:before.bounds.maxY+30};
  await drag(layer,start,end);
  assert.equal(await card.locator('[data-glyph-index][aria-pressed=true]').count(),2,'dragging outside the selection BOX still starts rectangle selection');
  afterLayer=(await exportJson(page)).pages[0].layers[0];
  assert.deepEqual(afterLayer.lettering,layer.lettering,'rectangle selection outside the BOX does not move glyphs');
  console.log('SFX selection drag: transparent glyphs, rotated glyph, multiple selection, selection tools and outside rectangle PASS');
});
