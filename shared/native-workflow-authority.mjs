import {createHash} from 'node:crypto';
import {canonical} from './signed-action.mjs';
import {PERSONAL_WORKFLOW_ENDPOINT,validatePersonalWorkflowRequest,validPersonalWorkflowIdentity,verifyPersonalWorkflowSignature} from './personal-workflow-authority.mjs';

export const NATIVE_WORKFLOW_ORIGINS=Object.freeze({crm:'https://crm.bittrees.org',autonote:'https://autonote.bittrees.org'});
export const NATIVE_WORKFLOW_MAX_AGE=5000;
export const NATIVE_WORKFLOW_ROLES=['workspace.owner','workspace.editor','workspace.viewer'];
export const nativeWorkflowEndpoint=project=>{
 const origin=NATIVE_WORKFLOW_ORIGINS[project];if(!origin)throw Error('Unsupported native workflow project');
 return origin+'/api/roles/workflow-authority';
};
const fail=()=>{throw Error('Native workflow authority rejected');};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const opaque=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,63}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);

// Opaque resource IDs and membership generations must come from native current
// authority. No private names, contents, member lists, contacts or record IDs.
// A restrictions digest binds native record-level limits without disclosing them.
export function nativeWorkflowScopeId(project,identity,{resourceId,membershipId,roleId,restrictionsDigest}){
 if(!NATIVE_WORKFLOW_ORIGINS[project]||!validPersonalWorkflowIdentity(identity)||!opaque(resourceId)||!opaque(membershipId)||!NATIVE_WORKFLOW_ROLES.includes(roleId)||!hex(restrictionsDigest))fail();
 return 'scope:'+createHash('sha256').update(canonical({version:1,issuer:NATIVE_WORKFLOW_ORIGINS[project],project,identity,resourceId,membershipId,roleId,restrictionsDigest})).digest('hex');
}
export function validateNativeWorkflowRequest(r,project,now=Date.now()){
 if(!exact(r,['version','issuer','audience','project','workflowRequest','policyDigest','requestId','issuedAt','expiresAt'])||
  !NATIVE_WORKFLOW_ORIGINS[project]||r.version!==1||r.issuer!=='https://roles.bittrees.org'||r.project!==project||r.audience!==nativeWorkflowEndpoint(project)||
  !hex(r.policyDigest)||!uuid(r.requestId)||!Number.isSafeInteger(r.issuedAt)||!Number.isSafeInteger(r.expiresAt)||r.issuedAt>now+1000||
  r.expiresAt<=now||r.expiresAt<=r.issuedAt||r.expiresAt-r.issuedAt>NATIVE_WORKFLOW_MAX_AGE)fail();
 validatePersonalWorkflowRequest(r.workflowRequest,now);
 if(r.workflowRequest.project!==project||r.expiresAt>r.workflowRequest.issuedAt+15000)fail();
 return r;
}
export const nativeWorkflowRequestMessage=r=>'Bittrees native workflow role request v1\n'+canonical(r);
export const nativeWorkflowDecisionMessage=d=>'Bittrees native workflow role decision v1\n'+canonical(d);
export function verifyNativeWorkflowRequest(envelope,project,rolesPublicKey,now=Date.now()){
 if(!exact(envelope,['request','signature']))fail();
 const r=validateNativeWorkflowRequest(envelope.request,project,now);
 if(!verifyPersonalWorkflowSignature(nativeWorkflowRequestMessage(r),envelope.signature,rolesPublicKey))fail();
 return r;
}
export function verifyNativeWorkflowDecision(envelope,request,sourcePublicKey,now=Date.now()){
 validateNativeWorkflowRequest(request,request.project,now);
 const d=envelope?.decision;
 if(!exact(envelope,['decision','signature'])||!exact(d,['version','issuer','audience','project','identity','request','status','checkedAt','expiresAt','scopes','readOnly','grantsSourceAuthority'])||
  !verifyPersonalWorkflowSignature(nativeWorkflowDecisionMessage(d),envelope.signature,sourcePublicKey)||d.version!==1||d.issuer!==NATIVE_WORKFLOW_ORIGINS[request.project]||
  d.audience!==PERSONAL_WORKFLOW_ENDPOINT||d.project!==request.project||canonical(d.identity)!==canonical(request.workflowRequest.identity)||canonical(d.request)!==canonical(request)||
  !['current','unavailable'].includes(d.status)||d.readOnly!==true||d.grantsSourceAuthority!==false||!Number.isSafeInteger(d.checkedAt)||!Number.isSafeInteger(d.expiresAt)||
  d.checkedAt>now+1000||d.checkedAt<request.issuedAt-1000||d.expiresAt<=now||d.expiresAt<=d.checkedAt||d.expiresAt-d.checkedAt>NATIVE_WORKFLOW_MAX_AGE||d.expiresAt>request.expiresAt||
  !Array.isArray(d.scopes)||d.scopes.length>100||new Set(d.scopes.map(s=>s?.id)).size!==d.scopes.length||d.status!=='current'&&d.scopes.length)fail();
 for(const s of d.scopes){
  if(!exact(s,['id','roleId','resourceId','membershipId','restrictionsDigest','expiresAt'])||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=now||s.expiresAt>d.expiresAt||
   s.id!==nativeWorkflowScopeId(request.project,d.identity,s)||request.workflowRequest.action!=='list'&&s.id!==request.workflowRequest.scopeId)fail();
 }
 if(request.workflowRequest.action!=='list'&&d.scopes.length>1)fail();
 return d;
}
