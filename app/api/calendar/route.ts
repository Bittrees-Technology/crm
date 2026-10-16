import {verifyCalendarRequest} from '@/shared/calendar-bridge.mjs';
import {calendarItems} from '@/lib/calendar';
import {rateLimit} from '@/lib/auth';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:Request){const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'};try{if(Number(req.headers.get('content-length')||0)>8192)return Response.json({error:'Request too large.'},{status:413,headers});const body=verifyCalendarRequest(await req.text(),req.headers.get('x-bittrees-calendar-signature'),process.env.CALENDAR_BRIDGE_SECRET);await rateLimit('calendar:'+body.identity,120);if(body.action!=='list')return Response.json({error:'Unsupported Calendar action.'},{status:400,headers});return Response.json(await calendarItems(body.identity,body),{headers});}catch(e:any){return Response.json({error:e.status?e.message:'Calendar feed is unavailable.'},{status:e.status||503,headers});}}
