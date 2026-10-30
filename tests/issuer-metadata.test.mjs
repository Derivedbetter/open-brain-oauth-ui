import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as lib from "../supabase/functions/open-brain-web-gateway/lib.mjs";
import * as bot from "../supabase/functions/open-brain-web-gateway/bot-policy.mjs";

const endpoints = lib.projectEndpoints();
const metadata = {
  issuer: endpoints.authIssuer,
  authorization_endpoint: `${endpoints.authIssuer}/oauth/authorize`,
  token_endpoint: `${endpoints.authIssuer}/oauth/token`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["client_secret_basic"],
};

function fixture(reply = () => Response.json(metadata)) {
  let handler; const requests = [];
  const Deno = { env: { get: () => undefined }, serve: fn => { handler = fn; } };
  const createClient = () => { throw Error("Metadata must not authenticate a user"); };
  const fetch = async (url, init) => { requests.push({ url, init }); return reply(); };
  let source = readFileSync(new URL("../supabase/functions/open-brain-web-gateway/index.ts", import.meta.url), "utf8");
  source = source.replace(/^import[\s\S]*?from "\.\/lib\.mjs";\n/, "");
  const dependencies = { ...lib, ...bot, Deno, createClient, fetch };
  new Function(...Object.keys(dependencies), stripTypeScriptTypes(source))(...Object.values(dependencies));
  return { requests, request: (path, method = "GET") => handler(new Request(endpoints.gatewayUrl + path, { method, headers: { authorization: "Bearer synthetic-must-not-forward" } })) };
}

for (const path of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
  test(`${path} mirrors real issuer metadata without forwarding credentials`, async () => {
    const f = fixture(); const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), metadata);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, `${endpoints.authIssuer}/.well-known/openid-configuration`);
    assert.deepEqual(f.requests[0].init.headers, { accept: "application/json" });
    assert.equal(f.requests[0].init.redirect, "error");
    assert(f.requests[0].init.signal instanceof AbortSignal);
  });
}

test("unavailable or mismatched issuer metadata fails closed without leaking errors", async () => {
  for (const reply of [
    () => new Response("upstream detail", { status: 500 }),
    () => { throw Error("private upstream error"); },
    () => Response.json({ ...metadata, issuer: "https://other.invalid" }),
    () => Response.json({ ...metadata, token_endpoint: "https://other.invalid/token" }),
    () => new Response("invalid JSON"),
  ]) {
    const f = fixture(reply); const response = await f.request("/.well-known/openid-configuration");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "issuer_metadata_unavailable" });
  }
});

test("aliases do not bypass auth for other paths or methods; resource metadata stays distinct", async () => {
  const f = fixture();
  for (const [path, method] of [["/.well-known/openid-configuration", "POST"], ["/readonly/.well-known/openid-configuration", "GET"], ["/oauth/token", "GET"], ["", "GET"]]) {
    // No configured anonymous key: all non-metadata routes stay unauthorized.
    assert.equal((await f.request(path, method)).status, 401);
  }
  const resource = await f.request("/.well-known/oauth-protected-resource");
  assert.equal(resource.status, 200);
  assert.deepEqual((await resource.json()).authorization_servers, [endpoints.authIssuer]);
  assert.equal(f.requests.length, 0);
});
