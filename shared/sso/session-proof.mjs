import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
const lifetime=7*24*60*60*1000,domain='bittrees.session-authentication.v1\n';
const identityValid=s=>typeof s==='string'&&s===s.toLowerCase()&&(/^0x[a-f0-9]{40}$/.test(s)||s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
const sessionHash=s=>createHash('sha256').update(s).digest('hex');
function key(secret){if(typeof secret!=='string'||secret.length<32)throw Error('Session authentication signing is unavailable');return secret;}
// This proof records authentication, never authority. Call only after a native
// login proof or a validated SSO exchange. It must accompany a live app session
// and an identity that is still verified on the same account.
export function issueSessionProof({clientId,session,identity,authTime},secret,now=Date.now()){
 key(secret);if(!/^[a-z][a-z0-9-]{0,47}$/.test(clientId)||typeof session!=='string'||!/^[a-f0-9]{64}$/.test(session)||!identityValid(identity)||!Number.isSafeInteger(authTime)||authTime>now+30000||authTime+lifetime<=now)throw Error('Invalid session authentication');
 const body=Buffer.from(JSON.stringify({version:1,clientId,sessionHash:sessionHash(session),identity,authTime,expiresAt:authTime+lifetime})).toString('base64url');
 return body+'.'+createHmac('sha256',secret).update(domain+body).digest('base64url');
}
export function readSessionProof(value,{clientId,session,secret,now=Date.now()}){
 try{
  key(secret);if(typeof value!=='string'||value.length>1200||typeof session!=='string'||!/^[a-f0-9]{64}$/.test(session))return null;
  const parts=value.split('.');if(parts.length!==2||parts.some(s=>!/^[A-Za-z0-9_-]+$/.test(s)))return null;
  const expected=createHmac('sha256',secret).update(domain+parts[0]).digest(),actual=Buffer.from(parts[1],'base64url');if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
  const p=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
  if(!p||Object.keys(p).sort().join(',')!=='authTime,clientId,expiresAt,identity,sessionHash,version'||p.version!==1||p.clientId!==clientId||p.sessionHash!==sessionHash(session)||!identityValid(p.identity)||!Number.isSafeInteger(p.authTime)||p.authTime>now+30000||p.expiresAt!==p.authTime+lifetime||p.expiresAt<=now)return null;
  return {identity:p.identity,kind:p.identity.startsWith('0x')?'ethereum':'email',authTime:p.authTime};
 }catch{return null;}
}
