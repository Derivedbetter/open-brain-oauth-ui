import { createClient } from "npm:@supabase/supabase-js@2";
import {
  appendCaptureEvidence,
  audienceAllowed,
  captureMode,
  decodeJwtPayload,
  decorateToolList,
  isCaptureCall,
  normalizeContent,
  parseMcpResponse,
  requestForUpstream,
  serializeMcpResponse,
  splitAllowlist,
} from "./lib.mjs";

const PROJECT_REF = "zoptbgumxukgpkgbtnpz";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const AUTH_ISSUER = `${PROJECT_URL}/auth/v1`;
const GATEWAY_URL = `${PROJECT_URL}/functions/v1/open-brain-web-gateway`;
const RESOURCE_METADATA_URL = `${GATEWAY_URL}/.well-known/oauth-protected-resource`;
const UPSTREAM_URL = `${PROJECT_URL}/functions/v1/open-brain-mcp`;
const MAX_MESSAGE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 120_000;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": [
    "authorization",
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
  ].join(", "),
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
};

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json", ...headers },
  });
}

function unauthorized(message = "OAuth authorization is required") {
  return json({ error: "unauthorized", error_description: message }, 401, {
    "www-authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="email"`,
  });
}

function protectedResourceMetadata() {
  return {
    resource: GATEWAY_URL,
    authorization_servers: [AUTH_ISSUER],
    scopes_supported: ["email"],
    bearer_methods_supported: ["header"],
    resource_name: "Tony Open Brain",
  };
}

async function authorize(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { error: unauthorized() };

  const token = match[1].trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? PROJECT_URL;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!anonKey) return { error: unauthorized("Gateway authentication is not configured") };

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { error: unauthorized("The access token is invalid or expired") };

  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(token);
  } catch {
    return { error: unauthorized("The access token is malformed") };
  }

  const allowedClientIds = splitAllowlist(Deno.env.get("OPEN_BRAIN_OAUTH_CLIENT_IDS"));
  const allowedEmails = splitAllowlist(Deno.env.get("OPEN_BRAIN_ALLOWED_EMAILS"))
    .map((email) => email.toLowerCase());
  const allowedAudiences = splitAllowlist(
    Deno.env.get("OPEN_BRAIN_OAUTH_AUDIENCES") ?? `authenticated,${GATEWAY_URL}`,
  );

  const clientId = typeof claims.client_id === "string" ? claims.client_id : "";
  const email = String(data.user.email ?? claims.email ?? "").toLowerCase();
  const issuer = claims.iss;
  const subject = claims.sub;
  const expiresAt = Number(claims.exp ?? 0);

  if (!allowedClientIds.length || !allowedClientIds.includes(clientId)) {
    return { error: unauthorized("This OAuth client is not approved") };
  }
  if (!allowedEmails.length || !allowedEmails.includes(email)) {
    return { error: unauthorized("This Open Brain user is not approved") };
  }
  if (issuer !== AUTH_ISSUER || subject !== data.user.id) {
    return { error: unauthorized("The token issuer or subject is invalid") };
  }
  if (!audienceAllowed(claims.aud, allowedAudiences)) {
    return { error: unauthorized("The token audience is invalid") };
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return { error: unauthorized("The access token is expired") };
  }
  return { user: data.user, clientId };
}

async function upstreamRequest(
  requestBody: unknown,
  brainKey: string,
  sessionId?: string | null,
) {
  const body = JSON.stringify(requestBody);
  if (new TextEncoder().encode(body).byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("MCP request exceeded the size limit");
  }
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-brain-key": brainKey,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const responseBody = await response.text();
  if (new TextEncoder().encode(responseBody).byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("MCP response exceeded the size limit");
  }
  return {
    response,
    body: responseBody,
    contentType: response.headers.get("content-type") ?? "application/json",
    sessionId: response.headers.get("mcp-session-id") ?? sessionId ?? null,
  };
}

function resultText(messages: Array<Record<string, unknown>>) {
  for (const message of messages) {
    const result = message?.result as Record<string, unknown> | undefined;
    const content = result?.content as Array<Record<string, unknown>> | undefined;
    for (const item of content ?? []) {
      if (item?.type === "text" && typeof item.text === "string") return item.text;
    }
  }
  return null;
}

async function verifyCapture(
  content: string,
  mode: string,
  brainKey: string,
  sessionId?: string | null,
) {
  const search = await upstreamRequest({
    jsonrpc: "2.0",
    id: `web-gateway-search-${crypto.randomUUID()}`,
    method: "tools/call",
    params: { name: "search", arguments: { query: content } },
  }, brainKey, sessionId);
  let candidates: Array<Record<string, unknown>> = [];
  try {
    const messages = parseMcpResponse(search.contentType, search.body);
    candidates = JSON.parse(resultText(messages) ?? "{}").results ?? [];
  } catch {
    return null;
  }
  for (const candidate of candidates.slice(0, 10)) {
    if (typeof candidate.id !== "string") continue;
    const fetched = await upstreamRequest({
      jsonrpc: "2.0",
      id: `web-gateway-fetch-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name: "fetch", arguments: { id: candidate.id } },
    }, brainKey, search.sessionId);
    try {
      const messages = parseMcpResponse(fetched.contentType, fetched.body);
      const thought = JSON.parse(resultText(messages) ?? "{}");
      const matches = mode === "exact"
        ? thought.text === content
        : normalizeContent(thought.text) === normalizeContent(content);
      if (matches) return { id: thought.id, text: thought.text, url: thought.url };
    } catch {
      // Try the next candidate without exposing captured content or secrets.
    }
  }
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const url = new URL(request.url);
  if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
    return json(protectedResourceMetadata());
  }

  const authorization = await authorize(request);
  if (authorization.error) return authorization.error;
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  }

  const brainKey = Deno.env.get("MCP_ACCESS_KEY");
  if (!brainKey) return json({ error: "gateway_not_configured" }, 503);

  let rawBody: string;
  let mcpRequest: Record<string, unknown>;
  try {
    rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_MESSAGE_BYTES) {
      return json({ error: "request_too_large" }, 413);
    }
    mcpRequest = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  try {
    const mode = captureMode(mcpRequest);
    const upstream = await upstreamRequest(
      requestForUpstream(mcpRequest),
      brainKey,
      request.headers.get("mcp-session-id"),
    );
    let messages = parseMcpResponse(upstream.contentType, upstream.body);
    if (mcpRequest.method === "tools/list") messages = decorateToolList(messages);
    const captureContent = (mcpRequest.params as {
      arguments?: { content?: unknown };
    } | undefined)?.arguments?.content;
    if (mode !== null && isCaptureCall(mcpRequest) && typeof captureContent === "string" &&
      upstream.response.ok &&
      !messages.some((message) => {
        const result = message?.result as Record<string, unknown> | undefined;
        return Boolean(message?.error || result?.isError);
      })) {
      let evidence = null;
      try {
        evidence = await verifyCapture(
          captureContent,
          mode,
          brainKey,
          upstream.sessionId,
        );
      } catch {
        evidence = null;
      }
      messages = appendCaptureEvidence(messages, evidence, mode);
    }

    const headers = new Headers(corsHeaders);
    headers.set("content-type", upstream.contentType);
    if (upstream.sessionId) headers.set("mcp-session-id", upstream.sessionId);
    headers.set("cache-control", "no-store");
    return new Response(serializeMcpResponse(upstream.contentType, messages), {
      status: upstream.response.status,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Upstream Open Brain timed out"
      : error instanceof Error ? error.message : "Upstream Open Brain failed";
    return json({ error: "upstream_failure", error_description: message }, 502);
  }
});
