import {draw,clearGlyphCache} from './renderer.js';
import {FONT_CATALOG} from './fonts.js';
const loadedFonts=new Map();
async function loadFonts(layers){
  for(const key of new Set(layers.filter(l=>l.kind!=='balloon').map(l=>l.font))){const font=FONT_CATALOG[key];if(!font?.file)continue;
    if(!loadedFonts.has(key))loadedFonts.set(key,(async()=>{const face=new FontFace(font.family,`url("${new URL(`./assets/fonts/${font.file}`,import.meta.url)}")`,{weight:String(font.faceWeight||font.weight)});await face.load();self.fonts.add(face);clearGlyphCache();})());
    await loadedFonts.get(key);
  }
}
self.onmessage=async({data})=>{
  const {operationId,jobId,kind,payload}=data;let image,canvas;
  const timings={},started=performance.now();
  try{
    let value;
    if(kind==='probe'){if(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap!=='function'||typeof FontFace==='undefined'||!self.fonts||typeof self.fonts.add!=='function')throw new Error('画像Worker API非対応');canvas=new OffscreenCanvas(2,2);const context=canvas.getContext('2d');if(!context)throw new Error('画像Workerの2D Canvas非対応');context.fillRect(0,0,1,1);const probe=await canvas.convertToBlob({type:'image/png'});if(!probe?.size)throw new Error('画像WorkerのPNG生成非対応');value=true;}
    else if(kind==='reset-fonts'){clearGlyphCache();value=true;}
    else {
      if(kind==='render-png'){const before=performance.now();await loadFonts(payload.layers);timings.fontMs=performance.now()-before;}
      const hint=kind==='prepare-image'&&payload.dimensions?.fastThumbnail?payload.dimensions:null,ratio=hint?Math.min(1,320/Math.max(hint.width,hint.height)):1;
      const before=performance.now();image=await createImageBitmap(payload.blob,...(hint?[{resizeWidth:Math.max(1,Math.round(hint.width*ratio)),resizeHeight:Math.max(1,Math.round(hint.height*ratio)),resizeQuality:'low'}]:[]));timings.decodeMs=performance.now()-before;
      if(kind==='prepare-image'){
        const ratio=Math.min(1,320/Math.max(image.width,image.height));canvas=new OffscreenCanvas(Math.max(1,Math.round(image.width*ratio)),Math.max(1,Math.round(image.height*ratio)));
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        value={width:hint?.width||image.width,height:hint?.height||image.height,thumbnail:await canvas.convertToBlob({type:'image/webp',quality:.75})};
      }else if(kind==='render-png'){
        if(image.width!==payload.width||image.height!==payload.height)throw new Error('画像寸法が既存デコードと一致しない');
        canvas=new OffscreenCanvas(image.width,image.height);const drawn=performance.now();draw(canvas.getContext('2d'),image,payload.layers);timings.drawMs=performance.now()-drawn;
        const encoded=performance.now();value=await canvas.convertToBlob({type:'image/png'});timings.pngMs=performance.now()-encoded;
      }else throw new Error('未知の画像ジョブ');
    }
    self.postMessage({operationId,jobId,value,timings:{...timings,totalMs:performance.now()-started}});
  }catch(error){self.postMessage({operationId,jobId,error:error.message});}
  finally{image?.close();if(canvas){canvas.width=1;canvas.height=1;}}
};
