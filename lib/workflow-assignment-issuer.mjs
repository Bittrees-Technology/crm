import {createHash,createPrivateKey,sign} from 'node:crypto';
import {z} from 'zod';
import {canonical} from './source-handoff/roles-proof.mjs';

const uuid=z.uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/);
const assignmentSchema=z.strictObject({
 assignmentId:uuid,taskId:uuid,taskRevision:z.int().positive(),projectId:uuid,
 workflowId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),workflowRevision:z.int().positive(),
 principal:z.string().regex(/^agent:[a-f0-9-]{36}$/)
});
const resultSchema=z.strictObject({summary:z.string().trim().min(1).max(4000)});
const writeSchema=z.strictObject({
 assignmentId:uuid,connectionId:uuid,runId:uuid,leaseId:uuid,crmOperationId:uuid,
 result:resultSchema
});
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const deny=()=>Object.assign(Error('CRM assignment or result is outside current approved scope.'),{status:403});

/** Internal source service. The transaction resolves only after commit.
 * authorize must check live CRM consent and current Roles/device authority
 * under the same transaction. For results it must also verify the exact lease. */
export function createWorkflowAssignmentIssuer({transaction,authorize,privateKey,now=Date.now}){
 const key=createPrivateKey(privateKey);
 if(key.asymmetricKeyType!=='ed25519')throw Error('CRM assignment signer must be Ed25519');
 const issue=fields=>{
  const issuedAt=now();
  const proof={version:1,issuer:'https://crm.bittrees.org',audience:'https://workflow.bittrees.org',
   issuedAt,expiresAt:Math.min(issuedAt+15000,fields.deadline),...fields.claims};
  if(proof.expiresAt<=issuedAt)throw deny();
  return {proof,signature:sign(null,Buffer.from('Bittrees CRM Workflows assignment proof v1\n'+canonical(proof)),key).toString('base64')};
 };
 const read=async(db,id,connectionId,action,extra={})=>{
  const [row]=(await db.query(`SELECT a.assignment,a.connection_id,a.expires_at,r.data
   FROM crm_workflow_assignments a JOIN records r ON r.id=a.task_id AND r.workspace_id=a.workspace_id
   WHERE a.id=$1 AND a.connection_id=$2 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
   AND r.kind='tasks' AND r.archived_at IS NULL AND r.version=a.task_revision
   AND r.data->>'projectId'=a.assignment->>'projectId' FOR SHARE OF a,r`,[id,connectionId])).rows;
  if(!row)throw deny();
  const assignment=assignmentSchema.parse(row.assignment);
  if(assignment.assignmentId!==id||String(row.connection_id)!==connectionId)throw deny();
  const deadline=await authorize(db,{action,assignment,connectionId,...extra});
  const expiresAt=Math.min(Number(deadline),new Date(row.expires_at).getTime());
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())throw deny();
  return {assignment,deadline:expiresAt,instruction:z.string().min(1).max(8000).parse(row.data.description)};
 };
 return {
  async assignment(id,connectionId){
   const {assignment,deadline}=await transaction(db=>read(db,uuid.parse(id),uuid.parse(connectionId),'assignment'));
   return {assignment,envelope:issue({deadline,claims:{kind:'assignment',assignmentDigest:digest(assignment),connectionId}})};
  },
  async task(id,connectionId){
   const {assignment,instruction}=await transaction(db=>read(db,uuid.parse(id),uuid.parse(connectionId),'read'));
   return {assignment,instruction};
  },
  async result(input,{write=false}={}){
   const v=(write?writeSchema:writeSchema.omit({result:true})).parse(input);
   const {assignmentId,connectionId,runId,leaseId,crmOperationId}=v;
   const committed=await transaction(async db=>{
    const {assignment,deadline}=await read(db,assignmentId,connectionId,write?'write':'read-receipt',{runId,leaseId,crmOperationId});
    const assignmentDigest=digest(assignment);
    if('result' in v){
     await db.query(`INSERT INTO crm_workflow_result_receipts(operation_id,assignment_id,assignment_digest,run_id,lease_id,result,result_digest)
      SELECT $1,$2,$3,$4,$5,$6::jsonb,$7 WHERE to_timestamp($8/1000.0)>clock_timestamp()
      ON CONFLICT DO NOTHING`,[crmOperationId,assignmentId,assignmentDigest,runId,leaseId,JSON.stringify(v.result),digest(v.result),deadline]);
    }
    const [saved]=(await db.query(`SELECT result_digest FROM crm_workflow_result_receipts
      WHERE operation_id=$1 AND assignment_id=$2 AND assignment_digest=$3 AND run_id=$4 AND lease_id=$5`,
      [crmOperationId,assignmentId,assignmentDigest,runId,leaseId])).rows;
    if(!saved||('result' in v&&saved.result_digest!==digest(v.result)))throw deny();
    return {deadline,claims:{kind:'result-receipt',assignmentDigest,connectionId,runId,leaseId,crmOperationId,resultDigest:saved.result_digest}};
   });
   return {receipt:{operationId:crmOperationId,resultDigest:committed.claims.resultDigest},envelope:issue(committed)};
  }
 };
}
