import { hash, rateLimit } from "./auth";

const reads = new Set([
  "dataset.schema",
  "dataset.read",
  "qualification.context",
  "projects.list",
  "project.read",
  "tasks.list",
]);
/** Polling must not spend the mutation budget used to save research and tasks. */
export async function datasetOperationLimit(bearer: string, input: unknown) {
  const rpc = input as any;
  const readOnly =
    rpc?.jsonrpc === "2.0" &&
    !Array.isArray(rpc) &&
    (["initialize", "ping", "tools/list"].includes(rpc.method) ||
      (rpc.method === "tools/call" && reads.has(rpc.params?.name)));
  await rateLimit(
    `dataset:${readOnly ? "read" : "write"}:${hash(bearer)}`,
    readOnly ? 160 : 40,
  );
}
