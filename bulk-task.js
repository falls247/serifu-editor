export function checkAbort(signal) { if(signal?.aborted)throw signal.reason || new DOMException('処理を中断','AbortError'); }
export function awaitWithAbort(pending,signal){
  if(!signal)return Promise.resolve(pending);
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason||new DOMException('処理を中断','AbortError'));};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(pending).then(value=>{signal.removeEventListener('abort',abort);signal.aborted?abort():resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    if(signal.aborted)abort();
  });
}
export const yieldToBrowser = () => new Promise(resolve=>setTimeout(resolve,0));
export class BulkTask {
  constructor(kind,{onProgress=()=>{},stageCount=1}={}) {
    this.controller=new AbortController();this.signal=this.controller.signal;this.onProgress=onProgress;this.started=performance.now();this.lastNotify=-Infinity;
    this.data={operationId:crypto.randomUUID(),kind,state:'running',stage:'準備',processed:0,succeeded:0,failed:0,total:null,currentName:'',elapsedMs:0,completedStages:0,stageCount,writtenBytes:0,errorMessage:''};
    this.metrics={stages:{},firstEditableMs:null};this.stageStarted=this.started;this.emit(true);
    this.timer=setInterval(()=>this.emit(),100);
  }
  emit(immediate=false) {const now=performance.now();if(!immediate&&now-this.lastNotify<100)return;this.lastNotify=now;this.data.elapsedMs=now-this.started;this.onProgress({...this.data});}
  update(values,immediate=false){Object.assign(this.data,values);this.emit(immediate);}
  stage(stage,total=null){this.recordStage();this.update({stage,total,processed:0,succeeded:0,failed:0,currentName:'',completedStages:this.data.completedStages+(this.data.stage==='準備'?0:1)},true);}
  recordStage(){const now=performance.now();this.metrics.stages[this.data.stage]=(this.metrics.stages[this.data.stage]||0)+now-this.stageStarted;this.stageStarted=now;}
  result(name,success=true,bytes=0){this.update({currentName:name,processed:this.data.processed+1,succeeded:this.data.succeeded+(success?1:0),failed:this.data.failed+(success?0:1),writtenBytes:this.data.writtenBytes+bytes});}
  cancel(){if(this.data.state!=='running')return;this.update({state:'cancelling'},true);this.controller.abort(new DOMException('処理を中断','AbortError'));}
  finish(error){this.recordStage();clearInterval(this.timer);this.update({state:error?(error.name==='AbortError'?'cancelled':'failed'):'succeeded',errorMessage:error?.message||''},true);return {...this.metrics,elapsedMs:this.data.elapsedMs,...this.data};}
}

// Active jobs and unconsumed results share slots. Consumer completion releases
// reservation, so a slow writer cannot grow an unbounded result backlog.
export async function* boundedResults(items,run,{signal,concurrency=2,memoryBudget=256*1024**2,resultBudget=64*1024**2,estimate=()=>({work:1,result:1}),onMetrics=()=>{},onStop=()=>{}}={}){
  const pending=[];let next=0,work=0,result=0,maxActive=0,maxReserved=0,maxResultBytes=0,pendingBytes=0,maxPendingBytes=0;
  const launch=()=>{
    while(next<items.length&&pending.length<concurrency){
      checkAbort(signal);const index=next,estimated=estimate(items[index]);
      if(pending.length&&(work+estimated.work>memoryBudget||result+estimated.result>resultBudget))break;
      next++;work+=estimated.work;result+=estimated.result;
      const entry={estimated,bytes:0};
      const report=()=>onMetrics({maxActive,maxReserved,maxResultBytes,maxPendingBytes});
      entry.promise=Promise.resolve().then(()=>{checkAbort(signal);return run(items[index],index);}).then(value=>{
        entry.bytes=value instanceof Blob?value.size:value?.thumbnail?.size||value?.prepared?.thumbnail?.size||0;pendingBytes+=entry.bytes;maxPendingBytes=Math.max(maxPendingBytes,pendingBytes);report();return {value,index};
      },error=>({error,index}));
      pending.push(entry);maxActive=Math.max(maxActive,pending.length);maxReserved=Math.max(maxReserved,work);maxResultBytes=Math.max(maxResultBytes,result);report();

    }
  };
  try {
    launch();while(pending.length){checkAbort(signal);const entry=pending[0],value=await entry.promise;checkAbort(signal);yield value;
      pending.shift();pendingBytes-=entry.bytes;work-=entry.estimated.work;result-=entry.estimated.result;launch();}
  }finally {if(pending.length)onStop();await Promise.all(pending.map(p=>p.promise));pending.length=0;}
}
export async function prepareLayers(layers,transform,task){const prepared=[];task.stage('レイヤー準備',layers.length);for(let i=0;i<layers.length;i++){checkAbort(task.signal);prepared.push(transform(layers[i]));task.result(String(i+1));if(i%20===19)await yieldToBrowser();}checkAbort(task.signal);return prepared;}
