export type SessionProof = {identity:string;kind:'ethereum'|'email';authTime:number};
export function issueSessionProof(input:{clientId:string;session:string;identity:string;authTime:number},secret:string|undefined,now?:number):string;
export function readSessionProof(value:string,input:{clientId:string;session:string;secret:string|undefined;now?:number}):SessionProof|null;
