import { tools } from "../integrations/lead-mcp.mjs";
import { agentBrief, prepare } from "./leads";
import { checkOrigin } from "./auth";
import { HttpError } from "./model";
const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
export async function leadMcp(req: Request, bearer: string, input: any) {
  const origin = req.headers.get("origin");
  if (origin) checkOrigin(req);
  const version = req.headers.get("mcp-protocol-version");
  if (version && !versions.includes(version))
    throw new HttpError(400, "Unsupported MCP protocol version.");
  const brief = await agentBrief(bearer); // Every request, including discovery, rechecks current authority.
  if (!input || Array.isArray(input) || input.jsonrpc !== "2.0")
    throw new HttpError(400, "Send one JSON-RPC message.");
  if (input.id === undefined) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: input.id, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: input.id,
    error: { code, message },
  });
  if (input.method === "initialize")
    return reply({
      protocolVersion: versions.includes(input.params?.protocolVersion)
        ? input.params.protocolVersion
        : versions[0],
      capabilities: { tools: {} },
      serverInfo: { name: "bittrees-crm-leads", version: "1.1.0" },
    });
  if (input.method === "ping") return reply({});
  if (input.method === "tools/list") return reply({ tools });
  if (input.method !== "tools/call") return error(-32601, "Method not found");
  if (!tools.some((t) => t.name === input.params?.name))
    return error(-32602, "Unknown tool");
  try {
    if (
      input.params.name === "leads.brief" &&
      Object.keys(input.params.arguments || {}).length
    )
      throw new HttpError(400, "This tool takes no arguments.");
    const result =
      input.params.name === "leads.brief"
        ? brief
        : await prepare(bearer, input.params.arguments);
    return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (e) {
    return reply({
      isError: true,
      content: [
        {
          type: "text",
          text:
            e instanceof HttpError
              ? e.message
              : "Check the candidate fields and try again.",
        },
      ],
    });
  }
}
