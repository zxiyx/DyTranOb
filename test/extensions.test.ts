import assert from 'node:assert/strict';
import { createECDH, createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiConnection, CookieJar, type ImService, type StoredAccount } from 'douyin-im/protocol';
import { EXTENSION_ACTIONS, EXTENSION_READ_ACTIONS, EXTENSION_WRITE_ACTIONS, extensionParams, type ExtensionAction } from '../src/extensions.js';
import { DouyinWebApi, signImageX, crc32 } from '../src/adapters/douyin-web.js';
import { DouyinExtensions, type ConversationAddress } from '../src/adapters/douyin-extensions.js';
import { Runtime } from '../src/runtime.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { DyTranObClient } from '../src/sdk.js';
import { startServer } from '../src/server.js';
import { READ_ACTIONS } from '../src/mcp.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZsAAAAASUVORK5CYII=', 'base64');
const account: StoredAccount = { platformUid: '123', session: { cookies: 'sessionid=test' }, deviceProfile: { userAgent: 'Chrome/130.0.0.0 Windows', bizTraceId: 'test' }, meta: { createdAt: '', updatedAt: '' } };
function webFixture(handler: (url: URL, init: RequestInit) => unknown, stored = account, fetcher?: typeof fetch) {
  const client = { getUserAgent: () => account.deviceProfile.userAgent, getMsToken: () => 'test-ms', jar: new CookieJar('sessionid=test'), requestRaw: async (url: string, init: RequestInit) => {
    const data = handler(new URL(url), init); const raw = typeof data === 'string' ? data : JSON.stringify(data);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), data: raw, rawText: raw };
  } } as unknown as ApiConnection;
  return new DouyinWebApi(client, stored, fetcher);
}
test('web API signs the encoded query, preserves large IDs, and refuses platform rejection', async () => {
  const web = webFixture((url, init) => {
    assert.equal(url.hostname, 'www.douyin.com'); assert.equal(url.searchParams.get('sec_user_id'), 'MS4w&test');
    assert.ok(url.searchParams.get('a_bogus')); assert.equal(init.redirect, 'error');
    return '{"status_code":0,"aweme_list":[{"aweme_id":9007199254740993123}],"has_more":0,"max_cursor":0}';
  });
  const result = await web.posts('MS4w&test'); assert.equal((result.aweme_list as Array<{aweme_id: string}>)[0]?.aweme_id, '9007199254740993123');
  await assert.rejects(webFixture(() => ({ status_code: 8 })).posts('user'), /status_code=8/);
  await assert.rejects(webFixture(() => ({})).posts('user'), /missing/);
});
test('post aggregation deduplicates, follows real cursors, and terminates repeated cursors', async () => {
  const cursors: string[] = [];
  const web = webFixture(url => { const cursor = url.searchParams.get('max_cursor')!; cursors.push(cursor); return { status_code: 0, aweme_list: cursor === '0' ? [{ aweme_id: '1' }, { aweme_id: '2' }] : [{ aweme_id: '2' }, { aweme_id: '3' }], max_cursor: '100', has_more: 1 }; });
  const result = await web.collectPosts('sec', 10); assert.deepEqual(cursors, ['0', '100']); assert.deepEqual(result.aweme_list, [{aweme_id:'1'}, {aweme_id:'2'}, {aweme_id:'3'}]); assert.equal(result.complete, false);
  cursors.length = 0; const page = await web.collectPosts('sec', 2, 2, 2); assert.deepEqual(page.aweme_list, [{ aweme_id: '3' }]);
});
test('comments sign using the saved scalar key and only succeed after a comment ID', async () => {
  const ec = createECDH('prime256v1'); ec.generateKeys();
  const stored = structuredClone(account); stored.session.desktopTicketGuard = { version: 1, privateKey: ec.getPrivateKey().toString('base64'), binding: { sessionHash: createHash('sha256').update('test').digest('hex'), tsSignRee: 'fixture' } };
  const web = webFixture((url, init) => {
    assert.equal(url.pathname, '/aweme/v1/web/comment/publish'); const headers = new Headers(init.headers);
    const point = Buffer.from(headers.get('bd-ticket-guard-ree-public-key')!, 'base64');
    const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1,33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
    const data = JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data')!, 'base64').toString());
    assert.ok(verify('sha256', Buffer.from(`ticket=test&path=/aweme/v1/web/comment/publish/&timestamp=${data.timestamp}`), publicKey, Buffer.from(data.req_sign_ree, 'base64')));
    const body = new URLSearchParams(String(init.body)); assert.equal(body.get('text'), 'a&b+你好'); assert.equal(body.get('image_widths'), '42'); return { status_code: 0, comment: { cid: '1234567890123456789' } };
  }, stored);
  await web.comment('123', 'a&b+你好', { uri: 'fixture', width: 42, height: 20, format: 'png' });
  await assert.rejects(webFixture(() => ({status_code: 0})).comment('123', 'x'), /comment ID/);
});
test('comment image upload completes auth, ImageX apply, storage CRC, commit, and uses actual dimensions', async () => {
  const calls: string[] = [];
  const web = webFixture(url => { assert.ok(url.pathname.endsWith('/comment/upload/auth/')); return { status_code:0, access_key:'fixture-key', secret_key:'fixture-secret', session_token:'fixture-token', service_id:'fixture-service' }; }, account, async (input, init) => {
    const url = new URL(String(input)); const action = url.searchParams.get('Action'); calls.push(action ?? 'storage');
    const headers = new Headers(init?.headers); assert.equal(headers.get('cookie'), null);
    if (action) { assert.equal(url.searchParams.get('ServiceId'), 'fixture-service'); assert.match(headers.get('authorization')!, /cn-north-1\/imagex\/aws4_request/); }
    if (action === 'ApplyImageUpload') return Response.json({ Result: { InnerUploadAddress: { UploadNodes: [{ StoreInfos: [{ StoreUri:'fixture.png', Auth:'upload-only' }], UploadHost:'tos.bytedance.com', SessionKey:'fixture-session' }] } } });
    if (action === 'CommitImageUpload') { assert.equal(init?.method, 'POST'); assert.equal(url.searchParams.get('SessionKey'), 'fixture-session'); return Response.json({ Result: { Results:[{Uri:'stored/image'}], PluginResult:[{ImageUri:'comment/image', ImageWidth:1, ImageHeight:1, ImageFormat:'png'}] } }); }
    assert.equal(url.href,'https://tos.bytedance.com/upload/v1/fixture.png'); assert.equal(headers.get('authorization'), 'upload-only'); assert.equal(headers.get('content-crc32'), crc32(png)); assert.deepEqual(Buffer.from(init?.body as Uint8Array),png); return Response.json({code:2000});
  });
  assert.deepEqual(await web.uploadCommentImage(png.toString('base64')), { uri:'comment/image',width:1,height:1,format:'png' });
  assert.deepEqual(calls,['ApplyImageUpload','storage','CommitImageUpload']); assert.equal(crc32(Buffer.from('123456789')),'cbf43926');
  const url = new URL('https://imagex.bytedanceapi.com/?s=a%20b&Action=ApplyImageUpload&ServiceId=test&Version=2018-08-01');
  assert.deepEqual(signImageX(url,'GET',{key:'key',secret:'secret',token:'token'}, new Date('2026-10-27T00:00:00Z')),signImageX(new URL('https://imagex.bytedanceapi.com/?Version=2018-08-01&ServiceId=test&Action=ApplyImageUpload&s=a+b'),'GET',{key:'key',secret:'secret',token:'token'}, new Date('2026-10-27T00:00:00Z')));
});
test('extension sends use native IDs and expose rejection instead of fabricated success', async () => {
  const sent: Array<Record<string, unknown>> = []; const routes: ConversationAddress[] = []; let reject = false;
  const im = { createPrivateConversation: async (users: string[]) => { assert.equal(users[0], '9007199254740993123'); return {statusCode:0,conversation:{conversationId:'0:1:123:9007199254740993123',conversationShortId:'9007199254740993124',conversationType:1}}; }, getUserProfile: async()=>({uid:'9007199254740993123'}), send: async(p: Record<string,unknown>) => {sent.push(p);return {statusCode:0,checkCode:reject?9:0,serverMessageId:'9007199254740993125'};}, uploadImage: async()=>({oid:'asset',skey:'a'.repeat(64),md5:'b'.repeat(32),dataSize:png.length,width:1,height:1}) } as unknown as ImService;
  const extension = new DouyinExtensions(im, webFixture(()=>({status_code:0})), {id:'123',nickname:'fixture'}, undefined, (_m, address)=>routes.push(address));
  const result = await extension.execute('dy_send_stranger_msg',extensionParams('dy_send_stranger_msg',{sec_user_id:'sec',text:'hello'}));
  assert.equal(result.message?.id,'9007199254740993125'); assert.equal(routes[0]?.userId,'9007199254740993123');
  await extension.execute('dy_send_dynamic_emoji',extensionParams('dy_send_dynamic_emoji',{native_user_id:'9007199254740993123',name:'比心'})); assert.equal(sent.at(-1)?.msgType,5); assert.equal(JSON.parse(String(sent.at(-1)?.content)).aweType,507);
  await extension.execute('dy_send_video_card',extensionParams('dy_send_video_card',{native_user_id:'9007199254740993123',item_id:'9007199254740993128'})); assert.ok(String(sent.at(-1)?.content).includes('9007199254740993128'));
  reject=true; await assert.rejects(extension.execute('dy_send_image',extensionParams('dy_send_image',{native_user_id:'9007199254740993123',image_base64:png.toString('base64')})),/rejected/);
});

