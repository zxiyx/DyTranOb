import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Runtime } from '../src/runtime.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { UnsupportedAdapterOperation } from '../src/adapters/types.js';
import { RuntimeStore } from '../src/store.js';
import { parseMessage, toCQ } from '../src/messages.js';
import { parseConfig } from '../src/config.js';

function directory(): string { return mkdtempSync(join(tmpdir(), 'dytranob-test-')); }
function cleanup(dir: string): void {
  if (!resolve(dir).startsWith(resolve(tmpdir(), 'dytranob-test-'))) throw new Error('Invalid test cleanup target');
  rmSync(dir, { recursive: true, force: true });
}
const tick = () => new Promise<void>(done => setImmediate(done));

test('native IDs keep exact precision, persist across restart and enforce account/type isolation', () => {
  const dir = directory();
  try {
    const first = new RuntimeStore(dir);
    const native = '7923372036854775807987';
    const user = first.id('a', 'user', native);
    const group = first.id('a', 'group', native);
    const other = first.id('b', 'user', native);
    assert.equal(new Set([user, group, other]).size, 3);
    assert.equal(first.native('a', 'user', user), native);
    assert.throws(() => first.native('b', 'user', user), /Unknown/);
    assert.throws(() => first.native('a', 'group', user), /Unknown/);
    assert.throws(() => new RuntimeStore(dir), /already in use/);
    first.close();
    const second = new RuntimeStore(dir);
    assert.equal(second.id('a', 'user', native), user);
    assert.equal(second.native('a', 'user', user), native);
    second.close();
  } finally { cleanup(dir); }
});

test('corrupt stores fail without resetting ID assignments or overwriting the original', () => {
  const dir = directory();
  try {
    const path = join(dir, 'onebot-store.json');
    writeFileSync(path, '{broken');
    assert.throws(() => new RuntimeStore(dir));
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  } finally { cleanup(dir); }
});

test('failed persistence rolls ID allocation back before an alias can leave the process', () => {
  const dir = directory();
  const store = new RuntimeStore(dir);
  try {
    const blocker = join(dir, 'onebot-store.json.tmp');
    mkdirSync(blocker);
    assert.throws(() => store.id('main', 'user', 'A'));
    rmdirSync(blocker);
    const id = store.id('main', 'user', 'A');
    store.close();
    const restored = new RuntimeStore(dir);
    assert.equal(restored.native('main', 'user', id), 'A');
    assert.notEqual(restored.id('main', 'user', 'B'), id);
    restored.close();
  } finally { store.close(); cleanup(dir); }
});

test('CQ conversion preserves escaped text and values, rejects unsupported segments', () => {
  const segments = parseMessage('a&amp;b&#91;x&#93;[CQ:at,qq=123][CQ:image,file=https://x.test/a&#44;b]');
  assert.equal(segments[0]!.data.text, 'a&b[x]');
  assert.equal(segments[2]!.data.file, 'https://x.test/a,b');
  assert.deepEqual(parseMessage(toCQ(segments)), segments);
  assert.deepEqual(parseMessage('[CQ:at,qq=all]', true), [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
  assert.equal(parseMessage('a&#44;b')[0]!.data.text, 'a&#44;b');
  assert.throws(() => parseMessage('[CQ:face,id=1]'), /Unsupported/);
  assert.throws(() => parseMessage([{ type: 'text', data: null }]), /Invalid/);
  assert.throws(() => parseMessage(''), /empty/);
});

test('messages, request/notice conversion, deduplication, echo and cache survive runtime restart', async () => {
  const dir = directory();
  const adapter = new MockAdapter({ accountId: 'self-long-native' });
  let runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'main', adapter }] });
  try {
    await runtime.start();
    const nativeMessage = { id: '9223372036854775807123', userId: 'user-long-native', time: 1700000000, segments: [{ type: 'text' as const, text: 'hello <world>' }] };
    adapter.injectMessage(nativeMessage);
    adapter.injectMessage(nativeMessage);
    await tick();
    const events = runtime.recentEvents().filter(e => e.post_type === 'message');
    assert.equal(events.length, 1);
    assert.deepEqual(runtime.recentEvents(0), []);
    const event = events[0]!;
    assert.equal(event.time, 1700000000);
    assert.deepEqual(event.dy, { message_id: nativeMessage.id, user_id: nativeMessage.userId });
    assert.equal(typeof event.message_id, 'number');
    const response = await runtime.execute({ action: 'get_msg', params: { message_id: event.message_id }, echo: { nested: ['yes'] } });
    assert.equal(response.status, 'ok');
    assert.deepEqual(response.echo, { nested: ['yes'] });
    adapter.emit('event', { type: 'request', request: 'friend', flag: 'req-1', userId: 'user-long-native', comment: 'hi' });
    adapter.emit('event', { type: 'notice', notice: 'message_recall', userId: 'user-long-native', messageId: nativeMessage.id });
    await tick();
    assert(runtime.recentEvents().some(e => e.post_type === 'request' && e.flag === 'req-1'));
    assert(runtime.recentEvents().some(e => e.notice_type === 'friend_recall' && e.message_id === event.message_id));
    await runtime.stop();
    runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'main', adapter: new MockAdapter({ accountId: 'self-long-native' }) }] });
    await runtime.start();
    const restored = await runtime.execute({ action: 'get_msg', params: { message_id: event.message_id } });
    assert.deepEqual(restored.data, response.data);
    await runtime.stop();
    const offline = new MockAdapter({ accountId: 'self-long-native' });
    runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'main', adapter: offline }] });
    await runtime.start(); await offline.disconnect();
    assert.equal((await runtime.execute({ action: 'get_msg', params: { message_id: event.message_id } })).retcode, 0);
  } finally { await runtime.stop(); cleanup(dir); }
});

