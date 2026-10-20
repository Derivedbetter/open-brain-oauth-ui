import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthClient } from '@supabase/auth-js';
import { readFile } from 'node:fs/promises';

// The exact browser SDK version, synthetic sessions, and fail-closed mocked HTTP.
// Separate SDK memory stores plus a shared channel model two storage-blocked tabs.
function browserFixture(t, { blockedStorage = false } = {}) {
  const saved = Object.fromEntries(['window','document','localStorage','BroadcastChannel'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const channels=[];
  const values=new Map();
  class Channel {
    constructor(name){this.name=name;this.handlers=[];channels.push(this)}
    addEventListener(type,handler){if(type==='message')this.handlers.push(handler)}
    postMessage(data){for(const peer of channels)if(peer!==this&&peer.name===this.name)queueMicrotask(()=>{for(const handler of peer.handlers)void handler({data})})}
    close(){}
  }
  globalThis.BroadcastChannel=Channel;
  globalThis.localStorage={
    getItem(k){if(blockedStorage)throw Error('fixture blocked storage');return values.get(k)||null},
    setItem(k,v){if(blockedStorage)throw Error('fixture blocked storage');values.set(k,v)},
    removeItem(k){if(blockedStorage)throw Error('fixture blocked storage');values.delete(k)},
  };
  globalThis.window={location:{href:'https://consent.invalid/?authorization_id=fixture',hash:''},addEventListener(){},removeEventListener(){}};
  globalThis.document={visibilityState:'hidden'};
  const calls=[];
  const clients=[];
  const key=`fixture-${t.name}`;
  function client(){
    const auth=new AuthClient({url:'https://auth.invalid/auth/v1',storageKey:key,autoRefreshToken:false,
      // The normal fixture supplies writable storage so it is independent of the
      // SDK's cached browser-storage capability probe in the blocked case.
      ...(!blockedStorage?{storage:globalThis.localStorage}:{}),
      fetch:async(url)=>{
        const path=new URL(url).pathname;calls.push(path);
        const body=path.endsWith('/user')?{id:'fixture-user'}:path.endsWith('/oauth/authorizations/fixture')?{authorization_id:'fixture',client:{name:'fixture'}}:null;
        assert.ok(body,`unexpected fixture request ${path}`);
        return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
      }});
    clients.push(auth);return auth;
  }
  function callbackURL(){
    const exp=Math.round(Date.now()/1000)+3600;
    const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
    const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'fixture-user',exp})+'.'+Buffer.from('fixture-signature').toString('base64url');
    window.location.hash=`#access_token=${token}&refresh_token=fixture-refresh&expires_in=3600&expires_at=${exp}&token_type=bearer&type=magiclink`;
    window.location.href+=window.location.hash;
  }
  t.after(async()=>{
    for(const auth of clients)await auth.stopAutoRefresh();
    for(const [k,descriptor]of Object.entries(saved))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];
  });
  return {client,callbackURL,calls};
}

test('real pinned SDK: normal callback retains a usable consent session',async(t)=>{
  const f=browserFixture(t);f.callbackURL();const auth=f.client();
  assert.ok((await auth.getSession()).data.session);
  const result=await auth.oauth.getAuthorizationDetails('fixture');
  assert.equal(result.error,null);assert.equal(result.data.authorization_id,'fixture');
  assert.deepEqual(f.calls,['/auth/v1/user','/auth/v1/oauth/authorizations/fixture']);
});

test('real pinned SDK: blocked-storage broadcast needs public session adoption before consent',async(t)=>{
  const f=browserFixture(t,{blockedStorage:true});const receiver=f.client();
  assert.equal((await receiver.getSession()).data.session,null);
  let received;
  receiver.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN')received=session});
  f.callbackURL();const callback=f.client();
  assert.ok((await callback.getSession()).data.session);
  await new Promise(r=>setTimeout(r,20));
  assert.ok(received,'another tab receives the sign-in event');
  assert.equal((await receiver.getSession()).data.session,null);
  const before=await receiver.oauth.getAuthorizationDetails('fixture');
  assert.equal(before.error.name,'AuthSessionMissingError');
  assert.deepEqual(f.calls,['/auth/v1/user'],'missing session fails locally before the consent request');
  const adopted=await receiver.setSession({access_token:received.access_token,refresh_token:received.refresh_token});
  assert.equal(adopted.error,null);
  const after=await receiver.oauth.getAuthorizationDetails('fixture');
  assert.equal(after.error,null);assert.equal(after.data.authorization_id,'fixture');
  assert.deepEqual(f.calls,['/auth/v1/user','/auth/v1/user','/auth/v1/oauth/authorizations/fixture']);
});


