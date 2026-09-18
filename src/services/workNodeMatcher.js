'use strict';
const db=require('./db/client');
const months=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
const norm=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function resolveNode(text,clientId,nodes,date){
 const t=' '+norm(text)+' ';
 const own=nodes.filter(n=>n.client_id===clientId);
 const byId=new Map(own.map(n=>[n.id,n]));
 const monthHits=months.map((m,i)=>t.includes(' '+m+' ')?i+1:null).filter(Boolean);
 let month=monthHits.length===1?monthHits[0]:null;
 if(monthHits.length>1)return null;
 if(/prossimo mese|mese prossimo/.test(t)&&/^\d{4}-\d{2}-\d{2}$/.test(date||''))month=Number(date.slice(5,7))%12+1;
 const years=t.match(/\b20\d{2}\b/g)||[];
 const candidates=own.filter(n=>['engagement','objective','deliverable'].includes(n.kind)).map(n=>{
  const terms=[n.name,...(n.metadata?.match_terms||[])].map(norm).filter(x=>x.length>=3);
  const hits=terms.filter(term=>t.includes(' '+term+' '));
  let score=hits.length?Math.max(...hits.map(x=>x.split(' ').length)):0;
  if(n.kind==='objective'&&month&&n.period_start&&Number(n.period_start.slice(5,7))===month&&/\b(ped|caption|social|reel|copy)\b/.test(t))score=Math.max(score,2);
  // An explicit different month excludes a monthly branch, even if it is current today.
  let parent=n,seen=new Set();
  while(parent&&!seen.has(parent.id)){
   seen.add(parent.id);
   if(parent.kind==='objective'&&parent.period_start){
    if(month&&Number(parent.period_start.slice(5,7))!==month)score=0;
    if(years.length&& !years.includes(parent.period_start.slice(0,4)))score=0;
   }
   parent=byId.get(parent.parent_id);
  }
  return {node:n,score};
 }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
 if(!candidates.length||candidates[1]?.score===candidates[0].score)return null;
 return candidates[0].node;
}
let cache=null,at=0;
async function loadNodes(){
 if(!db.useSupabase)return [];
 if(cache&&Date.now()-at<60000)return cache;
 const rows=[];
 for(let offset=0;offset<10000;offset+=500){
  let q=db.getClient().from('work_nodes').select('id,client_id,parent_id,kind,name,period_start,period_end,metadata,source_url').order('id').range(offset,offset+499);
  if(q.abortSignal)q=q.abortSignal(AbortSignal.timeout(1000));
  const r=await q;if(r.error)throw r.error;rows.push(...(r.data||[]));
  if((r.data||[]).length<500){cache=rows;at=Date.now();return rows;}
 }
 throw Error('Gerarchia incompleta');
}
async function enrich(tasks,options={}){
 const pending=tasks.filter(t=>t?.client_id&&!t.work_node_id);if(!pending.length)return tasks;
 const nodes=options.nodes||await loadNodes();
 for(const t of pending){const n=resolveNode(t.task,t.client_id,nodes,options.date);if(n){t.work_node_id=n.id;t.work_node_name=n.name;t.assignment_status=n.kind==='engagement'?'workstream':'delivery';}}
 return tasks;
}
module.exports={resolveNode,loadNodes,enrich};