test('shutdown waits for an accepted send acknowledgement before closing storage', async () => {
  const dir = directory();
  let release!: () => void;
  let sent!: () => void;
  const sentSignal = new Promise<void>(resolve => { sent = resolve; });
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  class SlowAdapter extends MockAdapter {
    override async sendMessage(...args: Parameters<MockAdapter['sendMessage']>) {
      const result = await super.sendMessage(...args);
      sent(); await acknowledgement; return result;
    }
  }
  const runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'main', adapter: new SlowAdapter() }] });
  try {
    await runtime.start();
    const friends = (await runtime.execute({ action: 'get_friend_list' })).data as Array<{ user_id: number }>;
    const sending = runtime.execute({ action: 'send_private_msg', params: { user_id: friends[0]!.user_id, message: 'once' } });
    await sentSignal;
    let closed = false;
    const stopping = runtime.stop().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.equal((await runtime.execute({ action: 'get_friend_list' })).retcode, 1500);
    release();
    const result = await sending;
    assert.equal(result.retcode, 0);
    await stopping;
    const store = new RuntimeStore(dir);
    assert.equal(store.message('main', (result.data as { message_id: number }).message_id).raw_message, 'once');
    store.close();
  } finally { release(); await runtime.stop(); cleanup(dir); }
});

test('one dispatcher sends and caches messages, rejects dangerous media paths and preserves failure echo', async () => {
  const dir = directory();
  const runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'main', adapter: new MockAdapter() }] });
  try {
    await runtime.start();
    const friends = (await runtime.execute({ action: 'get_friend_list' })).data as Array<{ user_id: number }>;
    const user_id = friends[0]!.user_id;
    const send = await runtime.execute({ action: 'send_private_msg', params: { user_id, message: '你好 &amp; welcome' } });
    assert.equal(send.retcode, 0);
    const { message_id } = send.data as { message_id: number };
    const message = (await runtime.execute({ action: 'get_msg', params: { message_id } })).data as { message: unknown };
    assert.deepEqual(message.message, [{ type: 'text', data: { text: '你好 & welcome' } }]);
    assert(runtime.recentEvents().some(e => e.post_type === 'message_sent'));
    const bad = await runtime.execute({ action: 'send_private_msg', params: { user_id, message: [{ type: 'image', data: { file: 'file:///etc/passwd' } }] }, echo: 0 });
    assert.equal(bad.retcode, 1400); assert.equal(bad.echo, 0);
    assert.equal((await runtime.execute({ action: 'set_group_ban', echo: null })).retcode, 1404);
    assert.equal((await runtime.execute({ action: 'delete_msg', params: { message_id } })).retcode, 0);
  } finally { await runtime.stop(); cleanup(dir); }
});

test('multi-account routing refuses ambiguity, cross-account IDs and conflicting selectors', async () => {
  const dir = directory();
  const runtime = new Runtime({ dataDir: dir, accounts: ['a', 'b'].map(id => ({ id, adapter: new MockAdapter({ accountId: id }) })) });
  try {
    await runtime.start();
    assert.equal((await runtime.execute({ action: 'get_friend_list' })).retcode, 1400);
    const accounts = runtime.accounts();
    assert.notEqual(accounts[0]!.self_id, accounts[1]!.self_id);
    const friends = (await runtime.execute({ action: 'get_friend_list', account_id: 'a' })).data as Array<{ user_id: number }>;
    assert.equal((await runtime.execute({ action: 'send_private_msg', account_id: 'b', params: { user_id: friends[0]!.user_id, message: 'hi' } })).retcode, 1404);
    assert.equal((await runtime.execute({ action: 'get_login_info', account_id: 'a', self_id: accounts[1]!.self_id })).retcode, 1400);
    assert.equal((await runtime.execute({ action: 'get_login_info', self_id: accounts[1]!.self_id })).retcode, 0);
  } finally { await runtime.stop(); cleanup(dir); }
});

test('unsupported native operations are explicit; unexpected errors never leak credentials', async () => {
  const dir = directory();
  class FailingAdapter extends MockAdapter {
    override async getFriends(): Promise<never> { throw new Error('cookie=sessionid=secret; token=secret password=secret'); }
    override async setGroupName(): Promise<never> { throw new UnsupportedAdapterOperation('Native group rename is unsupported'); }
  }
  const runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'main', adapter: new FailingAdapter() }] });
  try {
    await runtime.start();
    const response = await runtime.execute({ action: 'get_friend_list' });
    assert.equal(response.retcode, 1500); assert(!JSON.stringify(response).includes('secret'));
    const groups = (await runtime.execute({ action: 'get_group_list' })).data as Array<{ group_id: number }>;
    const rename = await runtime.execute({ action: 'set_group_name', params: { group_id: groups[0]!.group_id, group_name: 'new' } });
    assert.equal(rename.retcode, 1404); assert.match(rename.message!, /unsupported/);
  } finally { await runtime.stop(); cleanup(dir); }
});

test('configuration validates duplicates, URL schemes and relative data paths', () => {
  assert.equal(parseConfig({ dataDir: 'state' }, resolve('.artifacts')).dataDir, resolve('.artifacts/state'));
  assert.throws(() => parseConfig({ accounts: [{ id: 'a' }, { id: 'a' }] }), /unique/);
  assert.throws(() => parseConfig({ accounts: [{ id: '../outside' }] }));
  assert.throws(() => parseConfig({ reverseWsUrls: ['https://wrong.test'] }));
  assert.throws(() => parseConfig({ unexpected: true }));
});
