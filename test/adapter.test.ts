import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createClient, MessageEvent, PrivateMessageEvent } from 'douyin-im';
import { DouyinAdapter, incomingMessage } from '../src/adapters/douyin.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { UnsupportedAdapterOperation, type NativeEvent } from '../src/adapters/types.js';
import { MediaCache } from '../src/media.js';
import { createCipheriv, randomBytes } from 'node:crypto';
import { Runtime } from '../src/runtime.js';
import { startServer } from '../src/server.js';
import { DyTranObClient, ActionError } from '../src/sdk.js';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-adapter-test-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const client = createClient({ dataDir, autoLoad: false, localState: false });
  const account = client.createAccount();
  return { client, account, dataDir };
}

function inbound(overrides: Partial<Parameters<typeof MessageEvent.fromInbound>[0]> = {}): Parameters<typeof MessageEvent.fromInbound>[0] {
  return { threadId: '9223372036854775801', conversationShortId: '9223372036854775802', conversationType: 2, senderUid: '9223372036854775803', serverMessageId: '9223372036854775804', createTime: '1700000000123', text: '你好', rawContent: JSON.stringify({ aweType: 700, text: '你好' }), messageType: 7, raw: {}, ...overrides };
}

test('maps real SDK group event fixtures without losing int64 IDs or mention offsets', async t => {
  const { account } = await fixture(t);
  const event = MessageEvent.fromInbound(inbound({ text: '你好 @测试 后文', rawContent: JSON.stringify({ aweType: 700, text: '你好 @测试 后文', richTextInfos: [{ infoType: 1, location: 3, length: 3, info: { uid: '9223372036854775805' } }] }) }), account);
  const mapped = incomingMessage(event);
  assert.equal(mapped.id, '9223372036854775804');
  assert.equal(mapped.groupId, '9223372036854775801');
  assert.equal(mapped.userId, '9223372036854775803');
  assert.equal(mapped.time, 1700000000);
  assert.deepEqual(mapped.segments, [{ type: 'text', text: '你好 ' }, { type: 'at', userId: '9223372036854775805', text: '@测试' }, { type: 'text', text: ' 后文' }]);
});

test('preserves reply IDs and client IDs, rejects messages with no usable identifier', async t => {
  const { account } = await fixture(t);
  const event = MessageEvent.fromInbound(inbound({ serverMessageId: undefined, clientMessageId: 'abc123', referenceInfo: { refMessageId: '9223372036854775807', hint: '{}', refMessageType: 7, refMessageStatus: 0 } }), account);
  assert.equal(incomingMessage(event).id, 'client:abc123');
  assert.deepEqual(incomingMessage(event).segments[0], { type: 'reply', messageId: '9223372036854775807' });
  assert.throws(() => incomingMessage(MessageEvent.fromInbound(inbound({ serverMessageId: undefined }), account)), /no server or client/);
});

test('native video fixtures never fabricate downloadable media URLs', async t => {
  const { account } = await fixture(t);
  const event = MessageEvent.fromInbound(inbound({ messageType: 30, text: '', rawContent: JSON.stringify({ video: { tkey: 'opaque-resource', skey: 'not-a-url' }, width: 10, height: 10 }) }), account);
  const mapped = incomingMessage(event);
  assert.equal(mapped.segments[0]?.type, 'text');
  assert.equal(mapped.segments[0]?.url, undefined);
});

