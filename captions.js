import { brushDefaults, paintBrushStroke } from './brush-stroke.js';
import { fontDescription, glyphFontDescription } from './fonts.js';
import { graphemes, verticalRotation, punctuationCenter } from './typography.js';

export const CAPTION_LIMITS=Object.freeze({transparency:[0,100],borderWidth:[0,80],padding:[0,2000],size:[8,500],textOutlineWidth:[0,80]});
export const CAPTION_ALIGNMENTS=Object.freeze({alignX:{left:'左',center:'中央',right:'右'},alignY:{top:'上',center:'中央',bottom:'下'}});
const limit=(value,min,max)=>Math.max(min,Math.min(max,value));
const alignedStart=(available,used,alignment)=>alignment==='left'||alignment==='top'?-available/2:alignment==='right'||alignment==='bottom'?available/2-used:-used/2;

export function newCaption(width,height) {
  const id=crypto.randomUUID();
  return {id,kind:'caption',presetId:null,shape:'rect',shapeSeed:seedFromId(id),distortion:55,x:width*.23,y:height*.28,
    w:limit(width*.32,30,30000),h:limit(height*.4,30,30000),rotation:0,text:'',
    ...brushDefaults(id),color:'#ffffff',transparency:25,borderColor:'#000000',borderWidth:limit(width*.003,.5,80),
    textColor:'#111111',textOutlineColor:'#ffffff',textOutlineWidth:0,font:'sans',size:limit(Math.round(width*.04),8,500),vertical:true,
    autoFit:true,padding:0,alignX:'center',alignY:'center'};
}

