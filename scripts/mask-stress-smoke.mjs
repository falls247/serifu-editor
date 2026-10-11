import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { once } from 'node:events';
const { chromium }=createRequire(import.meta.url)('playwright');
const port=5247,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});let browser;
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('Stress server failed to start');})]);
  browser=await chromium.launch({headless:true,args:['--enable-precise-memory-info']});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}/src/mask-effects.js`);
  const cdp=await browser.newBrowserCDPSession(),results=[];
  async function browserRss(){
    const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
    const values=await Promise.all(processInfo.map(async process=>{
      try{const status=await readFile(`/proc/${process.id}/status`,'utf8');return Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1]||0)*1024;}catch{return 0;}
    }));
    return values.reduce((sum,value)=>sum+value,0);
  }
  for(const [width,height] of [[3840,2160],[6000,4000]]){
    let peakBrowserRssBytes=await browserRss(),sample=null;
    const baselineBrowserRssBytes=peakBrowserRssBytes;
    const sampleMemory=async()=>{peakBrowserRssBytes=Math.max(peakBrowserRssBytes,await browserRss());};
    const timer=setInterval(()=>{if(!sample)sample=sampleMemory().finally(()=>{sample=null;});},50);
    let result;
    try{result=await page.evaluate(async({width,height})=>{
      const {encodeMask,assetFromEncoded}=await import('/src/mask-codec.js'),{applyMaskEffectsToImageData}=await import('/src/mask-effects.js'),{defaultMaskEffect,checkpoint,restore}=await import('/src/model.js'),{projectBlob,readProject}=await import('/src/project-io.js');
      const started=performance.now(),base=await encodeMask(new Uint8Array(64*64).fill(1),64,64),assets={},effects=[];
      for(let i=0;i<100;i++){const asset=await assetFromEncoded({...base,id:`mask-${i}`,imageWidth:width,imageHeight:height,bbox:{x:100+(i%10)*Math.floor(width/10),y:100+Math.floor(i/10)*Math.floor(height/10),width:64,height:64}});assets[asset.id]=asset;effects.push({...defaultMaskEffect(asset,{createdOrder:i,effect:['pixelate','blur','fill-black','fill-white'][i%4]}),marginPx:[0,-5,5][i%3]});}
      const source=new Uint8ClampedArray(width*height*4);new Uint32Array(source.buffer).fill(0xffccbbaa);
      const renderStart=performance.now(),pixels=applyMaskEffectsToImageData(source,width,height,effects,assets),renderMs=performance.now()-renderStart;
      if(source[0]!==170||pixels[0]!==170)throw new Error('Original/background changed');
      const black=effects[2],at=((black.y+32)*width+black.x+32)*4;if(pixels[at]!==0||pixels[at+3]!==255)throw new Error('Large image mask pixel mismatch');
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').putImageData(new ImageData(source,width,height),0,0);
      const file=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('PNG allocation failed')),'image/png'));
      const state={id:'stress',name:'stress.png',img:{width,height},file,layers:[],maskEffects:effects,maskAssets:assets,undo:[],redo:[],selectedId:null,selectedIds:[],selectedMaskId:null};
      const historyStart=performance.now();for(let i=0;i<100;i++){checkpoint(state);state.maskEffects[0].blockSize=21+i;}
      const historyBytes=state.undo.reduce((sum,s)=>sum+s.length,0);if(state.undo.some(s=>s.includes('dataBase64')||s.includes('decoded')))throw new Error('History copied mask bytes');
      for(let i=0;i<100;i++)if(!restore(state,'undo'))throw new Error('Undo lost');if(state.maskEffects[0].blockSize!==20)throw new Error('Undo result mismatch');for(let i=0;i<100;i++)if(!restore(state,'redo'))throw new Error('Redo lost');
      const historyMs=performance.now()-historyStart,saveStart=performance.now(),blob=await projectBlob([state],{},{}),restored=await readProject(blob),saveMs=performance.now()-saveStart;
      if(restored.pages[0].maskEffects.length!==100||Object.keys(restored.pages[0].maskAssets).length!==100)throw new Error('Large save lost masks');
      if(restored.pages[0].maskEffects[0].blockSize!==120)throw new Error('Effect state was not restored');
      return {width,height,masks:100,renderMs:Math.round(renderMs),historyMs:Math.round(historyMs),saveAndRestoreMs:Math.round(saveMs),totalMs:Math.round(performance.now()-started),decodedMaskBytes:Object.values(assets).reduce((sum,a)=>sum+a.decoded.length,0),compressedMaskBytes:Object.values(assets).reduce((sum,a)=>sum+a.data.length,0),historyBytes,projectBytes:blob.size,heapUsed:performance.memory?.usedJSHeapSize??null};
    },{width,height});}finally{clearInterval(timer);await sample;await sampleMemory();}
    results.push({...result,baselineBrowserRssBytes,peakBrowserRssBytes,rssSampleIntervalMs:50});
  }
  for(const result of results)assert.equal(result.masks,100);
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/sam3-mask-stress.json',JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
}finally{await browser?.close();server.kill('SIGTERM');}
