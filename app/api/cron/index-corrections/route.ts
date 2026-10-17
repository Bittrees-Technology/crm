import {deliverCorrections,secretMatches} from '../../../../lib/index-corrections';
export const runtime='nodejs';
export const maxDuration=240;
export async function GET(request:Request){
 if(!secretMatches(request.headers.get('authorization'),process.env.CRON_SECRET))return Response.json({error:'Unauthorized.'},{status:401});
 try{return Response.json(await deliverCorrections(),{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'Delivery is temporarily unavailable.'},{status:503});}
}
