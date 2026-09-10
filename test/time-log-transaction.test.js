'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

test('PostgreSQL: canonical snapshots, rollback, replay, estimates and access', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE projects(id text PRIMARY KEY);
      INSERT INTO projects VALUES ('p1'),('p2');
      CREATE TABLE time_logs (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        slack_user_id text NOT NULL, project_id text REFERENCES projects(id),
        log_date date NOT NULL, log_type text NOT NULL CHECK(log_type IN ('daily','weekly')),
        hours numeric(4,2) NOT NULL, notes text, validation jsonb,
        CONSTRAINT time_logs_check CHECK(hours >= 0.5 AND ((log_type='daily' AND hours<=24) OR (log_type='weekly' AND hours<=60))),
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        UNIQUE(slack_user_id,project_id,log_date,log_type));`);
    await pg.exec(fs.readFileSync(path.join(__dirname,'../docs/time-log-writes.sql'),'utf8'));
    const row = (id, h, estimate = false) => ({project_id:id,hours:h,
      validation: estimate ? {status:'estimate'} : {status:'declared'}});
    const write = async (rows, replace = false, estimate = false) => {
      return (await pg.query('SELECT write_time_logs($1,$2,$3,$4::jsonb,$5,$6) AS result',
        ['U1','2026-09-10','daily',JSON.stringify(rows),replace,estimate])).rows[0].result;
    };
    const all = async () => (await pg.query('SELECT project_id,hours::float FROM time_logs ORDER BY project_id')).rows;
    await write([row('p1',0.25)]);
    await write([row('p1',0.25)]);
    assert.deepEqual(await all(),[{project_id:'p1',hours:0.25}]);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM time_log_write_history')).rows[0].n,1);
    await write([row('p1',4,true)],false,true);
    assert.equal((await all())[0].hours,0.25,'estimate cannot overwrite declaration');
    await write([row('p2',2,true)],true,true);
    assert.equal((await all()).length,2,'estimate snapshot cannot remove declaration');
    await assert.rejects(write([row('missing',2)],true),/foreign key/i);
    assert.equal((await all()).length,2,'delete and insert rolled back together');
    await assert.rejects(write([row('p2',24)]),/24 hours/);
    assert.equal((await all())[1].hours,2);
    await assert.rejects(write([row('p1',1),row('p1',2)]),/Duplicate/);
    await write([row('p2',3)],true);
    assert.deepEqual(await all(),[{project_id:'p2',hours:3}]);
    const deleted = await write([],true);
    assert.deepEqual(deleted.removedProjectIds,['p2']);
    assert.deepEqual(await all(),[],'empty correction removes the final project');
    const permission = await pg.query("SELECT has_function_privilege('anon','write_time_logs(text,date,text,jsonb,boolean,boolean)','EXECUTE') AS allowed");
    assert.equal(permission.rows[0].allowed,false);
    await pg.exec(fs.readFileSync(path.join(__dirname,'../docs/time-log-writes.sql'),'utf8'));
  } finally { await pg.close(); }
});
