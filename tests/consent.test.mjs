import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthClient } from "@supabase/auth-js";
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

async function consentHarness({ hash = "", initialSession = null, detailsError = null, adoptionError = null, broadcastOnAdoption = false, surface = staticConsentPath, sendError = null, verifyError = null, missingAuthorization = false, broadcastOnVerify = false, detailsResponse = null, approveError = null, denyError = null, useRealSdk = false } = {}) {
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
  let auth = {
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
      storedSession={access_token:'synthetic-otp-session',refresh_token:'synthetic-refresh',user:{id:'fixture-user'}};
      if(broadcastOnVerify) authStateHandler('SIGNED_IN',storedSession);
      return {data:{session:storedSession},error:null};
    },
    async signOut() {},
    oauth: {
      async getAuthorizationDetails(id) {
        detailIds.push(id);
        authorizationDetailCalls += 1;
        if(detailsResponse) return detailsResponse(authorizationDetailCalls);
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
      async approveAuthorization(id) { approvedIds.push(id); approveCalls += 1; return { data: { redirect_url: "https://example.test/approved" }, error: approveError }; },
      async denyAuthorization() { return { data: { redirect_url: "https://example.test/denied" }, error: denyError }; },
    },
  };
  if(useRealSdk){
    const exp=Math.floor(Date.now()/1000)+3600;
    const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const accessToken=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'fixture-user',exp})+'.'+encode('fixture-signature');
    auth=new AuthClient({url:'https://fixture.invalid/auth/v1',persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,
      fetch:async(url,options)=>{
        const path=new URL(url).pathname;
        let response;
        if(path.endsWith('/logout'))response={data:{},error:null};
        else if(path.endsWith('/otp'))response={data:{},error:null};
        else if(path.endsWith('/verify'))response={data:{access_token:accessToken,refresh_token:'fixture-refresh',expires_in:3600,expires_at:exp,token_type:'bearer',user:{id:'fixture-user'}},error:null};
        else if(path.endsWith('/oauth/authorizations/request-1')){
          authorizationDetailCalls+=1;
          response=await detailsResponse(authorizationDetailCalls);
        }else if(path.endsWith('/oauth/authorizations/request-1/consent')){
          assert.equal(JSON.parse(options.body).action,'deny');
          response={data:{redirect_url:'https://example.test/denied'},error:null};
        }else throw Error('Unexpected fixture request');
        return new Response(JSON.stringify(response.error?{code:'validation_failed',message:response.error.message}:response.data),{status:response.error?400:200,headers:{'content-type':'application/json'}});
      }});
  }
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
    signOut:()=>auth.signOut(),
    changeSession(event,session){storedSession=session;authStateHandler(event,session)},
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


const settle = () => new Promise(resolve => setImmediate(resolve));
for(const surface of [staticConsentPath,edgeConsentPath]){
  const label=surface===staticConsentPath?'static':'edge';
  for(const useRealSdk of [false,true]){
  for(const timing of ['in-flight','after-result']){
    for(const outcome of ['auto-approved','pending','error']){
      test(`${label}: ${useRealSdk?"pinned SDK":"mock SDK"} OTP auth event ${timing} shares ${outcome} details without consuming twice`,async()=>{
        let resolveDetails;
        const firstResponse=new Promise(resolve=>{resolveDetails=resolve});
        const h=await consentHarness({surface,useRealSdk,broadcastOnVerify:true,detailsResponse:call=>call===1?firstResponse:{data:null,error:{message:'authorization request cannot be processed'}}});
        h.elements.get('#email').value='fixture@example.test';
        await h.elements.get('#send-code').handlers.click();
        h.elements.get('#code').value='12345678';
        const verification=h.elements.get('#verify-code').handlers.click();
        await settle();
        assert.equal(h.authorizationDetailCalls(),1);
        assert.equal(h.timers.length,1,'verifyOtp emitted SIGNED_IN before returning its session');
        const response=outcome==='auto-approved'?{data:{redirect_url:'https://example.test/approved',auto_approved:true},error:null}:
          outcome==='pending'?{data:{authorization_id:'request-1',client:{name:'Fixture client'},scopes:['email']},error:null}:
          {data:null,error:{message:'Authorization request expired'}};
        if(timing==='after-result'){resolveDetails(response);await verification;}
        h.timers.shift()();
        await settle();
        if(timing==='in-flight')resolveDetails(response);
        await verification;
        await settle();
        assert.equal(h.authorizationDetailCalls(),1);
        assert.equal(h.approveCalls(),0,'loading details never approves pending consent');
        assert.equal(h.location.assigned,outcome==='auto-approved'?'https://example.test/approved':null);
        assert.equal(h.elements.get('#consent').hidden,outcome!=='pending');
        assert.equal(h.elements.get('#status').textContent,outcome==='error'?'Authorization request expired':outcome==='pending'?'':'Finishing sign-in...');
        if(outcome==='pending'){
          await h.elements.get('#deny').handlers.click();
          assert.equal(h.location.assigned,'https://example.test/denied');
          assert.equal(h.approveCalls(),0);
        }
      });
    }
  }
  }
  test(`${label}: explicit approve and deny errors remain errors without redirect`,async()=>{
    for(const action of ['approve','deny']){
      const h=await consentHarness({surface,initialSession:{access_token:'fixture-session'},[`${action}Error`]:{message:'Request cannot be processed'}});
      await h.elements.get(`#${action}`).handlers.click();
      assert.equal(h.location.assigned,null);
      assert.equal(h.elements.get('#status').textContent,'Request cannot be processed');
    }
  });
}


