export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(){return Response.json({protocol:'bittrees-roles-ecosystem-v1',project:'crm',configured:!!process.env.ROLES_ECOSYSTEM_REQUEST_PRIVATE_KEY&&!!process.env.ROLES_ECOSYSTEM_DECISION_PUBLIC_KEY},{headers:{'Cache-Control':'no-store'}});}
