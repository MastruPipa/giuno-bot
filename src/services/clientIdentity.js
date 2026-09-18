'use strict';
const db = require('./db/client');
function norm(s) {return String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function identify(text, clients) {
 const hay=' '+norm(text)+' ';
 const matches=clients.filter(c=>[c.name,...(c.aliases||[])].some(a=>norm(a).length>=4 && hay.includes(' '+norm(a)+' ')));
 if(matches.length>1)return {ambiguous:true,clientIds:matches.map(c=>c.id)};
 return matches.length?{client:matches[0]}:null;
}
let cache=null,at=0;
async function getClients() {
 if(!db.useSupabase)return [];
 if(cache && Date.now()-at<60000)return cache;
 const all=[];
 for(let offset=0;offset<10000;offset+=500){
  let q=db.getClient().from('agency_clients').select('id,name,aliases,default_project_id').order('id').range(offset,offset+499);
  if(q.abortSignal)q=q.abortSignal(AbortSignal.timeout(1000));
  const res=await q;if(res.error)throw res.error;
  all.push(...(res.data||[]));if((res.data||[]).length<500){cache=all;at=Date.now();return all;}
 }
 throw Error('Catalogo clienti incompleto');
}
async function resolve(text){return identify(text,await getClients());}
module.exports={identify,getClients,resolve};
