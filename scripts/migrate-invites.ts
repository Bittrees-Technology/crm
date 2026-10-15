import { pool, transaction } from "../lib/db";
import { invitesSchema } from "../lib/invites-schema";
try {
  await transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SELECT pg_advisory_xact_lock(73492016)");
    await db.query(invitesSchema);
  });
  console.log(
    "Wallet invitation migration applied; existing email invitations preserved.",
  );
} catch {
  console.error("Migration rolled back. Connection details withheld.");
  process.exitCode = 1;
} finally {
  await pool().end();
}