function seedFromId(id) {
  let hash=2166136261;
  for(const char of String(id)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return hash>>>0;
}

export function captionOutline(layer) {
  const {w,h}=layer;
  if(layer.shape!=='spiky')return [{x:-w/2,y:-h/2},{x:w/2,y:-h/2},{x:w/2,y:h/2},{x:-w/2,y:h/2},{x:-w/2,y:-h/2}];
  const count=14,phase=(layer.shapeSeed>>>0)/4294967296*Math.PI*2,amount=(layer.distortion??55)/100,points=[];
  for(let i=0;i<count;i++){
    const angle=-Math.PI/2+i*Math.PI*2/count+phase*.055+Math.sin(i*1.83+phase)*.025*amount;
    const peak=i%2===0,wobble=Math.sin(i*1.71+phase)*.13,radius=(peak?.98:.62)+wobble*amount;
    points.push({x:Math.cos(angle)*w/2*radius,y:Math.sin(angle)*h/2*radius});
  }
  return [...points,points[0]];
}
function captionPath(ctx,layer) {
  ctx.beginPath();
  if(layer.shape!=='spiky'){ctx.rect(-layer.w/2,-layer.h/2,layer.w,layer.h);return;}
  const points=captionOutline(layer);ctx.moveTo(points[0].x,points[0].y);
  for(const p of points.slice(1,-1))ctx.lineTo(p.x,p.y);
  ctx.closePath();
}

export function captionContentBox(layer) {
  const inset=Math.min(layer.padding+layer.borderWidth/2,Math.max(0,Math.min(layer.w,layer.h)/2-.5));
  return {width:Math.max(1,layer.w-inset*2),height:Math.max(1,layer.h-inset*2)};
}

// Layout and fitting share the same font metrics as painting and PNG export.
export function captionLayout(ctx,layer,sizeOverride) {
  ctx.save();
  try {
    const box=captionContentBox(layer),outline=layer.textOutlineWidth??0,
      textWidth=Math.max(1,box.width-outline*2),textHeight=Math.max(1,box.height-outline*2),
      description=fontDescription(layer),lines=layer.text.split('\n').map(graphemes);
    const atSize=size=>{
      const font=`${description.weight} ${size}px ${description.family}`;
      ctx.font=font;ctx.textAlign='left';ctx.textBaseline='alphabetic';
      if(!layer.text)return {size,font,glyphs:[],width:0,height:0,innerWidth:box.width,innerHeight:box.height,fits:true};
      const measured=new Map();
      for(const char of lines.flat())if(!measured.has(char)){
        const glyphDescription=glyphFontDescription(ctx,layer,char),glyphFont=`${glyphDescription.weight} ${size}px ${glyphDescription.family}`;ctx.font=glyphFont;
        const m=ctx.measureText(char),left=m.actualBoundingBoxLeft||0,right=m.actualBoundingBoxRight??m.width,
          ascent=m.actualBoundingBoxAscent??size*.8,descent=m.actualBoundingBoxDescent??size*.2;
        measured.set(char,{char,font:glyphFont,left,right,ascent,descent,width:Math.max(m.width,left+right),height:Math.max(0,ascent+descent),rotate:layer.vertical&&verticalRotation(char)!==0});
      }
      const metrics=[...measured.values()],glyphs=[];
      let width=0,height=0;
      if(layer.vertical){
        const advance=Math.max(size*1.12,...metrics.map(m=>m.rotate?m.width:m.height));
        const columnWidth=Math.max(size*1.3,...metrics.map(m=>m.rotate?m.height:m.width));
        const count=Math.max(1,Math.floor(textHeight/advance)),columns=[];
        for(const chars of lines){if(!chars.length)columns.push([]);for(let i=0;i<chars.length;i+=count)columns.push(chars.slice(i,i+count));}
        width=columns.length*columnWidth;height=Math.max(0,...columns.map(column=>column.length*advance));
        const startX=alignedStart(textWidth,width,layer.alignX??'center');
        columns.forEach((column,i)=>column.forEach((char,j)=>{
          const m=measured.get(char),corner=punctuationCenter(char,size,true,m.left+m.right,m.height);
          glyphs.push({...m,x:startX+(columns.length-i-.5)*columnWidth+corner.x,y:alignedStart(textHeight,column.length*advance,layer.alignY??'center')+(j+.5)*advance+corner.y});
        }));
      }else{
        const advance=Math.max(size*1.3,...metrics.map(m=>m.height)),rows=[];
        for(const chars of lines){
          let row=[],rowWidth=0;
          for(const char of chars){const m=measured.get(char);if(row.length&&rowWidth+m.width>textWidth){rows.push(row);row=[];rowWidth=0;}row.push(m);rowWidth+=m.width;}
          rows.push(row);
        }
        width=Math.max(0,...rows.map(row=>row.reduce((sum,m)=>sum+m.width,0)));height=rows.length*advance;
        const startY=alignedStart(textHeight,height,layer.alignY??'center');
        rows.forEach((row,i)=>{let x=alignedStart(textWidth,row.reduce((sum,m)=>sum+m.width,0),layer.alignX??'center');for(const m of row){glyphs.push({...m,x:x+m.width/2,y:startY+(i+.5)*advance});x+=m.width;}});
      }
      width+=outline*2;height+=outline*2;
      return {size,font,glyphs,width,height,innerWidth:box.width,innerHeight:box.height,fits:width<=box.width+.001&&height<=box.height+.001};
    };
    if(sizeOverride!==undefined)return atSize(sizeOverride);
    if(!layer.autoFit||!layer.text)return atSize(layer.size);
    let low=2,high=1000,best=atSize(1);
    while(low<=high){const mid=Math.floor((low+high)/2),candidate=atSize(mid/2);if(candidate.fits){best=candidate;low=mid+1;}else high=mid-1;}
    return best;
  } finally {ctx.restore();}
}

export function paintCaption(ctx,layer) {
  ctx.save();ctx.globalAlpha*=1-layer.transparency/100;ctx.fillStyle=layer.color;captionPath(ctx,layer);
  ctx.fill();ctx.restore();
  if(layer.borderWidth>0){
    if(['brush','dry-brush'].includes(layer.borderStyle))paintBrushStroke(ctx,captionOutline(layer),layer);
    else {captionPath(ctx,layer);ctx.strokeStyle=layer.borderColor;ctx.lineWidth=layer.borderWidth;ctx.lineJoin='miter';ctx.stroke();}
  }
  const layout=captionLayout(ctx,layer);
  ctx.save();captionPath(ctx,{...layer,w:layout.innerWidth,h:layout.innerHeight});ctx.clip();
  ctx.font=layout.font;ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillStyle=layer.textColor;
  const outline=layer.textOutlineWidth??0;
  ctx.strokeStyle=layer.textOutlineColor??'#ffffff';ctx.lineWidth=outline*2;ctx.lineJoin='round';
  for(const stroke of outline>0?[true,false]:[false])for(const glyph of layout.glyphs){
    ctx.font=glyph.font;
    ctx.save();ctx.translate(glyph.x,glyph.y);if(glyph.rotate)ctx.rotate(Math.PI/2);
    const x=(glyph.left-glyph.right)/2,y=(glyph.ascent-glyph.descent)/2;
    if(stroke)ctx.strokeText(glyph.char,x,y);else ctx.fillText(glyph.char,x,y);
    ctx.restore();
  }
  ctx.restore();
}
