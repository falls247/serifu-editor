import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';

await sfxTest(5318,async({page,row,card})=>{
  const lens=row.locator('.preview-magnifier'),detail=lens.locator('canvas');
  const open=async()=>{
    await row.locator('[data-action=preview-magnifier]').click();
    await lens.locator('.magnifier-status').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('.preview-magnifier').getAttribute('aria-busy')==='false');
  };
  const check=async(index,{focused=true}={})=>{
    const saved=(await exportJson(page)).pages[0],layer=saved.layers[0];
    const result=await detail.evaluate(async(canvas,{layer,index,edit})=>{
      const {draw,sfxScene}=await import('/src/renderer.js'),{imagePoint}=await import('/src/image-edit.js');
      const source=document.querySelector('.original'),expected=document.createElement('canvas');
      const rendered=document.querySelector('#fullPreviewCanvas');expected.width=rendered.width;expected.height=rendered.height;
      draw(expected.getContext('2d'),source,[layer],null,1,1,edit,source);
      const x=Number(canvas.dataset.sourceX),y=Number(canvas.dataset.sourceY);
      const actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const pixels=expected.getContext('2d').getImageData(x,y,canvas.width,canvas.height).data;
      const item=sfxScene(expected.getContext('2d'),layer).items.find(item=>item.index===index),a=layer.rotation*Math.PI/180;
      const local={x:(item.bounds.minX+item.bounds.maxX)/2,y:(item.bounds.minY+item.bounds.maxY)/2};
      const point=imagePoint({x:layer.x+local.x*Math.cos(a)-local.y*Math.sin(a),y:layer.y+local.x*Math.sin(a)+local.y*Math.cos(a)},source.naturalWidth,source.naturalHeight,edit);
      return {same:actual.every((byte,i)=>byte===pixels[i]),ink:actual.reduce((n,byte,i)=>n+(i%4===0&&byte<50),0),
        contains:point.x>=x&&point.x<x+canvas.width&&point.y>=y&&point.y<y+canvas.height};
    },{layer,index,edit:saved.imageEdit});
    assert.equal(result.same,true,'magnifier pixels match the edited original-resolution renderer');
    assert.ok(result.ink>50,'magnifier includes visible SFX ink');
    if(focused)assert.equal(result.contains,true,'magnifier opens on the selected glyph');
  };
  await open();await check(0);
  const before=await detail.evaluate(canvas=>canvas.toDataURL());
  await card.locator('[data-glyph-field=dx]').fill('24');await card.locator('[data-glyph-field=dx]').press('Tab');
  await page.waitForFunction(before=>document.querySelector('.magnifier-canvas').toDataURL()!==before,before);
  await check(0,{focused:false});
  await lens.locator('.magnifier-close').click();
  await card.locator('[data-glyph-index="5"]').click();
  await open();await check(5);
  await lens.locator('.magnifier-close').click();
  await row.locator('[data-action=rotate-right]').click();
  await open();await check(5);
  console.log('SFX magnifier: selected glyph visibility, live edits, original pixel parity and image rotation PASS');
});
