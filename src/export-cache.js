export const RENDER_VERSION=8;
export function exportKey(page,fontVersion=0){return JSON.stringify([page.id,page.img.width,page.img.height,RENDER_VERSION,fontVersion,page.layers.map(({id,presetId,...rendered})=>rendered)]);}
export class ExportCache {
  constructor(limit=128*1024**2){this.limit=limit;this.bytes=0;this.entries=new Map();this.hits=0;this.misses=0;}
  get(key){const entry=this.entries.get(key);if(!entry){this.misses++;return null;}this.entries.delete(key);this.entries.set(key,entry);this.hits++;return entry.blob;}
  put(key,blob,imageId){this.delete(key);if(blob.size>this.limit)return;this.entries.set(key,{blob,imageId});this.bytes+=blob.size;while(this.bytes>this.limit)this.delete(this.entries.keys().next().value);}
  delete(key){const entry=this.entries.get(key);if(entry)this.bytes-=entry.blob.size;this.entries.delete(key);}
  invalidate(imageId){for(const [key,entry] of this.entries)if(entry.imageId===imageId)this.delete(key);}
  clear(){this.entries.clear();this.bytes=0;}
}
