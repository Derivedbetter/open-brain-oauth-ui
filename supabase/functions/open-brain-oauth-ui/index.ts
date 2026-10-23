const PROJECT_REF = "zoptbgumxukgpkgbtnpz";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const UI_URL = `${PROJECT_URL}/functions/v1/open-brain-oauth-ui`;

function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{font-family:Inter,system-ui,sans-serif;color:#18201c;background:#f5f7f6}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(560px,calc(100% - 40px));background:#fff;border:1px solid #dce4df;border-radius:18px;padding:30px;box-shadow:0 18px 50px #173a2520}h1{margin:0 0 10px;font-size:26px}p{line-height:1.5;color:#4e5c54}.details{background:#f4f8f5;border-radius:12px;padding:14px;margin:18px 0}.row{margin:8px 0}.label{font-weight:700}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}button,input{font:inherit;border-radius:10px;padding:11px 14px}input{width:100%;box-sizing:border-box;border:1px solid #bac8bf}button{border:0;background:#23864c;color:white;font-weight:700;cursor:pointer}button.secondary{background:#e9efeb;color:#26352b}button:disabled{opacity:.55;cursor:not-allowed}.status{min-height:24px;margin-top:12px;color:#9a3412}.links{margin-top:20px;font-size:14px}.links a{color:#176a3a;margin-right:12px}</style></head>
<body>${body}</body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src https://zoptbgumxukgpkgbtnpz.supabase.co; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function consentPage(anonKey: string) {
  const publicConfig = JSON.stringify({ projectUrl: PROJECT_URL, anonKey, uiUrl: UI_URL });
  return page("Authorize Open Brain", `<main class="card">
<h1>Authorize Tony's Open Brain</h1>
<p>This private consent screen grants an approved AI client access to Tony's shared operational memory. It is not Continuity, COTA, Current-State Tracker, or owner-acceptance authority.</p>
<section id="login"><label class="label" for="email">Tony's approved email</label><input id="email" type="email" autocomplete="email" placeholder="name@example.com"><div class="actions"><button id="send-code">Send eight-digit code</button></div><div id="code-entry" hidden>
      <label class="label" for="code">Eight-digit email code</label>
      <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{8}" placeholder="12345678">
      <div class="actions"><button id="verify-code">Verify code</button></div>
    </div></section>
<section id="consent" hidden><div class="details"><div class="row"><span class="label">Application:</span> <span id="client-name"></span></div><div class="row"><span class="label">Redirect:</span> <span id="redirect-uri"></span></div><div class="row"><span class="label">Requested access:</span> <span id="scope"></span></div></div><p>Approve only if you initiated this connection. Open Brain captures content only when you explicitly request a capture.</p><div class="actions"><button id="approve">Approve</button><button id="deny" class="secondary">Deny</button><button id="sign-out" class="secondary">Sign out</button></div></section>
<div id="status" class="status" role="status"></div><div class="links"><a href="${UI_URL}/privacy">Privacy</a><a href="${UI_URL}/terms">Terms</a></div>
</main><script type="module">
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/+esm';
const callbackParams=new URLSearchParams(location.hash.slice(1));
const callbackError=callbackParams.get('error_description')||callbackParams.get('error');
const callbackAttempted=location.hash.length>1;
const config=${publicConfig};
const client=createClient(config.projectUrl,config.anonKey,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:true}});
const qs=new URLSearchParams(location.search); const authorizationId=qs.get('authorization_id');
const login=document.querySelector('#login'), consent=document.querySelector('#consent'), status=document.querySelector('#status');
function setStatus(message){status.textContent=message||''}
let showGeneration=0;
let eventSessionAdoption;
let detailsRequest;
function authorizationDetails(session){
  const userId=session.user?.id||session.access_token;
  if(!detailsRequest||detailsRequest.userId!==userId){
    // Details may auto-approve and consume the request. Keep its first result,
    // including its redirect, when verifyOtp and auth events both call show().
    detailsRequest={userId,promise:client.auth.oauth.getAuthorizationDetails(authorizationId)};
  }
  return detailsRequest.promise;
}
async function show(sessionFromEvent){
  const generation=++showGeneration;
  let session=sessionFromEvent;
  if(typeof session==='undefined'||session){
    const {data,error}=await client.auth.getSession();
    if(generation!==showGeneration)return;
    if(error){login.hidden=false;consent.hidden=true;setStatus(error.message);return}
    session=data.session;
    // Broadcast auth events can reach a tab whose SDK uses separate memory storage.
    // Adopt that verified event through the public API once before OAuth rereads storage.
    if(!session&&sessionFromEvent){
      eventSessionAdoption??=client.auth.setSession({access_token:sessionFromEvent.access_token,refresh_token:sessionFromEvent.refresh_token});
      const adopted=await eventSessionAdoption;
      if(generation!==showGeneration)return;
      if(adopted.error){login.hidden=false;consent.hidden=true;setStatus(adopted.error.message);return}
      session=adopted.data.session;
    }
  }
  if(!session){
    detailsRequest=undefined;
    login.hidden=false;
    consent.hidden=true;
    setStatus(callbackError||(callbackAttempted?'Sign-in did not complete in this tab. Close other Open Brain authorization tabs, then request a new code.':''));
    return;
  }
  if(!authorizationId){login.hidden=true;consent.hidden=true;setStatus('Missing authorization request. Return to the app and start the connection again.');return}
  login.hidden=true;
  consent.hidden=true;
  setStatus('Finishing sign-in...');
  const {data,error}=await authorizationDetails(session);
  if(generation!==showGeneration)return;
  if(error||!data){setStatus(error?.message||'Invalid authorization request.');return}
  if(!('authorization_id' in data)&&data.redirect_url){location.assign(data.redirect_url);return}
  login.hidden=true;consent.hidden=false;
  setStatus('');
  document.querySelector('#client-name').textContent=data.client?.name||data.client_name||'Approved AI client';
  document.querySelector('#redirect-uri').textContent=data.redirect_uri||'';
  document.querySelector('#scope').textContent=Array.isArray(data.scopes)?data.scopes.join(', '):(data.scope||'email');
}
let otpEmail=null;
let otpBusy=false;
document.querySelector('#send-code').addEventListener('click',async()=>{
  if(otpBusy)return;
  const email=document.querySelector('#email').value.trim();
  if(!authorizationId){setStatus('Missing authorization request. Return to the app and start the connection again.');return}
  if(!email){setStatus('Enter the approved email address.');return}
  otpBusy=true;
  document.querySelector('#send-code').disabled=true;
  setStatus('Sending eight-digit sign-in code...');
  try{
    const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:false}});
    if(error){setStatus(error.message);return}
    otpEmail=email;
    document.querySelector('#email').readOnly=true;
    document.querySelector('#code-entry').hidden=false;
    document.querySelector('#code').value='';
    setStatus('Check your email for the eight-digit code. Enter it here, in this same page.');
  }catch{setStatus('Could not send the code. Check your connection and try again.')}
  finally{otpBusy=false;document.querySelector('#send-code').disabled=false}
});
document.querySelector('#verify-code').addEventListener('click',async()=>{
  if(otpBusy)return;
  const token=document.querySelector('#code').value.trim();
  if(!otpEmail||!/^[0-9]{8}$/.test(token)){setStatus('Enter the eight-digit code from your email.');return}
  otpBusy=true;
  document.querySelector('#verify-code').disabled=true;
  setStatus('Verifying sign-in code...');
  try{
    const {data,error}=await client.auth.verifyOtp({email:otpEmail,token,type:'email'});
    if(error){setStatus(error.message);return}
    if(!data?.session){setStatus('Sign-in did not complete. Request a new code.');return}
    document.querySelector('#code').value='';
    await show(data.session);
  }catch{setStatus('Could not verify the code. Check your connection and try again.')}
  finally{otpBusy=false;document.querySelector('#verify-code').disabled=false}
});
document.querySelector('#approve').addEventListener('click',async()=>{setStatus('Approving…');const {data,error}=await client.auth.oauth.approveAuthorization(authorizationId);if(error){setStatus(error.message);return}location.assign(data.redirect_url);});
document.querySelector('#deny').addEventListener('click',async()=>{setStatus('Denying…');const {data,error}=await client.auth.oauth.denyAuthorization(authorizationId);if(error){setStatus(error.message);return}location.assign(data.redirect_url);});
document.querySelector('#sign-out').addEventListener('click',async()=>{await client.auth.signOut();location.reload()});
client.auth.onAuthStateChange((event,session)=>{
  if(session){login.hidden=true;consent.hidden=true;setStatus('Finishing sign-in...');setTimeout(()=>void show(session),0)}
  else if(event==='SIGNED_OUT'){setTimeout(()=>void show(null),0)}
});
await show();
</script>`);
}

Deno.serve((request: Request) => {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/privacy")) {
    return page("Open Brain Privacy", `<main class="card"><h1>Open Brain privacy</h1><p>This private gateway sends only the content necessary to perform an explicitly requested Open Brain tool call. It does not automatically capture conversations. OAuth tokens and the Open Brain access key are not logged. Operational memory is not authoritative Continuity, COTA, Current-State Tracker, or owner acceptance.</p><div class="links"><a href="${UI_URL}/terms">Terms</a></div></main>`);
  }
  if (url.pathname.endsWith("/terms")) {
    return page("Open Brain Terms", `<main class="card"><h1>Open Brain terms</h1><p>This gateway is a private pilot for Tony's approved AI clients. Use is limited to explicit operational-memory search, retrieval, statistics, listing, and capture. Do not store secrets or treat retrieved memories as verified authority.</p><div class="links"><a href="${UI_URL}/privacy">Privacy</a></div></main>`);
  }
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!anonKey) return page("Open Brain unavailable", `<main class="card"><h1>Open Brain authorization unavailable</h1><p>The authorization interface is not configured.</p></main>`, 503);
  return consentPage(anonKey);
});

