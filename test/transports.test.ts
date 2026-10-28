import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { startServer } from '../src/server.js';
import type { Runtime } from '../src/runtime.js';
import { ActionFault, type ActionRequest, type ActionResponse, type OneBotEvent } from '../src/types.js';

class FakeRuntime extends EventEmitter {
  accounts() { return [{ id: 'main', kind: 'mock', online: true, self_id: 42 }]; }
  actions() { return [{ action: 'get_login_info', description: 'test', params: {} }]; }
  recentEvents() { return []; }
  async startQrLogin(id: string) { return { account_id: id, state: 'waiting' }; }
  async loginState(id: string) { return { account_id: id, state: 'online' }; }
  async execute(request: ActionRequest): Promise<ActionResponse> {
    return { status: 'ok', retcode: 0, data: { action: request.action, params: request.params, user_id: 42 }, echo: request.echo };
  }
}
function waitMessage(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('Message timed out')); }, 3000);
    const listener = (data: unknown) => {
      const value = JSON.parse(String(data)) as Record<string, unknown>;
      if (predicate(value)) { clearTimeout(timer); socket.off('message', listener); resolve(value); }
    };
    socket.on('message', listener);
  });
}

test('WebUI management and standard HTTP/WS actions use independent tokens', async t => {
  const runtime = new FakeRuntime();
  for (const botToken of ['', 'bot-only']) {
    const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'webui-only', onebotToken: botToken, heartbeatInterval: 0 });
    t.after(() => service.close());
    const base = `http://127.0.0.1:${service.port}`;
    const auth = (token: string): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {};
    for (const path of ['/api/auth', '/api/status', '/api/actions', '/api/events', '/api/connections', '/api/accounts', '/api/accounts/main/login', '/api/action', '/events']) {
      assert.equal((await fetch(base + path, { headers: auth(botToken) })).status, 401, path);
    }
    assert.equal((await fetch(base + '/api/status', { headers: auth('webui-only') })).status, 200);
    assert.equal((await fetch(base + '/get_login_info', { headers: auth(botToken) })).status, 200);
    if (botToken) {
      assert.equal((await fetch(base + '/get_login_info', { headers: auth('webui-only') })).status, 401);
      assert.equal((await fetch(base + '/get_login_info')).status, 401);
    }
    const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws/api`, { headers: auth(botToken) });
    t.after(() => socket.terminate());
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const response = waitMessage(socket, value => value.echo === 'separate-auth');
    socket.send(JSON.stringify({ action: 'get_login_info', echo: 'separate-auth' }));
    assert.equal((await response).retcode, 0);
    socket.terminate();
    await service.close();
  }
});

test('HTTP transport authenticates, validates requests, preserves echo and restricts origins', async t => {
  const runtime = new FakeRuntime();
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'test-secret', heartbeatInterval: 0 });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.port}`;
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  const unauthorized = await fetch(`${base}/api/status`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json() as ActionResponse).retcode, 1401);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
  const action = await fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify({ action: 'get_login_info', echo: { id: 1 } }) });
  assert.deepEqual((await action.json() as ActionResponse).echo, { id: 1 });
  const shorthand = await fetch(`${base}/send_private_msg`, { method: 'POST', headers, body: JSON.stringify({ user_id: 77, message: 'hi', echo: 'shorthand' }) });
  const value = await shorthand.json() as ActionResponse<{ params: unknown }>;
  assert.equal(value.echo, 'shorthand');
  assert.deepEqual(value.data?.params, { user_id: 77, message: 'hi' });
  assert.equal((await fetch(`${base}/get_login_info?access_token=test-secret`)).status, 200);
  const query = await (await fetch(`${base}/send_private_msg?access_token=test-secret&account_id=123&user_id=77&message=123`)).json() as ActionResponse<{ params: unknown }>;
  assert.deepEqual(query.data?.params, { user_id: 77, message: '123' });
  assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers, body: '"invalid"' })).status, 400);
  assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers, body: 'x'.repeat(24 * 1024 * 1024 + 1) })).status, 413);
  const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${base}/api/action`, { method: 'POST', headers }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.write('x'.repeat(24 * 1024 * 1024)); request.end('x');
  });
  assert.equal(chunkedStatus, 413);
  const status = await (await fetch(`${base}/api/status`, { headers })).json() as ActionResponse<{ accounts: unknown[] }>;
  assert.equal(status.data?.accounts.length, 1);
  assert.equal((await (await fetch(`${base}/api/accounts/main/login/qr`, { method: 'POST', headers })).json() as ActionResponse<{ state: string }>).data?.state, 'waiting');
});

test('WebSocket universal, API and event modes follow OneBot echo and lifecycle semantics', async t => {
  const runtime = new FakeRuntime();
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 0 });
  t.after(() => service.close());
  const api = new WebSocket(`ws://127.0.0.1:${service.port}/api/?access_token=secret`);
  t.after(() => api.terminate());
  await new Promise<void>((resolve, reject) => { api.once('open', resolve); api.once('error', reject); });
  const reply = waitMessage(api);
  api.send(JSON.stringify({ action: 'get_login_info', echo: ['correlation', 1] }));
  assert.deepEqual((await reply).echo, ['correlation', 1]);
  const invalid = waitMessage(api);
  api.send('not json');
  assert.equal((await invalid).retcode, 1400);
  const events = new WebSocket(`ws://127.0.0.1:${service.port}/ws/event/`, { headers: { Authorization: 'Bearer secret' } });
  t.after(() => events.terminate());
  const lifecycle = await waitMessage(events);
  assert.equal(lifecycle.meta_event_type, 'lifecycle');
  assert.equal(lifecycle.self_id, 42);
  const incoming = waitMessage(events, value => value.post_type === 'message');
  runtime.emit('event', { time: 1, self_id: 42, post_type: 'message', message: 'hello' } satisfies OneBotEvent);
  assert.equal((await incoming).message, 'hello');
  const forbidden = waitMessage(events);
  events.send(JSON.stringify({ action: 'get_login_info', echo: 'blocked' }));
  assert.equal((await forbidden).retcode, 1404);
  await new Promise<void>((resolve, reject) => {
    const denied = new WebSocket(`ws://127.0.0.1:${service.port}/ws`);
    denied.on('error', () => {});
    denied.once('open', () => reject(new Error('Unauthorized WebSocket connected')));
    denied.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 401); response.resume(); denied.terminate(); resolve(); });
  });
});

