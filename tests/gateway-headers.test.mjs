import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as bot from "../supabase/functions/open-brain-web-gateway/bot-policy.mjs";
import * as lib from "../supabase/functions/open-brain-web-gateway/lib.mjs";

// Load the actual HTTP handler with synthetic auth and a fail-closed HTTP mock.
function fixture() {
  const source = readFileSync(new URL("../supabase/functions/open-brain-web-gateway/index.ts", import.meta.url), "utf8")
    .replace(/import[\s\S]*?from "[^"]+";\s*/g, "");
  let handler;
  const calls = [];
  const env = {
    SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "synthetic-anon",
    MCP_ACCESS_KEY: "synthetic-server-key", OPEN_BRAIN_OAUTH_CLIENT_IDS: "full",
    OPEN_BRAIN_READ_ONLY_OAUTH_CLIENT_IDS: "read", OPEN_BRAIN_ALLOWED_EMAILS: "user@example.test",
  };
  const fetch = async (url, init) => {
    assert.equal(url, "https://project.test/functions/v1/open-brain-mcp");
    assert.equal(init.redirect, "error");
    calls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { events: [] } }),
      { headers: { "content-type": "application/json" } });
  };
  const createClient = () => ({ auth: { getUser: async () => ({ data: { user: {
    id: "user", email: "user@example.test",
  } }, error: null }) } });
  const dependencies = { ...lib, ...bot };
  new Function("createClient", ...Object.keys(dependencies), "Deno", "fetch", stripTypeScriptTypes(source))(
    createClient, ...Object.values(dependencies), { env: { get: key => env[key] }, serve: fn => { handler = fn; } }, fetch,
  );
  const token = client => {
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({})}.${encode({ sub: "user", email: "user@example.test", client_id: client,
      iss: "https://project.test/auth/v1", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 60 })}.synthetic`;
  };
  const request = (method, params = {}, options = {}) => handler(new Request(
    `https://project.test/functions/v1/open-brain-web-gateway${options.readOnly ? "/readonly" : ""}`, {
      method: "POST", headers: { authorization: `Bearer ${token(options.client ?? "full")}`,
        "content-type": "application/json", ...options.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
  return { request, calls, handler };
}

test("actual gateway forwards modern discovery/event/tool routing headers only", async () => {
  const { request, calls } = fixture();
  for (const [method, params] of [["server/discover", {}], ["events/list", {}],
    ["events/subscribe", { name: "message.created", arguments: { recipient: "coop" } }],
    ["tools/call", { name: "check_messages", arguments: { recipient: "coop" } }]]) {
    const headers = { "mcp-protocol-version": "2026-07-28", "mcp-method": method,
      "mcp-session-id": "session", "x-brain-key": "caller-key", "x-open-brain-client": "spoof" };
    if (params.name) headers["mcp-name"] = params.name;
    assert.equal((await request(method, params, { headers })).status, 200);
    const upstream = calls.at(-1);
    assert.equal(upstream.headers.get("mcp-protocol-version"), "2026-07-28");
    assert.equal(upstream.headers.get("mcp-method"), method);
    assert.equal(upstream.headers.get("mcp-name"), params.name ?? null);
    assert.equal(upstream.headers.get("mcp-session-id"), "session");
    assert.equal(upstream.headers.get("x-brain-key"), "synthetic-server-key");
    assert.equal(upstream.headers.has("authorization"), false);
    assert.equal(upstream.headers.has("x-open-brain-client"), false);
    assert.deepEqual(upstream.body.params, params);
  }
});

test("legacy routing, authentication and existing read-only tool denial stay intact", async () => {
  const { request, calls } = fixture();
  assert.equal((await request("tools/list")).status, 200);
  assert.equal(calls[0].headers.has("mcp-method"), false);
  assert.equal((await request("events/list", {}, { client: "unapproved" })).status, 401);
  assert.equal(calls.length, 1);
  const denied = await request("tools/call", { name: "capture_thought", arguments: { content: "synthetic" } },
    { readOnly: true, client: "read", headers: { "mcp-method": "tools/call", "mcp-name": "capture_thought" } });
  assert.equal((await denied.json()).error.code, -32601);
  assert.equal(calls.length, 1);
});

test("capture aliases align matching modern name headers without repairing malformed pairs", async () => {
  const { request, calls } = fixture();
  for (const incomingName of ["capture_thought_exact", "mismatched"]) {
    const firstCall = calls.length;
    await request("tools/call", { name: "capture_thought_exact", arguments: { content: "synthetic" } }, {
      headers: { "mcp-method": "tools/call", "mcp-name": incomingName, "mcp-protocol-version": "2026-07-28" },
    });
    const upstream = calls[firstCall];
    assert.equal(upstream.body.params.name, "capture_thought");
    assert.equal(upstream.headers.get("mcp-name"), incomingName === "mismatched" ? incomingName : "capture_thought");
  }
});

test("browser preflight permits the same three modern routing headers", async () => {
  const { handler } = fixture();
  const response = await handler(new Request("https://project.test/functions/v1/open-brain-web-gateway", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  const allowed = response.headers.get("access-control-allow-headers").split(", ");
  for (const name of ["mcp-protocol-version", "mcp-method", "mcp-name"]) assert.ok(allowed.includes(name));
});
