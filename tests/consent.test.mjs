import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const staticConsentPath = new URL("../docs/oauth/consent/index.html", import.meta.url);
const edgeConsentPath = new URL("../supabase/functions/open-brain-oauth-ui/index.ts", import.meta.url);

function element(overrides = {}) {
  return {
    hidden: false,
    textContent: "",
    value: "",
    handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    ...overrides,
  };
}

async function consentHarness({ hash = "", initialSession = null, detailsError = null, adoptionError = null, broadcastOnAdoption = false, surface = staticConsentPath, sendError = null, verifyError = null, missingAuthorization = false } = {}) {
  let html = await readFile(surface, "utf8");
  if(surface === edgeConsentPath){
    let handler;
    runInNewContext(stripTypeScriptTypes(html),{
      Response, URL,
      Deno:{env:{get:()=> 'fixture-public-key'},serve:(fn)=>{handler=fn}},
    });
    html=await handler(new Request('https://fixture.test/oauth/consent?authorization_id=request-1')).text();
  }
  const moduleScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(moduleScript, "consent module script is present");
  const executableScript = moduleScript.replace(/^import .*?;\s*/m, "").replace("${publicConfig}", "{}");

  const elements = new Map([
    ["#login", element()],
    ["#consent", element({ hidden: true })],
    ["#status", element()],
    ["#email", element()],
    ["#send-code", element()],
    ["#code-entry", element({hidden:true})],
    ["#code", element()],
    ["#verify-code", element()],
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
    search: missingAuthorization ? "" : "?authorization_id=request-1",
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
  let signInCalls = 0;
  let approveCalls = 0;
  let setSessionCalls = 0;
  let storedSession = initialSession;
  const sent = [], verified = [], detailIds = [], approvedIds = [];
  const auth = {
    async getSession() { return { data: { session: storedSession }, error: null }; },
    async setSession(session) {
      setSessionCalls += 1;
      if(adoptionError) return {data:{session:null},error:adoptionError};
      storedSession = session;
      if(broadcastOnAdoption) authStateHandler("SIGNED_IN", session);
      return {data:{session},error:null};
    },
    onAuthStateChange(handler) {
      authStateHandler = handler;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signInWithOtp(args) { signInCalls += 1; sent.push(args); return {error:sendError}; },
    async verifyOtp(args) {
      verified.push(args);
      if(verifyError)return {data:{session:null},error:verifyError};
      storedSession={access_token:'synthetic-otp-session',refresh_token:'synthetic-refresh'};
      return {data:{session:storedSession},error:null};
    },
    async signOut() {},
    oauth: {
      async getAuthorizationDetails(id) {
        detailIds.push(id);
        authorizationDetailCalls += 1;
        if(detailsError) return {data:null,error:detailsError};
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
      async approveAuthorization(id) { approvedIds.push(id); approveCalls += 1; return { data: { redirect_url: "https://example.test/approved" }, error: null }; },
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
    sent, verified, detailIds, approvedIds,
    elements,
    location,
    timers,
    authorizationDetailCalls: () => authorizationDetailCalls,
    signInCalls: () => signInCalls,
    approveCalls: () => approveCalls,
    setSessionCalls: () => setSessionCalls,
  };
}

test("missing server auth session restores email entry without signing in or granting consent", async () => {
  for(const detailsError of [{name:'AuthSessionMissingError',message:'Auth session missing!'}, {message:'Auth session missing!'}]){
    const harness=await consentHarness({initialSession:{access_token:'fixture-only'},detailsError});
    assert.equal(harness.authorizationDetailCalls(),1);
    assert.equal(harness.elements.get('#login').hidden,false);
    assert.equal(harness.elements.get('#consent').hidden,true);
    assert.match(harness.elements.get('#status').textContent,/Enter your approved email/);
    assert.equal(harness.signInCalls(),0);
    assert.equal(harness.approveCalls(),0);
    assert.equal(harness.location.assigned,null);
  }
});

test("an unrelated authorization error is preserved without suggesting a sign-in repair", async () => {
  const harness=await consentHarness({initialSession:{access_token:'fixture-only'},detailsError:{message:'Authorization request expired'}});
  assert.equal(harness.elements.get('#status').textContent,'Authorization request expired');
  assert.equal(harness.elements.get('#login').hidden,true);
  assert.equal(harness.elements.get('#consent').hidden,true);
  assert.equal(harness.approveCalls(),0);
});

test("uses the callback auth event session instead of falling back to an empty store", async () => {
  const harness = await consentHarness();
  assert.equal(harness.authorizationDetailCalls(), 0);
  assert.equal(harness.elements.get("#login").hidden, false);

  harness.authStateHandler("SIGNED_IN", { access_token: "verified-session", refresh_token: "fixture-refresh" });
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
    assert.doesNotMatch(source, /emailRedirectTo/);
    assert.match(source, /shouldCreateUser:false/);
  }
});

for(const surface of [staticConsentPath,edgeConsentPath]){
  const label=surface===staticConsentPath?'static':'edge';
  test(`${label}: event session is adopted once even when adoption emits another auth event`,async()=>{
    const h=await consentHarness({surface,broadcastOnAdoption:true});
    h.authStateHandler('SIGNED_IN',{access_token:'fixture-access',refresh_token:'fixture-refresh'});
    let turns=0;
    while(h.timers.length&&turns++<10){h.timers.shift()();await new Promise(r=>setImmediate(r));}
    assert.ok(turns<10,'auth events must settle');
    assert.equal(h.setSessionCalls(),1);
    assert.equal(h.elements.get('#consent').hidden,false);
    assert.equal(h.approveCalls(),0);
    assert.equal(h.location.assigned,null);
    await h.elements.get('#approve').handlers.click();
    assert.equal(h.approveCalls(),1);
    assert.equal(h.location.assigned,'https://example.test/approved');
  });
  test(`${label}: stored sessions need no adoption`,async()=>{
    const h=await consentHarness({surface,initialSession:{access_token:'fixture-stored'}});
    h.authStateHandler('SIGNED_IN',{access_token:'fixture-event',refresh_token:'fixture-refresh'});
    h.timers.shift()();await new Promise(r=>setImmediate(r));
    assert.equal(h.setSessionCalls(),0);
    assert.equal(h.elements.get('#consent').hidden,false);
    assert.equal(h.approveCalls(),0);
  });
  test(`${label}: rejected event adoption remains a sign-in error without looping`,async()=>{
    const h=await consentHarness({surface,adoptionError:{message:'Session could not be verified'}});
    for(let i=0;i<2;i++){
      h.authStateHandler('SIGNED_IN',{access_token:'fixture-access',refresh_token:'fixture-refresh'});
      h.timers.shift()();await new Promise(r=>setImmediate(r));
    }
    assert.equal(h.setSessionCalls(),1);
    assert.equal(h.authorizationDetailCalls(),0);
    assert.equal(h.elements.get('#login').hidden,false);
    assert.equal(h.elements.get('#consent').hidden,true);
    assert.equal(h.elements.get('#status').textContent,'Session could not be verified');
    assert.equal(h.approveCalls(),0);
    assert.equal(h.location.assigned,null);
  });
}

for (const surface of [staticConsentPath, edgeConsentPath]) {
  test(`same-page OTP to explicit consent/approve, no inbox or redirect loop: ${surface.pathname}`, async () => {
    const h=await consentHarness({surface});
    h.elements.get('#email').value='owner@example.test';
    await h.elements.get('#send-code').handlers.click();
    assert.deepEqual(h.sent,[{email:'owner@example.test',options:{shouldCreateUser:false}}]);
    assert.equal(h.elements.get('#code-entry').hidden,false);
    assert.equal(h.location.assigned,null);
    assert.equal(h.authorizationDetailCalls(),0);
    h.elements.get('#email').value='different@example.test'; // verify binds the successful send
    h.elements.get('#code').value='12345678';
    await h.elements.get('#verify-code').handlers.click();
    assert.deepEqual(h.verified,[{email:'owner@example.test',token:'12345678',type:'email'}]);
    assert.equal(h.elements.get('#login').hidden,true);
    assert.equal(h.elements.get('#consent').hidden,false);
    assert.deepEqual(h.detailIds,['request-1']);
    assert.equal(h.approveCalls(),0);
    assert.equal(h.location.assigned,null);
    await h.elements.get('#approve').handlers.click();
    assert.deepEqual(h.approvedIds,['request-1']);
    assert.equal(h.location.assigned,'https://example.test/approved');
  });

  test(`invalid and expired OTP fail closed: ${surface.pathname}`, async () => {
    const h=await consentHarness({surface,verifyError:{message:'Token has expired'}});
    h.elements.get('#email').value='owner@example.test';
    await h.elements.get('#send-code').handlers.click();
    for(const invalid of ['123456','123456789','12a45678']){
      h.elements.get('#code').value=invalid;
      await h.elements.get('#verify-code').handlers.click();
      assert.equal(h.verified.length,0);
    }
    h.elements.get('#code').value='87654321';
    await h.elements.get('#verify-code').handlers.click();
    assert.equal(h.verified.length,1);
    assert.equal(h.elements.get('#status').textContent,'Token has expired');
    assert.equal(h.elements.get('#consent').hidden,true);
    assert.equal(h.approveCalls(),0);
    assert.equal(h.authorizationDetailCalls(),0);
    assert.equal(h.location.assigned,null);
  });

  test(`send errors and missing authorization do not admit verification: ${surface.pathname}`, async () => {
    const h=await consentHarness({surface,sendError:{message:'Try again in 60 seconds'}});
    h.elements.get('#email').value='owner@example.test';
    await h.elements.get('#send-code').handlers.click();
    assert.equal(h.elements.get('#code-entry').hidden,true);
    assert.match(h.elements.get('#status').textContent,/60 seconds/);
    h.elements.get('#code').value='12345678';
    await h.elements.get('#verify-code').handlers.click();
    assert.equal(h.verified.length,0);
    const absent=await consentHarness({surface,missingAuthorization:true});
    absent.elements.get('#email').value='owner@example.test';
    await absent.elements.get('#send-code').handlers.click();
    assert.equal(absent.signInCalls(),0);
    assert.equal(absent.approveCalls(),0);
  });
}

test('hosted Magic Link template uses the same-page token, never a link',async()=>{
  const template=await readFile(new URL('../supabase/templates/magic_link.html',import.meta.url),'utf8');
  assert.match(template,/\{\{ \.Token \}\}/);
  assert.doesNotMatch(template,/ConfirmationURL|TokenHash|<a\b/);
});
