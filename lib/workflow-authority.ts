import { HttpError } from "./model";
export async function checkWorkflowAuthority(
  token: string,
  audience: string,
  scope: string,
  request: typeof fetch = fetch,
) {
  const response = await request(
    "https://ai.bittrees.org/api/workflow-authority",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "check", audience, scope }),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new HttpError(403, "Workflow authority unavailable");
  const result = await response.json();
  if (result.active !== true)
    throw new HttpError(403, "Workflow authority revoked");
  return result;
}
export function activeExpiry(
  grant: { managed?: boolean; expiresAt: number | null },
  now = Date.now(),
) {
  return (
    (grant.managed === true && grant.expiresAt === null) ||
    (Number.isFinite(grant.expiresAt) && grant.expiresAt! > now)
  );
}