test('video and photo share cards expose exact work IDs and links, including bare int64 JSON', async t => {
  const { account, dataDir } = await fixture(t);
  const adapter = new MockAdapter(); const runtime = new Runtime({ dataDir: join(dataDir, 'runtime'), accounts: [{ id: 'test', adapter }] });
  await runtime.start(); t.after(() => runtime.stop());
  for (const [index, value] of [
    { type: 8, raw: '{"aweType":800,"itemId":7523456789012345678,"content_title":"分享标题 1234567890123456789","uid":"987654321098765432"}', kind: 'video' },
    { type: 77, raw: '{"awemeType":68,"itemId":"7523456789012345679","content_title":"相册"}', kind: 'images' },
    { type: 8, raw: '{"aweme_id":"7523456789012345680","desc":"兼容字段"}', kind: 'video' },
    { type: 999, raw: '{"aweType":800,"itemId":"7523456789012345681"}', kind: 'video' },
  ].entries()) {
    const message = incomingMessage(MessageEvent.fromInbound(inbound({ conversationType: 1, threadId: '0:1:10000:10001', senderUid:'10001', messageType:value.type, serverMessageId:String(200+index), rawContent:value.raw }), account));
    const id = String(7523456789012345678n + BigInt(index));
    assert.equal(message.sharedWork?.itemId,id); assert.equal(message.sharedWork?.kind,value.kind);
    assert.ok(message.sharedWork?.conversationShortId);
    assert.ok(message.segments.some(s=>s.text?.includes(`作品ID：${id}`))); assert.ok(message.segments.some(s=>s.text?.includes(`https://www.douyin.com/${value.kind==='images'?'note':'video'}/${id}`)));
    assert.ok(message.segments.every(s=>s.type!=='video')); adapter.injectMessage(message);
    await new Promise(resolve=>setImmediate(resolve));
    const event = runtime.recentEvents().at(-1)!; assert.equal((event.dy as {work:{item_id:string}}).work.item_id,id);
    assert.equal((event.dy as {work:{conversation_short_id:string}}).work.conversation_short_id,message.sharedWork?.conversationShortId);
    const cached = await runtime.execute({action:'get_msg',params:{message_id:event.message_id}}); assert.deepEqual((cached.data as {dy:unknown}).dy,event.dy);
  }
  const malformed = incomingMessage(MessageEvent.fromInbound(inbound({ messageType:8,rawContent:'{"itemId":"not-a-work-id"}' }),account));
  assert.equal(malformed.sharedWork,undefined); assert.ok(!malformed.segments.some(s=>s.text?.includes('/video/not-a-work-id')));
});

