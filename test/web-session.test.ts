import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar, type ApiConnection, type StoredAccount } from 'douyin-im/protocol';
import { loadWebSession, resolveWebSession } from '../src/adapters/web-session.js';
import { DouyinWebApi } from '../src/adapters/douyin-web.js';

test('browser identity aliases become consistent cookies, query parameters and UIFID header', async t => {
  const dir=await mkdtemp(join(tmpdir(),'dytranob-web-session-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'web-session.json'),JSON.stringify({cookies:'sessionid=browser; UIFID=old; s_v_web_id=old; ttwid=old',userAgent:'Chrome/130.0 Windows',UIFID:'browser-uifid',ttwid:'1%7Cbrowser-visitor',s_v_web_id:'verify_browser'}));
  const options=resolveWebSession(await loadWebSession(dir),'sessionid=im; im_only=secret');
  const jar=new CookieJar(options.cookies);assert.equal(jar.get('sessionid'),'browser');assert.equal(jar.get('im_only'),undefined);
  assert.equal(jar.get('UIFID'),'browser-uifid');assert.equal(jar.get('s_v_web_id'),'verify_browser');assert.equal(jar.get('ttwid'),'1%7Cbrowser-visitor');
  const stored={session:{cookies:'sessionid=im'},deviceProfile:{userAgent:'Chrome/130.0 Windows'}} as StoredAccount;
  const client={jar,getUserAgent:()=>options.userAgent,getMsToken:()=>undefined,requestRaw:async(input:string,init:RequestInit)=>{
    const url=new URL(input);assert.equal(url.searchParams.get('uifid'),'browser-uifid');assert.equal(url.searchParams.get('fp'),'verify_browser');assert.equal(url.searchParams.get('verifyFp'),'verify_browser');
    assert.equal(new Headers(init.headers).get('uifid'),'browser-uifid');
    const raw='{"status_code":0,"aweme_detail":{"aweme_id":"123"}}';return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),data:raw,rawText:raw};
  }} as unknown as ApiConnection;
  assert.equal((await new DouyinWebApi(client,stored,fetch,options).videoDetail('123')).aweme_id,'123');
});

test('web session rejects conflicting aliases and cookie injection without disclosing credentials', async t => {
  const dir=await mkdtemp(join(tmpdir(),'dytranob-web-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const value of [{UIFID:'secret-a',uifid:'secret-b'},{s_v_web_id:'secret-a',fp:'secret-b'},{ttwid:'secret; sessionid=other'},{UIFID:'secret\r\nHeader:value'},{ttwid:'secret\u0000'}]){
    await writeFile(join(dir,'web-session.json'),JSON.stringify(value));
    await assert.rejects(loadWebSession(dir),e=>e instanceof Error && e.message==='Invalid web-session.json; see developer documentation');
  }
});

test('legacy cookie-only sessions and missing configuration preserve existing behavior', async t => {
  const dir=await mkdtemp(join(tmpdir(),'dytranob-web-legacy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  assert.deepEqual(await loadWebSession(dir),{});
  assert.equal(resolveWebSession({},'sessionid=im').cookies,'sessionid=im');
  await writeFile(join(dir,'web-session.json'),JSON.stringify({cookies:'UIFID=browser; ttwid=visitor; s_v_web_id=verify_browser',uifid:'browser',fp:'verify_browser'}));
  assert.equal(resolveWebSession(await loadWebSession(dir),'sessionid=im').cookies,'UIFID=browser; ttwid=visitor; s_v_web_id=verify_browser');
  assert.equal(resolveWebSession({cookies:''},'sessionid=im').cookies,'');
});
