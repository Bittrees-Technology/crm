import { pool, schema } from "../lib/db";
await pool().query(schema);
console.log("CRM schema is ready.");
await pool().end();
