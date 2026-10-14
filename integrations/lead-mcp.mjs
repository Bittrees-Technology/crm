#!/usr/bin/env node
// MCP 2025-11-25 stdio adapter. Credential stays in this process, never in tool arguments/results.
import { pathToFileURL } from "node:url";
export const tools = [
  {
    name: "leads.brief",
    description:
      "Read the user-approved organization research brief. Public research must use permitted sources. Do not send private CRM information to search/model providers.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "leads.preview",
    description:
      "Submit one immutable batch of up to 20 sourced organizations for review in CRM. Does not import, contact, or merge records. Retry with the same operationId and identical candidates after an uncertain response.",
    inputSchema: {
      type: "object",
      required: ["operationId", "candidates"],
      additionalProperties: false,
      properties: {
        operationId: { type: "string", format: "uuid" },
        candidates: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "name",
              "website",
              "summary",
              "relevance",
              "uncertainties",
              "fit",
              "evidence",
              "sources",
            ],
            properties: {
              name: { type: "string", maxLength: 200 },
              website: { type: "string", format: "uri", maxLength: 800 },
              summary: { type: "string", maxLength: 500 },
              relevance: { type: "string", maxLength: 500 },
              uncertainties: { type: "string", maxLength: 500 },
              fit: { enum: ["high", "medium", "low"] },
              evidence: { enum: ["primary", "secondary", "unconfirmed"] },
              sources: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["url", "retrievedAt"],
                  properties: {
                    url: { type: "string", format: "uri", maxLength: 800 },
                    retrievedAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
export function handler({
  token = process.env.CRM_LEAD_TOKEN,
  origin = process.env.CRM_ORIGIN || "https://crm.bittrees.org",
  request = fetch,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(token || ""))
    throw Error("Set CRM_LEAD_TOKEN in the MCP server environment.");
  if (!["https://crm.bittrees.org", "http://127.0.0.1:3040"].includes(origin))
    throw Error("Unsupported CRM origin.");
  let initialized = false;
  return async (message) => {
    if (message.id === undefined) return null;
    const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
    const error = (code, text) => ({
      jsonrpc: "2.0",
      id: message.id,
      error: { code, message: text },
    });
    if (message.jsonrpc !== "2.0") return error(-32600, "Invalid request");
    if (message.method === "initialize") {
      initialized = true;
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "bittrees-crm-leads", version: "1.0.0" },
      });
    }
    if (!initialized) return error(-32002, "Initialize first");
    if (message.method === "ping") return reply({});
    if (message.method === "tools/list") return reply({ tools });
    if (message.method !== "tools/call")
      return error(-32601, "Method not found");
    const name = message.params?.name;
    if (!tools.some((t) => t.name === name))
      return error(-32602, "Unknown tool");
    try {
      const response = await request(
        origin +
          "/api/integrations/leads/" +
          (name === "leads.brief" ? "brief" : "prepare"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify(message.params?.arguments || {}),
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      const data = await response.json();
      if (!response.ok)
        return reply({
          isError: true,
          content: [
            {
              type: "text",
              text:
                typeof data.error === "string"
                  ? data.error
                  : "CRM request failed.",
            },
          ],
        });
      return reply({ content: [{ type: "text", text: JSON.stringify(data) }] });
    } catch {
      return reply({
        isError: true,
        content: [
          {
            type: "text",
            text: "CRM request could not be confirmed. Retry the same operation ID and payload; do not generate a replacement batch.",
          },
        ],
      });
    }
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let handle;
  try {
    handle = handler();
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exit(1);
  }
  let buffer = "",
    chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 256000) {
      process.stderr.write("MCP input exceeded size limit.\n");
      process.exit(1);
    }
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        let result;
        try {
          result = await handle(JSON.parse(line));
        } catch {
          result = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          };
        }
        if (result) process.stdout.write(JSON.stringify(result) + "\n");
      });
    }
  });
}
