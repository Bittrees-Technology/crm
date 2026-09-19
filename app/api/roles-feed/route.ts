import {pool} from '@/lib/db';
import {feedAuthorized,createRoleFeed} from '@/lib/role-feed-core.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'private, no-store'};
 if(!feedAuthorized(request.headers.get('authorization'),process.env.ROLES_FEED_READ_TOKEN))return Response.json({error:'Feed authentication required'},{status:401,headers});
 try{
 const result=await pool().query("SELECT m.user_id,m.workspace_id,m.role,m.scope_ids FROM members m JOIN users u ON u.id=m.user_id WHERE u.merged_into IS NULL ORDER BY m.user_id,m.workspace_id LIMIT 1001");
 const rows=result.rows.map(r=>({identity:r.user_id,kind:'account',label:r.role,scope:'workspace:'+r.workspace_id,restrictions:{recordIds:r.scope_ids}}));
 return Response.json(createRoleFeed('crm.bittrees.org',rows,{coverageNote:'Workspace account memberships only; source-scoped pseudonyms do not merge accounts across products. Record restrictions are preserved. Invitations and per-record/private-note visibility are not exported.',roledefs:['owner','editor','viewer']}),{headers});
 }catch{return Response.json({error:'Role feed unavailable'},{status:503,headers});}
}
