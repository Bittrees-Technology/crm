import { acceptCorrection, deliverCorrections, secretMatches } from '../../../../../lib/index-corrections';
export const runtime='nodejs';
export const maxDuration=30;
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store'};
 if(!secretMatches(request.headers.get('authorization'),process.env.INDEX_CORRECTIONS_SECRET))return Response.json({error:'Unauthorized.'},{status:401,headers});
 try{
  const text=await request.text();if(Buffer.byteLength(text)>18000)return Response.json({error:'Suggestion too large.'},{status:413,headers});
  const result=await acceptCorrection(JSON.parse(text));
  // The task and durable retry record are committed before attempting delivery.
  try{await deliverCorrections(fetch,result.reference);}catch{}
  return Response.json(result,{status:202,headers});
 }catch(e){const error=e as {status?:number;name?:string;message?:string};const status=error.status||(error.name==='ZodError'||error.name==='SyntaxError'?400:503);return Response.json({error:status===503?'Correction intake is temporarily unavailable.':error.status?error.message:'Check the suggestion fields.'},{status,headers});}
}
