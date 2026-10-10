import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5199,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser;
try {
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('browser smoke server timeout')),10000);
    server.stdout.once('data',()=>{clearTimeout(timer);resolve();});
    server.once('error',reject);
  });
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+port);
  const result=await page.evaluate(async()=>{
    const {newLayer,draw,clearGlyphCache}=await import('./renderer.js');
    const base=document.createElement('canvas');base.width=720;base.height=700;
    const bctx=base.getContext('2d');bctx.fillStyle='#efeae0';bctx.fillRect(0,0,720,700);
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=700;const ctx=canvas.getContext('2d');
    const pixels=layer=>{clearGlyphCache();draw(ctx,base,[layer]);return new Uint8ClampedArray(ctx.getImageData(0,0,720,700).data);};
    const diff=(a,b)=>a.reduce((sum,value,i)=>sum+(value!==b[i]?1:0),0);
    const l={...newLayer('sfx',720,700),x:360,y:350,w:600,h:550,text:'ザザザ',vertical:false,size:144,rotation:0,outline:0,effect:'none',distortion:0,skew:0,roughness:0,dryInk:0,brushTails:0,sizeVariation:0,horizontalJitter:0,blur:0,blurX:0,blurY:0,motionBlur:0,inkTexture:'none'};
    const clean=pixels(l);
    l.inkTexture='grunge';l.grungeAmount=75;l.scratchLength=60;l.scratchAngle=90;l.spatterAmount=50;
    const distressed=pixels(l),repeat=pixels(l),inkPreview=canvas.toDataURL('image/png');
    const changedSeed=pixels({...l,textureSeed:(l.textureSeed+1)>>>0});
    const empty=pixels({...l,text:''});
    const plainEmpty=pixels({...l,text:'',inkTexture:'none'});
    const b={...newLayer('balloon',720,700),x:360,y:350,w:320,h:520,shape:'spiky',distortion:85,color:'#ffffff',transparency:0,borderWidth:8,borderColor:'#ffc71a'};
    const spike=pixels(b),brush=pixels({...b,borderStyle:'brush',brushRoughness:100});
    const shadow=pixels({...b,shadowEnabled:true,shadowColor:'#212121',shadowBlur:16,shadowOffsetX:9,shadowOffsetY:10,shadowOpacity:75}),balloonPreview=canvas.toDataURL('image/png');
    return {inkPreview,balloonPreview,inkChange:diff(clean,distressed),seedChange:diff(distressed,changedSeed),fixed:diff(distressed,repeat),empty:diff(empty,plainEmpty),brushChange:diff(spike,brush),shadowChange:diff(spike,shadow)};
  });
  await mkdir('artifacts',{recursive:true});
  for(const [key,file] of [['inkPreview','grunge-ink-preview.png'],['balloonPreview','spiky-balloon-preview.png']]){await writeFile('artifacts/'+file,Buffer.from(result[key].split(',')[1],'base64'));delete result[key];}
  assert.equal(result.fixed,0,'same seed renders identical pixels');
  assert.equal(result.empty,0,'empty glyph emits no print noise');
  assert.ok(result.inkChange>100,'distressed print must change letter pixels');
  assert.ok(result.seedChange>100,'regenerated seed must change holes');
  assert.ok(result.brushChange>10,'brush stroke must differ from solid stroke');
  assert.ok(result.shadowChange>100,'balloon shadow must be visible');
  assert.deepEqual(errors,[]);
  console.log('Print ink and balloon browser pixels OK',result);
} finally {await browser?.close();server.kill();}
