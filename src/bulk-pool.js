import {checkAbort,yieldToBrowser} from './bulk-task.js';
export class ImagePool {
  constructor({size=2,timeout=60000}={}){this.size=Math.min(4,Math.max(1,size));this.timeout=timeout;this.workers=[];this.disabled=false;this.sequence=0;this.metrics={jobs:0,fallbackJobs:0,timings:{},reasons:[]};}
  async start(signal){if(this.disabled)return false;if(this.starting)return this.starting;this.starting=(async()=>{try{for(let i=this.workers.length;i<this.size;i++){const worker=new Worker(new URL('./image-worker.js',import.meta.url),{type:'module'});const slot={worker,busy:false};this.workers.push(slot);await this.send(slot,'probe',{},'startup',signal);}return true;}catch(error){if(error.name==='AbortError'){for(const slot of this.workers){slot.reject?.(error);slot.worker.terminate();}this.workers=[];this.starting=null;}else this.disable(error.message);return false;}})();return this.starting;}
  resize(size){size=Math.min(4,Math.max(1,size));if(size===this.size)return;this.size=size;this.starting=null;while(this.workers.length>size){const slot=this.workers.pop();slot.reject?.(new Error('画像Workerの終了'));slot.worker.terminate();}}
  disable(reason){this.disabled=true;this.metrics.reasons.push(reason);for(const slot of this.workers){slot.reject?.(new Error(reason));slot.worker.terminate();}this.workers=[];}
  send(slot,kind,payload,operationId,signal){return new Promise((resolve,reject)=>{
    let killTimer;slot.busy=true;let finished=false;
    const finish=(error,data)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);slot.worker.onmessage=null;slot.worker.onerror=null;slot.worker.onmessageerror=null;slot.busy=false;slot.reject=null;error?reject(error):resolve(data);};
    slot.reject=error=>finish(error);
    const abort=()=>{killTimer=setTimeout(()=>{slot.worker.terminate();this.workers=this.workers.filter(s=>s!==slot);this.starting=null;finish(signal.reason);},2000);};
    const jobId=++this.sequence,timer=setTimeout(()=>{slot.worker.terminate();this.disable('画像Workerがタイムアウト');finish(new Error('画像Workerがタイムアウト'));},this.timeout);
    slot.worker.onmessage=({data})=>{if(data.jobId!==jobId||data.operationId!==operationId)return;if(signal?.aborted){finish(signal.reason);return;}if(data.error){finish(new Error(data.error));return;}for(const [key,value] of Object.entries(data.timings||{}))this.metrics.timings[key]=(this.metrics.timings[key]||0)+value;finish(null,data.value);};
    slot.worker.onerror=event=>{event.preventDefault();this.disable(event.message||'画像Workerが終了');};slot.worker.onmessageerror=()=>this.disable('画像Workerの応答を読めない');
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{slot.worker.postMessage({operationId,jobId,kind,payload});}catch(error){finish(error);}
  });}
  async run(kind,payload,task,fallback){checkAbort(task?.signal);const supported=await this.start(task?.signal);checkAbort(task?.signal);
    const slot=this.workers.find(s=>!s.busy);
    if(supported&&slot){try{this.metrics.jobs++;return await this.send(slot,kind,payload,task?.data.operationId||crypto.randomUUID(),task?.signal);}catch(error){checkAbort(task?.signal);this.metrics.reasons.push(`${kind}: ${error.message}`);}}
    this.metrics.fallbackJobs++;await yieldToBrowser();checkAbort(task?.signal);return fallback();
  }
  close(){this.disable('終了');}
}
