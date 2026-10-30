import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as lib from "../supabase/functions/open-brain-web-gateway/lib.mjs";
import * as bot from "../supabase/functions/open-brain-web-gateway/bot-policy.mjs";

const actor = "grok/bot/corty";
const read = { actor };
const write = read;
const call = (name, args = {}) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
const configuration = (p) => JSON.stringify({ "bot-client": p });

test("strict server policy refuses malformed phases/identities and retains legacy client behavior", () => {
  for (const bad of ["[]", "null", "not-json", configuration({ ...read, phase: "full" }),
    configuration({ ...read, actor: "Tony" }), configuration({ ...read, actor: [actor] }),
    configuration({ ...read, actor: null }), configuration({ ...read, actor: {} }),
    configuration({ ...read, extra: true }),
    configuration({ ...read, recipients: ["lead"] })]) assert.throws(() => bot.botClientPolicy(bad, "bot-client"));
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
    assert.throws(() => bot.bindBotRequest(call(name), read, true));
  assert.throws(() => bot.bindBotRequest(call("write_work_receipt"), write, true));
  for (const request of [[], null, { method: "resources/read" }, { method: "notifications/cancelled" }])
    assert.throws(() => bot.bindBotRequest(request, read, false));
});

test("full-route Advisor read/write parity binds real writes without phase promotion", () => {
  for (const name of ["capture_thought", "capture_thought_exact", "capture_thought_summary", "capture_memory", "write_work_receipt", "relate_memories"]) {
    const args = bot.bindBotRequest(call(name, { content: "Synthetic fixture" }), write, false).params.arguments;
    assert.equal(args.source_actor, actor);
  }
  for (const name of ["set_board_judgement", "set_lifecycle_status", "clear_derived_action_items", "correct_board_judgement", "correct_legacy_board_tag"])
    assert.equal(bot.bindBotRequest(call(name), write, false).params.arguments.actor, actor);
  for (const name of ["edit_thought", "record_recall_usage", "record_machine_alive", "record_quota_usage"])
    assert.equal(bot.bindBotRequest(call(name), write, false).params.name, name);
  const send = bot.bindBotRequest(call("send_message", { recipient: "lead", intent: "request", review: { owner_record: "synthetic" } }), write, false);
  assert.equal(send.params.arguments.sender, actor);
  assert.equal(send.params.arguments.intent, "request");
  assert.deepEqual(send.params.arguments.review, { owner_record: "synthetic" }); // existing core review gate still validates it
  assert.equal(bot.bindBotRequest(call("capture_memory"), write, false).params.arguments.statement_origin, "agent_generated");
  for (const args of [{ source_actor: "Tony" }, { statement_origin: "owner_direct" }, { statement_origin: "mixed" },
    { corrects: { verification_basis: "owner_direct" } }, { corrects: { verification_actor: "claude/advisor/prime" } }])
    assert.throws(() => bot.bindBotRequest(call("capture_memory", args), write, false));
  assert.throws(() => bot.bindBotRequest(call("relate_memories", { verification_actor: "Tony" }), write, false));
  assert.throws(() => bot.bindBotRequest(call("submit_capture_candidate"), write, false));
  assert.equal(bot.bindBotRequest(call("pending_messages"), write, false).params.arguments.recipients[0], actor);
  assert.throws(() => bot.bindBotRequest(call("pending_messages", { recipients: ["lead"] }), write, false));
});

test("actual maintained tool registrations receive full route parity and eight-route readonly protection", () => {
  // Pinned public source fixture keeps this repository's tests standalone.
  // The private cross-repo integration check verifies it against exact core bytes.
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/core-tool-registrations.json", import.meta.url), "utf8"));
  const names = fixture.files.flatMap(file => file.tools);
  assert.equal(names.length, 29);
  names.push("capture_thought_exact", "capture_thought_summary");
  const messages = () => [{ result: { tools: names.map(name => ({ name, inputSchema: { properties: { recipient: {}, recipients: {}, sender: {}, source_actor: {}, actor: {}, statement_origin: {}, review: {} } } })) } }];
  const scoped = bot.filterBotToolList(messages(), write, false);
  assert.deepEqual(scoped[0].result.tools.map(t => t.name), names.filter(n => n !== "submit_capture_candidate"));
  for (const name of names.filter(n => n !== "submit_capture_candidate")) assert.equal(bot.bindBotRequest(call(name), write, false).params.name, name);
  assert.equal(bot.filterBotToolList(messages(), read, true)[0].result.tools.length, 8);
  assert.equal(scoped[0].result.tools.find(t => t.name === "capture_memory").inputSchema.properties.source_actor.const, actor);
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
  assert.equal(headers["x-open-brain-client"], actor);
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
  for (const [p, request, path] of [[read, call("capture_memory", { source_actor: "Tony" }), ""], [write, call("write_work_receipt"), "/readonly"], [read, call("check_messages", { recipient: "lead" }), ""]]) {
    const f = fixture(p); assert.equal((await (await f.request(request, path)).json()).error.code, -32601); assert.equal(f.calls.length, 0);
  }
  const legacy = fixture(read, { claims: { client_id: "legacy" } });
  assert.equal((await legacy.request(call("capture_thought"))).status, 200);
  assert.equal(legacy.calls[0].body.params.name, "capture_thought");
});


