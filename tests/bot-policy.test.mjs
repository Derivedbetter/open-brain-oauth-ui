import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as lib from "../supabase/functions/open-brain-web-gateway/lib.mjs";
import * as bot from "../supabase/functions/open-brain-web-gateway/bot-policy.mjs";

const actor = "grok/bot/corty";
const read = { actor, phase: "readonly", recipients: [] };
const write = { actor, phase: "own_mail_receipt", recipients: ["codex/advisor/prime"] };
const call = (name, args = {}) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
const configuration = (p) => JSON.stringify({ "bot-client": p });

test("strict server policy refuses malformed phases/identities and retains legacy client behavior", () => {
  for (const bad of ["[]", "null", "not-json", configuration({ ...read, phase: "full" }),
    configuration({ ...read, actor: "Tony" }), configuration({ ...read, actor: [actor] }),
    configuration({ ...read, actor: null }), configuration({ ...read, actor: {} }),
    configuration({ ...read, extra: true }),
    configuration({ ...read, recipients: ["lead", "lead"] })]) assert.throws(() => bot.botClientPolicy(bad, "bot-client"));
  assert.deepEqual(bot.botClientPolicy(configuration(read), "bot-client"), read);
  assert.equal(bot.botClientPolicy(configuration(read), "legacy"), null);
  const admin = call("set_memory_lifecycle", { actor: "Tony" });
  assert.equal(bot.bindBotRequest(admin, null, false), admin);
});

test("own mailbox binding refuses identity spoof and read-only writes on either route", () => {
  assert.equal(bot.bindBotRequest(call("check_messages"), read, false).params.arguments.recipient, actor);
  for (const args of [{ recipient: "lead" }, { recipient: "grok/bot/other" }, { actor: "Tony" }, { sender: "lead" }])
    assert.throws(() => bot.bindBotRequest(call("check_messages", args), read, false));
  for (const name of ["send_message", "consume_message", "write_work_receipt", "capture_thought", "pending_messages", "set_memory_lifecycle"])
    assert.throws(() => bot.bindBotRequest(call(name), read, false));
  assert.throws(() => bot.bindBotRequest(call("write_work_receipt"), write, true));
  for (const request of [[], null, { method: "resources/read" }, { method: "notifications/cancelled" }])
    assert.throws(() => bot.bindBotRequest(request, read, false));
});

test("promoted client has only own mail and agent work receipt, never review or owner authority", () => {
  const receipt = bot.bindBotRequest(call("write_work_receipt", { meaningful_outcome: "Synthetic fixture only" }), write, false);
  assert.equal(receipt.params.arguments.source_actor, actor);
  assert.throws(() => bot.bindBotRequest(call("write_work_receipt", { source_actor: "Tony" }), write, false));
  assert.throws(() => bot.bindBotRequest(call("consume_message", { recipient: "lead" }), write, false));
  assert.equal(bot.bindBotRequest(call("consume_message"), write, false).params.arguments.recipient, actor);
  const send = call("send_message", { recipient: "codex/advisor/prime", content: "Synthetic fixture receipt" });
  assert.equal(bot.bindBotRequest(send, write, false).params.arguments.sender, actor);
  for (const args of [{ recipient: "lead" }, { recipient: "codex/advisor/prime", sender: "lead" },
    { recipient: "codex/advisor/prime", review: {} }, { recipient: "codex/advisor/prime", intent: "task_handoff" }])
    assert.throws(() => bot.bindBotRequest(call("send_message", args), write, false));
  assert.throws(() => bot.bindBotRequest(call("capture_thought", { source_actor: actor }), write, false));
});

test("tool lists disclose exactly eight reads then only three bounded writes; SSE remains valid", () => {
  const names = ["check_messages", "export_memory_changes", "fetch", "list_thoughts", "memory_audit", "search", "search_thoughts", "thought_stats", "send_message", "consume_message", "write_work_receipt", "capture_thought", "set_memory_lifecycle"];
  const messages = () => [{ result: { tools: names.map(name => ({ name, inputSchema: { properties: { recipient: {}, sender: {}, source_actor: {}, review: {} } } })) } }];
  assert.equal(bot.filterBotToolList(messages(), read, false)[0].result.tools.length, 8);
  const scoped = bot.filterBotToolList(messages(), write, false);
  assert.equal(scoped[0].result.tools.length, 11);
  assert.equal(scoped[0].result.tools.find(t => t.name === "check_messages").inputSchema.properties.recipient.const, actor);
  assert.deepEqual(lib.parseMcpResponse("text/event-stream", lib.serializeMcpResponse("text/event-stream", scoped)), scoped);
});

