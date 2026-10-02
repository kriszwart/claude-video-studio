import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_BRAND, instantiateTemplate } from "@vs/templates";
import { lanternistShots, McpError, McpHttpClient, sendToLanternist } from "../src";

let n = 0;
const template = BUILTIN_TEMPLATES.find((t) => t.id === "product-launch")!;
const doc = instantiateTemplate(template, { title: "Tidewave launch", brand: { ...DEFAULT_BRAND, name: "Tidewave" }, inputs: { productName: "Tidewave", headline: "Plan less, ship more", brandName: "Tidewave" }, newId: (p) => `${p}${++n}` });

type Call = { method: string; params: { name?: string; arguments?: Record<string, unknown> }; session: string | null; auth: string | null };

/** A tiny MCP server: JSON for initialize, SSE for tool calls. */
function server(tools: Record<string, (args: Record<string, unknown>) => unknown>, opts: { status?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    calls.push({ method: body.method, params: body.params, session: h.get("mcp-session-id"), auth: h.get("authorization") });
    if (opts.status) return new Response("no", { status: opts.status });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "mcp-session-id": "s-1" } });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const fn = tools[body.params.name];
    const result = fn ? { content: [{ type: "text", text: JSON.stringify(fn(body.params.arguments)) }] } : { isError: true, content: [{ type: "text", text: "no such tool" }] };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  return { calls, fetchImpl };
}

describe("Lanternist", () => {
  it("turns each scene into a shot with its timing, narration and an image prompt", () => {
    const shots = lanternistShots(doc);
    expect(shots).toHaveLength(doc.scenes.length);
    for (const [i, s] of shots.entries()) {
      expect(s.duration).toBeCloseTo(doc.scenes[i]!.durationFrames / doc.format.fps, 1);
      expect(s.description).toContain(doc.scenes[i]!.purpose);
      expect(s.image_prompt).toBeTruthy();
      expect(s.description.length).toBeLessThanOrEqual(2000);
    }
  });

  it("initializes once, keeps the session id and reads SSE tool replies", async () => {
    const srv = server({ list_projects: () => ({ projects: [] }) });
    const c = new McpHttpClient("https://lantern.example/mcp", "tok", srv.fetchImpl);
    expect(await c.callTool("list_projects", {})).toEqual({ projects: [] });
    await c.callTool("list_projects", {});
    expect(srv.calls.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(srv.calls[0]!.auth).toBe("Bearer tok");
    expect(srv.calls.slice(1).every((x) => x.session === "s-1")).toBe(true);
  });

  it("maps a rejected token and a failing tool to clear errors", async () => {
    const denied = new McpHttpClient("https://lantern.example/mcp", "bad", server({}, { status: 401 }).fetchImpl);
    await expect(denied.callTool("list_projects", {})).rejects.toMatchObject({ code: "auth" });
    const c = new McpHttpClient("https://lantern.example/mcp", "tok", server({}).fetchImpl);
    const err = await c.callTool("nope", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: "tool", message: "no such tool" });
  });

  it("creates the film, draws pictures when asked (counting failures) and makes a review link", async () => {
    let pic = 0;
    const srv = server({
      create_project: (a) => ({ project_id: "p1", editor_url: "https://lantern.example/editor?project=p1", shots: (a.shots as unknown[]).length }),
      get_project: () => ({ shots: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      make_picture: () => {
        if (++pic === 2) throw new Error("x");
        return { ok: true };
      },
      create_review_link: () => ({ review_url: "https://lantern.example/v/abc" }),
    });
    // A throwing tool handler becomes a transport error; wrap it as a tool error instead.
    const tolerant = async (url: string, init?: RequestInit) => srv.fetchImpl(url, init).catch(() => Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result: { isError: true, content: [{ type: "text", text: "busy" }] } }));
    const stages: string[] = [];
    const r = await sendToLanternist(new McpHttpClient("https://lantern.example/mcp", "tok", tolerant), doc, { reviewLink: true, pictures: "lanternist", onStage: (s) => void stages.push(s) });
    expect(r).toEqual({ projectId: "p1", editorUrl: "https://lantern.example/editor?project=p1", reviewUrl: "https://lantern.example/v/abc", shots: doc.scenes.length, pictures: { made: 2, failed: 1 } });
    const create = srv.calls.find((x) => x.params?.name === "create_project")!;
    expect(create.params.arguments).toMatchObject({ title: "Tidewave launch (from Fluxtify)" });
    expect(stages).toContain("Lanternist is drawing shot 3 of 3");

    const plain = server({ create_project: () => ({ project_id: "p2" }) });
    const r2 = await sendToLanternist(new McpHttpClient("https://lantern.example/mcp", "tok", plain.fetchImpl), doc, { reviewLink: false, pictures: "none" });
    expect(r2).toMatchObject({ projectId: "p2", reviewUrl: null, editorUrl: null, pictures: { made: 0, failed: 0 } });
    expect(plain.calls.filter((x) => x.method === "tools/call").map((x) => x.params.name)).toEqual(["create_project"]);
  });

  it("attaches Fluxtify's own pictures by address, in film order, skipping scenes without one", async () => {
    const srv = server({
      create_project: () => ({ project_id: "p3" }),
      get_project: () => ({ shots: [{ id: "b", scene_number: 2 }, { id: "a", scene_number: 1 }, { id: "c", scene_number: 3 }] }),
      set_picture: () => ({ ok: true }),
    });
    const r = await sendToLanternist(new McpHttpClient("https://lantern.example/mcp", "tok", srv.fetchImpl), doc, { reviewLink: false, pictures: "fluxtify", pictureUrls: ["https://cdn.example/1.jpg", null, "https://cdn.example/3.jpg"] });
    expect(r.pictures).toEqual({ made: 2, failed: 0 });
    const sets = srv.calls.filter((x) => x.params?.name === "set_picture").map((x) => x.params.arguments);
    expect(sets).toEqual([{ scene_id: "a", image_url: "https://cdn.example/1.jpg" }, { scene_id: "c", image_url: "https://cdn.example/3.jpg" }]);
    expect(srv.calls.some((x) => x.params?.name === "make_picture")).toBe(false);
  });
});
