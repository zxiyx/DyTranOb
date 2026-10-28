import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { Runtime } from '../src/runtime.js';
import { startServer } from '../src/server.js';
import { AccountManager, loadAccounts, type AccountConfig } from '../src/accounts.js';
import { MockAdapter } from '../src/adapters/mock.js';

/** Logs in only when told to, like a Douyin session that is still restoring. */
class DelayedMock extends MockAdapter {
  private release?: () => void;
  async connect(): Promise<void> { this.release = () => { void super.connect(); }; }
  goOnline(): void { this.release?.(); }
}

function nextMessage(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('Message timed out')); }, 3000);
    const listener = (data: unknown) => {
      const value = JSON.parse(String(data)) as Record<string, unknown>;
      if (predicate(value)) { clearTimeout(timer); socket.off('message', listener); resolve(value); }
    };
    socket.on('message', listener);
  });
}

async function receiver(t: { after(fn: () => unknown): void }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()); }));
  const address = server.address();
  assert(address && typeof address === 'object');
  const handshakes: Array<{ socket: WebSocket; request: IncomingMessage }> = [];
  const waiters: Array<() => void> = [];
  server.on('connection', (socket, request) => { handshakes.push({ socket, request }); waiters.splice(0).forEach(fn => fn()); });
  const connection = async (index: number) => {
    while (handshakes.length <= index) await new Promise<void>(resolve => waiters.push(resolve));
    return handshakes[index]!;
  };
  return { url: `ws://127.0.0.1:${address.port}/ws`, handshakes, connection };
}

test('reverse WebSocket waits for login, then announces the real self_id and replies through that account', async t => {
  const bot = await receiver(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-accounts-reverse-'));
  const adapter = new DelayedMock({ accountId: '10000' });
  const runtime = new Runtime({ dataDir, accounts: [{ id: 'main', adapter }] });
  await runtime.start();
  const service = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 0, listen: false, reverseWsUrls: [bot.url] });
  t.after(async () => { await service.close(); await runtime.stop(); await rm(dataDir, { recursive: true, force: true }); });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(bot.handshakes.length, 0, 'no connection may be announced as self_id 0');
  adapter.goOnline();
  const { socket, request } = await bot.connection(0);
  const selfId = Number(request.headers['x-self-id']);
  assert(selfId > 0);
  const lifecycle = await nextMessage(socket, value => value.meta_event_type === 'lifecycle');
  assert.equal(lifecycle.self_id, selfId);
  const incoming = nextMessage(socket, value => value.post_type === 'message');
  adapter.injectMessage({ id: 'm1', userId: '10001', time: Math.floor(Date.now() / 1000), segments: [{ type: 'text', text: 'ping' }] });
  const message = await incoming;
  assert.equal(message.self_id, selfId);
  const reply = nextMessage(socket, value => value.echo === 'reply');
  socket.send(JSON.stringify({ action: 'send_msg', params: { message_type: 'private', user_id: message.user_id, message: 'pong' }, echo: 'reply' }));
  assert.equal((await reply).status, 'ok');
});

test('each account gets its own reverse connection; accounts can be added and removed at runtime', async t => {
  const bot = await receiver(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-accounts-manage-'));
  const createAdapter = (account: AccountConfig) => new MockAdapter({ accountId: account.id === 'main' ? '10000' : '20000' });
  const initial: AccountConfig[] = [{ id: 'main', type: 'mock' }];
  const runtime = new Runtime({ dataDir, accounts: initial.map(account => ({ id: account.id, adapter: createAdapter(account) })) });
  const accounts = new AccountManager(runtime, { dataDir, accounts: initial, createAdapter });
  await runtime.start();
  const service = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 0, accounts, reverseWsUrls: [bot.url] });
  t.after(async () => { await service.close(); await runtime.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.port}`;
  const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
  const first = await bot.connection(0);

  const created = await fetch(`${base}/api/accounts`, { method: 'POST', headers, body: JSON.stringify({ id: 'second', type: 'mock' }) });
  assert.equal(created.status, 201);
  assert.equal((await fetch(`${base}/api/accounts`, { method: 'POST', headers, body: JSON.stringify({ id: 'second', type: 'mock' }) })).status, 409);
  assert.equal((await fetch(`${base}/api/accounts`, { method: 'POST', headers, body: JSON.stringify({ id: 'bad id' }) })).status, 400);
  const second = await bot.connection(1);
  assert.notEqual(second.request.headers['x-self-id'], first.request.headers['x-self-id']);
  assert.deepEqual(loadAccounts(dataDir, []), [{ id: 'main', type: 'mock' }, { id: 'second', type: 'mock' }]);

  // An action without a selector on the second socket is routed to the second account.
  const login = nextMessage(second.socket, value => value.echo === 'who');
  second.socket.send(JSON.stringify({ action: 'get_login_info', echo: 'who' }));
  assert.equal((await login as { data: { user_id: number } }).data.user_id, Number(second.request.headers['x-self-id']));

  const closed = new Promise(resolve => second.socket.once('close', resolve));
  assert.equal((await fetch(`${base}/api/accounts/second`, { method: 'DELETE', headers })).status, 200);
  await closed;
  assert.deepEqual((await (await fetch(`${base}/api/accounts`, { headers })).json() as { data: Array<{ id: string }> }).data.map(account => account.id), ['main']);
  assert.equal((await fetch(`${base}/api/accounts/main`, { method: 'DELETE', headers })).status, 400, 'the last account cannot be removed');
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')), { accounts: [{ id: 'main', type: 'mock' }] });
  assert.equal(first.socket.readyState, WebSocket.OPEN);
});
