import {awaitWithAbort,checkAbort,yieldToBrowser} from './bulk-task.js';

const MAX_UINT32=0xffffffff,encoder=new TextEncoder();
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let bit=0;bit<8;bit++)i=(i>>>1)^((i&1)?0xedb88320:0);return i>>>0;});
async function checksum(blob,signal){
  let crc=MAX_UINT32,lastYield=performance.now();const reader=blob.stream().getReader();
  try{while(true){checkAbort(signal);const {value,done}=await awaitWithAbort(reader.read(),signal);if(done)break;for(let start=0;start<value.length;start+=65536){checkAbort(signal);for(let i=start,end=Math.min(start+65536,value.length);i<end;i++)crc=(crc>>>8)^crcTable[(crc^value[i])&255];if(performance.now()-lastYield>=16){await yieldToBrowser();lastYield=performance.now();}}}return (crc^MAX_UINT32)>>>0;}
  finally{if(signal?.aborted)await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Stored ZIP entries reuse PNG/asset Blobs. ZIP64 and compression are unnecessary
// for ordinary image collections; reject their limits instead of truncating sizes.
export class ZipArchive{
  constructor(date=new Date()){
    this.parts=[];this.entries=[];this.offset=0;this.centralSize=0;this.names=new Set();
    this.time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
    this.date=((Math.min(2107,Math.max(1980,date.getFullYear()))-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  }
  async add(name,blob,signal){
    checkAbort(signal);const encoded=encoder.encode(name);
    if(!name||name.startsWith('/')||name.includes('\\')||name.includes('\0')||name.split('/').some(part=>!part||part==='.'||part==='..')||encoded.length>65535)throw new Error('ZIPのファイル名が不正');
    if(this.names.has(name))throw new Error(`ZIPのファイル名が重複: ${name}`);
    const localSize=30+encoded.length+blob.size,centralSize=46+encoded.length;
    if(this.entries.length>=65535||blob.size>MAX_UINT32||this.offset+localSize+this.centralSize+centralSize+22>MAX_UINT32)throw new Error('ZIP保存の上限（4GiB・65535ファイル）を超えた。画像を分けて保存してほしい');
    const crc=await checksum(blob,signal);checkAbort(signal);
    const header=new Uint8Array(30),view=new DataView(header.buffer);
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(10,this.time,true);view.setUint16(12,this.date,true);view.setUint32(14,crc,true);view.setUint32(18,blob.size,true);view.setUint32(22,blob.size,true);view.setUint16(26,encoded.length,true);
    this.entries.push({encoded,size:blob.size,crc,offset:this.offset});this.names.add(name);this.parts.push(header,encoded,blob);this.offset+=localSize;this.centralSize+=centralSize;
  }
  blob(signal){
    checkAbort(signal);const central=[];
    for(const entry of this.entries){const header=new Uint8Array(46),view=new DataView(header.buffer);view.setUint32(0,0x02014b50,true);view.setUint16(4,20,true);view.setUint16(6,20,true);view.setUint16(8,0x800,true);view.setUint16(12,this.time,true);view.setUint16(14,this.date,true);view.setUint32(16,entry.crc,true);view.setUint32(20,entry.size,true);view.setUint32(24,entry.size,true);view.setUint16(28,entry.encoded.length,true);view.setUint32(42,entry.offset,true);central.push(header,entry.encoded);}
    const end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,this.entries.length,true);view.setUint16(10,this.entries.length,true);view.setUint32(12,this.centralSize,true);view.setUint32(16,this.offset,true);
    return new Blob([...this.parts,...central,end],{type:'application/zip'});
  }
}
