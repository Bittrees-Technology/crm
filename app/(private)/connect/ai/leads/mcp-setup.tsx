"use client";
import { useState, useEffect } from "react";
export default function McpSetup({
  credential,
  onHide,
}: {
  credential: string;
  onHide: () => void;
}) {
  const [client, setClient] = useState("cursor"),
    [show, setShow] = useState(false),
    [status, setStatus] = useState(""),
    [testing, setTesting] = useState(false);
  useEffect(() => {
    document.getElementById("agent-setup")?.scrollIntoView();
  }, [credential]);
  const url =
    typeof window === "undefined"
      ? ""
      : window.location.origin + "/api/integrations/leads/mcp";
  function config(secret: string) {
    const server = {
      ...(client === "vscode" ? { type: "http" } : {}),
      url,
      headers: { Authorization: "Bearer " + secret },
    };
    return JSON.stringify(
      {
        [client === "vscode" ? "servers" : "mcpServers"]: {
          "bittrees-leads": server,
        },
      },
      null,
      2,
    );
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(label + " copied.");
    } catch {
      setStatus(
        "Clipboard unavailable. Use Show configuration, select the text and copy it.",
      );
      setShow(true);
    }
  }
  async function test() {
    setTesting(true);
    setStatus("");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json();
      if (
        !r.ok ||
        !data.result?.tools?.some((t: any) => t.name === "leads.preview")
      )
        throw Error(
          data.error?.message || data.error || "Connection unavailable.",
        );
      setStatus(
        "CRM connection verified. Your agent should show leads.brief, leads.preview and leads.status.",
      );
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setTesting(false);
    }
  }
  const prompt =
    "Read my assignment with leads.brief. Research investors using the permitted public sources. Categorize people and organizations, link people to their firms, and include sources and uncertainties. Propose linked follow-up tasks only if the brief allows them; do not invent deadlines. Submit one finished batch with leads.preview using a stable operationId, then use leads.status with that operationId to check its outcome when requested. Do not contact anyone or publish records.";
  return (
    <section id="agent-setup" className="integration-card">
      <h3>Connect your local agent</h3>
      <p>
        No download or terminal command is needed for an app that supports
        remote MCP with an authorization header. Your agent still needs its own
        web search tools.
      </p>
      <ol>
        <li>Choose your app below and copy the configuration.</li>
        <li>
          In your app’s MCP settings, open your personal configuration and add
          the Bittrees entry. Keep any existing servers.
        </li>
        <li>
          Enable the connection, then copy the research instructions into your
          agent.
        </li>
      </ol>
      <label>
        AI app
        <select
          aria-label="AI app"
          value={client}
          onChange={(e) => setClient(e.target.value)}
        >
          <option value="cursor">Cursor</option>
          <option value="vscode">VS Code</option>
          <option value="other">Other remote MCP client</option>
        </select>
      </label>
      {client === "cursor" && (
        <p>
          Open Cursor Settings → Tools &amp; MCP → Add new global MCP server.
          Paste into your personal MCP configuration.{" "}
          <a
            href="https://cursor.com/docs/context/mcp"
            target="_blank"
            rel="noopener noreferrer"
          >
            Cursor setup help
          </a>
        </p>
      )}
      {client === "vscode" && (
        <p>
          Run “MCP: Open User Configuration” from the Command Palette. Paste the
          configuration there, save, and start the server.{" "}
          <a
            href="https://code.visualstudio.com/docs/agent-customization/mcp-servers"
            target="_blank"
            rel="noopener noreferrer"
          >
            VS Code setup help
          </a>
        </p>
      )}
      {client === "other" && (
        <p>
          Choose HTTP / Streamable HTTP. Use the server URL below and an
          Authorization header containing “Bearer ” followed by your credential.
          Apps that only support OAuth or local commands need a different setup;
          the existing local adapter remains available.
        </p>
      )}
      <p>
        This configuration contains your private, assignment-limited credential.
        Paste it only into your own agent settings, never a chat or shared
        repository. It expires with the assignment after seven days. Replacing
        it invalidates the old connection.
      </p>
      <label>
        Server URL
        <input readOnly value={url} />
      </label>
      <label>
        Lead connection credential
        <input
          type={show ? "text" : "password"}
          readOnly
          value={credential}
          autoComplete="off"
          onFocus={(e) => e.target.select()}
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={show}
          onChange={(e) => setShow(e.target.checked)}
        />
        Show configuration and credential
      </label>
      {show && (
        <label>
          MCP configuration
          <textarea
            aria-label="MCP configuration"
            readOnly
            rows={12}
            value={config(credential)}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      <button
        className="button primary"
        onClick={() => void copy(config(credential), "MCP configuration")}
      >
        Copy MCP configuration
      </button>{" "}
      <button className="button" onClick={() => void copy(url, "Server URL")}>
        Copy server URL
      </button>{" "}
      <button className="button" disabled={testing} onClick={() => void test()}>
        Test connection
      </button>
      <h4>Start researching</h4>
      <p>{prompt}</p>
      <button
        className="button"
        onClick={() => void copy(prompt, "Research instructions")}
      >
        Copy research instructions
      </button>{" "}
      <button className="button" onClick={onHide}>
        Hide credential
      </button>
      <p>
        Only your brief and submitted research pass through this connection. It
        cannot read CRM contacts, private notes, publish leads or send messages.
        Your agent’s search and model providers may receive the brief and
        research.
      </p>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
