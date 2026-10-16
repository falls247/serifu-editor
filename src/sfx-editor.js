import {sfxScene,sfxItemHit,sfxResolvedGroups,paintEditedSfx} from './renderer.js';
import {strokeGeometry,strokeFrame,pathToLocal,localToPath,bezierPoint,moveCurvePoint,addCurvePoint,removeCurvePoint,addWidthPoint,removeWidthPoint} from './sfx-stroke-geometry.js';
import {glyphSelection,selectGlyph,freezeGlyphOrigins,duplicateSelectedGlyphs,transformGlyphSelection,transformStrokeSelection,selectionRegion} from './sfx-edit-operations.js';

export const sceneFor=(p,l)=>sfxScene(p.canvas.getContext('2d'),l);
const boundsOf=items=>items.length?{minX:Math.min(...items.map(i=>i.bounds.minX)),maxX:Math.max(...items.map(i=>i.bounds.maxX)),minY:Math.min(...items.map(i=>i.bounds.minY)),maxY:Math.max(...items.map(i=>i.bounds.maxY))}:null;
const selectedSceneItems=(scene,mode,strokeRuns=mode.strokeRuns||[])=>scene.items.filter(item=>item.type==='glyph'?glyphSelection(mode).includes(item.index):mode.editMode==='glyph'&&strokeRuns.includes(item.stroke.runStart));
export function nearestStrokeHandle(handles,point,radius){
  let closest=null,distance=Infinity;
  for(const handle of handles){const next=Math.hypot(handle.x-point.x,handle.y-point.y);if(next<=radius&&next<distance){closest=handle;distance=next;}}
  return closest;
}
export function strokeHandles(scene,l,mode){
  const run=l.lettering.strokes.find(s=>s.runStart===mode.strokeRun);if(!run||run.mode!=='continuous'||mode.editMode==='glyph')return [];
  const frame=strokeFrame(run,scene.positions,{vertical:l.vertical,size:l.size});if(!frame)return [];
  const list=[];
  if(mode.editMode!=='width')run.path.points.forEach((p,i)=>list.push({kind:'curve',index:i,run:run.runStart,...pathToLocal(frame,p)}));
  if(mode.editMode!=='curve')for(let i=0;i<run.widths.length;i++){const knot=run.widths[i],p=pathToLocal(frame,bezierPoint(run.path.points,knot.t));list.push({kind:'width',index:i,run:run.runStart,x:p.x+frame.nx*knot.w/2,y:p.y+frame.ny*knot.w/2});}
  return list;
}
export function beginLetteringGesture(p,l,mode,event,point,scale,{render,magnify}={}){
  mode.touches??=new Map();
  if(event.pointerType==='touch'){
    mode.touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(mode.touches.size===2){
      if(p.glyphDrag){Object.assign(l,p.glyphDrag.before);if(p.glyphDrag.changed)p.undo.length=p.glyphDrag.undo;p.redo=p.glyphDrag.redo;clearTimeout(p.glyphDrag.longPress);p.glyphDrag=null;}
      const points=[...mode.touches.values()],frame=p.canvas.parentElement;
      mode.pan={zoom:p.sfxZoom||1,distance:Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y),x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2,width:parseFloat(p.canvas.style.width),scrollX:frame.scrollLeft,scrollY:frame.scrollTop};
      p.canvas.setPointerCapture(event.pointerId);return true;
    }
  }
  if(!event.isPrimary||event.button!==0)return true;
  const scene=sceneFor(p,l),handles=strokeHandles(scene,l,mode),radius=(event.pointerType==='touch'?18:10)/Math.max(.01,scale);
  const handle=nearestStrokeHandle(handles,point,radius);
  const selectedBounds=boundsOf(selectedSceneItems(scene,mode));
  let operation='move',picked=null;
  if(handle){operation=handle.kind;mode.pointSelection=event.shiftKey?[...(mode.pointSelection||[]).filter(h=>h.kind!==handle.kind||h.index!==handle.index),handle]:[handle];if(handle.kind==='curve')mode.strokePoint=handle.index;else mode.widthIndex=handle.index;}
  else if(selectedBounds&&Math.hypot(point.x-selectedBounds.maxX,point.y-selectedBounds.maxY)<=radius)operation='scale';
  else if(selectedBounds&&Math.hypot(point.x-(selectedBounds.minX+selectedBounds.maxX)/2,point.y-(selectedBounds.minY-25/scale))<=radius)operation='rotate';
  else{
    let candidates=scene.items.filter(i=>sfxItemHit(i,point)).reverse();
    if(mode.priority==='stroke')candidates.sort((a,b)=>(b.type==='stroke')-(a.type==='stroke'));
    if(mode.priority==='glyph')candidates.sort((a,b)=>(b.type==='glyph')-(a.type==='glyph'));
    if(event.altKey){const previous=mode.hitCycle?.point;if(previous&&Math.hypot(previous.x-point.x,previous.y-point.y)<radius)mode.hitCycle.index=(mode.hitCycle.index+1)%Math.max(1,candidates.length);else mode.hitCycle={point,index:Math.min(1,candidates.length-1)};picked=candidates[mode.hitCycle.index];}
    else{mode.hitCycle={point,index:0};picked=candidates[0];}
    if(picked?.type==='glyph'){
      if(mode.priority==='group'){
        const group=sfxResolvedGroups(scene,l.lettering).find(g=>g.members.includes(picked.index));mode.indices=group?.members??[picked.index];mode.selected=picked.index;
      }else if(event.shiftKey)selectGlyph(mode,picked.index,{toggle:true});
      else if(event.altKey||!glyphSelection(mode).includes(picked.index))selectGlyph(mode,picked.index);else mode.selected=picked.index;
      mode.strokeRuns=[];mode.editMode='glyph';mode.pointSelection=[];
    }else if(picked?.type==='stroke'){
      mode.strokeRun=picked.stroke.runStart;mode.strokeRuns=event.shiftKey?[...new Set([...(mode.strokeRuns||[]),picked.stroke.runStart])]:[picked.stroke.runStart];mode.indices=[];mode.selected=null;mode.editMode='glyph';mode.pointSelection=[];operation='move';
    }else{operation=event.pointerType==='touch'&&mode.selectionTool!=='lasso'&&mode.selectionTool!=='rectangle'?'pan':mode.selectionTool==='lasso'?'lasso':'rectangle';if(!event.shiftKey){mode.indices=[];mode.selected=null;mode.strokeRuns=[];}}
  }
  const strokeRuns=mode.editMode==='glyph'?[...(mode.strokeRuns||[])]:[];
  const gesture=p.glyphDrag={id:event.pointerId,anchor:point,screen:{x:event.clientX,y:event.clientY},operation,narrowOnClick:picked?.type==='glyph'&&!event.shiftKey&&mode.priority!=='group'&&glyphSelection(mode).length>1,handle,scene,selection:glyphSelection(mode),strokeRuns,before:structuredClone(l),undo:p.undo.length,redo:p.redo.slice(),done:p.done,edited:p.edited,region:[point],copy:(event.ctrlKey||event.metaKey)&&operation==='move'&&!strokeRuns.length,scrollX:p.canvas.parentElement.scrollLeft,scrollY:p.canvas.parentElement.scrollTop};
  if(event.pointerType==='touch')gesture.longPress=setTimeout(()=>{if(p.glyphDrag===gesture&&!gesture.changed)magnify?.();},450);
  p.canvas.setPointerCapture(event.pointerId);p.canvas.focus({preventScroll:true});render?.();return true;
}
export function moveLetteringGesture(p,l,mode,event,point,{checkpoint,render}={}){
  if(event.pointerType==='touch'&&mode.touches?.has(event.pointerId)){
    mode.touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(mode.pan&&mode.touches.size===2){const points=[...mode.touches.values()],frame=p.canvas.parentElement,ratio=Math.max(.5,Math.min(4,Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y)/mode.pan.distance));
      p.sfxZoom=Math.max(.5,Math.min(4,mode.pan.zoom*ratio));p.canvas.style.width=mode.pan.width*ratio+'px';p.canvas.style.height=mode.pan.width*ratio*p.canvas.height/p.canvas.width+'px';frame.scrollLeft=mode.pan.scrollX+mode.pan.x-(points[0].x+points[1].x)/2;frame.scrollTop=mode.pan.scrollY+mode.pan.y-(points[0].y+points[1].y)/2;return true;}
  }
  const g=p.glyphDrag;if(g?.id!==event.pointerId)return false;
  let dx=point.x-g.anchor.x,dy=point.y-g.anchor.y;
  if(Math.hypot(dx,dy)<.1&&!g.changed)return true;
  clearTimeout(g.longPress);
  if(g.operation==='pan'){p.canvas.parentElement.scrollLeft=g.scrollX+g.screen.x-event.clientX;p.canvas.parentElement.scrollTop=g.scrollY+g.screen.y-event.clientY;return true;}
  if(['rectangle','lasso'].includes(g.operation)){if(g.operation==='lasso')g.region.push(point);else g.region=[g.anchor,{x:point.x,y:g.anchor.y},point,{x:g.anchor.x,y:point.y}];render?.();return true;}
  if(!g.changed){checkpoint?.();g.changed=true;
    if(g.copy){g.original=structuredClone(g.before);Object.assign(l,duplicateSelectedGlyphs(l,g.selection,g.scene,{offset:0}));const sorted=g.selection.sort((a,b)=>a-b);mode.indices=sorted.map((i,n)=>i+n+1);mode.selected=mode.indices.at(-1);g.selection=mode.indices;g.before=structuredClone(l);g.scene=sceneFor(p,l);}
  }
  Object.assign(l,structuredClone(g.before));
  if(mode.snap){dx=Math.round(dx/5)*5;dy=Math.round(dy/5)*5;}
  if(event.shiftKey&&g.operation==='move'){if(Math.abs(dx)>Math.abs(dy))dy=0;else dx=0;}
  if(['move','scale','rotate'].includes(g.operation)){
    let transform={dx,dy},center=null;
    if(g.operation!=='move'){const bounds=boundsOf(selectedSceneItems(g.scene,{indices:g.selection,selected:g.selection.at(-1),editMode:'glyph',strokeRuns:g.strokeRuns}));if(!bounds)return true;center={x:(bounds.minX+bounds.maxX)/2,y:(bounds.minY+bounds.maxY)/2};
      transform=g.operation==='rotate'?{rotation:(Math.atan2(point.y-center.y,point.x-center.x)-Math.atan2(g.anchor.y-center.y,g.anchor.x-center.x))*180/Math.PI}:{scaleX:Math.max(.05,Math.min(20,(point.x-center.x)/(g.anchor.x-center.x||1))),scaleY:Math.max(.05,Math.min(20,(point.y-center.y)/(g.anchor.y-center.y||1)))};
    }
    const withCenter=g.strokeRuns.length?{...transform,center:center??{x:0,y:0}}:transform;
    const strokeMembers=new Set(l.lettering.strokes.filter(run=>run.mode==='continuous'&&g.strokeRuns.includes(run.runStart)).flatMap(run=>Array.from({length:run.runLength},(_,i)=>run.runStart+i)));
    const glyphSelectionIndices=g.selection.filter(index=>!strokeMembers.has(index));
    if(glyphSelectionIndices.length)transformGlyphSelection(l,glyphSelectionIndices,g.scene,withCenter);
    if(g.strokeRuns.length)transformStrokeSelection(l,g.strokeRuns,g.scene,{...transform,center:center??{x:0,y:0}});
  }else if(g.operation==='stroke'){
    for(const run of l.lettering.strokes.filter(s=>(mode.strokeRuns||[]).includes(s.runStart))){const old=strokeFrame(run,g.scene.positions,{vertical:l.vertical,size:l.size});if(!old)continue;for(const side of ['start','end']){const origin=side==='start'?old.start:old.end;run[side].detached=true;run[side].fixedPosition={x:origin.x+dx,y:origin.y+dy};}}
  }else{
    for(const handle of mode.pointSelection||[g.handle]){
      const run=l.lettering.strokes.find(s=>s.runStart===handle.run);if(!run)continue;const frame=strokeFrame(run,g.scene.positions,{vertical:l.vertical,size:l.size});if(!frame)continue;
      if(handle.kind==='curve'){
        const original=pathToLocal(frame,run.path.points[handle.index]),target={x:original.x+dx,y:original.y+dy};
        if(handle.index===0||handle.index===run.path.points.length-1){const side=handle.index===0?'start':'end';run[side].detached=true;run[side].fixedPosition=target;}
        else Object.assign(run,moveCurvePoint(run,handle.index,localToPath(frame,target),{mode:run.path.handleMode}));
      }else{
        const knot=run.widths[handle.index],target={x:handle.x+dx,y:handle.y+dy};let best={distance:Infinity,t:knot.t};
        for(let i=0;i<=100;i++){const t=i/100,p=pathToLocal(frame,bezierPoint(run.path.points,t)),distance=Math.hypot(target.x-p.x,target.y-p.y);if(distance<best.distance)best={distance,t};}
        if(handle.index>0&&handle.index<run.widths.length-1)knot.t=Math.max(run.widths[handle.index-1].t+.001,Math.min(run.widths[handle.index+1].t-.001,best.t));
        knot.w=Math.max(0,Math.min(500,best.distance*2));if(knot.fixed)knot.distance=knot.t*frame.length;
      }
    }
  }
  render?.();return true;
}
export function endLetteringGesture(p,l,mode,event,{commit,render}={}){
  mode.touches?.delete(event.pointerId);if(mode.pan){mode.pan=null;return true;}
  const g=p.glyphDrag;if(g?.id!==event.pointerId)return false;clearTimeout(g.longPress);p.glyphDrag=null;
  if(event.type!=='pointerup'){
    // A duplicate gesture's original state is held separately for full rollback.
    Object.assign(l,g.original??g.before);if(g.changed)p.undo.length=g.undo;p.redo=g.redo;p.done=g.done;p.edited=g.edited;
  }else if(['rectangle','lasso'].includes(g.operation)){
    const chosen=selectionRegion(g.scene.items,g.region,{contain:g.operation==='rectangle'&&g.region[2]?.x>g.anchor.x,hit:sfxItemHit});
    mode.indices=[...new Set([...(mode.indices||[]),...chosen.filter(i=>i.type==='glyph').map(i=>i.index)])];mode.selected=mode.indices.at(-1)??null;mode.strokeRuns=[...new Set([...(mode.strokeRuns||[]),...chosen.filter(i=>i.type==='stroke').map(i=>i.stroke.runStart)])];
  }else if(g.changed)commit?.();else if(g.narrowOnClick)mode.indices=mode.selected==null?[]:[mode.selected];
  if(p.canvas.hasPointerCapture(event.pointerId))p.canvas.releasePointerCapture(event.pointerId);render?.();return true;
}
export function drawLetteringOverlay(ctx,l,mode,scene,scale,gesture){
  ctx.strokeStyle='#00bfff';ctx.fillStyle='#182d3b';ctx.lineWidth=2/scale;ctx.setLineDash([5/scale,3/scale]);
  const selected=scene.items.filter(i=>i.type==='glyph'?glyphSelection(mode).includes(i.index):(mode.strokeRuns||[]).includes(i.stroke.runStart));
  for(const item of selected){const b=item.bounds;ctx.strokeRect(b.minX-3/scale,b.minY-3/scale,b.maxX-b.minX+6/scale,b.maxY-b.minY+6/scale);}
  const boundsItems=mode.editMode==='glyph'?selected:selected.filter(i=>i.type==='glyph');
  const bounds=boundsOf(boundsItems),boxRadius=(mode.touch?12:7)/scale,pointRadius=boxRadius/2;ctx.setLineDash([]);
  if(bounds){ctx.fillRect(bounds.maxX-boxRadius,bounds.maxY-boxRadius,boxRadius*2,boxRadius*2);ctx.strokeRect(bounds.maxX-boxRadius,bounds.maxY-boxRadius,boxRadius*2,boxRadius*2);ctx.beginPath();ctx.arc((bounds.minX+bounds.maxX)/2,bounds.minY-25/scale,boxRadius,0,Math.PI*2);ctx.fill();ctx.stroke();}
  const run=l.lettering.strokes.find(s=>s.runStart===mode.strokeRun),frame=run&&strokeFrame(run,scene.positions,{vertical:l.vertical,size:l.size});
  if(frame&&mode.editMode!=='glyph'){ctx.strokeStyle='#00bfff88';ctx.beginPath();run.path.points.forEach((p,i)=>{const q=pathToLocal(frame,p);if(i)ctx.lineTo(q.x,q.y);else ctx.moveTo(q.x,q.y);});ctx.stroke();}
  const selectedCurves=mode.pointSelection?.filter(h=>h.kind==='curve')??(mode.strokePoint==null?[]:[{run:mode.strokeRun,index:mode.strokePoint}]);
  const handles=strokeHandles(scene,l,mode),isSelected=h=>h.kind==='curve'&&selectedCurves.some(point=>point.run===h.run&&point.index===h.index);
  for(const h of [...handles.filter(h=>!isSelected(h)),...handles.filter(isSelected)]){
    const active=isSelected(h);
    ctx.fillStyle=active?'#ef4b91':h.kind==='curve'?'#00bfff':'#ffba66';ctx.strokeStyle=active?'#762543':'#00bfff';
    ctx.beginPath();ctx.arc(h.x,h.y,pointRadius,0,Math.PI*2);ctx.fill();ctx.stroke();
  }
  if(gesture?.region?.length>1){ctx.strokeStyle='#00bfff';ctx.beginPath();gesture.region.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();}
}
const node=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
export function advancedLetteringPanel(p,l,mode,{edit,render,fonts,copyStroke,pasteStroke,saveStroke,loadStroke}={}){
  const panel=node('details');panel.className='sfx-advanced-panel';panel.append(node('summary','選択・文字の外観・線の制御点'));
  const select=(title,key,values,value,change)=>{const label=node('label',title),control=node('select');control.dataset.sfxEditor=key;for(const [id,name] of values)control.add(new Option(name,id));control.value=String(value);control.onchange=()=>change(control.value);label.append(control);panel.append(label);return control;};
  const numeric=(title,key,value,min,max,change)=>{const label=node('label',title),control=node('input');control.type='number';control.dataset.sfxEditor=key;control.min=min;control.max=max;control.step='any';control.value=value??'';control.placeholder=value==null?'混在':'';control.onchange=()=>{const value=Number(control.value);if(control.value!==''&&Number.isFinite(value)&&value>=min&&value<=max)change(value);};label.append(control);panel.append(label);};
  const action=(title,key,callback)=>{const button=node('button',title);button.type='button';button.dataset.sfxEditorAction=key;button.onclick=event=>{event.stopPropagation();callback();};panel.append(button);};
  select('選択方法','selectionTool',[['click','クリック'],['rectangle','矩形'],['lasso','なげなわ']],mode.selectionTool||'click',value=>{mode.selectionTool=value;render();});
  select('選択優先','priority',[['glyph','文字'],['stroke','線'],['point','制御点'],['group','輪郭グループ']],mode.priority||'glyph',value=>{mode.priority=value;render();});
  select('編集対象','editMode',[['glyph','文字'],['curve','曲線点'],['width','太さ点'],['both','曲線・太さ点']],mode.editMode||'glyph',value=>{mode.editMode=value;render();});
  select('位置スナップ','snap',[['false','なし'],['true','5px']],!!mode.snap,value=>{mode.snap=value==='true';});
  select('数値の適用','valueMode',[['absolute','絶対値'],['add','差分加算'],['multiply','倍率']],mode.valueMode||'absolute',value=>{mode.valueMode=value;});
  select('自動配置','layoutMode',[['readable','読みやすさ'],['overlap','重なり']],l.lettering.layoutMode,value=>edit(()=>{l.lettering.layoutMode=value;}));
  numeric('重なり強度','overlapIntensity',l.lettering.overlapIntensity,0,100,value=>edit(()=>{l.lettering.overlapIntensity=value;}));
  select('外側輪郭','outlineMode',[['individual','個別'],['union','文字集合']],l.lettering.outlineMode,value=>edit(()=>{l.lettering.outlineMode=value;}));
  select('個別輪郭の幅','outlineScale',[['false','出力pxを維持'],['true','変形と拡縮']],l.lettering.outlineScale,value=>edit(()=>{l.lettering.outlineScale=value==='true';}));
  const indices=glyphSelection(mode),glyphs=l.lettering.glyphs.filter(g=>indices.includes(g.index)),first=glyphs[0];
  action('全文字を選択','select-all',()=>{mode.indices=l.lettering.glyphs.map(g=>g.index);mode.selected=mode.indices[0]??null;render();});
  action('同じ位置へ複製','duplicate-in-place',()=>edit(()=>{const scene=sceneFor(p,l),selection=glyphSelection(mode);Object.assign(l,duplicateSelectedGlyphs(l,selection,scene,{offset:0}));mode.indices=selection.sort((a,b)=>a-b).map((i,n)=>i+n+1);mode.selected=mode.indices[0];}));
  for(const kind of ['position','transform','style'])action(({position:'位置',transform:'変形',style:'外観'})[kind]+'だけリセット','reset-'+kind,()=>edit(()=>{for(const g of glyphs){if(kind==='position'){g.origin=null;g.dx=g.dy=0;}if(kind==='transform'){g.rotation=g.shear=0;g.scaleX=g.scaleY=1;}if(kind==='style')g.overrides={font:null,fill:null,outlineColor:null,outlineWidth:null};g.manual[kind]=false;}}));
  if(first){
    select('文字の方向','orientationOverride',[['auto','自動'],['upright','正立'],['sideways','横倒し'],['tate-chu-yoko','縦中横']],first.orientationOverride,value=>edit(()=>glyphs.forEach(g=>{g.orientationOverride=value;g.manual.transform=true;})));
    select('回転・倍率の中心','pivot',[...['center','top-left','top','top-right','left','right','bottom-left','bottom','bottom-right','custom']].map((key,i)=>[key,['中央','左上','上','右上','左','右','左下','下','右下','指定'][i]]),first.pivot.preset,value=>edit(()=>glyphs.forEach(g=>g.pivot.preset=value)));
    for(const axis of ['x','y'])numeric('中心 '+axis,'pivot-'+axis,first.pivot[axis],-30000,30000,value=>edit(()=>glyphs.forEach(g=>{g.pivot.preset='custom';g.pivot[axis]=value;})));
    select('文字の書体','font',[['','SFX共通'],...Object.entries(fonts).map(([key,value])=>[key,value.label])],first.overrides.font??'',value=>edit(()=>glyphs.forEach(g=>{g.overrides.font=value||null;g.manual.style=true;})));
    for(const [key,title,fallback] of [['fill','文字色',l.color],['outlineColor','輪郭色',l.textOutlineColor??'#ffffff']]){const label=node('label',title),input=node('input');input.type='color';input.dataset.sfxEditor=key;input.value=first.overrides[key]??fallback;input.onchange=()=>edit(()=>glyphs.forEach(g=>{g.overrides[key]=input.value;g.manual.style=true;}));label.append(input);panel.append(label);}
    numeric('文字の輪郭幅','outlineWidth',first.overrides.outlineWidth??l.outline,0,80,value=>edit(()=>glyphs.forEach(g=>{g.overrides.outlineWidth=value;g.manual.style=true;})));
  }
  const variants=[];
  for(let i=0;i<4;i++){
    const variant=structuredClone(l);variant.lettering.layoutSeed=(Math.imul(l.lettering.layoutSeed+1,1664525)+1013904223+i)>>>0;
    for(const g of variant.lettering.glyphs)if(!g.manual.position){const seed=(variant.lettering.layoutSeed^Math.imul(g.index+1,2654435761))>>>0;g.origin=null;g.dx=(seed%21-10)*l.size*.02;g.dy=((seed>>>8)%21-10)*l.size*.02;}
    action('配置案 '+(i+1),'layout-'+i,()=>edit(()=>{l.lettering=structuredClone(variant.lettering);}));
    const canvas=node('canvas');canvas.width=120;canvas.height=80;canvas.setAttribute('aria-label','配置案 '+(i+1)+' のプレビュー');panel.querySelector('[data-sfx-editor-action=layout-'+i+']').append(canvas);variants.push({variant,canvas});
  }
  const previewVariants=()=>{if(!panel.open)return;for(const {variant,canvas} of variants){const ctx=canvas.getContext('2d'),scene=sfxScene(ctx,variant),b=boundsOf(scene.items);if(!b)continue;const scale=Math.min(110/Math.max(1,b.maxX-b.minX),70/Math.max(1,b.maxY-b.minY));ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,120,80);ctx.translate(60,40);ctx.scale(scale,scale);ctx.translate(-(b.minX+b.maxX)/2,-(b.minY+b.maxY)/2);paintEditedSfx(ctx,variant);}};
  panel.addEventListener('toggle',previewVariants);if(document.fonts)void document.fonts.ready.then(()=>{if(panel.isConnected)previewVariants();});
  const run=l.lettering.strokes.find(s=>s.runStart===mode.strokeRun)??l.lettering.strokes[0];
  if(run){
    mode.strokeRun=run.runStart;
    numeric('選択点の回転','pointRotation',0,-360,360,value=>edit(()=>{const handles=mode.pointSelection||[{kind:'curve',index:mode.strokePoint??1,run:run.runStart}],points=handles.filter(h=>h.kind==='curve'&&h.run===run.runStart).map(h=>run.path.points[h.index]);if(!points.length)return;const x=points.reduce((n,p)=>n+p.x,0)/points.length,y=points.reduce((n,p)=>n+p.y,0)/points.length,a=value*Math.PI/180;for(const p of points){const dx=p.x-x,dy=p.y-y;p.x=x+dx*Math.cos(a)-dy*Math.sin(a);p.y=y+dx*Math.sin(a)+dy*Math.cos(a);}}));
    numeric('選択点の倍率','pointScale',1,.01,20,value=>edit(()=>{const handles=mode.pointSelection||[{kind:'curve',index:mode.strokePoint??1,run:run.runStart}],points=handles.filter(h=>h.kind==='curve'&&h.run===run.runStart).map(h=>run.path.points[h.index]);if(points.length){const x=points.reduce((n,p)=>n+p.x,0)/points.length,y=points.reduce((n,p)=>n+p.y,0)/points.length;for(const p of points){p.x=Math.max(-10,Math.min(10,x+(p.x-x)*value));p.y=Math.max(-10,Math.min(10,y+(p.y-y)*value));}}for(const h of handles.filter(h=>h.kind==='width'&&h.run===run.runStart))run.widths[h.index].w=Math.min(500,run.widths[h.index].w*value);}));
    select('ハンドル','handleMode',[['smooth','滑らか'],['sharp','角'],['independent','左右独立']],run.path.handleMode??'independent',value=>edit(()=>{run.path.handleMode=value;}));
    select('長さロック','lengthLock',[['false','なし'],['true','固定']],run.manualLengthLocked,value=>edit(()=>{run.manualLengthLocked=value==='true';run.lockedLength=strokeFrame(run,sceneFor(p,l).positions,{vertical:l.vertical,size:l.size})?.length??null;}));
    action('曲線点を追加','curve-add',()=>edit(()=>{
      const segments=(run.path.points.length-1)/3,segment=Math.min(segments-1,Math.floor(segments/2));
      Object.assign(run,addCurvePoint(run));
      if(mode.editMode!=='both')mode.editMode='curve';
      mode.strokePoint=segment*3+3;
      mode.pointSelection=[{kind:'curve',index:mode.strokePoint,run:run.runStart}];
    }));
    action('曲線点を削除','curve-remove',()=>edit(()=>Object.assign(run,removeCurvePoint(run,mode.strokePoint??3))));
    action('線幅点を追加','width-add',()=>edit(()=>Object.assign(run,addWidthPoint(run,(mode.widthT??.5)))));
    action('線幅点を削除','width-remove',()=>edit(()=>Object.assign(run,removeWidthPoint(run,mode.widthIndex??1))));
    select('線幅点','widthIndex',run.widths.map((_,i)=>[String(i),String(i+1)+'番']),mode.widthIndex??0,value=>{mode.widthIndex=Number(value);mode.pointSelection=[{kind:'width',index:mode.widthIndex,run:run.runStart}];if(mode.editMode!=='both')mode.editMode='width';render();});
    const currentKnot=()=>run.widths[Math.min(mode.widthIndex??0,run.widths.length-1)],knot=currentKnot();
    numeric('線幅点の位置','widthT',knot.t,0,1,value=>edit(()=>{const knot=currentKnot(),i=run.widths.indexOf(knot);if(i>0&&i<run.widths.length-1)knot.t=Math.max(run.widths[i-1].t+.001,Math.min(run.widths[i+1].t-.001,value));mode.widthT=value;}));
    numeric('線幅点の太さ','widthW',knot.w,0,500,value=>edit(()=>{currentKnot().w=value;}));
    select('線幅の補間','widthInterpolation',[['smooth','滑らか'],['linear','直線'],['step','段階']],knot.interpolation,value=>edit(()=>{currentKnot().interpolation=value;}));
    select('線幅点の位置固定','widthFixed',[['false','比例追従'],['true','始点から固定']],knot.fixed,value=>edit(()=>{const knot=currentKnot();knot.fixed=value==='true';knot.distance=knot.t*(strokeFrame(run,sceneFor(p,l).positions,{vertical:l.vertical,size:l.size})?.length??0);}));
    for(const side of ['start','end']){
      select(side==='start'?'始点接続':'終点接続',side+'Relation',[['touch','接触'],['inside','文字内部'],['gap','隙間']],run[side].relation,value=>edit(()=>{run[side].relation=value;}));
      for(const [key,title,min,max] of [['offset','接続オフセット',-30000,30000],['sharpness','尖り度',0,100],['angle','筆先角度',-360,360],['length','筆先長さ',0,30000]])numeric((side==='start'?'始点 ':'終点 ')+title,side+'-'+key,run[side][key],min,max,value=>edit(()=>{run[side][key]=value;}));
    }
    select('線コピー範囲','strokePart',[['all','すべて'],['shape','形状のみ'],['width','太さのみ'],['look','見た目のみ']],mode.strokePart||'all',value=>{mode.strokePart=value;});
    action('線をコピー','stroke-copy',()=>copyStroke(run,mode.strokePart||'all'));
    action('線へ貼付け','stroke-paste',()=>pasteStroke(run,mode.strokePart||'all'));
    action('線プリセット登録','stroke-save',()=>saveStroke(run));
    action('線プリセット適用','stroke-load',()=>loadStroke(run));
  }
  return panel;
}