test("actual full handler supports capture aliases and edits with trusted Bot provenance", async () => {
  for (const name of ["capture_thought", "capture_thought_exact", "capture_thought_summary", "capture_memory", "edit_thought", "set_lifecycle_status", "send_message"]) {
    const f = fixture();
    const input = { content: "Synthetic parity fixture", expected_content: "Synthetic old text", recipient: "lead" };
    assert.equal((await f.request(call(name, input), "", { "x-open-brain-client": "Tony", "x-bot-actor": "lead", "mcp-name": name })).status, 200);
    const forwarded = f.calls[0];
    assert.equal(forwarded.headers["x-open-brain-client"], actor);
    assert.equal(forwarded.headers["x-bot-actor"], undefined);
    if (name.startsWith("capture_")) {
      assert.equal(forwarded.body.params.arguments.source_actor, actor);
      assert.equal(forwarded.body.params.arguments.statement_origin, "agent_generated");
      if (name === "capture_thought_exact" || name === "capture_thought_summary") {
        assert.equal(forwarded.body.params.name, "capture_thought");
        assert.equal(forwarded.headers["mcp-name"], "capture_thought");
      }
    }
    if (name === "edit_thought") assert.equal(forwarded.body.params.arguments.expected_content, input.expected_content);
    if (name === "set_lifecycle_status") assert.equal(forwarded.body.params.arguments.actor, actor);
    if (name === "send_message") assert.equal(forwarded.body.params.arguments.sender, actor);
    const r = fixture();
    assert.equal((await (await r.request(call(name, input), "/readonly")).json()).error.code, -32601);
    assert.equal(r.calls.length, 0);
  }
});


test("four authorized Advisor principals retain full parity with exact own-mail and actor binding", async () => {
  for (const host of ["prime", "bee", "mac", "boompro"]) {
    const seat = `grok/advisor/${host}`;
    const policy = { actor: seat };
    assert.deepEqual(bot.botClientPolicy(configuration(policy), "bot-client"), policy);
    assert.equal(bot.bindBotRequest(call("check_messages"), policy, false).params.arguments.recipient, seat);
    assert.deepEqual(bot.bindBotRequest(call("pending_messages"), policy, false).params.arguments.recipients, [seat]);
    assert.equal(bot.bindBotRequest(call("consume_message"), policy, false).params.arguments.recipient, seat);
    assert.equal(bot.bindBotRequest(call("capture_memory"), policy, false).params.arguments.source_actor, seat);
    assert.equal(bot.bindBotRequest(call("send_message", { recipient: "lead" }), policy, false).params.arguments.sender, seat);
    for (const args of [{ recipient: "grok/bot/corty" }, { recipient: "codex/advisor/prime" }, { recipient: `grok/advisor/${host === "prime" ? "bee" : "prime"}` }])
      assert.throws(() => bot.bindBotRequest(call("check_messages", args), policy, false));
    for (const source_actor of ["Tony", "grok/bot/corty", "codex/advisor/prime"])
      assert.throws(() => bot.bindBotRequest(call("capture_memory", { source_actor }), policy, false));
    assert.throws(() => bot.bindBotRequest(call("send_message", { sender: "lead" }), policy, false));
    assert.throws(() => bot.bindBotRequest(call("write_work_receipt"), policy, true));
    const f = fixture(policy);
    assert.equal((await f.request(call("write_work_receipt"), "", { "x-open-brain-client": "lead" })).status, 200);
    assert.equal(f.calls[0].headers["x-open-brain-client"], seat);
    assert.equal(f.calls[0].body.params.arguments.source_actor, seat);
    const own = [{ result: { content: [{ type: "text", text: JSON.stringify({ id: "fixture", text: "Synthetic mail", metadata: { storage: "messaging", record_kind: "message", type: "internal_message", recipient: seat } }) }] } }];
    assert.equal(bot.filterBotFetch(own, call("fetch"), policy)[0].result.isError, undefined);
    const foreign = structuredClone(own);
    foreign[0].result.content[0].text = foreign[0].result.content[0].text.replace(seat, "grok/bot/corty");
    assert.equal(bot.filterBotFetch(foreign, call("fetch"), policy)[0].result.isError, true);
  }
});

test("Advisor role and host admission rejects unapproved or malformed principals", () => {
  for (const seat of ["grok/advisor/wsl", "grok/advisor/linux", "grok/advisor/", "grok/worker/prime", "grok/advisor/prime/task", "grok/advisor/../lead", "grok/advisor/prime-other", "GROK/advisor/prime"])
    assert.throws(() => bot.botClientPolicy(configuration({ actor: seat }), "bot-client"), seat);
  assert.deepEqual(bot.botClientPolicy(configuration({ actor }), "bot-client"), { actor }); // existing Corty unchanged
});
