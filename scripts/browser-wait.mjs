// Await the predicate result on every poll; a Promise itself is not success.
export async function waitForAsync(page,predicate,arg,{timeout=30000,polling=100}={}){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(await page.evaluate(predicate,arg))return;
  await new Promise(resolve=>setTimeout(resolve,Math.min(polling,Math.max(0,deadline-Date.now()))));
 }
 throw new Error(`Async browser condition did not become true within ${timeout}ms`);
}