// Browser storage can accept writes yet later return no session. Exercise the real
// SDK's OTP -> public adoption -> OAuth storage reread against that boundary.
async function otpStorageFlow(t, persistSession) {
  const calls=[];
  const exp=Math.floor(Date.now()/1000)+3600;
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:'fixture-user',exp})+'.'+encode('fixture-signature');
  const auth=new AuthClient({
    url:'https://auth.invalid/auth/v1', storageKey:`otp-${t.name}`,
    persistSession, autoRefreshToken:false, detectSessionInUrl:false,
    storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
    fetch:async(url,options)=>{
      const path=new URL(url).pathname;calls.push(path);
      let body;
      if(path.endsWith('/verify')) body={access_token:token,refresh_token:'fixture-refresh',expires_in:3600,expires_at:exp,token_type:'bearer',user:{id:'fixture-user'}};
      else if(path.endsWith('/user')) body={id:'fixture-user'};
      else if(path.endsWith('/oauth/authorizations/fixture/consent')) {
        assert.equal(options.method,'POST');
        body={redirect_url:'https://client.invalid/approved'};
      } else if(path.endsWith('/oauth/authorizations/fixture')) body={authorization_id:'fixture',client:{name:'fixture'}};
      else throw Error(`Unexpected fixture request ${path}`);
      return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
    },
  });
  t.after(()=>auth.stopAutoRefresh());
  await auth.getSession();
  const verified=await auth.verifyOtp({email:'fixture@example.test',token:'12345678',type:'email'});
  assert.equal(verified.error,null);assert.ok(verified.data.session);
  const adopted=await auth.setSession(verified.data.session);
  assert.equal(adopted.error,null);assert.ok(adopted.data.session);
  const details=await auth.oauth.getAuthorizationDetails('fixture');
  return {auth,calls,details};
}

test('real pinned SDK: lost persistent storage reproduces verify/user success without details HTTP',async(t)=>{
  const f=await otpStorageFlow(t,true);
  assert.equal(f.details.error.name,'AuthSessionMissingError');
  assert.deepEqual(f.calls,['/auth/v1/verify','/auth/v1/user']);
});

for(const surface of ['../docs/oauth/consent/index.html','../supabase/functions/open-brain-oauth-ui/index.ts']) {
  test(`real pinned SDK: actual consent config survives lost browser storage to details and explicit approval: ${surface}`,async(t)=>{
    const source=await readFile(new URL(surface,import.meta.url),'utf8');
    const config=source.match(/persistSession:\s*(true|false)/);
    assert.ok(config,'actual browser auth configuration exists');
    const f=await otpStorageFlow(t,config[1]==='true');
    assert.equal(f.details.error,null);
    assert.equal(f.details.data.authorization_id,'fixture');
    assert.deepEqual(f.calls,['/auth/v1/verify','/auth/v1/user','/auth/v1/oauth/authorizations/fixture']);
    // Obtaining details must not itself grant consent. Only the explicit action
    // below may cause the POST and produce the original client redirect.
    const approved=await f.auth.oauth.approveAuthorization('fixture',{skipBrowserRedirect:true});
    assert.equal(approved.error,null);
    assert.equal(approved.data.redirect_url,'https://client.invalid/approved');
    assert.deepEqual(f.calls,['/auth/v1/verify','/auth/v1/user','/auth/v1/oauth/authorizations/fixture','/auth/v1/oauth/authorizations/fixture/consent']);
  });
}
