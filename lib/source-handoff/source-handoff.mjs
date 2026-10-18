import {createHash,createPublicKey,createPrivateKey,randomBytes,publicEncrypt,privateDecrypt,createCipheriv,createDecipheriv,sign,verify,constants} from 'node:crypto';
import {canonical} from './roles-proof.mjs';

const PREFIX='Bittrees CRM sealed source handoff v1\n';
const META=['version','issuer','audience','handoffId','connectionId','leaseId','policyDigest','tenant','workspace','principal','credentialId','runtimeBindingDigest','sourceWorkspace','mappingDigest','activatedAt','expiresAt','recipientKeyId'];
const FIELDS=['metadata','encryptedKey','iv','ciphertext','tag','signature'];
const fail=()=>{throw new Error('Invalid or expired source handoff');};
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...keys].sort().join())fail();}
function key(value,type,privatePart=false){const k=privatePart?createPrivateKey(value):createPublicKey(value);if(k.asymmetricKeyType!==type||(type==='rsa'&&k.asymmetricKeyDetails.modulusLength<3072))fail();return k;}
export function recipientKeyId(value){return createHash('sha256').update(key(value,'rsa').export({type:'spki',format:'der'})).digest('hex');}
function metadata(m,now){
 exact(m,META);
 if(m.version!==1||m.issuer!=='https://crm.bittrees.org'||m.audience!=='https://mcp.bittrees.org')fail();
 for(const field of META.filter(x=>!['version','issuer','audience'].includes(x)))if(typeof m[field]!=='string'||!m[field]||m[field].length>256)fail();
 for(const f of ['handoffId','connectionId','leaseId','sourceWorkspace'])if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[f]))fail();
 for(const f of ['credentialId','policyDigest','runtimeBindingDigest','mappingDigest','recipientKeyId'])if(!/^[0-9a-f]{64}$/.test(m[f]))fail();
 if(!/^agent:[0-9a-f-]{36}$/i.test(m.principal))fail();
 if(m.workspace!=='crm:'+m.sourceWorkspace||!/^roles:[0-9a-f-]{36}$/i.test(m.tenant))fail();
 const start=Date.parse(m.activatedAt),end=Date.parse(m.expiresAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||new Date(start).toISOString()!==m.activatedAt||new Date(end).toISOString()!==m.expiresAt||end-start!==3600000||start>now||end<=now)fail();
}
function bytes(value,max){if(typeof value!=='string'||!value||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))fail();const b=Buffer.from(value,'base64url');if(b.toString('base64url')!==value)fail();return b;}
const encoded=b=>b.toString('base64url');
const unsigned=e=>Object.fromEntries(FIELDS.filter(f=>f!=='signature').map(f=>[f,e[f]]));

// CRM calls only after owner consent and verification of the actual Roles receipt.
// The signing and recipient keys are server configuration, never browser input.
export function sealSourceHandoff({metadata:meta,token,recipientPublicKey,signingPrivateKey,now=Date.now()}){
 metadata(meta,now);
 if(meta.recipientKeyId!==recipientKeyId(recipientPublicKey)||typeof token!=='string'||token.length<16||token.length>4096||/\s/.test(token))fail();
 const aes=randomBytes(32),iv=randomBytes(12);
 try{
  const cipher=createCipheriv('aes-256-gcm',aes,iv);cipher.setAAD(Buffer.from(canonical(meta)));
  const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  const envelope={metadata:meta,encryptedKey:encoded(publicEncrypt({key:key(recipientPublicKey,'rsa'),oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},aes)),iv:encoded(iv),ciphertext:encoded(ciphertext),tag:encoded(cipher.getAuthTag())};
  return {...envelope,signature:encoded(sign(null,Buffer.from(PREFIX+canonical(envelope)),key(signingPrivateKey,'ed25519',true)))};
 }finally{aes.fill(0);}
}

// Operator expectedMetadata must come from independently verified owner consent,
// signed Roles receipt and approved mapping review, not be copied from this envelope.
export function openSourceHandoff({envelope,expectedMetadata,recipientPrivateKey,signingPublicKey,now=Date.now()}){
 try{
  exact(envelope,FIELDS);metadata(expectedMetadata,now);metadata(envelope.metadata,now);
  if(canonical(envelope.metadata)!==canonical(expectedMetadata))fail();
  for(const [field,max] of [['encryptedKey',1400],['iv',20],['ciphertext',5500],['tag',30]])bytes(envelope[field],max);
  const signature=bytes(envelope.signature,100);
  if(!verify(null,Buffer.from(PREFIX+canonical(unsigned(envelope))),key(signingPublicKey,'ed25519'),signature))fail();
  const privateKey=key(recipientPrivateKey,'rsa',true);
  if(recipientKeyId(createPublicKey(privateKey).export({type:'spki',format:'pem'}))!==expectedMetadata.recipientKeyId)fail();
  const iv=bytes(envelope.iv,20),tag=bytes(envelope.tag,30),encryptedKey=bytes(envelope.encryptedKey,1400),ciphertext=bytes(envelope.ciphertext,5500);
  if(iv.length!==12||tag.length!==16)fail();
  const aes=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},encryptedKey);
  try{
   if(aes.length!==32)fail();const decipher=createDecipheriv('aes-256-gcm',aes,iv);decipher.setAAD(Buffer.from(canonical(expectedMetadata)));decipher.setAuthTag(tag);
   const token=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
   if(token.length<16||token.length>4096||/\s/.test(token))fail();
   return {token,sourceWorkspace:expectedMetadata.sourceWorkspace,expiresAt:Date.parse(expectedMetadata.expiresAt)};
  }finally{aes.fill(0);}
 }catch{fail();}
}
