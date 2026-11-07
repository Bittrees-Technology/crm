import { pool, transaction } from "../lib/db";
import { migrateWorkflowAssignments } from "../lib/workflow-assignment-migration";
// No auto-migration at import/startup. This exact command is an operator release
// action, subject to reviewed source, runtime account/cost and rollback evidence.
if (
  process.argv.length !== 3 ||
  process.argv[2] !== "--apply-reviewed-schema"
) {
  console.error(
    "Review the workflow source migration and use --apply-reviewed-schema. No database was opened.",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await transaction(migrateWorkflowAssignments)));
  } catch {
    console.error(
      "Workflow source migration failed and rolled back; connection details withheld.",
    );
    process.exitCode = 1;
  } finally {
    await pool().end();
  }
}
