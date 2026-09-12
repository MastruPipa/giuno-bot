'use strict';
// Multiple activities for a reconciled client share one weekly ledger row.
// Preserve each original text and duration, rather than losing the task detail.
function groupClientActivities(rows) {
 const result=[],groups=new Map();
 for(const row of rows){
  if(!row.client_id || !Number.isFinite(row.hours) || row.hours < 0.5){result.push(row);continue;}
  const key=JSON.stringify([row.client_id,row.project_id]);
  const activity={text:row.other_name||'',hours:row.hours};
  const prior=groups.get(key);
  if(prior){prior.hours+=row.hours;prior.activities.push(activity);prior.other_name+='; '+(row.other_name||'');}
  else {const combined={...row,activities:[activity]};groups.set(key,combined);result.push(combined);}
 }
 return result;
}
module.exports={groupClientActivities};
