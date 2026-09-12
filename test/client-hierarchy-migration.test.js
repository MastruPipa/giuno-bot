'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
test('hierarchy migration is repeatable and rejects cycles, foreign clients and overlapping ownership',async()=>{
 const db=new PGlite();
 try {
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE projects(id text PRIMARY KEY);');
 const sql=fs.readFileSync(require.resolve('../docs/client-hierarchy.sql'),'utf8');await db.exec(sql);await db.exec(sql);
 await db.exec("INSERT INTO agency_clients(id,name) VALUES ('c','Client'),('d','Other'); INSERT INTO projects VALUES ('p'); INSERT INTO work_nodes(id,client_id,kind,name,source_url) VALUES ('e','c','engagement','Social','https://example.org');");
 await db.exec("INSERT INTO work_nodes(id,client_id,parent_id,kind,name,source_url) VALUES ('s','c','e','objective','September','https://example.org');");
 await assert.rejects(db.exec("UPDATE work_nodes SET parent_id='s' WHERE id='e'"));
 await assert.rejects(db.exec("INSERT INTO work_nodes(id,client_id,parent_id,kind,name,source_url) VALUES ('x','d','e','objective','Cross client','https://example.org')"));
 await assert.rejects(db.exec("INSERT INTO project_client_links VALUES ('p','d','s','https://example.org',null)"));
 await db.exec("INSERT INTO project_client_links VALUES ('p','c','s','https://example.org',null)");
 await assert.rejects(db.exec("INSERT INTO project_client_links VALUES ('p','d',null,'https://example.org',null)"));
 const r=await db.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('agency_clients','work_nodes','project_client_links','client_evidence')");assert(r.rows.every(x=>x.relrowsecurity));
 } finally {await db.close();}
});
