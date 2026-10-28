import {createPublicKey,verify} from 'node:crypto';
import {canonical} from './signed-action.mjs';

export const PERSONAL_WORKFLOW_ENDPOINT='https://roles.bittrees.org/api/authority/personal-workflow';
export const PERSONAL_WORKFLOW_MAX_AGE=5000;
export const PERSONAL_WORKFLOW_ADAPTERS=['human','roles-health'];
const fail=()=>{throw Error('Personal workflow authority rejected');};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|');
const text=(x,n=240)=>typeof x==='string'&&x.length>0&&x.length<=n;
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
export function validPersonalWorkflowIdentity(x){
 return Boolean(exact(x,['kind','value'])&&text(x.value,254)&&x.value===x.value.toLowerCase()&&
  (x.kind==='wallet'?/^0x[a-f0-9]{40}$/.test(x.value):x.kind==='email'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.value)));
}
export function validatePersonalWorkflowRequest(r,now=Date.now()){
 if(!exact(r,['version','source','audience','identity','project','action','scopeId','workflowId','operationId','parametersDigest','issuedAt','requestId'])||
  r.version!==1||r.source!=='workflow.bittrees.org'||r.audience!==PERSONAL_WORKFLOW_ENDPOINT||!validPersonalWorkflowIdentity(r.identity)||
  !/^[a-z][a-z0-9-]{0,47}$/.test(r.project||'')||!['list','create','manage','execute'].includes(r.action)||!uuid(r.operationId)||!uuid(r.requestId)||!hex(r.parametersDigest)||
  !Number.isSafeInteger(r.issuedAt)||r.issuedAt>now+1000||now-r.issuedAt>15000||
  (r.action==='list'?r.scopeId!==null:r.scopeId===null||!/^scope:[a-f0-9]{64}$/.test(r.scopeId))||
  (['list','create'].includes(r.action)?r.workflowId!==null:!text(r.workflowId,128)||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(r.workflowId)))fail();
 return r;
}
export const personalWorkflowRequestMessage=r=>'Bittrees personal workflow authority request v1\n'+canonical(r);
export const personalWorkflowDecisionMessage=d=>'Bittrees personal workflow authority decision v1\n'+canonical(d);
export function verifyPersonalWorkflowSignature(message,signature,pem){
 try{const key=createPublicKey(pem);return key.asymmetricKeyType==='ed25519'&&typeof signature==='string'&&signature.length<=128&&verify(null,Buffer.from(message),key,Buffer.from(signature,'base64'));}catch{return false;}
}
export function verifyPersonalWorkflowDecision(envelope,request,pem,now=Date.now()){
 validatePersonalWorkflowRequest(request,now);const d=envelope?.decision;
 if(!exact(envelope,['decision','signature'])||!exact(d,['version','issuer','audience','identity','request','authoritative','allowed','reason','checkedAt','expiresAt','policyDigest','scopes','ownerOnly','grantsSourceAuthority','schedulesAllowed','executionAdapters'])||
  !verifyPersonalWorkflowSignature(personalWorkflowDecisionMessage(d),envelope.signature,pem)||d.version!==1||d.issuer!=='https://roles.bittrees.org'||d.audience!=='workflow.bittrees.org'||
  canonical(d.request)!==canonical(request)||canonical(d.identity)!==canonical(request.identity)||typeof d.authoritative!=='boolean'||typeof d.allowed!=='boolean'||
  !['policy-pending','scope-denied','current-role','not-enrolled','source-unavailable'].includes(d.reason)||
  !Number.isSafeInteger(d.checkedAt)||!Number.isSafeInteger(d.expiresAt)||d.checkedAt>now+1000||d.expiresAt<=now||d.expiresAt<=d.checkedAt||d.expiresAt-d.checkedAt>PERSONAL_WORKFLOW_MAX_AGE||
  !(d.policyDigest===null||hex(d.policyDigest))||d.ownerOnly!==true||d.grantsSourceAuthority!==false||d.schedulesAllowed!==false||canonical(d.executionAdapters)!==canonical(PERSONAL_WORKFLOW_ADAPTERS)||
  !Array.isArray(d.scopes)||d.scopes.length>100||new Set(d.scopes.map(s=>s.id)).size!==d.scopes.length)fail();
 for(const s of d.scopes){
  if(!exact(s,['id','project','roleId','name','expiresAt','provenance'])||!/^scope:[a-f0-9]{64}$/.test(s.id)||s.project!==request.project||!text(s.roleId)||!text(s.name,120)||
   !Number.isSafeInteger(s.expiresAt)||s.expiresAt<=now||s.expiresAt>d.expiresAt||!Array.isArray(s.provenance)||!s.provenance.length||s.provenance.length>100||
   s.provenance.some(p=>!exact(p,['source','action','resource'])||!['policy','delegation','ethereum-registry','gov-council','research-credential'].includes(p.source)||!text(p.action)||!text(p.resource)))fail();
 }
 if((!d.authoritative&&(d.allowed||d.scopes.length))||d.allowed!==(d.authoritative&&d.scopes.length>0)||
  (d.allowed?d.reason!=='current-role':d.reason==='current-role')||d.allowed&&(!d.policyDigest||!d.scopes.length)||
  request.action!=='list'&&(d.scopes.length>1||d.scopes.some(s=>s.id!==request.scopeId)))fail();
 return d;
}