test('AstrBot plugin text + Base64 images send over OneBot WS with real IDs, quotes and partial-failure reporting', async t => {
  const { account, client, dataDir } = await fixture(t);
  account.login = async () => {}; account.logout = async () => {};
  Object.defineProperty(account,'uid',{value:'10000'});
  const incoming = MessageEvent.fromInbound(inbound({threadId:'0:1:10000:10001',conversationType:1,senderUid:'10001'}),account);
  assert.ok(incoming instanceof PrivateMessageEvent); const friend=incoming.friend; account.pickFriend=()=>friend;
  const payloads: unknown[]=[]; const recalls:string[]=[]; let rejectAt=-1;
  friend.sendMsg=async payload=>{payloads.push(payload);return {statusCode:0,statusMsg:'',checkCode:payloads.length===rejectAt?99:0,serverMessageId:String(300+payloads.length)};};
  friend.recallMsg=async id=>{recalls.push(id);return {statusCode:0,statusMsg:'',recalled:true};};
  const media=new MediaCache(); const adapter=new DouyinAdapter({accountId:'',dataDir,media},{createClient:async()=>client});
  adapter.isOnline=()=>true;adapter.getSelf=async()=>({id:'10000',nickname:'self'});
  const runtime=new Runtime({dataDir:join(dataDir,'runtime'),accounts:[{id:'test',adapter}]}); await runtime.start();
  const server=await startServer(runtime,{host:'127.0.0.1',port:0,token:'ui',onebotToken:'bot',heartbeatInterval:0,media}); media.setBaseUrl(`http://127.0.0.1:${server.port}`);
  const sdk=new DyTranObClient({baseUrl:`http://127.0.0.1:${server.port}`,token:'bot',reconnect:false});
  t.after(async()=>{sdk.close();await server.close();await runtime.stop();});
  const resolved=await sdk.callWs<{id:number}>('dy_resolve_id',{kind:'user',native_id:'10001'});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZsAAAAASUVORK5CYII=','base64');
  const image={type:'image',data:{file:`base64://${png.toString('base64')}`}};
  const result=await sdk.callWs<{message_id:number;message_ids:number[]}>('send_private_msg',{user_id:resolved.id,message:[{type:'text',data:{text:'给你找到这张图'}},image,image]});
  assert.equal(payloads.length,3);assert.deepEqual(payloads[0],[{type:'text',text:'给你找到这张图'}]);assert.deepEqual((payloads[1] as {data:Uint8Array}).data,png);
  assert.equal(result.message_ids.length,3);assert.equal(result.message_id,result.message_ids[2]);
  for(const id of result.message_ids){const cached=await sdk.callWs<{message:unknown[]}>('get_msg',{message_id:id});assert.ok(!JSON.stringify(cached).includes('base64://'));}
  const imageEvent=runtime.recentEvents().at(-1)!;const url=(imageEvent.message as Array<{data:{url:string}}>)[0]!.data.url;assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()),png);
  await sdk.callWs('delete_msg',{message_id:result.message_id});assert.deepEqual(recalls,['303']);
  const quote=await sdk.callWs<{message_ids:number[]}>('send_private_msg',{user_id:resolved.id,message:[{type:'reply',data:{id:result.message_ids[0]}},image]});
  assert.equal(quote.message_ids.length,2);assert.equal((payloads[3] as {type:string}).type,'reply');assert.equal((payloads[3] as {text:string}).text,'[图片]');
  const before=payloads.length;await assert.rejects(sdk.callWs('send_private_msg',{user_id:resolved.id,message:[{type:'text',data:{text:'不应先发送'}}, {type:'video',data:{file:'https://example.test/video.mp4'}},image]}));assert.equal(payloads.length,before);
  rejectAt=before+2;
  await assert.rejects(sdk.callWs('send_private_msg',{user_id:resolved.id,message:[{type:'text',data:{text:'部分已发送'}},image,{type:'text',data:{text:'不应发送尾部'}}]}),(error:unknown)=>error instanceof ActionError && error.retcode===1500 && /Partial delivery: 1/.test(error.message) && /message_ids=/.test(error.message));
  assert.equal(payloads.length,before+2);assert.equal((runtime.recentEvents().at(-1)!.message as Array<{data:{text:string}}>)[0]?.data.text,'部分已发送');
});

