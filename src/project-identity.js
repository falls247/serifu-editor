const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validProjectId=value=>typeof value==='string'&&UUID.test(value);
export const newProjectId=()=>crypto.randomUUID();
export function projectIdentity(record,version){
  const id=record?.projectId;
  if(id===undefined||id===null)return null;
  if(!validProjectId(id)||version<14)throw new Error('編集データのプロジェクトIDが不正');
  return id;
}
export function pageIdentity(record,version){
  const id=record?.id;
  if(id===undefined||id===null)return null;
  if(!validProjectId(id)||version<14)throw new Error('編集データのページIDが不正');
  return id;
}
