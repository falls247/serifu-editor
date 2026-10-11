// Allocation hints only: unknown formats reserve the entire budget. JPEG
// orientation can swap axes, but does not change pixel count.
export async function imageDimensions(blob){
  const bytes=new Uint8Array(await blob.slice(0,65536).arrayBuffer()),view=new DataView(bytes.buffer);
  if(bytes.length>=24&&bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)return {width:view.getUint32(16),height:view.getUint32(20)};
  if(bytes.length>=30&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'&&String.fromCharCode(...bytes.slice(12,16))==='VP8X')return {width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)};
  if(bytes[0]===255&&bytes[1]===216){let offset=2,dimensions=null,hasExif=false;
    while(offset+4<bytes.length){if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;const marker=bytes[offset++];
      if(marker===0xda)return dimensions?{...dimensions,fastThumbnail:!hasExif}:null;if(marker===0xd9)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)break;
      if(marker===0xe1&&length>=8&&String.fromCharCode(...bytes.slice(offset+2,offset+8))==='Exif\0\0')hasExif=true;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)dimensions={width:view.getUint16(offset+5),height:view.getUint16(offset+3)};
      offset+=length;
    }
    return dimensions;
  }

  return null;
}
