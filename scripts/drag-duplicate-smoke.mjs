import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port=5198;
const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
const near=(actual,expected,msg)=>assert.ok(Math.abs(actual-expected)<=2,`${msg}: expected ${expected}, got ${actual}`);
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Drag smoke server did not start')),10000);
    server.stdout.once('data',()=>{clearTimeout(timer);resolve();});
    server.once('error',reject);server.stderr.on('data',data=>process.stderr.write(data));
  });
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.click('#demo');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3 && !document.querySelector('#projectLoad').disabled);
  const row=page.locator('.image-row').first(),canvas=row.locator('canvas.preview');
  const count=()=>row.locator('.layer-card').count();
  const value=async field=>Number(await row.locator(`.position-controls [data-field=${field}]`).inputValue());
  const select=async index=>row.locator('.layer-card').nth(index).locator('.layer-summary').click();
  const position=async()=>{
    await canvas.scrollIntoViewIfNeeded();
    const box=await canvas.boundingBox();
    const dimensions=await row.locator('.dimensions').textContent();
    const [width,height]=dimensions.match(/\d+/g).map(Number);
    const x=await value('x'),y=await value('y');
    return {x,y,clientX:box.x + box.width*x/width,clientY:box.y + box.height*y/height,box,width,height};
  };
  const drag=async (dx,dy,keys=[])=>{
    const pos=await position();
    await page.mouse.move(pos.clientX,pos.clientY);
    for(const key of keys)await page.keyboard.down(key);
    await page.mouse.down();
    await page.mouse.move(pos.clientX+dx*pos.box.width/pos.width,pos.clientY+dy*pos.box.height/pos.height,{steps:5});
    const during=await canvas.evaluate(el=>el.toDataURL());
    await page.mouse.up();
    for(const key of keys.slice().reverse())await page.keyboard.up(key);
    return {...pos,during,after:await canvas.evaluate(el=>el.toDataURL())};
  };
  // Empty the demo layers so exact hit testing and overlap order are deterministic.
  await row.locator('[data-action=cut-all]').click();
  await page.waitForFunction(()=>document.querySelector('.image-row .layer-cards')?.children.length===0);
  for(const kind of ['dialogue','sfx','balloon','caption']){
    await row.locator(`[data-action=add-${kind==='dialogue'?'male':kind}]`).click();
    assert.equal(await count(),1);
    await row.locator('.position-controls [data-field=x]').fill('500');
    await row.locator('.position-controls [data-field=y]').fill('390');
    await row.locator('.position-controls [data-field=y]').blur();
    const sourceId=await row.locator('.layer-card').first().getAttribute('data-layer-id');
    const original=await position();

    // Ctrl+click is selection only; drag must actually move before cloning.
    await canvas.scrollIntoViewIfNeeded();
    await page.mouse.move(original.clientX,original.clientY);
    await page.keyboard.down('Control');await page.mouse.down();await page.mouse.up();await page.keyboard.up('Control');
    assert.equal(await count(),1,`${kind}: Ctrl click must not duplicate`);

    // Normal drag still moves the existing layer.
    await drag(32,14);
    assert.equal(await count(),1,`${kind}: normal drag must not clone`);
    near(await value('x'),original.x+32,`${kind}: move x`);
    near(await value('y'),original.y+14,`${kind}: move y`);
    const moved=await position();
    const movedId=await row.locator('.layer-card').first().getAttribute('data-layer-id');
    assert.equal(movedId,sourceId);

    const duplicated=await drag(60,35,['Control']);
    assert.equal(await count(),2,`${kind}: Ctrl drag must clone once`);
    assert.equal(await row.locator('.layer-card').last().getAttribute('data-kind'),kind);
    const copyId=await row.locator('.layer-card').last().getAttribute('data-layer-id');
    assert.notEqual(copyId,sourceId);
    near(await value('x'),moved.x+60,`${kind}: copy x`);
    near(await value('y'),moved.y+35,`${kind}: copy y`);
    await select(0);
    near(await value('x'),moved.x,`${kind}: source x remains`);
    near(await value('y'),moved.y,`${kind}: source y remains`);

    // Undo removes only the duplicated object; redo restores it.
    await row.locator('[data-action=undo]').click();
    assert.equal(await count(),1,`${kind}: undo removes duplicate`);
    await row.locator('[data-action=redo]').click();
    assert.equal(await count(),2,`${kind}: redo restores duplicate`);
    await row.locator('[data-action=undo]').click();
    assert.equal(await count(),1);
    await select(0);

    for(const [dx,dy,expectedAxis] of [
      [90,16,'horizontal'],[-90,16,'horizontal'],[16,90,'vertical'],[16,-90,'vertical']
    ]){
      const origin=await position();
      const guide=await drag(dx,dy,['Control','Shift']);
      assert.equal(await count(),2,`${kind} ${expectedAxis}: constrained copy`);
      near(await value('x'),origin.x+(expectedAxis==='horizontal'?dx:0),`${kind} ${expectedAxis}: x`);
      near(await value('y'),origin.y+(expectedAxis==='vertical'?dy:0),`${kind} ${expectedAxis}: y`);
      assert.notEqual(guide.during,guide.after,'alignment guide should disappear at pointerup');
      await select(0);
      near(await value('x'),origin.x,`${kind}: original x remains`);
      near(await value('y'),origin.y,`${kind}: original y remains`);
      await row.locator('[data-action=undo]').click();
      assert.equal(await count(),1);
      await select(0);
    }
    // One original layer remains after all duplicate/undo cycles.
    await row.locator('[data-action=cut-all]').click();
    await page.waitForFunction(()=>document.querySelector('.image-row .layer-cards')?.children.length===0);
  }
  assert.deepEqual(errors,[],'no browser script errors');
  console.log('Ctrl-drag browser smoke passed: four layer kinds, normal drag, Ctrl-click no-op, Ctrl-copy, Ctrl-Shift four axes with guide, Undo/Redo');
} finally {
  await browser?.close();
  server.kill();
}
