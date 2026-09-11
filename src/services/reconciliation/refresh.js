'use strict';
const {assessContract}=require('./contracts');
// Refresh registered sources; old approval never follows a changed revision.
async function refreshInput(input,drive,sheets) {
  const next=structuredClone(input);
  delete next.read_error;
  try {
    for(const item of [next.contract,next.sheet].filter(Boolean)) {
      const id=item.file_id;
      if(!id)throw new Error('Identificatore Drive mancante');
      const meta=(await drive.files.get({fileId:id,fields:'id,modifiedTime,trashed',supportsAllDrives:true})).data;
      if(meta.trashed||!meta.modifiedTime)throw new Error('Fonte rimossa o revisione non leggibile');
      item.revision=meta.modifiedTime;
    }
    if(next.sheet) {
      const data=(await sheets.spreadsheets.values.get({spreadsheetId:next.sheet.file_id,
        range:"'2. Effort team'!A1:Z100",valueRenderOption:'UNFORMATTED_VALUE'})).data;
      const after=(await drive.files.get({fileId:next.sheet.file_id,fields:'modifiedTime',supportsAllDrives:true})).data;
      if(after.modifiedTime!==next.sheet.revision)throw new Error('Fonte modificata durante la lettura');
      next.sheet.values=data.values||[];next.sheet.range=data.range;
    }
  } catch(error){next.read_error=error.message;}
  return next;
}
async function refreshRegistered({client,drive,sheets,now=()=>new Date()}) {
  const records=[];
  for(let offset=0;offset<10000;offset+=200) {
    const res=await client.from('project_contract_sources').select('id,input').order('id').range(offset,offset+199);
    if(res.error)throw res.error;
    records.push(...(res.data||[]));
    if((res.data||[]).length<200)break;
    if(offset===9800)throw new Error('Registro contratti oltre il limite di lettura');
  }
  let refreshed=0;
  for(const record of records) {
    const input=await refreshInput(record.input,drive,sheets);
    const assessment=assessContract(input);
    const result=await client.from('project_contract_sources').update({input,assessment,updated_at:now().toISOString()}).eq('id',record.id);
    if(result.error)throw result.error;
    refreshed++;
  }
  return {refreshed};
}
module.exports={refreshInput,refreshRegistered};
