import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { Runtime } from '../src/runtime.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { ConnectionManager } from '../src/connections.js';
import type { ActionResponse } from '../src/types.js';

// The native adapter's unsupported operations remain unsupported; this fixture
// exercises transport dispatch for every catalog entry without a real account.
class ActionFixture extends MockAdapter {
  override async handleRequest(): Promise<void> {}
}

test('AstrBot-style reverse WS round-trips all 25 actions using only its independent token', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dytranob-astrbot-'));
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => receiver.once('listening', resolve));
  const address = receiver.address();
  assert(address && typeof address === 'object');
  const runtime = new Runtime({ dataDir: dir, accounts: [{ id: '001', adapter: new ActionFixture({ accountId: '001' }) }] });
  const manager = new ConnectionManager(runtime, { dataDir: dir, token: 'webui-must-not-be-sent' });
  t.after(async () => {
    await manager.close(); await runtime.stop();
    for (const socket of receiver.clients) socket.terminate();
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await runtime.start(); await manager.start();
  const incoming = new Promise<WebSocket>(resolve => receiver.once('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer astrbot-fixed-token');
    assert.equal(request.headers['x-client-role'], 'Universal');
    assert.equal(request.headers['x-self-id'], String(runtime.accounts()[0]!.self_id));
    resolve(socket);
  }));
  await manager.create({ name: 'AstrBot', type: 'ws_reverse', url: `ws://127.0.0.1:${address.port}/ws`, token: 'astrbot-fixed-token', heartbeatInterval: 0 });
  const socket = await incoming;
  const called = new Set<string>();
  let sequence = 0;
  const call = <T>(action: string, params: Record<string, unknown> = {}): Promise<T> => new Promise((resolve, reject) => {
    const echo = { request: ++sequence };
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error(`No response for ${action}`)); }, 3000);
    const listener = (raw: unknown) => {
      const response = JSON.parse(String(raw)) as ActionResponse<T>;
      if (JSON.stringify(response.echo) !== JSON.stringify(echo)) return;
      clearTimeout(timer); socket.off('message', listener);
      called.add(action);
      if (response.retcode !== 0) { reject(new Error(`${action}: ${response.retcode} ${response.message}`)); return; }
      resolve(response.data as T);
    };
    socket.on('message', listener);
    socket.send(JSON.stringify({ action, params, echo }));
  });
  const friends = await call<Array<{ user_id: number }>>('get_friend_list');
  const groups = await call<Array<{ group_id: number }>>('get_group_list');
  const user_id = friends[0]!.user_id;
  const group_id = groups[0]!.group_id;
  for (const action of ['get_version_info', 'get_status', 'get_login_info', 'can_send_image', 'can_send_record', 'dy_list_accounts', 'dy_get_capabilities']) await call(action);
  await call('get_group_info', { group_id });
  await call('get_group_member_list', { group_id });
  await call('get_group_member_info', { group_id, user_id });
  await call('get_stranger_info', { user_id });
  const sent = await call<{ message_id: number }>('send_private_msg', { user_id, message: [{ type: 'text', data: { text: 'AstrBot 回复测试' } }] });
  const cached = await call<{ raw_message: string }>('get_msg', { message_id: sent.message_id });
  assert.equal(cached.raw_message, 'AstrBot 回复测试');
  await call('send_group_msg', { group_id, message: '群聊测试' });
  await call('send_msg', { user_id, message_type: 'private', message: '通用发送' });
  const mapped = await call<{ id: number }>('dy_resolve_id', { kind: 'user', native_id: '9223372036854775807123' });
  assert.deepEqual(await call('dy_get_native_id', { kind: 'user', id: mapped.id }), { native_id: '9223372036854775807123' });
  await call('delete_msg', { message_id: sent.message_id });
  await call('set_group_name', { group_id, group_name: '测试群' });
  await call('set_group_kick', { group_id, user_id });
  await call('set_group_leave', { group_id });
  await call('set_friend_add_request', { flag: 'fixture', approve: true });
  await call('set_group_add_request', { flag: 'fixture', sub_type: 'add', approve: true });
  assert.equal(called.size, 25);
  assert.ok([...called].every(name => runtime.actions().some(action => action.action === name)));
  assert.equal(runtime.actions().length, 45);
});
