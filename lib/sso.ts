import {randomUUID} from 'node:crypto';
import {createSsoClient} from '../shared/sso/client.mjs';
import {currentUser,cookie,cookieName,hash,token,setCookie} from './auth';
import {pool,transaction} from './db';

export async function sharedSignIn(req:Request) {
 const env=process.env,origin=env.APP_URL||new URL(req.url).origin;
 return createSsoClient({clientId:'crm',origin,issuer:env.BITTREES_SSO_ISSUER||'https://roles.bittrees.org',secret:env.BITTREES_SSO_CLIENT_SECRET,enabled:env.BITTREES_SSO_ENABLED==='1',adapter:{
  async current(r:Request){
   const user=await currentUser(r,false);if(!user)return null;
   const key=cookie(r,cookieName),result=await pool().query("SELECT i.value,s.expires_at FROM sessions s JOIN identities i ON i.user_id=s.user_id WHERE s.hash=$1 ORDER BY i.kind,i.value LIMIT 1",[hash(key)]);
   const row=result.rows[0];return row?{key,identity:row.value,authTime:new Date(row.expires_at).getTime()-604800000}:null;
  },
  async establish(identity:string,authTime:number){
   const key=token(),kind=identity.startsWith('0x')?'ethereum':'email';
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
   return {key,cookies:[setCookie(cookieName,key,Math.max(0,Math.floor((authTime+604800000-Date.now())/1000)))]};
  }
 }})(req);
}
