import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool, transaction } from './db';
import { membership } from './service';
import { HttpError, recordSchema } from './model';
import { checkRecordAccess } from './access';

export const correctionInput = z.object({
 id: z.uuid(), site: z.string().regex(/^[a-z0-9-]{1,64}$/),
 details: z.string().trim().min(10).max(3000),
 source: z.union([z.literal(''), z.url({protocol:/^https?$/}).max(500)]),
 clientKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function secretMatches(header: string | null, secret: string | undefined) {
 if (!secret || secret.length < 32) return false;
 const a=Buffer.from(header || ''), b=Buffer.from('Bearer '+secret);
 return a.length===b.length && timingSafeEqual(a,b);
}
function destination() {
 return {workspace:z.uuid().parse(process.env.INDEX_CORRECTIONS_WORKSPACE_ID),owner:z.uuid().parse(process.env.INDEX_CORRECTIONS_OWNER_ID),project:z.uuid().parse(process.env.INDEX_CORRECTIONS_PROJECT_ID)};
}
async function validateDestination(db: Parameters<typeof membership>[4], config: ReturnType<typeof destination>) {
 await membership(config.workspace,config.owner,true,true,db);
 await checkRecordAccess(db!,config.owner,config.workspace,config.project);
 const p=(await db!.query("SELECT id FROM records WHERE id=$1 AND workspace_id=$2 AND kind='projects' AND archived_at IS NULL FOR SHARE",[config.project,config.workspace])).rows[0];
 if(!p) throw new HttpError(503,'Correction intake is temporarily unavailable.');
}
export async function acceptCorrection(raw: unknown) {
 const input=correctionInput.parse(raw),config=destination();
 const sites: Record<string,string>=JSON.parse(process.env.INDEX_CORRECTIONS_SITES || '{}');
 if(!Object.hasOwn(sites,input.site))throw new HttpError(400,'Choose a listed site.');
 const payload={site:input.site,siteName:sites[input.site],details:input.details,source:input.source};
 const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 return transaction(async db=>{
  await validateDestination(db,config);
  const old=(await db.query('SELECT payload_hash,workspace_id,owner_id FROM index_corrections WHERE id=$1',[input.id])).rows[0];
  if(old){if(old.payload_hash!==digest||old.workspace_id!==config.workspace||old.owner_id!==config.owner)throw new HttpError(409,'This submission changed. Submit it with a new reference.');return {accepted:true,reference:input.id,replayed:true};}
  for(const [key,max,seconds] of [[`index:client:${input.clientKey}`,5,3600],['index:global',100,86400]] as const){
   const r=(await db.query(`INSERT INTO rate_limits(key,hits,resets_at) VALUES($1,1,now()+$2::int*interval '1 second') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.resets_at<=now() THEN 1 ELSE rate_limits.hits+1 END,resets_at=CASE WHEN rate_limits.resets_at<=now() THEN now()+$2::int*interval '1 second' ELSE rate_limits.resets_at END RETURNING hits`,[key,seconds])).rows[0];
   if(r.hits>max)throw new HttpError(429,'Too many suggestions. Please try again later.');
  }
  const taskId=randomUUID();
  const data=recordSchema.parse({name:`Review Index correction: ${payload.siteName}`,projectId:config.project,ownerId:config.owner,category:'Index correction',source:'Bittrees Index',description:`Unverified public suggestion — approval is required before publication.\n\nSite: ${payload.siteName}\n\n${payload.details}\n\nSupporting source: ${payload.source||'Not supplied'}\n\nReference: ${input.id}\nReview workflow: https://workflow.bittrees.org`,nextAction:'Verify the report and prepare the exact correction for approval.',status:'Open'});
  await db.query("INSERT INTO records(id,workspace_id,kind,data,visibility_ids) VALUES($1,$2,'tasks',$3,'{}'::uuid[])",[taskId,config.workspace,data]);
  await db.query('INSERT INTO index_corrections(id,payload_hash,payload,workspace_id,owner_id,task_id) VALUES($1,$2,$3,$4,$5,$6)',[input.id,digest,payload,config.workspace,config.owner,taskId]);
  await db.query("INSERT INTO audit(workspace_id,actor_id,action,record_id,detail) VALUES($1,$2,'index.correction.received',$3,$4)",[config.workspace,config.owner,taskId,{reference:input.id,source:'public-index',assignedBy:'configured-intake'}]);
  return {accepted:true,reference:input.id,replayed:false};
 });
}
export async function deliverCorrections(fetcher:typeof fetch=fetch,reference?:string) {
 const config=destination();
 const claimed=await transaction(async db=>{
  await validateDestination(db,config);
  return (await db.query(`WITH candidates AS (SELECT id FROM index_corrections WHERE delivered_at IS NULL AND task_id IS NOT NULL AND EXISTS (SELECT 1 FROM records t WHERE t.id=index_corrections.task_id AND t.archived_at IS NULL AND t.data->>'ownerId'=($2::uuid)::text AND t.data->>'status'='Open') AND workspace_id=$1 AND owner_id=$2 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND ($3::uuid IS NULL OR id=$3::uuid) ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED) UPDATE index_corrections c SET lease_until=now()+interval '2 minutes',attempts=attempts+1 FROM candidates x WHERE c.id=x.id RETURNING c.*`,[config.workspace,config.owner,reference||null])).rows;
 });
 let delivered=0;
 for(const r of claimed){
  try{
   const res=await fetcher('https://workflow.bittrees.org/api/triggers/index-correction',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+process.env.INDEX_CORRECTIONS_WORKFLOW_SECRET,'Content-Type':'application/json'},body:JSON.stringify({submissionId:r.id,taskId:r.task_id,workspaceId:r.workspace_id,...r.payload})});
   if(!res.ok)throw Error('Workflow unavailable');
   const result=z.object({runId:z.uuid()}).passthrough().parse(await res.json());
   await pool().query('UPDATE index_corrections SET workflow_run_id=$2,delivered_at=now(),lease_until=NULL WHERE id=$1 AND delivered_at IS NULL',[r.id,result.runId]);delivered++;
  }catch{await pool().query("UPDATE index_corrections SET lease_until=NULL,next_attempt_at=now()+LEAST(3600,60*power(2,LEAST(attempts,6)))::int*interval '1 second' WHERE id=$1 AND delivered_at IS NULL",[r.id]);}
 }
 return {processed:claimed.length,delivered};
}
