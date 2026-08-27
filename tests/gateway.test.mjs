import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCaptureEvidence,
  audienceAllowed,
  captureMode,
  decodeJwtPayload,
  decorateToolList,
  filterReadOnlyToolList,
  formatToolResponse,
  isCaptureCall,
  oauthClientAllowlist,
  parseMcpResponse,
  requestForUpstream,
  readOnlyBlockedResponse,
  readOnlyRequestAllowed,
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

test("formats tool responses from one injected server-clock sample", () => {
  let clockSamples = 0;
  const messages = [{ result: { content: [{ type: "text", text: "Captured thought-1." }] } }];

  formatToolResponse(messages, () => {
    clockSamples += 1;
    return new Date("2026-08-27T12:34:56.789Z");
  });

  assert.equal(clockSamples, 1);
  assert.equal(
    messages[0].result.content[0].text,
    "Server time: 2026-08-27T12:34:56.789Z (8:34 AM EDT, America/New_York)\n\nCaptured thought-1.",
  );
  assert.equal(messages[0].result.content[0].text.match(/^Server time:/gm).length, 1);
});

test("preserves an upstream server-time line without sampling or duplicating it", () => {
  let clockSamples = 0;
  const upstream = "Server time: 2026-08-27T12:34:56.789Z (8:34 AM EDT, America/New_York)";
  const messages = [{ result: { content: [
    { type: "text", text: upstream },
    { type: "text", text: JSON.stringify({ id: "thought-1" }) },
  ] } }];

  formatToolResponse(messages, () => {
    clockSamples += 1;
    return new Date("2026-08-27T12:35:00.000Z");
  });

  assert.equal(clockSamples, 0);
  assert.equal(messages[0].result.content[0].text, upstream);
  assert.equal(
    messages[0].result.content.flatMap((item) => item.text.match(/^Server time:/gm) ?? []).length,
    1,
  );
});

test("formats Eastern time correctly on both sides of the DST transition", () => {
  for (const [utc, eastern] of [
    ["2026-03-08T06:59:00Z", "1:59 AM EST"],
    ["2026-03-08T07:01:00Z", "3:01 AM EDT"],
  ]) {
    const messages = [{ result: { content: [] } }];
    formatToolResponse(messages, () => new Date(utc));
    assert.equal(
      messages[0].result.content[0].text,
      `Server time: ${new Date(utc).toISOString()} (${eastern}, America/New_York)`,
    );
  }
});

test("preserves structured and JSON payloads while adding a separate visible time block", () => {
  const structuredContent = {
    id: "thought-1",
    hash: "sha256:abc123",
    pagination: { cursor: "next-1", has_more: true },
    error_details: { code: "handled", retryable: false },
  };
  const structuredBytes = JSON.stringify(structuredContent);
  const jsonPayload = JSON.stringify(structuredContent);
  const messages = [{ result: {
    content: [{ type: "text", text: jsonPayload }],
    structuredContent,
  } }];

  formatToolResponse(messages, () => new Date("2026-11-01T06:01:00Z"));

  assert.strictEqual(messages[0].result.structuredContent, structuredContent);
  assert.equal(JSON.stringify(messages[0].result.structuredContent), structuredBytes);
  assert.equal(messages[0].result.content[0].text,
    "Server time: 2026-11-01T06:01:00.000Z (1:01 AM EST, America/New_York)");
  assert.equal(messages[0].result.content[1].text, jsonPayload);
});

test("formats handled tool errors without changing their details", () => {
  const errorDetails = { reason: "not_found", id: "missing-thought" };
  const messages = [{ result: {
    isError: true,
    content: [{ type: "text", text: "Thought not found." }],
    structuredContent: errorDetails,
  } }];

  formatToolResponse(messages, () => new Date("2026-01-15T17:00:00Z"));

  assert.equal(messages[0].result.isError, true);
  assert.strictEqual(messages[0].result.structuredContent, errorDetails);
  assert.match(messages[0].result.content[0].text,
    /^Server time: 2026-01-15T17:00:00\.000Z \(12:00 PM EST, America\/New_York\)\n\nThought not found\.$/);
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

