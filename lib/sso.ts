import {issueSessionProof} from '../shared/sso/session-proof.mjs';
import {randomUUID} from 'node:crypto';
import {createSsoClient} from '../shared/sso/client.mjs';
import {currentUser,currentAuthentication,authenticationCookieName,cookie,cookieName,hash,token,setCookie} from './auth';
import {pool,transaction} from './db';

export async function sharedSignIn(req:Request) {
 const env=process.env,origin=env.APP_URL||new URL(req.url).origin;
 // A legacy session can keep private workspace access, but its linked identities
 // cannot identify which method authenticated it. Never publish a guessed
 // identity or replace that account during an SSO callback.
 const local=await currentUser(req,false);
 if(local&&!await currentAuthentication(req)){
  const u=new URL(req.url),headers={'Cache-Control':'private, no-store'};
  if(u.origin!==origin||req.method!=='GET')return Response.json({error:'Unexpected sign-in request'},{status:403,headers});
  if(u.pathname.endsWith('/status'))return Response.json({configured:env.BITTREES_SSO_ENABLED==='1'&&Boolean(env.BITTREES_SSO_CLIENT_SECRET&&env.BITTREES_SSO_CLIENT_SECRET.length>=32),action:null,reauthenticationRequired:true},{headers});
  if(u.pathname.endsWith('/profile'))return Response.json({error:'Sign in again before shared profile access.'},{status:401,headers});
  return new Response(null,{status:303,headers:{...headers,Location:origin+'/'}});
 }

 return createSsoClient({clientId:'crm',origin,issuer:env.BITTREES_SSO_ISSUER||'https://roles.bittrees.org',secret:env.BITTREES_SSO_CLIENT_SECRET,enabled:env.BITTREES_SSO_ENABLED==='1',adapter:{
  async current(r:Request){
   const user=await currentUser(r,false);if(!user)return null;
   const proof=await currentAuthentication(r);return proof?{key:cookie(r,cookieName),identity:proof.identity,authTime:proof.authTime}:null;
  },
  async establish(identity:string,authTime:number){
   const key=token(),kind=identity.startsWith('0x')?'ethereum':'email';
   const proof=issueSessionProof({clientId:'crm',session:key,identity,authTime},env.AUTH_SECRET);
   await transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[kind+':'+identity]);
    const existing=(await db.query('SELECT i.user_id,u.merged_into FROM identities i JOIN users u ON u.id=i.user_id WHERE i.kind=$1 AND i.value=$2 FOR UPDATE OF u',[kind,identity])).rows[0];
    if(existing?.merged_into)throw Error('Account changed. Sign in again.');
    let userId=existing?.user_id;
    if(!userId){

     userId=randomUUID();const workspace=randomUUID();
     await db.query('INSERT INTO users(id,name) VALUES($1,$2)',[userId,kind==='email'?identity.split('@')[0]:identity.slice(0,6)+'…'+identity.slice(-4)]);
     await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)',[workspace,'My workspace']);
     await db.query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace,userId]);
     await db.query('INSERT INTO identities(kind,value,user_id) VALUES($1,$2,$3)',[kind,identity,userId]);
    }
    await db.query('INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,$3)',[hash(key),userId,new Date(authTime+604800000)]);
   });
   const maxAge=Math.max(0,Math.floor((authTime+604800000-Date.now())/1000));
   return {key,cookies:[setCookie(cookieName,key,maxAge),setCookie(authenticationCookieName,proof,maxAge)]};
  }
 }})(req);
}