test('stranger cursors descend and partial platform pages retain the remaining conversations', async () => {
  const versions:string[]=[];
  const im={getRecentStrangerMessages:async(p:{latestStrangerVersion:string;earliestStrangerVersion:string})=>{versions.push(p.latestStrangerVersion);assert.equal(p.earliestStrangerVersion,'0');return {statusCode:0,nextStrangerVersion:'50',hasMore:true,messages:[{conversationId:'a'},{conversationId:'b'},{conversationId:'c'}]};}} as unknown as ImService;
  const extension=new DouyinExtensions(im,webFixture(()=>({status_code:0})),{id:'123',nickname:'fixture'});
  const first=(await extension.execute('dy_fetch_stranger_messages',extensionParams('dy_fetch_stranger_messages',{count:2}))).data as {conversations:unknown[];next_cursor:string};
  assert.deepEqual(first.conversations,[{conversationId:'a'},{conversationId:'b'}]); assert.equal(first.next_cursor,'9223372036854775807:2');
  const second=(await extension.execute('dy_fetch_stranger_messages',extensionParams('dy_fetch_stranger_messages',{count:2,cursor:first.next_cursor}))).data as {conversations:unknown[];next_cursor:string};
  assert.deepEqual(second.conversations,[{conversationId:'c'}]);assert.equal(second.next_cursor,'50');assert.deepEqual(versions,['9223372036854775807','9223372036854775807']);
});
test('all extension schemas and permissions are published, invalid input stops before adapter calls, WS/HTTP share dispatch', async t => {
  assert.equal(EXTENSION_ACTIONS.length,20); assert.equal(new Set([...EXTENSION_READ_ACTIONS,...EXTENSION_WRITE_ACTIONS]).size,20);
  for (const name of ['dy_comment_video','dy_send_stranger_msg','dy_upload_comment_image'] as ExtensionAction[]) assert.ok(EXTENSION_WRITE_ACTIONS.includes(name));
  const dir = await mkdtemp(join(tmpdir(),'dytranob-extensions-')); const adapter = new MockAdapter(); let calls=0;
  adapter.executeExtension = async (_action,p) => {calls++;return { data:p };};
  const runtime = new Runtime({dataDir:dir,accounts:[{id:'mock',adapter}]}); await runtime.start();
  const server = await startServer(runtime,{host:'127.0.0.1',port:0,token:'ui',heartbeatInterval:0});
  const sdk = new DyTranObClient({baseUrl:`http://127.0.0.1:${server.port}`,token:'ui',reconnect:false});
  t.after(async()=>{sdk.close();await server.close();await runtime.stop();await rm(dir,{recursive:true,force:true});});
  assert.equal((await runtime.execute({action:'dy_get_user_posts',params:{sec_user_id:'sec',count:101}})).retcode,1400);
  assert.equal((await runtime.execute({action:'dy_send_image',params:{native_user_id:'123',image_base64:'AAAA',conversation_id:'wrong'}})).retcode,1400); assert.equal(calls,0);
  assert.equal((await sdk.getUserPosts('sec') as {max_cursor:string}).max_cursor,'0');
  assert.equal((await sdk.callWs<{aweme_id:string}>('dy_get_video_comments',{aweme_id:'9007199254740993123'})).aweme_id,'9007199254740993123');
  const large = Buffer.concat([png,Buffer.alloc(1024*1024)]); assert.equal((await sdk.uploadImage(large) as unknown as {image_base64:string}).image_base64.length,large.toString('base64').length);
  const received=await sdk.callWs<{image_base64:string}>('dy_upload_image',{image_base64:large.toString('base64')}); assert.equal(received.image_base64.length,large.toString('base64').length);
});

