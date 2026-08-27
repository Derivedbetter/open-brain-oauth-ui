import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCaptureEvidence,
  audienceAllowed,
  captureMode,
  decodeJwtPayload,
  decorateToolList,
  filterReadOnlyToolList,
  isCaptureCall,
  oauthClientAllowlist,
  parseMcpResponse,
  requestForUpstream,
  readOnlyBlockedResponse,
  readOnlyRequestAllowed,
  resultJson,
  serializeMcpResponse,
  splitAllowlist,
} from "../supabase/functions/open-brain-web-gateway/lib.mjs";

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

test("parses and serializes JSON and SSE MCP messages", () => {
  const json = parseMcpResponse("application/json", '{"id":1}');
  assert.equal(json[0].id, 1);
  const sse = parseMcpResponse("text/event-stream", 'data: {"id":2}\n\ndata: [DONE]\n');
  assert.equal(sse[0].id, 2);
  assert.match(serializeMcpResponse("text/event-stream", sse), /data: \{"id":2\}/);
});

test("round-trips the upstream server time and machine payload without duplication", () => {
  const line = "Server time: 2026-08-27T12:34:56.789Z (8:34 AM EDT, America/New_York)";
  const structuredContent = { id: "thought-1", hash: "sha256:abc123" };
  const jsonPayload = JSON.stringify(structuredContent);
  const body = `data: ${JSON.stringify({ result: {
    content: [
      { type: "text", text: line },
      { type: "text", text: jsonPayload },
    ],
    structuredContent,
  } })}\n\n`;

  const roundTripped = parseMcpResponse(
    "text/event-stream",
    serializeMcpResponse("text/event-stream", parseMcpResponse("text/event-stream", body)),
  )[0];

  assert.equal(roundTripped.result.content[0].text, line);
  assert.equal(roundTripped.result.content[1].text, jsonPayload);
  assert.deepEqual(roundTripped.result.structuredContent, structuredContent);
  assert.equal(
    roundTripped.result.content.flatMap((item) => item.text.match(/^Server time:/gm) ?? []).length,
    1,
  );
});

test("reads verification JSON after a leading server-time block", () => {
  const line = "Server time: 2026-08-27T12:34:56.789Z (8:34 AM EDT, America/New_York)";
  const searchResult = { results: [{ id: "thought-1" }] };
  const messages = [{ result: { content: [
    { type: "text", text: line },
    { type: "text", text: JSON.stringify(searchResult) },
  ] } }];

  assert.deepEqual(resultJson(messages), searchResult);
  assert.equal(resultJson([{ result: { content: [
    { type: "text", text: line },
    { type: "text", text: "human-readable detail" },
  ] } }]), null);
});

test("maps exact and summary aliases to vanilla capture_thought", () => {
  for (const [name, mode] of [["capture_thought_exact", "exact"], ["capture_thought_summary", "summary"]]) {
    const request = { method: "tools/call", params: { name, arguments: { content: "memory" } } };
    assert.equal(isCaptureCall(request), true);
    assert.equal(captureMode(request), mode);
    assert.equal(requestForUpstream(request).params.name, "capture_thought");
  }
});

test("decorates tools with exact payload and failure rules", () => {
  const closedWorldReadTools = [
    "export_memory_changes",
    "fetch",
    "list_thoughts",
    "memory_audit",
    "search",
    "search_thoughts",
    "thought_stats",
  ].map((name) => ({
    name,
    description: `Read with ${name}.`,
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object" },
  }));
  const messages = decorateToolList([{ result: { tools: [
    ...closedWorldReadTools,
    {
      name: "external_lookup",
      description: "Read from an open-world source.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: { type: "object" },
    },
    {
      name: "capture_thought",
      description: "Capture.",
      annotations: { readOnlyHint: false, openWorldHint: false },
      inputSchema: { type: "object" },
    },
  ] } }]);
  const tools = messages[0].result.tools;
  for (const { name } of closedWorldReadTools) {
    assert.deepEqual(tools.find((tool) => tool.name === name).annotations, {
      readOnlyHint: true,
      openWorldHint: false,
    });
  }
  assert.deepEqual(tools.find((tool) => tool.name === "external_lookup").annotations, {
    readOnlyHint: true,
    openWorldHint: true,
  });
  assert.equal(tools.find((tool) => tool.name === "capture_thought").annotations.readOnlyHint, false);
  assert.equal(tools.find((tool) => tool.name === "capture_thought").annotations.openWorldHint, false);
  assert.match(tools.find((tool) => tool.name === "capture_thought_exact").description, /preserve it literally/);
  assert.match(tools.find((tool) => tool.name === "capture_thought_summary").description, /report failure instead of improvising/);
  assert.match(tools.find((tool) => tool.name === "capture_thought").description, /never capture a transcript automatically/);
});

test("read-only route lists only bounded reads and blocks direct writes", () => {
  const messages = filterReadOnlyToolList([{ result: { tools: [
    { name: "list_thoughts" },
    { name: "search" },
    { name: "capture_thought" },
    { name: "write_work_receipt" },
  ] } }]);
  assert.deepEqual(messages[0].result.tools.map((tool) => tool.name), [
    "list_thoughts",
    "search",
  ]);
  assert.equal(readOnlyRequestAllowed({ method: "tools/list" }), true);
  assert.equal(readOnlyRequestAllowed({
    method: "tools/call",
    params: { name: "fetch" },
  }), true);
  const blocked = { id: 42, method: "tools/call", params: { name: "capture_thought" } };
  assert.equal(readOnlyRequestAllowed(blocked), false);
  assert.deepEqual(readOnlyBlockedResponse(blocked), {
    jsonrpc: "2.0",
    id: 42,
    error: {
      code: -32601,
      message: "Tool not available on the read-only Open Brain endpoint",
    },
  });
});

test("returns authoritative evidence or explicit verification failure", () => {
  const success = appendCaptureEvidence([{ result: { content: [] } }], {
    id: "thought-1", text: "memory", url: "https://example/thought-1",
  }, "exact");
  assert.match(success[0].result.content[0].text, /ID: thought-1/);
  const failure = appendCaptureEvidence([{ result: { content: [] } }], null, "summary");
  assert.match(failure[0].result.content[0].text, /could not be authoritatively verified/);
});

test("decodes JWT claims and enforces allowlist helpers", () => {
  const payload = decodeJwtPayload(fakeJwt({ sub: "user-1", aud: ["gateway"] }));
  assert.equal(payload.sub, "user-1");
  assert.equal(audienceAllowed(payload.aud, ["gateway"]), true);
  assert.equal(audienceAllowed("other", ["gateway"]), false);
  assert.deepEqual(splitAllowlist("a, b ,,c"), ["a", "b", "c"]);
  assert.deepEqual(oauthClientAllowlist(false, "full-1,full-2", "read-1"), [
    "full-1",
    "full-2",
  ]);
  assert.deepEqual(oauthClientAllowlist(true, "full-1,full-2", "read-1"), [
    "read-1",
  ]);
});

