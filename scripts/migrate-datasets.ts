// Additive migration only: does not rewrite existing CRM records.
import { pool, transaction } from "../lib/db";
import { datasetSchema } from "../lib/dataset-schema";
await transaction(async (db) => {
  await db.query(datasetSchema);
});
console.log("Dataset tables are ready.");
await pool().end();
