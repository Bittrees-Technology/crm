import { pool, transaction } from "../lib/db";
import { leadsSchema } from "../lib/leads-schema";
import { workflowSchema } from "../lib/workflow-schema";
try {
  await transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SELECT pg_advisory_xact_lock(73492016)");
    await db.query(leadsSchema + workflowSchema);
  });
  console.log("Additive lead research and CRM workflow migration applied.");
} catch {
  console.error("Migration rolled back. Connection details withheld.");
  process.exitCode = 1;
} finally {
  await pool().end();
}
