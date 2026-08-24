import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCaptureEvidence,
  audienceAllowed,
  captureMode,
  decodeJwtPayload,
  decorateToolList,
  isCaptureCall,
  parseMcpResponse,
  requestForUpstream,
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
});

