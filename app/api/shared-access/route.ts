import {currentUser} from '@/lib/auth';
import {pool} from '@/lib/db';
import {ecosystemAccess,ecosystemSubject} from '@/lib/ecosystem-client.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'private, no-store'};
 try{
  const user=await currentUser(request,false);
  if(!user)return Response.json({error:'Sign in first.'},{status:401,headers});
  const identities=(await pool().query('SELECT kind,value FROM identities WHERE user_id=$1 AND verified_at IS NOT NULL ORDER BY kind,value LIMIT 21',[user.id])).rows;
  const subjects=identities.map(i=>ecosystemSubject('crm',i.kind==='ethereum'?'wallet':i.kind,i.value,process.env.ROLES_FEED_SUBJECT_SECRET));
  const access=await ecosystemAccess('crm',subjects,{verifiedEmails:identities.flatMap((i,index)=>i.kind==='email'?[{subject:subjects[index],email:i.value}]:[])});
  return Response.json({...access,rolesUrl:'https://roles.bittrees.org',manageRolesUrl:'https://roles.bittrees.org/role-management?project=crm',workflowsUrl:'https://workflow.bittrees.org',privateOwnershipRequired:true},{headers});
 }catch{return Response.json({error:'Shared permission check unavailable. Private workspace access is unchanged.'},{status:503,headers});}
}