test('work detail validates exact ID and falls back to an existing IM context without creating conversations', async () => {
  const id='7701010931699085753'; let calls=0;
  const im={listThreads:async()=>({statusCode:0,conversations:[{conversationShortId:'123'}]}),getSharedWorkDetails:async(shortId:string,ids:string[])=>{calls++;assert.equal(shortId,'123');assert.deepEqual(ids,[id]);return [{workId:id,detail:{aweme_id:id,video:{}},filtered:false}];}} as unknown as ImService;
  const web=webFixture(()=>({status_code:0,aweme_detail:{aweme_id:'wrong'}}));
  const extension=new DouyinExtensions(im,web,{id:'123',nickname:'test'});
  const data=(await extension.execute('dy_get_video_detail',{aweme_id:id})).data as {source:string;warnings:string[];aweme_detail:{aweme_id:string}};
  assert.equal(data.source,'im');assert.equal(data.aweme_detail.aweme_id,id);assert.deepEqual(data.warnings,['WEB_DETAIL_UNAVAILABLE']);assert.equal(calls,1);
  await extension.execute('dy_get_video_detail',{aweme_id:id,conversation_short_id:'123'});assert.equal(calls,2);
  im.getSharedWorkDetails=async()=>[{workId:id,filtered:true,reason:'private'}];
  await assert.rejects(extension.execute('dy_get_video_detail',{aweme_id:id,conversation_short_id:'123'}),/WORK_UNAVAILABLE/);
});

