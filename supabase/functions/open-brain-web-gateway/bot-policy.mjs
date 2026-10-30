import { isReadOnlyTool } from "./lib.mjs";

const PRINCIPAL = /^grok\/(?:bot\/[a-z0-9][a-z0-9-]{0,62}|advisor\/(?:prime|bee|mac|boompro))$/;
const CAPTURES = new Set(["capture_thought", "capture_thought_exact", "capture_thought_summary", "capture_memory"]);
const SOURCE_ACTORS = new Set([...CAPTURES, "write_work_receipt", "relate_memories"]);
const ACTORS = new Set(["set_board_judgement", "set_lifecycle_status", "clear_derived_action_items", "correct_board_judgement", "correct_legacy_board_tag"]);
const METHODS = new Set(["initialize", "server/discover", "notifications/initialized", "ping", "tools/list", "tools/call"]);
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// This configuration is server-owned, never supplied by a request or header.
// Missing policy preserves existing clients; malformed configuration fails closed.
export function botClientPolicy(serialized, clientId) {
  if (serialized === undefined || serialized === null || serialized === "") return null;
  const policies = JSON.parse(serialized);
  if (!plain(policies)) throw new Error("Invalid Bot client policy");
  for (const [id, p] of Object.entries(policies)) {
    if (!id.trim() || !plain(p) || Object.keys(p).some(k => k !== "actor") ||
        typeof p.actor !== "string" || !PRINCIPAL.test(p.actor)) {
      throw new Error("Invalid Bot client policy");
    }
  }
  return Object.hasOwn(policies, clientId) ? policies[clientId] : null;
}

export function botToolAllowed(name, policy, readOnly) {
  // Full-route parity uses the maintained upstream registry, not a second tool
  // inventory. Coop's owner-event submission is a separate producer identity.
  return typeof name === "string" && name !== "submit_capture_candidate" &&
    (!readOnly || isReadOnlyTool(name));
}

export function bindBotRequest(request, policy, readOnly) {
  if (!policy) return request;
  const refuse = () => { throw new Error("Request outside this OAuth Bot client policy"); };
  if (!plain(request) || !METHODS.has(request.method)) refuse();
  if (request.method !== "tools/call") return request;
  const name = request.params?.name;
  if (!botToolAllowed(name, policy, readOnly)) refuse();
  const args = request.params.arguments ?? {};
  if (!plain(args)) refuse();
  // Reject supplied identity overrides even for tools whose upstream schemas
  // would strip unknown arguments. Never silently endorse a spoofed actor.
  for (const field of ["actor", "source_actor", "sender"]) {
    if (Object.hasOwn(args, field) && args[field] !== policy.actor) refuse();
  }
  const bound = { ...args };
  if (["check_messages", "consume_message"].includes(name)) {
    if (args.recipient !== undefined && args.recipient !== policy.actor) refuse();
    bound.recipient = policy.actor;
  }
  if (name === "pending_messages") {
    if (args.recipients !== undefined && (!Array.isArray(args.recipients) ||
        args.recipients.length !== 1 || args.recipients[0] !== policy.actor)) refuse();
    bound.recipients = [policy.actor];
  }
  if (name === "send_message") bound.sender = policy.actor;
  if (SOURCE_ACTORS.has(name)) bound.source_actor = policy.actor;
  if (ACTORS.has(name)) bound.actor = policy.actor;
  if (CAPTURES.has(name)) {
    if (args.statement_origin !== undefined && args.statement_origin !== "agent_generated") refuse();
    bound.statement_origin = "agent_generated";
  }
  // Evidence is still checked by the existing core validators. A Bot cannot
  // claim to be Tony or an independent seated reviewer in those fields.
  for (const evidence of [bound, bound.corrects]) {
    if (!plain(evidence)) continue;
    if (evidence.verification_basis === "owner_direct" ||
        (evidence.verification_actor !== undefined && evidence.verification_actor !== policy.actor)) refuse();
  }
  return { ...request, params: { ...request.params, arguments: bound } };
}

export function filterBotToolList(messages, policy, readOnly) {
  if (!policy) return messages;
  for (const message of messages) {
    if (!Array.isArray(message?.result?.tools)) continue;
    message.result.tools = message.result.tools.filter(t => botToolAllowed(t?.name, policy, readOnly));
    for (const tool of message.result.tools) {
      const own = ["check_messages", "consume_message"].includes(tool.name) ? "recipient"
        : tool.name === "send_message" ? "sender" : SOURCE_ACTORS.has(tool.name) ? "source_actor"
        : ACTORS.has(tool.name) ? "actor" : null;
      if (own && tool.inputSchema?.properties?.[own]) {
        tool.inputSchema.properties[own] = { ...tool.inputSchema.properties[own], const: policy.actor };
      }
      if (tool.name === "pending_messages" && tool.inputSchema?.properties?.recipients) {
        tool.inputSchema.properties.recipients = { ...tool.inputSchema.properties.recipients, const: [policy.actor] };
      }
      if (CAPTURES.has(tool.name) && tool.inputSchema?.properties?.statement_origin) {
        tool.inputSchema.properties.statement_origin = { ...tool.inputSchema.properties.statement_origin, const: "agent_generated" };
      }
    }
  }
  return messages;
}

// The current core fetchMessagingRecord formatter always emits storage=messaging,
// record_kind=message|receipt, type=internal_message|internal_message_receipt and
// recipient (plus sender for a message). Anything claiming protected storage but
// missing this contract is refused, not reclassified as an ordinary thought.
export function filterBotFetch(messages, request, policy) {
  if (!policy || request?.method !== "tools/call" || request.params?.name !== "fetch") return messages;
  for (const message of messages) {
    const result = message?.result;
    if (!result || message.error) continue;
    let refuse = !Array.isArray(result.content);
    for (const item of result.content ?? []) {
      if (item.type !== "text" || typeof item.text !== "string") { refuse = true; break; }
      if (/^(Server time:|Fetch error:|Error:)/.test(item.text)) continue;
      let document;
      try { document = JSON.parse(item.text); } catch { refuse = true; break; }
      const m = document?.metadata;
      if (!plain(document) || typeof document.id !== "string" || typeof document.text !== "string" || !plain(m)) {
        refuse = true; break;
      }
      const protectedRecord = m.storage !== undefined || m.record_kind !== undefined ||
        ["internal_message", "internal_message_receipt"].includes(m.type);
      if (!protectedRecord) continue;
      const expectedType = m.record_kind === "message" ? "internal_message"
        : m.record_kind === "receipt" ? "internal_message_receipt" : null;
      if (m.storage !== "messaging" || !expectedType || m.type !== expectedType ||
          typeof m.recipient !== "string" ||
          (m.recipient !== policy.actor && !(m.record_kind === "message" && m.sender === policy.actor))) {
        refuse = true; break;
      }
    }
    // A modern SDK may include a structured duplicate. The core formatter only
    // returns text; refuse unfamiliar duplicates rather than leaking a second copy.
    if (result.structuredContent !== undefined) refuse = true;
    if (refuse) message.result = {
      ...(result.resultType !== undefined ? { resultType: result.resultType } : {}),
      ...(result._meta !== undefined ? { _meta: result._meta } : {}),
      isError: true, content: [{ type: "text", text: "Message outside this OAuth Bot mailbox or unrecognized fetch record" }],
    };
  }
  return messages;
}
