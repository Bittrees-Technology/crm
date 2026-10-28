import { pool, transaction } from "../lib/db";
import { nativeWorkflowSchema } from "../lib/native-workflow-schema";
import type { PoolClient } from "pg";
async function retention(db: PoolClient) {
  const result: Record<string, unknown> = {};
  for (const table of ["users", "identities", "members", "workspaces", "records"]) {
    result[table] = (await db.query(`SELECT count(*)::text AS count,coalesce(sum(('x'||substr(md5((to_jsonb(t)-'authority_generation')::text),1,16))::bit(64)::bigint::numeric),0)::text AS digest FROM ${table} t`)).rows[0];
  }
  return result;
}
try {
  const receipt = await transaction(async db => {
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query("SELECT pg_advisory_xact_lock(73492016)");
    // Keep the snapshot stable across backfill without changing live rows.
    await db.query("LOCK TABLE users,identities,members,workspaces,records IN SHARE ROW EXCLUSIVE MODE");
    const before = await retention(db);
    await db.query(nativeWorkflowSchema);
    const runtimeRole = process.env.NATIVE_WORKFLOW_RUNTIME_ROLE;
    if (runtimeRole) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(runtimeRole)) throw Error("Invalid existing runtime role");
      if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [runtimeRole])).rowCount) throw Error("Existing runtime role missing");
      await db.query(`GRANT SELECT,INSERT,DELETE ON native_workflow_requests TO "${runtimeRole}"`);
    }
    const after = await retention(db);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("CRM retention mismatch");
    const installed = (await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='members'::regclass AND tgname IN ('crm_native_member_generation','crm_native_workspace_generation')")).rows[0].n;
    if (installed !== 2) throw Error("Generation triggers missing");
    return { migration: "crm-native-workflow-authority-v1", crmContentAndMembershipsUnchanged: true, snapshot: after, generationTriggers: installed, runtimeReplayPermission: !!runtimeRole };
  });
  console.log(JSON.stringify(receipt));
} catch {
  console.error("Native workflow migration failed and rolled back; connection details withheld.");
  process.exitCode = 1;
} finally { await pool().end(); }
