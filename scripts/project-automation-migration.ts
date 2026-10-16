import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { projectAutomationSchema } from "../lib/project-automation-schema";
const file = process.argv[2];
if (!file) throw Error("Provide a protected connection-string file.");
const connectionString = readFileSync(file, "utf8").trim();
const url = new URL(connectionString);
if (url.hostname.includes("-pooler"))
  throw Error("Use a direct connection for migration.");
if (url.pathname !== "/bittrees_crm") throw Error("Expected the CRM database.");
const db = new Pool({ connectionString, max: 1 });
try {
  await db.query("BEGIN");
  await db.query("SET LOCAL ROLE crm_production_owner");
  await db.query(projectAutomationSchema);
  await db.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON dataset_project_permissions,project_ai_runs TO crm_production",
  );
  await db.query("COMMIT");
  const r = await db.query(
    "SELECT to_regclass('dataset_project_permissions') IS NOT NULL AND to_regclass('project_ai_runs') IS NOT NULL AS ready",
  );
  console.log(
    JSON.stringify({ migration: "project-automation", ready: r.rows[0].ready }),
  );
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