for(const surface of [staticConsentPath,edgeConsentPath]){
  const label=surface===staticConsentPath?'static':'edge';
  test(`${label}: token refresh shares details, different user and signed-out session do not`,async()=>{
    const h=await consentHarness({surface,initialSession:{access_token:'fixture-first',user:{id:'first'}}});
    h.changeSession('TOKEN_REFRESHED',{access_token:'fixture-refreshed',user:{id:'first'}});
    h.timers.shift()();await settle();
    assert.equal(h.authorizationDetailCalls(),1);
    h.changeSession('SIGNED_IN',{access_token:'fixture-other',user:{id:'second'}});
    h.timers.shift()();await settle();
    assert.equal(h.authorizationDetailCalls(),2);
    h.changeSession('SIGNED_OUT',null);
    h.timers.shift()();await settle();
    assert.equal(h.elements.get('#consent').hidden,true);
    h.changeSession('SIGNED_IN',{access_token:'fixture-other',user:{id:'second'}});
    h.timers.shift()();await settle();
    assert.equal(h.authorizationDetailCalls(),3);
  });
  test(`${label}: signing out while auto-approved details are in flight prevents redirect`,async()=>{
    let resolveDetails;
    const response=new Promise(resolve=>{resolveDetails=resolve});
    const h=await consentHarness({surface,detailsResponse:()=>response});
    h.elements.get('#email').value='fixture@example.test';
    await h.elements.get('#send-code').handlers.click();
    h.elements.get('#code').value='12345678';
    const verification=h.elements.get('#verify-code').handlers.click();
    await settle();
    h.changeSession('SIGNED_OUT',null);
    h.timers.shift()();await settle();
    resolveDetails({data:{redirect_url:'https://example.test/approved'},error:null});
    await verification;
    assert.equal(h.location.assigned,null);
    assert.equal(h.elements.get('#login').hidden,false);
    assert.equal(h.elements.get('#consent').hidden,true);
  });
}


for(const surface of [staticConsentPath,edgeConsentPath]){
  const label=surface===staticConsentPath?'static':'edge';
  for(const transition of ['signed-out','different-user']){
    test(`${label}: ${transition} invalidates pending details before its deferred show runs`,async()=>{
      let resolveDetails;
      const response=new Promise(resolve=>{resolveDetails=resolve});
      const h=await consentHarness({surface,useRealSdk:transition==='signed-out',detailsResponse:()=>response});
      h.elements.get('#email').value='fixture@example.test';
      await h.elements.get('#send-code').handlers.click();
      h.elements.get('#code').value='12345678';
      const verification=h.elements.get('#verify-code').handlers.click();
      await settle();
      if(transition==='signed-out')await h.signOut();
      else h.changeSession('SIGNED_IN',{access_token:'fixture-other',user:{id:'different-user'}});
      assert.ok(h.timers.length,'the auth-event presentation is still deferred');
      resolveDetails({data:{redirect_url:'https://example.test/approved'},error:null});
      await verification;
      assert.equal(h.location.assigned,null,'old result must be invalidated at the event boundary');
    });
  }
}