test('private encrypted image and sticker events are resolved in order before publication', async t => {
  const { account, client, dataDir } = await fixture(t);
  account.login = async () => {}; account.logout = async () => {};
  Object.defineProperty(account, 'uid', { value: '10000' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZsAAAAASUVORK5CYII=', 'base64');
  const key = randomBytes(32); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([iv,cipher.update(png),cipher.final(),cipher.getAuthTag()]);
  const cache = new MediaCache({ fetcher: async url => new Response(String(url).includes('encrypted') ? encrypted : png) }); cache.setBaseUrl('http://127.0.0.1:5088');
  const adapter = new DouyinAdapter({accountId:'',dataDir,media:cache},{createClient:async()=>client}); await adapter.connect(); t.after(()=>adapter.disconnect());
  const received: NativeEvent[] = []; const done = new Promise<void>(resolve=>adapter.on('event',(event: NativeEvent)=>{if(event.type==='message'){ received.push(event); if(received.length===2)resolve(); }}));
  account.emit('message',MessageEvent.fromInbound(inbound({threadId:'0:1:10000:10001',conversationType:1,senderUid:'10001',messageType:27,serverMessageId:'123',rawContent:JSON.stringify({aweType:2702,resource_url:{oid:'a',skey:key.toString('hex'),origin_url_list:['https://p3.douyinpic.com/encrypted.image']}})}),account));
  account.emit('message',MessageEvent.fromInbound(inbound({threadId:'0:1:10000:10001',conversationType:1,senderUid:'10001',messageType:5,serverMessageId:'124',rawContent:JSON.stringify({aweType:507,url:{uri:'opaque-sticker',url_list:['https://p3.douyinpic.com/sticker.png']}})}),account));
  await Promise.race([done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Media events timed out')),2000);timer.unref();})]);
  for (const [index,event] of received.entries()) { assert.equal(event.type,'message'); if(event.type!=='message')continue; assert.equal(event.message.id,String(123+index));assert.equal(event.message.groupId,undefined);const segment=event.message.segments[0]!;assert.equal(segment.type,'image');assert.match(segment.url!,/^http:\/\/127\.0\.0\.1:5088\/media\//);assert.deepEqual(cache.get(segment.url!.split('/').at(-1)!)?.bytes,png); }
});

test('QR login begins in the background and never exposes the upstream polling token', async t => {
  const { account, client, dataDir } = await fixture(t);
  let resolveLogin!: () => void;
  const pending = new Promise<void>(resolve => { resolveLogin = resolve; });
  let loginCalls = 0;
  let continuationCalls = 0;
  account.login = () => { loginCalls++; return pending; };
  account.continueLogin = async () => { continuationCalls++; };
  account.logout = async () => { resolveLogin(); };
  const adapter = new DouyinAdapter({ accountId: '', dataDir }, { createClient: async () => client });
  await adapter.connect();
  await adapter.connect();
  assert.equal(loginCalls, 1);
  account.emit('system.login.qrcode', { token: 'secret-poll-token', qrcodeBase64: 'aW1hZ2U=', expireTime: 123, qrcodeIndexUrl: 'https://example.test/qr' });
  assert.equal(continuationCalls, 1);
  const state = await adapter.getLoginState();
  assert.equal(state.qrcodeBase64, 'aW1hZ2U=');
  assert.equal(state.expireTime, 123);
  assert.equal(JSON.stringify(state).includes('secret-poll-token'), false);
  await adapter.disconnect();
  assert.equal((await adapter.getLoginState()).state, 'offline');
});

test('failed background login is handled without leaking credential-like errors', async t => {
  const { account, client, dataDir } = await fixture(t);
  account.login = async () => { throw new Error('sessionid=secret-cookie'); };
  account.logout = async () => {};
  const adapter = new DouyinAdapter({ accountId: '', dataDir }, { createClient: async () => client });
  await adapter.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await adapter.getLoginState()).state, 'error');
  assert.equal(JSON.stringify(await adapter.getLoginState()).includes('secret-cookie'), false);
  await adapter.disconnect();
});

test('disconnect cancels a connect while the SDK factory is still initializing', async t => {
  const { account, client, dataDir } = await fixture(t);
  let release!: (value: typeof client) => void;
  let loginCalls = 0;
  account.login = async () => { loginCalls++; };
  account.logout = async () => {};
  const pending = new Promise<typeof client>(resolve => { release = resolve; });
  const adapter = new DouyinAdapter({ accountId: '', dataDir }, { createClient: () => pending });
  const connecting = adapter.connect();
  const stopping = adapter.disconnect();
  release(client);
  await Promise.all([connecting, stopping]);
  assert.equal(loginCalls, 0);
  assert.equal((await adapter.getLoginState()).state, 'offline');
});

test('unsupported upstream operations fail explicitly before any network call', async () => {
  const adapter = new DouyinAdapter({ accountId: '', dataDir: './unused' });
  await assert.rejects(adapter.setGroupName('1', 'new'), (error: unknown) => error instanceof UnsupportedAdapterOperation && error.code === 'UNSUPPORTED_OPERATION');
  await assert.rejects(adapter.deleteMessage('unknown'), UnsupportedAdapterOperation);
});

test('outgoing SDK bridge rejects partial/mixed sends and platform rejection', async t => {
  const { account, client, dataDir } = await fixture(t);
  account.login = async () => {};
  account.logout = async () => {};
  const event = MessageEvent.fromInbound(inbound({ threadId: '0:1:10000:10001', conversationType: 1, senderUid: '10001' }), account);
  assert.ok(event instanceof PrivateMessageEvent);
  const friend = event.friend;
  account.pickFriend = () => friend;
  let sends = 0;
  const payloads: unknown[] = [];
  friend.sendMsg = async payload => { sends++; payloads.push(payload); return { statusCode: 0, statusMsg: '', serverMessageId: '9223372036854775807' }; };
  const adapter = new DouyinAdapter({ accountId: '', dataDir }, { createClient: async () => client });
  await adapter.connect();
  adapter.isOnline = () => true;
  adapter.getSelf = async () => ({ id: '10000', nickname: 'self' });
  Object.defineProperty(account, 'uid', { value: '10000' });
  await assert.rejects(adapter.sendMessage({ userId: '10001' }, [{ type: 'text', text: 'first' }, { type: 'image', url: 'https://example.test/image.png' }]), UnsupportedAdapterOperation);
  await assert.rejects(adapter.sendMessage({ userId: '10001' }, [{ type: 'image', url: 'file:///C:/sensitive.txt' }]), UnsupportedAdapterOperation);
  assert.equal(sends, 0);
  const sent = await adapter.sendMessage({ userId: '10001' }, [{ type: 'text', text: 'hello' }]);
  assert.equal(sent.id, '9223372036854775807');
  account.emit('message', MessageEvent.fromInbound(inbound({ threadId: '0:1:10000:10001', conversationType: 1, senderUid: '10000', serverMessageId: sent.id }), account));
  await adapter.sendMessage({ userId: '10001' }, [{ type: 'reply', messageId: sent.id }, { type: 'text', text: 'reply' }]);
  assert.deepEqual(payloads[1], { type: 'reply', text: 'reply', referencedMessageId: sent.id, referencedMessageType: 7, referencedUid: '10000', referencedText: 'hello' });
  friend.sendMsg = async () => ({ statusCode: 0, statusMsg: '', checkCode: 123, serverMessageId: '999' });
  await assert.rejects(adapter.sendMessage({ userId: '10001' }, [{ type: 'text', text: 'rejected' }]), /rejected/);
  await adapter.disconnect();
});

test('offline demo can send, inject and recall with isolated state and no outgoing echo', async () => {
  const adapter = new MockAdapter();
  const events: NativeEvent[] = [];
  adapter.on('event', event => events.push(event));
  await adapter.connect();
  const segments = [{ type: 'text' as const, text: 'hello' }];
  const sent = await adapter.sendMessage({ groupId: '20001' }, segments);
  segments[0]!.text = 'modified';
  assert.equal(sent.segments[0]?.text, 'hello');
  assert.equal(events.filter(event => event.type === 'message').length, 0);
  const incoming = { id: '9223372036854775807', userId: '10001', time: 1700000000, segments: [{ type: 'text' as const, text: 'fixture' }] };
  adapter.injectMessage(incoming);
  incoming.segments[0]!.text = 'changed';
  const messageEvent = events.find(event => event.type === 'message');
  assert.equal(messageEvent?.type === 'message' ? messageEvent.message.segments[0]?.text : '', 'fixture');
  await adapter.deleteMessage(sent.id);
  assert.ok(events.some(event => event.type === 'notice' && event.notice === 'message_recall'));
  const friends = await adapter.getFriends();
  friends[0]!.nickname = 'changed';
  assert.equal((await adapter.getFriends())[0]?.nickname, '演示好友');
  await adapter.kickGroupMember('20001', '10002');
  assert.equal((await adapter.getGroupMembers('20001')).length, 2);
  await adapter.disconnect();
  await assert.rejects(adapter.sendMessage({ userId: '10001' }, segments), /offline/);
});
