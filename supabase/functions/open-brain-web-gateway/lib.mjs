const CAPTURE_TOOLS = new Set([
  "capture_thought",
  "capture_thought_exact",
  "capture_thought_summary",
]);

const CLOSED_WORLD_READ_TOOLS = new Set([
  "export_memory_changes",
  "fetch",
  "list_thoughts",
  "memory_audit",
  "search",
  "search_thoughts",
  "thought_stats",
]);

export function isReadOnlyTool(name) {
  return CLOSED_WORLD_READ_TOOLS.has(name);
}

export function filterReadOnlyToolList(messages) {
  for (const message of messages) {
    const tools = message?.result?.tools;
    if (!Array.isArray(tools)) continue;
    message.result.tools = tools.filter((tool) => isReadOnlyTool(tool?.name));
  }
  return messages;
}

export function readOnlyRequestAllowed(request) {
  if (request?.method !== "tools/call") return true;
  return isReadOnlyTool(request?.params?.name);
}

export function readOnlyBlockedResponse(request) {
  return {
    jsonrpc: "2.0",
    id: request?.id ?? null,
    error: {
      code: -32601,
      message: "Tool not available on the read-only Open Brain endpoint",
    },
  };
}

export function parseMcpResponse(contentType, body) {
  if (!body.trim()) return [];
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return [JSON.parse(body)];
  }
  const messages = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    messages.push(JSON.parse(data));
  }
  return messages;
}

export function serializeMcpResponse(contentType, messages) {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return `${messages.map((message) => `data: ${JSON.stringify(message)}`).join("\n\n")}\n\n`;
  }
  return messages.length === 1
    ? JSON.stringify(messages[0])
    : messages.map((message) => JSON.stringify(message)).join("\n");
}

export function resultJson(messages) {
  for (const message of messages) {
    const content = message?.result?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      try {
        return JSON.parse(item.text);
      } catch {
        // Visible prose, including the leading server-time block, is not JSON.
      }
    }
  }
  return null;
}

export function captureMode(request) {
  const name = request?.params?.name;
  if (name === "capture_thought_exact") return "exact";
  if (name === "capture_thought_summary") return "summary";
  return name === "capture_thought" ? "general" : null;
}

export function isCaptureCall(request) {
  return request?.method === "tools/call" &&
    CAPTURE_TOOLS.has(request?.params?.name) &&
    typeof request?.params?.arguments?.content === "string";
}

export function requestForUpstream(request) {
  if (!isCaptureCall(request) || request.params.name === "capture_thought") return request;
  return { ...request, params: { ...request.params, name: "capture_thought" } };
}

function commonCaptureDescription() {
  return [
    "Invoke this MCP tool directly; never use a shell or HTTP command to write to Open Brain.",
    "The content argument must contain only the memory to store, never the user's surrounding save instruction.",
    "Use the gateway's verified storage evidence and authoritative ID in the reply.",
    "If verification is unavailable, report failure instead of improvising.",
    "Capture only when the user explicitly asks; never capture a transcript automatically.",
  ].join(" ");
}

export function decorateToolList(messages) {
  for (const message of messages) {
    const tools = message?.result?.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (!CLOSED_WORLD_READ_TOOLS.has(tool?.name)) continue;
      tool.annotations = {
        ...(tool.annotations ?? {}),
        readOnlyHint: true,
        openWorldHint: false,
      };
    }
    const capture = tools.find((tool) => tool?.name === "capture_thought");
    if (!capture) continue;
    capture.description = `${capture.description} ${commonCaptureDescription()}`;
    capture.annotations = { ...(capture.annotations ?? {}), idempotentHint: true };

    const aliases = [
      {
        name: "capture_thought_exact",
        title: "Capture exact Open Brain memory",
        description: [
          "Capture an exact Open Brain memory.",
          "Copy only the text inside the user's explicit delimiters into content, excluding the delimiters, and preserve it literally without additions, deletions, summarization, or reformatting.",
          commonCaptureDescription(),
        ].join(" "),
      },
      {
        name: "capture_thought_summary",
        title: "Capture Open Brain summary",
        description: [
          "Capture a concise standalone Open Brain summary.",
          "Summarize only the material the user selected; omit capture commands, conversational filler, and unverified claims.",
          commonCaptureDescription(),
        ].join(" "),
      },
    ];
    for (const alias of aliases) {
      if (tools.some((tool) => tool?.name === alias.name)) continue;
      tools.push({
        ...capture,
        ...alias,
        inputSchema: structuredClone(capture.inputSchema),
        annotations: { ...(capture.annotations ?? {}), idempotentHint: true },
      });
    }
  }
  return messages;
}

export function appendCaptureEvidence(messages, evidence, mode) {
  for (const message of messages) {
    if (!Array.isArray(message?.result?.content)) continue;
    const text = evidence
      ? [
          "Verified Open Brain storage evidence:",
          `Mode: ${mode}`,
          `ID: ${evidence.id}`,
          `Content: ${evidence.text}`,
          `URL: ${evidence.url}`,
          "Return this verified ID and content in the user-facing receipt.",
        ].join("\n")
      : "Open Brain storage evidence could not be verified after capture. Do not invent or infer a thought ID; report that the write could not be authoritatively verified.";
    message.result.content.push({ type: "text", text });
  }
  return messages;
}

export function normalizeContent(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function decodeJwtPayload(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function audienceAllowed(audience, allowed) {
  const actual = Array.isArray(audience) ? audience : [audience];
  return actual.some((value) => typeof value === "string" && allowed.includes(value));
}

export function splitAllowlist(value) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function oauthClientAllowlist(readOnly, fullClientIds, readOnlyClientIds) {
  return splitAllowlist(readOnly ? readOnlyClientIds : fullClientIds);
}

