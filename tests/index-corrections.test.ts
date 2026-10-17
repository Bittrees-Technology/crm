import {before,after,test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool} from '../lib/db';
import {indexCorrectionsSchema} from '../lib/index-corrections-schema';
import {acceptCorrection,deliverCorrections,correctionInput,secretMatches} from '../lib/index-corrections';
const enabled=process.env.INDEX_CORRECTIONS_TEST==='1';
const test=(name:string,fn:()=>void|Promise<void>)=>nodeTest(name,{skip:!enabled},fn);
const owner=randomUUID(),workspace=randomUUID(),project=randomUUID();
process.env.INDEX_CORRECTIONS_OWNER_ID=owner;process.env.INDEX_CORRECTIONS_WORKSPACE_ID=workspace;process.env.INDEX_CORRECTIONS_PROJECT_ID=project;process.env.INDEX_CORRECTIONS_SITES='{"index":"Index directory"}';
const clientKey=randomUUID().replaceAll('-','').repeat(2);
const event=()=>({id:randomUUID(),site:'index',details:'Please correct this test description.',source:'https://example.org/evidence',clientKey:clientKey});
before(async()=>{if(!enabled)return;await pool().query(indexCorrectionsSchema);await pool().query('INSERT INTO users(id,name) VALUES($1,$2)',[owner,'Synthetic Index Reviewer']);await pool().query('INSERT INTO workspaces(id,name) VALUES($1,$2)',[workspace,'Synthetic Index Intake']);await pool().query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,owner]);await pool().query("INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'projects',$3)",[project,workspace,{name:'Synthetic Index'}]);});
after(async()=>{if(enabled)await pool().end()});
test('strict inputs and service secret cannot choose assignment or accept script URLs',()=>{assert.equal(secretMatches(null,undefined),false);assert.equal(secretMatches('Bearer '+'x'.repeat(32),'x'.repeat(32)),true);assert.throws(()=>correctionInput.parse({...event(),ownerId:randomUUID()}));assert.throws(()=>correctionInput.parse({...event(),source:'javascript:alert(1)'}));});
test('concurrent retry creates one assigned private task, survives workflow failure, and retries once',async()=>{
 const e=event();const results=await Promise.all([acceptCorrection(e),acceptCorrection(e)]);assert.equal(results.filter(r=>!r.replayed).length,1);
 const receipt=(await pool().query('SELECT * FROM index_corrections WHERE id=$1',[e.id])).rows[0];const task=(await pool().query('SELECT * FROM records WHERE id=$1',[receipt.task_id])).rows[0];assert.equal(task.data.ownerId,owner);assert.equal(task.data.projectId,project);assert.deepEqual(task.visibility_ids,[]);assert.equal(task.kind,'tasks');
 await assert.rejects(acceptCorrection({...e,details:'An altered correction with the same ID.'}),{status:409});
 const failed=await deliverCorrections(async()=>{throw Error('Outage')},e.id);assert.equal(failed.delivered,0);
 assert.equal((await pool().query('SELECT delivered_at FROM index_corrections WHERE id=$1',[e.id])).rows[0].delivered_at,null);
 await pool().query('UPDATE index_corrections SET next_attempt_at=now() WHERE id=$1',[e.id]);const runId=randomUUID();let calls=0;
 const fetcher:typeof fetch=async(url,init)=>{calls++;assert.equal(url,'https://workflow.bittrees.org/api/triggers/index-correction');const body=JSON.parse(String(init?.body));assert.equal(body.taskId,task.id);assert.equal(body.submissionId,e.id);assert.equal(body.clientKey,undefined);return Response.json({runId});};
 assert.equal((await deliverCorrections(fetcher,e.id)).delivered,1);await deliverCorrections(fetcher,e.id);assert.equal(calls,1);
 assert.equal((await pool().query('SELECT workflow_run_id FROM index_corrections WHERE id=$1',[e.id])).rows[0].workflow_run_id,runId);
});
test('rate limits apply to new reports but an accepted retry remains safe',async()=>{
 const e=event();await acceptCorrection(e);for(let i=0;i<3;i++)await acceptCorrection(event());await assert.rejects(acceptCorrection(event()),{status:429});assert.equal((await acceptCorrection(e)).replayed,true);
});
test('revoked owner or archived destination fails closed without new tasks',async()=>{
 await pool().query("UPDATE members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);await assert.rejects(acceptCorrection({...event(),clientKey:'b'.repeat(64)}),{status:403});await assert.rejects(deliverCorrections(),{status:403});
 await pool().query("UPDATE members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);await pool().query('UPDATE records SET archived_at=now() WHERE id=$1',[project]);await assert.rejects(acceptCorrection({...event(),clientKey:'b'.repeat(64)}));
});