test('webhook delivers each event once per URL and signs the exact JSON body', async t => {
  let deliveries = 0;
  let resolveDelivery!: (value: { signature: string | undefined; body: string }) => void;
  const delivered = new Promise<{ signature: string | undefined; body: string }>(resolve => { resolveDelivery = resolve; });
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    deliveries++;
    resolveDelivery({ signature: request.headers['x-signature'] as string | undefined, body: Buffer.concat(chunks).toString() });
    response.writeHead(204); response.end();
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections(); }));
  const address = receiver.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/event`;
  const runtime = new FakeRuntime();
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'webhook-key', heartbeatInterval: 0, webhookUrls: [url, url] });
  t.after(() => service.close());
  runtime.emit('event', { time: 1, self_id: 42, post_type: 'notice' } satisfies OneBotEvent);
  const result = await delivered;
  assert.equal(result.signature, `sha1=${createHmac('sha1', 'webhook-key').update(result.body).digest('hex')}`);
  assert.equal(JSON.parse(result.body).post_type, 'notice');
  assert.equal(deliveries, 1);
});

test('reverse WebSocket sends events, accepts actions and reconnects after disconnect', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => receiver.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => { for (const client of receiver.clients) client.terminate(); receiver.close(() => resolve()); }));
  const address = receiver.address();
  assert(address && typeof address === 'object');
  const connection = new Promise<WebSocket>(resolve => receiver.once('connection', resolve));
  const runtime = new FakeRuntime();
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 0, reverseWsUrls: [`ws://127.0.0.1:${address.port}`] });
  t.after(() => service.close());
  const socket = await connection;
  const lifecycle = await waitMessage(socket);
  assert.equal(lifecycle.meta_event_type, 'lifecycle');
  const result = waitMessage(socket, value => value.echo === 'reverse');
  socket.send(JSON.stringify({ action: 'get_login_info', echo: 'reverse' }));
  assert.equal((await result).status, 'ok');
  const reconnected = new Promise<WebSocket>(resolve => receiver.once('connection', resolve));
  socket.terminate();
  assert.notEqual(await reconnected, socket);
});

test('remote binding requires an explicit opt-in and access token', async () => {
  const runtime = new FakeRuntime() as unknown as Runtime;
  await assert.rejects(startServer(runtime, { host: '0.0.0.0', port: 0, token: '' }), /Remote binding/);
  await assert.rejects(startServer(runtime, { host: '0.0.0.0', port: 0, token: 'token' }), /Remote binding/);
});

test('heartbeat reflects each account and login faults use safe HTTP statuses', async t => {
  const runtime = new FakeRuntime();
  runtime.accounts = () => [
    { id: 'main', kind: 'mock', online: true, self_id: 42 },
    { id: 'offline', kind: 'mock', online: false, self_id: 55 },
  ];
  runtime.startQrLogin = async () => { throw new ActionFault(1404, 'Unknown account_id'); };
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 20 });
  t.after(() => service.close());
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/event/?access_token=secret`);
  t.after(() => socket.terminate());
  const heartbeat = await waitMessage(socket, value => value.meta_event_type === 'heartbeat' && value.self_id === 55);
  assert.deepEqual(heartbeat.status, { online: false, good: false });
  const login = await fetch(`http://127.0.0.1:${service.port}/api/accounts/unknown/login/qr`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
  assert.equal(login.status, 404);
  assert.equal((await login.json() as ActionResponse).retcode, 1404);
  runtime.startQrLogin = async () => { throw new Error('sessionid=secret-credential'); };
  const failed = await fetch(`http://127.0.0.1:${service.port}/api/accounts/main/login/qr`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
  assert.equal(failed.status, 500);
  assert(!(await failed.text()).includes('secret-credential'));
});