test('mobile detail selects only the requested ID, preserves int64 and never sends session cookies', async () => {
  let calls=0; const id='7701010931699085753';
  const web=webFixture(()=>({status_code:0}),account,async(input,init)=>{
    calls++; const url=new URL(String(input)); assert.equal(url.searchParams.get('aweme_id'),id); assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('cookie'),null);
    return new Response(calls===1?'{"status_code":0,"aweme_list":[{"aweme_id":"123"}]}':`{"status_code":0,"aweme_list":[{"aweme_id":${id},"video":{}}]}`,{headers:{'content-type':'application/json'}});
  });
  assert.equal((await web.mobileVideoDetail(id)).aweme_id,id);assert.equal(calls,2);
  const rejected=webFixture(()=>({}),account,async()=>Response.json({status_code:0,aweme_list:[{aweme_id:'wrong'}]}));
  await assert.rejects(rejected.mobileVideoDetail(id),/MOBILE_DETAIL_UNAVAILABLE/);
});

test('subtitle HTTP, AstrBot-style WS, SDK helpers and MCP read permissions expose normalized text', async t => {
  const id='7701010931699085753'; const fixtureDetail={aweme_id:id,video:{cla_info:{caption_info:{url:'https://sf1.douyinstatic.com/test.vtt',language_code:'zh-Hans'}}}};
  const originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input: Parameters<typeof fetch>[0],init?:RequestInit)=>{
    if(new URL(String(input)).hostname==='sf1.douyinstatic.com') return new Response('WEBVTT\n\n00:00.500 --> 00:01.750\n测试字幕\n');
    return originalFetch(input,init);
  });
  const ext=new DouyinExtensions({} as ImService,webFixture((url,init)=>{assert.equal(url.pathname,'/aweme/v1/web/aweme/detail/');assert.equal(new Headers(init.headers).get('referer'),`https://www.douyin.com/video/${id}`);return {status_code:0,aweme_detail:fixtureDetail};}),{id:'123',nickname:'test'});
  const dir=await mkdtemp(join(tmpdir(),'dytranob-subtitles-'));const adapter=new MockAdapter();adapter.executeExtension=(action,p)=>ext.execute(action,p);
  const runtime=new Runtime({dataDir:dir,accounts:[{id:'test',adapter}]});await runtime.start();
  const server=await startServer(runtime,{host:'127.0.0.1',port:0,token:'ui',onebotToken:'',heartbeatInterval:0});
  const http=new DyTranObClient({baseUrl:`http://127.0.0.1:${server.port}`,token:'ui',reconnect:false});
  const ws=new DyTranObClient({baseUrl:`http://127.0.0.1:${server.port}`,reconnect:false});
  t.after(async()=>{http.close();ws.close();await server.close();await runtime.stop();await rm(dir,{recursive:true,force:true});});
  for(const action of ['dy_get_video_detail','dy_get_video_subtitles']) assert.ok((READ_ACTIONS as readonly string[]).includes(action));
  assert.equal((await http.getVideoDetail(id)).aweme_detail.aweme_id,id);
  const byHttp=await http.getVideoSubtitles(id) as {text:string;cues:unknown[];available:boolean};assert.equal(byHttp.available,true);assert.equal(byHttp.text,'测试字幕');
  const byWs=await ws.callWs('dy_get_video_subtitles',{aweme_id:id});assert.deepEqual(byWs,byHttp);
  const response=await originalFetch(`http://127.0.0.1:${server.port}/action`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'dy_get_video_subtitles',params:{aweme_id:id},echo:'ast-1'})});
  const body=await response.json() as {retcode:number;data:unknown;echo:string};assert.equal(body.retcode,0);assert.equal(body.echo,'ast-1');assert.deepEqual(body.data,byHttp);
  assert.equal((await runtime.execute({action:'dy_get_video_subtitles',params:{aweme_id:Number(id)}})).retcode,1400);
});

test('no subtitle metadata is distinguished from failed detail and failed subtitle downloads', async () => {
  const id='7701010931699085753';
  const web=webFixture(()=>({status_code:0,aweme_detail:{aweme_id:id,video:{}}}),account,async()=>Response.json({status_code:0,aweme_list:[{aweme_id:id,video:{}}]}));
  const ext=new DouyinExtensions({} as ImService,web,{id:'123',nickname:'test'});
  const data=(await ext.execute('dy_get_video_subtitles',{aweme_id:id})).data as {available:boolean;reason:string;sources_checked:string[]};
  assert.equal(data.available,false);assert.equal(data.reason,'no_subtitle_metadata');assert.deepEqual(data.sources_checked,['web','mobile']);
  const failed=new DouyinExtensions({} as ImService,webFixture(()=>({status_code:9}),account,async()=>Response.json({status_code:9})),{id:'123',nickname:'test'});
  await assert.rejects(failed.execute('dy_get_video_detail',{aweme_id:id}),/WORK_DETAIL_FAILED/);
});
