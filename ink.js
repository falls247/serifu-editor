// Pure alpha-mask operations. Seeded texture keeps preview, export and restored drafts identical.
export function inkSeed(text) {
  let seed=2166136261;
  for(const char of text){seed^=char.codePointAt(0);seed=Math.imul(seed,16777619);}
  return seed>>>0;
}
function random(seed) {
  let value=seed||1;
  return ()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return (value>>>0)/4294967296;};
}
function noise(x,y,seed) {
  let value=Math.imul(x+1,374761393)^Math.imul(y+1,668265263)^seed;
  value=Math.imul(value^(value>>>13),1274126177);return ((value^(value>>>16))>>>0)/4294967296;
}
export function glyphVariation(seed,index,sizeVariation=0,horizontalJitter=0) {
  return {
    scale:sizeVariation?1+(noise(index,0,seed)*2-1)*sizeVariation/100:1,
    shift:horizontalJitter?(noise(index,1,seed)*2-1)*horizontalJitter/100:0,
  };
}
export function distressMask(source,width,height,{size,roughness=0,dryInk=0,brushTails=0,seed=1}) {
  const alpha=new Uint8ClampedArray(source),rnd=random(seed);
  if(!roughness&&!dryInk&&!brushTails)return alpha;
  let left=width,top=height,right=-1,bottom=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(source[y*width+x]>64){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  if(right<left)return alpha;
  const at=(x,y)=>x<0||y<0||x>=width||y>=height?0:source[y*width+x];
  if(brushTails){
    // Attach tapered fibres to actual upper/lower contours, rather than decorating the text box.
    const step=Math.max(2,Math.round(size*.035)),reach=size*brushTails/100*.65;
    const candidates=[];
    for(let x=left;x<=right;x+=step)for(const direction of [-1,1]){
      let y=direction<0?top:bottom;
      while(y>=top&&y<=bottom&&at(x,y)<96)y-=direction;
      if(y<top||y>bottom)continue;
      const insideY=y-direction*Math.max(2,Math.round(size*.035));
      let support=0;
      for(let dx=-Math.round(size*.22);dx<=size*.22;dx++)if(at(x+dx,insideY)>96)support++;
      if(!support||support>size*.36)continue;
      candidates.push({x,y,direction,priority:rnd()});
    }
    candidates.sort((a,b)=>a.priority-b.priority);
    for(const {x,y,direction} of candidates.slice(0,Math.round(3+brushTails/100*10))){
      const length=Math.max(2,reach*(.3+rnd()*.7)),drift=(rnd()-.5)*length*.3,half=Math.max(.6,size*.009*(.5+rnd()));
      for(let t=0;t<length;t++){
        const cy=Math.round(y+direction*t),cx=x+drift*t/length,thickness=half*(1-t/length);
        if(cy<0||cy>=height)continue;
        for(let px=Math.floor(cx-thickness);px<=Math.ceil(cx+thickness);px++)if(px>=0&&px<width){
          const coverage=Math.max(0,Math.min(1,thickness+.65-Math.abs(px-cx)));
          alpha[cy*width+px]=Math.max(alpha[cy*width+px],Math.round(255*coverage));
        }
      }
    }
  }
  if(roughness){
    const radius=Math.max(1,Math.round(size*.027*roughness/100));
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
      const i=y*width+x;
      if(!source[i])continue;
      const edge=Math.min(at(x-radius,y),at(x+radius,y),at(x,y-radius),at(x,y+radius))<source[i]*.5;
      if(edge&&noise(Math.floor(x/2),Math.floor(y/2),seed)>1-roughness/100*.82)alpha[i]*=.08+noise(x,y,seed^8191)*.3;
    }
  }
  if(dryInk){
    const amount=dryInk/100,count=Math.ceil(8+amount*36);
    for(let strand=0;strand<count;strand++){
      const x0=left+rnd()*(right-left),y0=top+rnd()*(bottom-top),length=size*(.12+rnd()*.7)*amount;
      const drift=(rnd()-.5)*size*.12,half=size*(.002+rnd()*.016)*amount,direction=rnd()>.5?1:-1;
      for(let t=0;t<length;t++){
        const y=Math.round(y0+direction*t),x=x0+drift*t/Math.max(1,length)+Math.sin(t/size*9+strand)*size*.008;
        if(y<0||y>=height)continue;
        const taper=Math.sin(Math.PI*(t+.5)/(length+1));
        for(let px=Math.floor(x-half);px<=Math.ceil(x+half);px++)if(px>=0&&px<width){
          const cut=Math.max(0,Math.min(1,half*taper+.55-Math.abs(px-x)));
          alpha[y*width+px]*=1-cut*.98;
        }
      }
    }
  }
  return alpha;
}

