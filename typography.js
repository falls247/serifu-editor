const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('ja',{granularity:'grapheme'}):null;
export const graphemes=text=>segmenter?[...segmenter.segment(text)].map(part=>part.segment):Array.from(text);
export const verticalRotation=char=>'ー―…‥（）「」『』【】〈〉《》'.includes(char)?Math.PI/2:0;
export const isCornerPunctuation=char=>'、。，．､｡,.'.includes(char);

// Position the actual ink at the top-right of its vertical em cell, regardless of font bearings.
export function punctuationCenter(char,size,vertical,width,height) {
  return vertical&&isCornerPunctuation(char)?{x:size*.43-width/2,y:-size*.43+height/2}:{x:0,y:0};
}
export function verticalPunctuationOffset(ctx,char,size,vertical) {
  if(!vertical||!isCornerPunctuation(char))return {x:0,y:0};
  const m=ctx.measureText(char),left=m.actualBoundingBoxLeft??m.width/2,right=m.actualBoundingBoxRight??m.width/2,
    ascent=m.actualBoundingBoxAscent??size*.4,descent=m.actualBoundingBoxDescent??size*.4;
  const center=punctuationCenter(char,size,true,left+right,ascent+descent);
  return {x:center.x-(right-left)/2,y:center.y-(descent-ascent)/2};
}
