// Verification helpers from Roles 73a97846ab2c82846d3824476381e24660c5a69e, shared/mcp-authority.mjs and signed-action.mjs.
import {createPublicKey,verify} from "node:crypto";
export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  throw Error("Invalid signed payload");
}
export const MCP_AUDIENCE="https://mcp.bittrees.org";
export const DECISION_ENDPOINT="https://roles.bittrees.org/api/authority/mcp-decision";
export const requestMessage=r=>"Bittrees MCP authority request v1\n"+canonical(r);
export const decisionMessage=d=>"Bittrees MCP authority decision v1\n"+canonical(d);
export function verifyEd25519(message,signature,pem){try{const key=createPublicKey(pem);return key.asymmetricKeyType==='ed25519'&&typeof signature==='string'&&signature.length<=128&&verify(null,Buffer.from(message),key,Buffer.from(signature,'base64'));}catch{return false;}}
export function verifyDecision(envelope,request,pem,now=Date.now()){
 const d=envelope?.decision;
 if(!d||d.version!==1||d.issuer!=='https://roles.bittrees.org'||d.audience!==MCP_AUDIENCE||canonical(d.request)!==canonical(request)||!verifyEd25519(decisionMessage(d),envelope.signature,pem)||!Number.isSafeInteger(d.checkedAt)||!Number.isSafeInteger(d.expiresAt)||d.checkedAt>now+1000||d.expiresAt<=now||d.expiresAt-d.checkedAt>5000||d.requiresSourceAuthorization!==true||typeof d.allowed!=='boolean')throw Error('Roles authority decision rejected');
 return d;
}
