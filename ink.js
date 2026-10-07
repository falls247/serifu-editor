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
export function dilateMask(source,width,height,radius) {
  radius=Math.ceil(radius);
  if(!radius)return new Uint8ClampedArray(source);
  let input=source;
  for(const vertical of [false,true]){
    const out=new Uint8ClampedArray(input.length),length=vertical?height:width,lines=vertical?width:height,stride=vertical?width:1,queue=new Int32Array(length);
    for(let line=0;line<lines;line++){
      const start=vertical?line:line*width;let head=0,tail=0,next=0;
      for(let k=0;k<length;k++){
        while(next<length&&next<=k+radius){
          while(tail>head&&input[start+queue[tail-1]*stride]<=input[start+next*stride])tail--;
          queue[tail++]=next++;
        }
        while(tail>head&&queue[head]<k-radius)head++;
        out[start+k*stride]=input[start+queue[head]*stride];
      }
    }
    input=out;
  }
  return input;
}
