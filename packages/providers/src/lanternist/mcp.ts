/**
 * Minimal MCP client over Streamable HTTP (JSON-RPC 2.0): initialize once, then tools/call.
 * Handles plain JSON and text/event-stream replies and the Mcp-Session-Id header. Enough to call
 * a remote MCP server's tools from the worker; no prompts, resources or server-initiated calls.
 */

export class McpError extends Error {
  constructor(
    public code: "auth" | "unavailable" | "protocol" | "tool" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class McpHttpClient {
  private session: string | null = null;
  private nextId = 1;
  private ready: Promise<void> | null = null;
  constructor(
    private url: string,
    private token: string | null,
    private fetchImpl: Fetch = fetch,
    private timeoutMs = 60_000,
  ) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const id = notify ? undefined : this.nextId++;
    let r: Response;
    try {
      r = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id !== undefined ? { id } : {}) }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new McpError(ctrl.signal.aborted ? "timeout" : "unavailable", ctrl.signal.aborted ? "The server did not answer in time." : `The server is unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (r.status === 401 || r.status === 403) throw new McpError("auth", "The server rejected the access token (or needs you to sign in another way).");
    if (notify) return null;
    if (!r.ok) throw new McpError("unavailable", `The server answered ${r.status}.`);
    const text = await r.text();
    const msg = parseReply(text, r.headers.get("content-type") ?? "", id!);
    if (msg.error) throw new McpError("protocol", msg.error.message ?? "The server returned an error.");
    return msg.result;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Fluxtify", version: "1" } });
      await this.rpc("notifications/initialized", {}, true);
    })();
    return this.ready;
  }

  /** Call a tool; returns its structured content, or its text content parsed as JSON when possible. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.init();
    const res = (await this.rpc("tools/call", { name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
    const text = (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (res?.isError) throw new McpError("tool", text || `The ${name} tool failed.`);
    if (res?.structuredContent !== undefined) return res.structuredContent as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}

function parseReply(text: string, contentType: string, id: number): { result?: unknown; error?: { message?: string } } {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) {
        try {
          candidates.push(JSON.parse(data));
        } catch {
          /* ignore keep-alives */
        }
      }
    }
  } else {
    try {
      const j = JSON.parse(text);
      candidates.push(...(Array.isArray(j) ? j : [j]));
    } catch {
      throw new McpError("protocol", "The server's reply wasn't JSON.");
    }
  }
  const m = candidates.find((c) => (c as { id?: unknown }).id === id) as { result?: unknown; error?: { message?: string } } | undefined;
  if (!m) throw new McpError("protocol", "The server's reply didn't answer the request.");
  return m;
}
