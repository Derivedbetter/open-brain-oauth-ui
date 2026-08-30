import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const staticConsentPath = new URL("../docs/oauth/consent/index.html", import.meta.url);
const edgeConsentPath = new URL("../supabase/functions/open-brain-oauth-ui/index.ts", import.meta.url);

function element(overrides = {}) {
  return {
    hidden: false,
    textContent: "",
    value: "",
    addEventListener() {},
    ...overrides,
  };
}

async function consentHarness({ hash = "", initialSession = null } = {}) {
  const html = await readFile(staticConsentPath, "utf8");
  const moduleScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(moduleScript, "consent module script is present");
  const executableScript = moduleScript.replace(/^import .*?;\s*/m, "");

  const elements = new Map([
    ["#login", element()],
    ["#consent", element({ hidden: true })],
    ["#status", element()],
    ["#email", element()],
    ["#send-link", element()],
    ["#approve", element()],
    ["#deny", element()],
    ["#sign-out", element()],
    ["#client-name", element()],
    ["#redirect-uri", element()],
    ["#scope", element()],
  ]);
  const document = {
    querySelector(selector) {
      const result = elements.get(selector);
      assert.ok(result, `unexpected selector: ${selector}`);
      return result;
    },
  };
  const location = {
    origin: "https://derivedbetter.github.io",
    pathname: "/open-brain-oauth-ui/oauth/consent/",
    search: "?authorization_id=request-1",
    hash,
    assigned: null,
    assign(url) { this.assigned = url; },
    reload() {},
  };
  const timers = [];
  const setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  let authStateHandler;
  let authorizationDetailCalls = 0;
  const auth = {
    async getSession() { return { data: { session: initialSession }, error: null }; },
    onAuthStateChange(handler) {
      authStateHandler = handler;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signInWithOtp() { return { error: null }; },
    async signOut() {},
    oauth: {
      async getAuthorizationDetails() {
        authorizationDetailCalls += 1;
        return {
          data: {
            authorization_id: "request-1",
            client: { name: "Gemini" },
            redirect_uri: "https://example.test/callback",
            scopes: ["openid", "email"],
          },
          error: null,
        };
      },
      async approveAuthorization() { return { data: { redirect_url: "https://example.test/approved" }, error: null }; },
      async denyAuthorization() { return { data: { redirect_url: "https://example.test/denied" }, error: null }; },
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction(
    "createClient",
    "location",
    "document",
    "setTimeout",
    "URLSearchParams",
    executableScript,
  );
  await run(() => ({ auth }), location, document, setTimeout, URLSearchParams);

  return {
    authStateHandler,
    elements,
    location,
    timers,
    authorizationDetailCalls: () => authorizationDetailCalls,
  };
}

test("uses the callback auth event session instead of falling back to an empty store", async () => {
  const harness = await consentHarness();
  assert.equal(harness.authorizationDetailCalls(), 0);
  assert.equal(harness.elements.get("#login").hidden, false);

  harness.authStateHandler("SIGNED_IN", { access_token: "verified-session" });
  assert.equal(harness.elements.get("#status").textContent, "Finishing sign-in...");
  assert.equal(harness.timers.length, 1);
  harness.timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.authorizationDetailCalls(), 1);
  assert.equal(harness.elements.get("#login").hidden, true);
  assert.equal(harness.elements.get("#consent").hidden, false);
  assert.equal(harness.elements.get("#client-name").textContent, "Gemini");
  assert.equal(harness.elements.get("#scope").textContent, "openid, email");
  assert.equal(harness.elements.get("#status").textContent, "");
});

test("shows an expired-link callback error instead of silently returning to email entry", async () => {
  const harness = await consentHarness({
    hash: "#error=access_denied&error_description=Email+link+is+invalid+or+has+expired",
  });

  assert.equal(harness.authorizationDetailCalls(), 0);
  assert.equal(harness.elements.get("#login").hidden, false);
  assert.equal(harness.elements.get("#consent").hidden, true);
  assert.equal(
    harness.elements.get("#status").textContent,
    "Email link is invalid or has expired",
  );
});

test("pins the browser auth dependency and keeps both consent surfaces on the callback-session fix", async () => {
  const [staticConsent, edgeConsent] = await Promise.all([
    readFile(staticConsentPath, "utf8"),
    readFile(edgeConsentPath, "utf8"),
  ]);

  for (const source of [staticConsent, edgeConsent]) {
    assert.match(source, /@supabase\/supabase-js@2\.112\.4\/\+esm/);
    assert.doesNotMatch(source, /@supabase\/supabase-js@2\/\+esm/);
    assert.match(source, /onAuthStateChange\(\(event,session\)=>/);
    assert.match(source, /show\(session\)/);
    assert.match(source, /error_description/);
    assert.match(source, /Sign-in did not complete in this tab/);
    assert.match(source, /location\.origin\+location\.pathname\+location\.search/);
  }
});
