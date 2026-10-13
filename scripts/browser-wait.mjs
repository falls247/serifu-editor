// Await the predicate result on every poll; a Promise itself is not success.
export async function waitForAsync(page,predicate,arg,{timeout=30000,polling=100}={}){
 let stopped=false,timer;
 const check=(async()=>{while(!stopped){if(await page.evaluate(predicate,arg))return;if(!stopped)await new Promise(resolve=>setTimeout(resolve,polling));}})();
 const limit=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Async browser condition did not become true within ${timeout}ms`)),timeout);});
 try{await Promise.race([check,limit]);}finally{stopped=true;clearTimeout(timer);}
}
