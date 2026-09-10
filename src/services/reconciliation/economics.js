'use strict';
// Parse the agency's native "Effort team" matrix, never its money columns.
// Input must be UNFORMATTED_VALUE cells starting at A1.
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\d+(?:[.,]\d+)?$/.test(value.trim())) return Number(value.replace(',','.'));
  return null;
}
function column(index) {
  let result='';
  for (let n=index+1;n>0;n=Math.floor((n-1)/26)) result=String.fromCharCode(65+(n-1)%26)+result;
  return result;
}
function extractEconomics(sheet) {
  const values=sheet.values||[], issues=[], lines=[];
  const header=values.findIndex(row=>row[0]==='Project activities');
  const totals=values.findIndex(row=>row[0]==='per ROLE');
  const source={url:'https://docs.google.com/spreadsheets/d/'+sheet.file_id+'/edit',revision:sheet.revision,range:sheet.range};
  if (header!==3 || totals<4 || values[header]?.[1]!=='M/D' || !sheet.file_id || !sheet.revision) {
    return {source,lines,issues:['Formato economics o copertura del foglio non riconosciuti.'],complete:false};
  }
  const areas=values[0],roles=values[1],people=values[2];
  const sums={}; let area='';
  const areasByColumn=roles.map((_,c)=>{if(areas[c])area=String(areas[c]);return area;});
  for(let r=header+1;r<totals;r++) {
    const row=values[r]||[], label=String(row[0]||'').trim();
    if(!label || label.startsWith('#') || /^TOT\./i.test(label))continue;
    let sum=0;
    for(let c=3;c<25;c++) {
      const value=row[c];
      if(value==null||value==='')continue;
      const quantity=number(value),cell=column(c)+(r+1);
      if(quantity===null || quantity<0){issues.push('Quantità non valida: '+cell);continue;}
      if(quantity===0)continue;
      sum+=quantity;sums[c]=(sums[c]||0)+quantity;
      const role=String(roles[c]||'').trim();
      if(!role || role==='\\' || /markup/i.test(role)) {
        issues.push('Voce non attribuibile a un ruolo di lavoro: '+cell);continue;
      }
      lines.push({activity:label,area:areasByColumn[c],role,person_label:people[c]||null,
        quantity,unit:'day',source:{...source,cell}});
    }
    const total=number(row[1]);
    if((sum>0 && total===null) || (total!==null && Math.abs(total-sum)>0.00001))issues.push('Totale attività non riconciliato: B'+(r+1));
  }
  for(let c=3;c<25;c++) {
    const total=number(values[totals][c]);
    if(((sums[c]||0)>0 && total===null) || (total!==null && Math.abs(total-(sums[c]||0))>0.00001))issues.push('Totale ruolo non riconciliato: '+column(c)+(totals+1));
  }
  if(values.some(row=>row.some(v=>typeof v==='string'&&/^#(?:REF!|VALUE!|DIV\/0!|N\/A|ERROR!|NUM!)/.test(v)))) issues.push('Il foglio contiene errori di formula.');
  if(!lines.length)issues.push('Nessuna quantità di lavoro leggibile.');
  return {source,lines,issues:[...new Set(issues)],complete:issues.length===0};
}
module.exports={extractEconomics,number,column};
