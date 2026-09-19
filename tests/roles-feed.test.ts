import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,verify} from 'node:crypto';import {pool} from '../lib/db';import {GET} from '../app/api/roles-feed/route';
test('Feed authentication, scoped account privacy, bounded roster and source failures',async()=>{
 process.env.DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/unreachable';process.env.ROLES_FEED_READ_TOKEN='a'.repeat(64);process.env.ROLES_FEED_SUBJECT_SECRET='b'.repeat(64);
 const pair=generateKeyPairSync('ed25519');process.env.ROLES_FEED_PRIVATE_KEY=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const db=pool(),original=db.query;let calls=0;
 const req=()=>new Request('https://crm.bittrees.org/api/roles-feed',{headers:{authorization:'Bearer '+process.env.ROLES_FEED_READ_TOKEN}});
 try{
 db.query=(async()=>{calls++;return {rows:[{user_id:'private-account',workspace_id:'workspace-one',role:'editor',scope_ids:[]},{user_id:'private-account',workspace_id:'workspace-two',role:'editor',scope_ids:null}]};}) as unknown as typeof db.query;
 assert.equal((await GET(new Request(req().url))).status,401);assert.equal(calls,0);
 const response=await GET(req());assert.equal(response.status,200);const feed=await response.json();assert(!JSON.stringify(feed).includes('private-account'));assert.equal(Object.keys(feed.data.subjects).length,1);assert.equal((Object.values(feed.data.roles)[0] as unknown[]).length,2);assert(verify(null,Buffer.from(JSON.stringify(feed.data)),pair.publicKey,Buffer.from(feed.signature,'base64')));
 db.query=(async()=>{throw Error('Storage down');}) as unknown as typeof db.query;assert.equal((await GET(req())).status,503);
 db.query=(async()=>({rows:Array(1001).fill({user_id:'one',workspace_id:'one',role:'owner'})})) as unknown as typeof db.query;assert.equal((await GET(req())).status,503);
 }finally{db.query=original;await db.end();}
});
