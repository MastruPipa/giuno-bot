'use strict';
// Local reconstruction by default. --stage stores evidence, never time logs.
const fs=require('node:fs');
const {projectBudgets}=require('../src/services/reconciliation/contracts');
const {reconcileHistory}=require('../src/services/reconciliation/history');
async function main() {
  const args=process.argv.slice(2), file=args.find(a=>!a.startsWith('--'));
  if(!file)throw new Error('Usage: node scripts/reconcile-contracts.js input.json [--stage]');
  const input=JSON.parse(fs.readFileSync(file,'utf8'));
  const projected=projectBudgets(input.cases||[]);
  const result={...projected,history:reconcileHistory({...input.database,logs:input.database?.time_logs,standups:input.standups,aliases:input.aliases,projectIds:(input.cases||[]).map(c=>c.project_id)})};
  if(args.includes('--stage')) {
    require('dotenv').config();
    if(!process.env.SUPABASE_URL||!process.env.SUPABASE_KEY)throw new Error('Database non configurato');
    const client=require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY,{auth:{persistSession:false}});
    for(const [index,item] of (input.cases||[]).entries()) {
      const assessment=projected.assessments[index];
      const res=await client.from('project_contract_sources').upsert({id:item.case_id||assessment.id,project_id:item.project_id,input:item,assessment,updated_at:new Date().toISOString()},{onConflict:'id'});
      if(res.error)throw res.error;
    }
  }
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
