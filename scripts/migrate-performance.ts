import { pool, transaction } from "../lib/db";
import { performanceSchema } from "../lib/performance-schema";
try {
  await transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SELECT pg_advisory_xact_lock(73492016)");
    await db.query(performanceSchema);
  });
  console.log(
    "Additive performance migration applied: pagination revisions, index and save receipts.",
  );
} catch {
  console.error(
    "Performance migration failed and was rolled back. Connection details withheld.",
  );
  process.exitCode = 1;
} finally {
  await pool().end();
}