function boxBlur(source,width,height,radius,vertical) {
  const out=new Float32Array(source.length),lines=vertical?width:height,length=vertical?height:width,stride=vertical?width:1;
  const window=radius*2+1;
  for(let line=0;line<lines;line++){
    const start=vertical?line:line*width;
    let sum=0;
    for(let k=0;k<=Math.min(radius,length-1);k++)sum+=source[start+k*stride];
    for(let k=0;k<length;k++){
      out[start+k*stride]=sum/window;
      if(k-radius>=0)sum-=source[start+(k-radius)*stride];
      if(k+radius+1<length)sum+=source[start+(k+radius+1)*stride];
    }
  }
  return out;
}
export function directionalBlur(source,width,height,blurX=0,blurY=0) {
  let result=source;
  // Three box passes approximate a Gaussian along each axis, without Canvas filter support.
  for(const [amount,vertical] of [[blurX,false],[blurY,true]])if(amount>0){
    const radius=Math.max(1,Math.round(amount*.58));
    for(let pass=0;pass<3;pass++)result=boxBlur(result,width,height,radius,vertical);
  }
  return new Uint8ClampedArray(result);
}
function extremeMask(source,width,height,radius,expand) {
  radius=Math.ceil(radius);
  if(!radius)return new Uint8ClampedArray(source);
  let input=source;
  for(const vertical of [false,true]){
    const out=new Uint8ClampedArray(input.length),length=vertical?height:width,lines=vertical?width:height,stride=vertical?width:1,queue=new Int32Array(length);
    for(let line=0;line<lines;line++){
      const start=vertical?line:line*width;let head=0,tail=0,next=0;
      for(let k=0;k<length;k++){
        while(next<length&&next<=k+radius){
          while(tail>head&&(expand?input[start+queue[tail-1]*stride]<=input[start+next*stride]:input[start+queue[tail-1]*stride]>=input[start+next*stride]))tail--;
          queue[tail++]=next++;
        }
        while(tail>head&&queue[head]<k-radius)head++;
        out[start+k*stride]=!expand&&(k<radius||k>=length-radius)?0:input[start+queue[head]*stride];
      }
    }
    input=out;
  }
  return input;
}
export function dilateMask(source,width,height,radius) {
  return extremeMask(source,width,height,radius,true);
}
export function adjustInkThickness(source,width,height,amount=0) {
  // Expand/erode glyph ink rather than changing its advance or relying on synthetic font weights.
  const radius=Math.abs(amount),whole=Math.floor(radius),fraction=radius-whole;
  const base=extremeMask(source,width,height,whole,amount>=0);
  if(!fraction)return base;
  const next=extremeMask(source,width,height,whole+1,amount>=0);
  for(let i=0;i<base.length;i++)base[i]=base[i]*(1-fraction)+next[i]*fraction;
  return base;
}


