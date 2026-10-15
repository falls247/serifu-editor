import assert from 'node:assert/strict';
import {sfxTest} from './sfx-test-support.mjs';

async function viewportState(page){
  return page.evaluate(()=>({
    windowY:document.scrollingElement.scrollTop,
    paneTop:document.querySelector('.dialogue-pane').scrollTop,
    listTop:document.querySelector('.sfx-glyph-list').scrollTop,
  }));
}
async function afterPaint(page){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function clickPreservingScroll(page,locator,label){
  await locator.scrollIntoViewIfNeeded();
  await locator.focus();
  const before=await viewportState(page);
  await locator.click();
  await afterPaint(page);
  const after=await viewportState(page);
  assert.deepEqual(after,before,`${label}: scroll remains stable after click-triggered rebuild`);
  assert.equal(await locator.evaluate(element=>document.activeElement===element),true,`${label}: focus survives card rebuild`);
  return after;
}

await sfxTest(5316,async({page,card})=>{
  await page.setViewportSize({width:1440,height:700});
  await card.locator('textarea').fill('あ'.repeat(72)+'ザーークーーッ');
  await card.locator('[data-action=sfx-text-apply]').click();
  await card.locator('.sfx-stroke-panel summary').click();

  const before=await page.evaluate(()=>{
    const root=document.scrollingElement,pane=document.querySelector('.dialogue-pane'),list=document.querySelector('.sfx-glyph-list');
    root.scrollTop=Math.min(110,root.scrollHeight-root.clientHeight);
    pane.scrollTop=Math.min(100,pane.scrollHeight-pane.clientHeight);
    list.scrollTop=Math.min(80,list.scrollHeight-list.clientHeight);
    return {windowY:root.scrollTop,paneTop:pane.scrollTop,listTop:list.scrollTop,
      paneMax:pane.scrollHeight-pane.clientHeight,listMax:list.scrollHeight-list.clientHeight};
  });
  assert.ok(before.paneMax>0,'dialogue pane has its own scroll range');
  assert.ok(before.listMax>0,'glyph list has its own scroll range');
  assert.ok(before.windowY>0,'document is scrolled before the edit');

  for(const side of ['start','end']){
    const checkbox=card.locator(`[data-glyph-stroke-detach="${side}"]`);
    assert.equal(await checkbox.isChecked(),false,`${side} begins attached`);
    await clickPreservingScroll(page,checkbox,`${side} endpoint ON`);
    assert.equal(await checkbox.isChecked(),true,`${side} endpoint detaches`);
    await clickPreservingScroll(page,checkbox,`${side} endpoint OFF`);
    assert.equal(await checkbox.isChecked(),false,`${side} endpoint reattaches`);
  }

  for(const index of [45,72,26,46,70]){
    const glyph=card.locator(`[data-glyph-index="${index}"]`);
    await clickPreservingScroll(page,glyph,`glyph ${index} selection`);
    assert.equal(await glyph.getAttribute('aria-pressed'),'true',`glyph ${index} is selected`);
  }
  console.log('SFX scroll browser smoke passed: start/end ON/OFF and repeated glyph selection preserve document, pane, glyph-list scroll and focus.');
});
