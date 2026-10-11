export function safeFilenamePart(value) {
  const cleaned=String(value||'').normalize('NFC').replace(/[<>:"\\|?*\x00-\x1f]/g,'_').replaceAll('/','_').trim().slice(0,60).replace(/[. ]+$/g,'');
  return cleaned||'serifu';
}

export function filenameTimestamp(date=new Date()) {
  const pad=value=>String(value).padStart(2,'0');
  return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${String(date.getMilliseconds()).padStart(3,'0')}`;
}

export function projectFileName(format,date=new Date(),folderName=null) {
  return format==='serifu'?`${safeFilenamePart(folderName)}_${filenameTimestamp(date)}.serifu`:`serifu-project.${format}`;
}

export function uploadedFolderName(entries) {
  for(const entry of entries){
    const directoryName=entry.directory?.name;
    if(typeof directoryName==='string'&&directoryName.trim())return directoryName;
  }
  for(const entry of entries){
    const relativePath=entry.file?.webkitRelativePath;
    if(typeof relativePath!=='string')continue;
    const parts=relativePath.split('/').filter(Boolean);
    if(parts.length>1)return parts[0];
  }
  return null;
}

export function projectFolderName(filename) {
  const name=filename.replace(/\.(?:serifu|json)$/i,'').replace(/_\d{8}_\d{6}_\d{3}(?:_edited)?$/i,'');
  return name==='serifu-project'?null:name||null;
}