test("exact fetch cannot reveal foreign mailbox by UUID, while own mail and ordinary memory remain readable", () => {
  const response = (metadata) => [{ result: { content: [{ type: "text", text: JSON.stringify({ id: "fixture", text: "Synthetic private fixture", metadata }) }] } }];
  assert.equal(bot.filterBotFetch(response({ storage: "messaging", recipient: "lead" }), call("fetch"), read)[0].result.isError, true);
  for (const metadata of [{ storage: "messaging", record_kind: "message", type: "internal_message", recipient: actor }, { storage: "messaging", record_kind: "message", type: "internal_message", recipient: "lead", sender: actor }, { memory_profile: { primary_kind: "work_receipt" } }]) {
    assert.equal(bot.filterBotFetch(response(metadata), call("fetch"), read)[0].result.isError, undefined);
  }
});

// Execute the actual Edge handler, replacing only external auth/network/runtime.
function fixture(policy = read, options = {}) {
  let handler; const calls = [];
  const endpoint = lib.projectEndpoints();
  const env = { SUPABASE_ANON_KEY: "fixture-anon", MCP_ACCESS_KEY: "fixture-upstream", OPEN_BRAIN_OAUTH_CLIENT_IDS: "bot-client,legacy",
    OPEN_BRAIN_READ_ONLY_OAUTH_CLIENT_IDS: "bot-client,legacy", OPEN_BRAIN_ALLOWED_EMAILS: "fixture@example.test",
    OPEN_BRAIN_BOT_CLIENT_POLICIES: configuration(policy), ...options.env };
  const Deno = { env: { get: key => env[key] }, serve: fn => { handler = fn; } };
  const fetch = async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [] } })); };
  const createClient = () => ({ auth: { getUser: async () => ({ data: { user: { id: "user", email: "fixture@example.test" } }, error: options.authError }) } });
  let source = readFileSync(new URL("../supabase/functions/open-brain-web-gateway/index.ts", import.meta.url), "utf8");
  source = source.replace(/^import[\s\S]*?from "\.\/lib\.mjs";\n/, "");
  const dependencies = { ...lib, ...bot, Deno, createClient, fetch };
  new Function(...Object.keys(dependencies), stripTypeScriptTypes(source))(...Object.values(dependencies));
  const claims = { client_id: "bot-client", sub: "user", iss: endpoint.authIssuer, aud: "authenticated", exp: Math.floor(Date.now()/1000) + 600, ...options.claims };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
  return { calls, request: (body, path = "", headers = {}) => handler(new Request(endpoint.gatewayUrl + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) })) };
}

test("actual handler stamps verified client identity, strips caller identity headers and preserves routing headers", async () => {
  const f = fixture(write);
  const result = await f.request(call("write_work_receipt"), "", { "x-open-brain-client": "lead", "x-bot-actor": "Tony", "mcp-name": "write_work_receipt", "mcp-method": "tools/call", "mcp-protocol-version": "2025-03-26" });
  assert.equal(result.status, 200);
  assert.equal(f.calls[0].body.params.arguments.source_actor, actor);
  const headers = f.calls[0].headers;
  assert.equal(headers["x-open-brain-client"], undefined);
  assert.equal(headers["x-bot-actor"], undefined);
  assert.equal(headers["mcp-name"], "write_work_receipt");
  assert.equal(headers["mcp-protocol-version"], "2025-03-26");
});

test("actual handler never calls upstream on invalid OAuth, policy or scoped operation", async () => {
  for (const claims of [{ client_id: "unknown" }, { iss: "https://foreign.test" }, { sub: "foreign" }, { aud: "wrong" }, { exp: 1 }]) {
    const f = fixture(read, { claims }); assert.equal((await f.request(call("search"))).status, 401); assert.equal(f.calls.length, 0);
  }
  const bad = fixture(read, { env: { OPEN_BRAIN_BOT_CLIENT_POLICIES: '{"bot-client":{"phase":"full"}}' } });
  assert.equal((await bad.request(call("search"))).status, 503); assert.equal(bad.calls.length, 0);
  for (const [p, request, path] of [[read, call("write_work_receipt"), ""], [write, call("write_work_receipt"), "/readonly"], [read, call("check_messages", { recipient: "lead" }), ""]]) {
    const f = fixture(p); assert.equal((await (await f.request(request, path)).json()).error.code, -32601); assert.equal(f.calls.length, 0);
  }
  const legacy = fixture(read, { claims: { client_id: "legacy" } });
  assert.equal((await legacy.request(call("capture_thought"))).status, 200);
  assert.equal(legacy.calls[0].body.params.name, "capture_thought");
});