// Deterministic distressed-print texture. All three masks are local to the glyph.
// A missing glyph never generates spatter; removed ink is always transparent.
export function printDistressMask(source,width,height,{size=100,grungeAmount=65,scratchLength=55,scratchAngle=90,spatterAmount=40,seed=1}={}) {
  const body=new Uint8ClampedArray(source),speckles=new Uint8ClampedArray(source.length),knockout=new Uint8ClampedArray(source.length);
  if(!grungeAmount&&!spatterAmount)return {body,speckles,knockout};
  let left=width,top=height,right=-1,bottom=-1,inkCount=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(source[y*width+x]>64){
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);inkCount++;
  }
  if(right<left)return {body,speckles,knockout};
  const amount=grungeAmount/100,rnd=random(seed>>>0),scale=Math.max(1,size);
  if(amount){
    const grain=Math.max(1,Math.round(scale*.014));
    // Correlated pinholes and edge chips; thresholds are fixed for each seed.
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
      const i=y*width+x,v=source[i];if(!v)continue;
      const cloud=noise(Math.floor(x/(grain*5)),Math.floor(y/(grain*5)),seed^0x74ab);
      const n=noise(Math.floor(x/grain),Math.floor(y/grain),seed^0x1997);
      const grit=noise(x,y,seed^0x9328);
      const intensity=(n*.65+grit*.35)*(.55+cloud*.9);
      const isEdge=(x===0||y===0||x===width-1||y===height-1||source[i-1]<96||source[i+1]<96||source[i-width]<96||source[i+width]<96);
      const threshold=(isEdge?.17:.075)*amount;
      if(intensity<threshold)body[i]=grit>.18?0:Math.round(v*.2);
    }
    if(scratchLength>0){
      const count=Math.min(180,Math.ceil(6+scale*.23*amount));
      const theta=scratchAngle*Math.PI/180,dx=Math.cos(theta),dy=Math.sin(theta);
      for(let mark=0;mark<count;mark++){
        const x0=left+rnd()*(right-left),y0=top+rnd()*(bottom-top);
        const length=scale*(.08+rnd()*.75)*scratchLength/100;
        const half=Math.max(.35,scale*(.0015+rnd()*.008)*(.4+amount*.6));
        const wiggle=rnd()*Math.PI*2,step=Math.max(1,Math.round(length*.02));
        for(let t=0;t<length;t+=step){
          const taper=Math.sin(Math.PI*(t+.5)/(length+1));
          const drift=Math.sin(t/Math.max(1,scale)*12+wiggle)*scale*.007;
          const px=x0+dx*t-dy*drift,py=y0+dy*t+dx*drift;
          const rad=Math.max(.35,half*taper);
          for(let yy=Math.max(top,Math.floor(py-rad-1));yy<=Math.min(bottom,Math.ceil(py+rad+1));yy++)
            for(let xx=Math.max(left,Math.floor(px-rad-1));xx<=Math.min(right,Math.ceil(px+rad+1));xx++){
              const d=Math.abs((xx-px)*dy-(yy-py)*dx);
              const along=(xx-px)*dx+(yy-py)*dy;
              if(d>rad+.35||Math.abs(along-t)>step+1)continue;
              const i=yy*width+xx;
              if(source[i]&&noise(xx,yy,seed^mark)>.12)body[i]=Math.min(body[i],Math.round(source[i]*Math.max(0,1-(rad+.35-d)*.94)));
            }
        }
      }
    }
  }
  // Fly-specks remain within a narrow halo and only attach near actual body pixels.
  if(spatterAmount>0){
    const count=Math.min(190,Math.ceil(scale*.48*spatterAmount/100));
    const halo=Math.max(2,Math.round(scale*.05)),radius=Math.max(1,Math.round(scale*.02));
    for(let mark=0;mark<count;mark++){
      const x=Math.round(left-halo+rnd()*(right-left+halo*2));
      const y=Math.round(top-halo+rnd()*(bottom-top+halo*2));
      if(x<0||y<0||x>=width||y>=height||source[y*width+x])continue;
      let near=false;
      for(let tries=0;tries<8&&!near;tries++){
        const a=tries*Math.PI/4;
        const xx=Math.round(x+Math.cos(a)*halo),yy=Math.round(y+Math.sin(a)*halo);
        near=xx>=0&&yy>=0&&xx<width&&yy<height&&source[yy*width+xx]>96;
      }
      if(!near)continue;
      const dot=Math.max(.6,scale*(.002+rnd()*.007))*Math.min(1,spatterAmount/30);
      for(let yy=Math.max(0,Math.floor(y-dot));yy<=Math.min(height-1,Math.ceil(y+dot));yy++)
        for(let xx=Math.max(0,Math.floor(x-dot));xx<=Math.min(width-1,Math.ceil(x+dot));xx++){
          const i=yy*width+xx,d=Math.hypot(xx-x,yy-y);
          if(d<=dot+.2&&!source[i])speckles[i]=Math.max(speckles[i],Math.round(210*Math.min(1,dot+.2-d)));
        }
    }
  }
  for(let i=0;i<body.length;i++)knockout[i]=Math.max(0,source[i]-body[i]);
  return {body,speckles,knockout};
}
