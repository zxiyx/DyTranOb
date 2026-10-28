import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { ConnectionManager } from '../src/connections.js';
import { parseConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import type { Runtime } from '../src/runtime.js';
import type { ActionRequest, ActionResponse } from '../src/types.js';

class FakeRuntime extends EventEmitter {
  accounts() { return [{ id: 'main', kind: 'mock', online: true, self_id: 42 }]; }
  actions() { return []; }
  recentEvents() { return []; }
  async execute(request: ActionRequest): Promise<ActionResponse> { return { status: 'ok', retcode: 0, data: { action: request.action }, echo: request.echo }; }
}
const asRuntime = (runtime: FakeRuntime) => runtime as unknown as Runtime;
const headers = (token = 'console-secret') => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const actionBody = JSON.stringify({ action: 'get_version_info', echo: 'managed' });
function message(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('Message timeout')); }, 3000);
    const listener = (data: unknown) => {
      const value = JSON.parse(String(data)) as Record<string, unknown>;
      if (predicate(value)) { clearTimeout(timer); socket.off('message', listener); resolve(value); }
    };
    socket.on('message', listener);
  });
}

test('management authentication and CRUD create real HTTP profiles without exposing token values', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-api-'));
  const runtime = new FakeRuntime();
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret' });
  await manager.start();
  const consoleServer = await startServer(asRuntime(runtime), { host: '127.0.0.1', port: 0, token: 'console-secret', connections: manager, heartbeatInterval: 0 });
  t.after(async () => { await consoleServer.close(); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${consoleServer.port}`;
  assert.equal((await fetch(`${base}/api/auth`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/auth`, { method: 'POST', headers: headers('wrong') })).status, 401);
  assert.deepEqual((await (await fetch(`${base}/api/auth`, { method: 'POST', headers: headers() })).json() as ActionResponse).data, { authenticated: true });
  assert.equal((await fetch(`${base}/api/connections`, { method: 'POST', headers: { ...headers(), Origin: 'https://other.invalid' }, body: '{}' })).status, 403);
  const createdResponse = await fetch(`${base}/api/connections`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'HTTP integration', type: 'http', host: '127.0.0.1', port: 0, token: 'private-secret', heartbeatInterval: 0 }) });
  assert.equal(createdResponse.status, 201);
  const createdText = await createdResponse.text();
  assert(!createdText.includes('private-secret'));
  assert(!createdText.includes('console-secret'));
  const created = (JSON.parse(createdText) as { data: { id: string; actualPort: number; tokenConfigured: boolean; status: string } }).data;
  assert.equal(created.status, 'running');
  assert.equal(created.tokenConfigured, true);
  const profile = `http://127.0.0.1:${created.actualPort}`;
  assert.equal((await fetch(`${profile}/action`, { method: 'POST', headers: headers(), body: actionBody })).status, 401);
  const executed = await fetch(`${profile}/action`, { method: 'POST', headers: headers('private-secret'), body: actionBody });
  assert.equal((await executed.json() as ActionResponse).echo, 'managed');
  assert.equal((await fetch(`${profile}/`, { headers: headers('private-secret') })).status, 404);
  assert.equal((await fetch(`${profile}/api/connections`, { headers: headers('private-secret') })).status, 404);
  assert.equal((await fetch(`${profile}/api/auth`, { method: 'POST', headers: headers('private-secret') })).status, 404);
  const renamed = await fetch(`${base}/api/connections/${created.id}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ name: 'Renamed' }) });
  assert.equal((await renamed.json() as { data: { actualPort: number } }).data.actualPort, created.actualPort);
  const disabled = await fetch(`${base}/api/connections/${created.id}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ enabled: false }) });
  assert.equal((await disabled.json() as { data: { status: string } }).data.status, 'stopped');
  await assert.rejects(fetch(`${profile}/health`));
  assert.equal((await fetch(`${base}/api/connections/${created.id}`, { method: 'DELETE', headers: headers() })).status, 200);
  assert.deepEqual(manager.list(), { revision: 4, connections: [] });
  assert.equal((await fetch(`${base}/api/connections/missing`, { method: 'DELETE', headers: headers() })).status, 404);
});

test('connection validation rejects unknown keys, malformed destinations and unsafe remote bindings', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-validation-'));
  const manager = new ConnectionManager(asRuntime(new FakeRuntime()), { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  for (const input of [
    { name: 'Bad', type: 'http', extra: true },
    { name: 'Bad', type: 'http', port: 65536 },
    { name: 'Bad', type: 'http', host: '0.0.0.0' },
    { name: 'Bad', type: 'http', token: 'contains spaces' },
    { name: 'Bad', type: 'http', token: '中文' },
    { name: 'Bad', type: 'http_post', url: 'file:///tmp/events' },
    { name: 'Bad', type: 'ws_reverse', url: 'https://localhost/events' },
    { name: 'Bad', type: 'ws_reverse', url: 'ws://user:secret@localhost/events' },
    { name: 'Bad', type: 'http_post', url: 'http://localhost/events?access_token=secret' },
  ]) await assert.rejects(manager.create(input), error => (error as { retcode?: number }).retcode === 1400);
  assert.equal(manager.list().revision, 0);
});

test('profiles persist across restart, override initial config, retain omitted tokens and preserve disabled state', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-save-'));
  const runtime = asRuntime(new FakeRuntime());
  const manager = new ConnectionManager(runtime, { dataDir, token: 'console-secret' });
  await manager.start();
  const first = await manager.create({ id: 'saved', name: 'Saved', type: 'http', port: 0, enabled: false, token: 'private-secret' });
  const renamed = await manager.update(first.id, { name: 'Renamed' });
  assert.equal(renamed.enabled, false);
  assert.equal(renamed.tokenConfigured, true);
  await manager.close();
  const restored = new ConnectionManager(runtime, { dataDir, token: 'console-secret', initial: [{ id: 'ignored', name: 'Ignored', type: 'http', port: 0, enabled: true }] });
  t.after(async () => { await restored.close(); await rm(dataDir, { recursive: true, force: true }); });
  await restored.start();
  assert.equal(restored.list().revision, 2);
  assert.equal(restored.list().connections.length, 1);
  assert.equal(restored.list().connections[0]?.name, 'Renamed');
  const inherited = await restored.update('saved', { token: '', enabled: true });
  assert.equal(inherited.tokenConfigured, false);
  const inheritedResponse = await fetch(`http://127.0.0.1:${inherited.actualPort}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: actionBody });
  assert.equal(inheritedResponse.status, 200);
  assert(!JSON.stringify(restored.list()).includes('secret'));
  assert.equal((JSON.parse(await readFile(join(dataDir, 'connections.json'), 'utf8')) as { revision: number }).revision, 3);
});

test('managed WS profiles stream real events, execute actions and close clients when disabled', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-ws-'));
  const runtime = new FakeRuntime();
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const profile = await manager.create({ name: 'WS', type: 'ws', port: 0, heartbeatInterval: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${profile.actualPort}/ws`, { headers: headers() });
  t.after(() => socket.terminate());
  const lifecycle = await message(socket);
  assert.equal(lifecycle.meta_event_type, 'lifecycle');
  const reply = message(socket, value => value.echo === 'managed');
  socket.send(actionBody);
  assert.equal((await reply).retcode, 0);
  const event = message(socket, value => value.post_type === 'notice');
  runtime.emit('event', { time: 1, self_id: 42, post_type: 'notice' });
  assert.equal((await event).self_id, 42);
  assert.equal((await fetch(`http://127.0.0.1:${profile.actualPort}/api/action`, { method: 'POST', headers: headers(), body: actionBody })).status, 404);
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  await manager.update(profile.id, { enabled: false });
  await closed;
  assert.equal(runtime.listenerCount('event'), 0);
});

test('port conflicts keep a working profile available and startup failures remain editable', async t => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address();
  assert(occupied && typeof occupied === 'object');
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-conflict-'));
  const manager = new ConnectionManager(asRuntime(new FakeRuntime()), { dataDir, token: 'console-secret', initial: [{ id: 'broken', name: 'Broken', type: 'http', enabled: true, port: occupied.port }] });
  await manager.start();
  t.after(async () => { await manager.close(); await new Promise<void>(resolve => blocker.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal(manager.list().connections[0]?.status, 'error');
  assert.match(manager.list().connections[0]?.error ?? '', /already in use/);
  const repaired = await manager.update('broken', { port: 0 });
  assert.equal(repaired.status, 'running');
  await assert.rejects(manager.update('broken', { port: occupied.port }), error => (error as { retcode?: number }).retcode === 1409);
  assert.equal(manager.list().connections[0]?.actualPort, repaired.actualPort);
  assert.equal((await fetch(`http://127.0.0.1:${repaired.actualPort}/health`)).status, 200);
  assert.equal(manager.list().revision, 1);
});

test('failed atomic persistence rolls back a same-port token change and retains old authentication', async t => {
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const address = reserve.address();
  assert(address && typeof address === 'object');
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-rollback-'));
  const runtime = new FakeRuntime();
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const profile = await manager.create({ name: 'Rollback', type: 'http', port: address.port, token: 'old-secret', heartbeatInterval: 0 });
  const path = join(dataDir, 'connections.json');
  await rename(path, `${path}.saved`);
  await mkdir(path);
  await assert.rejects(manager.update(profile.id, { token: 'new-secret' }), error => (error as { retcode?: number }).retcode === 1500);
  const endpoint = `http://127.0.0.1:${address.port}/action`;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: headers('old-secret'), body: actionBody })).status, 200);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: headers('new-secret'), body: actionBody })).status, 401);
  assert.equal(manager.list().revision, 1);
  assert.equal(manager.list().connections[0]?.status, 'running');
  assert.equal(runtime.listenerCount('event'), 1);
});

test('dynamic HTTP post profiles sign events and remove all runtime listeners when disabled', async t => {
  let resolveDelivery!: (value: { signature: string | undefined; body: string }) => void;
  const delivered = new Promise<{ signature: string | undefined; body: string }>(resolve => { resolveDelivery = resolve; });
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    resolveDelivery({ signature: request.headers['x-signature'] as string | undefined, body: Buffer.concat(chunks).toString() });
    response.writeHead(204); response.end();
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  assert(address && typeof address === 'object');
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-post-'));
  const runtime = new FakeRuntime();
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => { await manager.close(); await new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const profile = await manager.create({ name: 'Events', type: 'http_post', url: `http://127.0.0.1:${address.port}/events`, token: 'report-key', heartbeatInterval: 0 });
  assert.equal(profile.actualPort, undefined);
  runtime.emit('event', { time: 1, self_id: 42, post_type: 'notice' });
  const result = await delivered;
  assert.equal(result.signature, `sha1=${createHmac('sha1', 'report-key').update(result.body).digest('hex')}`);
  await manager.update(profile.id, { enabled: false });
  assert.equal(runtime.listenerCount('event'), 0);
});

test('legacy URL lists migrate to deterministic profiles and configuration IDs are stable', () => {
  const input = { heartbeatInterval: 2000, connections: [{ name: 'HTTP', type: 'http', port: 0 }], webhookUrls: ['http://127.0.0.1/events'], reverseWsUrls: ['ws://127.0.0.1/ws'] };
  const first = parseConfig(input);
  assert.deepEqual(first.connections, parseConfig(input).connections);
  assert.deepEqual(first.connections.map(value => value.id), ['connection-1', 'legacy-http-post-1', 'legacy-ws-reverse-1']);
  assert.deepEqual(first.connections.map(value => value.type), ['http', 'http_post', 'ws_reverse']);
  assert.equal(first.connections[1]?.heartbeatInterval, 2000);
  assert.equal(parseConfig({ webhookUrls: ['http://127.0.0.1/events', 'http://127.0.0.1/events'], reverseWsUrls: ['ws://127.0.0.1/ws', 'ws://127.0.0.1/ws'] }).connections.length, 2);
});

test('reverse profiles omit WebUI authorization, execute actions and cancel pending reconnects when disabled', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => receiver.once('listening', resolve));
  const address = receiver.address();
  assert(address && typeof address === 'object');
  let connections = 0;
  const incoming = new Promise<WebSocket>(resolve => receiver.on('connection', (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, undefined);
    resolve(socket);
  }));
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-reverse-'));
  const runtime = new FakeRuntime();
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => {
    await manager.close();
    await new Promise<void>(resolve => { for (const socket of receiver.clients) socket.terminate(); receiver.close(() => resolve()); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const profile = await manager.create({ name: 'Reverse', type: 'ws_reverse', url: `ws://127.0.0.1:${address.port}/`, heartbeatInterval: 0 });
  assert.equal(profile.actualPort, undefined);
  assert.equal(profile.tokenConfigured, false);
  const socket = await incoming;
  const result = message(socket, value => value.echo === 'managed');
  socket.send(actionBody);
  assert.equal((await result).status, 'ok');
  assert.equal(manager.list().connections[0]?.status, 'connected');
  socket.terminate();
  await manager.update(profile.id, { enabled: false });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(connections, 1);
  assert.equal(manager.list().connections[0]?.status, 'stopped');
  assert.equal(runtime.listenerCount('event'), 0);
});

test('simultaneous mutations are serialized and one manager owns each runtime', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-concurrent-'));
  const runtime = asRuntime(new FakeRuntime());
  const manager = new ConnectionManager(runtime, { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const other = new ConnectionManager(runtime, { dataDir, token: 'console-secret' });
  await assert.rejects(other.start(), error => (error as { retcode?: number }).retcode === 1409);
  await Promise.all(Array.from({ length: 6 }, (_, index) => manager.create({ id: `parallel-${index}`, name: `Parallel ${index}`, type: 'http', enabled: false })));
  assert.equal(manager.list().revision, 6);
  const persisted = JSON.parse(await readFile(join(dataDir, 'connections.json'), 'utf8')) as { revision: number; connections: unknown[] };
  assert.equal(persisted.revision, 6);
  assert.equal(persisted.connections.length, 6);
  await assert.rejects(manager.create({ id: 'parallel-0', name: 'Duplicate', type: 'http', enabled: false }), error => (error as { retcode?: number }).retcode === 1409);
});

test('corrupt saved connections report an explicit API error while console login stays available and the file stays unchanged', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-corrupt-'));
  const path = join(dataDir, 'connections.json');
  const corrupt = '{"revision":2,"connections":[{"token":"private-secret"}';
  await writeFile(path, corrupt, 'utf8');
  const runtime = new FakeRuntime();
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret', initial: [{ id: 'fallback', name: 'Fallback', type: 'http', enabled: false }] });
  const consoleServer = await startServer(asRuntime(runtime), { host: '127.0.0.1', port: 0, token: 'console-secret', connections: manager, heartbeatInterval: 0 });
  t.after(async () => { await consoleServer.close(); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(manager.start(), error => (error as { retcode?: number }).retcode === 1500);
  assert.throws(() => manager.list(), /Saved connection configuration is unavailable; repair connections\.json/);
  const base = `http://127.0.0.1:${consoleServer.port}`;
  assert.equal((await fetch(`${base}/api/auth`, { method: 'POST', headers: headers() })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: headers() })).status, 200);
  const list = await fetch(`${base}/api/connections`, { headers: headers() });
  assert.equal(list.status, 500);
  const failureText = await list.text();
  const failed = JSON.parse(failureText) as ActionResponse;
  assert.equal(failed.retcode, 1500);
  assert.equal(failed.data, null);
  assert.match(failed.message ?? '', /Saved connection configuration is unavailable; repair connections\.json/);
  assert(!failureText.includes('private-secret'));
  assert(!failureText.includes('console-secret'));
  assert.equal((await fetch(`${base}/api/connections`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: 'New', type: 'http', enabled: false }) })).status, 500);
  assert.equal((await fetch(`${base}/api/connections/fallback`, { method: 'PUT', headers: headers(), body: JSON.stringify({ name: 'Changed' }) })).status, 500);
  assert.equal((await fetch(`${base}/api/connections/fallback`, { method: 'DELETE', headers: headers() })).status, 500);
  assert.equal(await readFile(path, 'utf8'), corrupt);
  assert.equal(runtime.listenerCount('event'), 1);
});

test('repeated fragment URL failures leave managed and legacy server event listeners at their baseline', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-fragment-'));
  const runtime = new FakeRuntime();
  const unrelated = () => {};
  runtime.on('event', unrelated);
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret' });
  await manager.start();
  t.after(async () => { await manager.close(); runtime.off('event', unrelated); await rm(dataDir, { recursive: true, force: true }); });
  const live = await manager.create({ name: 'Live HTTP', type: 'http', port: 0, heartbeatInterval: 0 });
  const baseline = runtime.listenerCount('event');
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const input of [
      { name: 'Invalid WS', type: 'ws_reverse', url: 'ws://127.0.0.1:1/#fragment' },
      { name: 'Invalid HTTP', type: 'http_post', url: 'http://127.0.0.1:1/#fragment' },
    ]) await assert.rejects(manager.create(input), error => (error as { retcode?: number }).retcode === 1400);
    await assert.rejects(startServer(asRuntime(runtime), { host: '127.0.0.1', port: 0, token: 'console-secret', reverseWsUrls: ['ws://127.0.0.1:1/#fragment'] }), /without credentials or fragments/);
    await assert.rejects(startServer(asRuntime(runtime), { host: '127.0.0.1', port: 0, token: 'console-secret', webhookUrls: ['http://127.0.0.1:1/#fragment'] }), /without credentials or fragments/);
    await assert.rejects(startServer(asRuntime(runtime), { host: '127.0.0.1', port: 0, token: 'invalid\nsecret', reverseWsUrls: ['ws://127.0.0.1:1/'] }), /visible ASCII/);
    assert.equal(runtime.listenerCount('event'), baseline);
  }
  assert.equal(manager.list().revision, 1);
  assert.equal((await fetch(`http://127.0.0.1:${live.actualPort}/health`)).status, 200);
  await manager.close();
  assert.equal(runtime.listenerCount('event'), 1);
});

test('a synchronous outbound initialization error closes an already listening server and removes its event listener', async () => {
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const address = reserve.address();
  assert(address && typeof address === 'object');
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const runtime = new FakeRuntime();
  await assert.rejects(startServer(asRuntime(runtime), {
    host: '127.0.0.1', port: address.port, token: 'console-secret', reverseWsUrls: ['ws://127.0.0.1:1/'],
    onOutboundStatus: () => { throw new Error('Synchronous initialization failure'); },
  }), /Synchronous initialization failure/);
  assert.equal(runtime.listenerCount('event'), 0);
  const recovered = await startServer(asRuntime(runtime), { host: '127.0.0.1', port: address.port, token: 'console-secret', heartbeatInterval: 0 });
  try { assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200); }
  finally { await recovered.close(); }
  assert.equal(runtime.listenerCount('event'), 0);
});

test('oversized initial profiles are rejected before persistence and the maximum valid count survives restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dytranob-connections-initial-limit-'));
  const runtime = new FakeRuntime();
  const initial = Array.from({ length: 65 }, (_, index) => ({ id: `initial-${index}`, name: `Initial ${index}`, type: 'http' as const, enabled: false }));
  const manager = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret', initial });
  let valid: ConnectionManager | undefined;
  let restored: ConnectionManager | undefined;
  t.after(async () => { await manager.close(); await valid?.close(); await restored?.close(); await rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(manager.start(), error => (error as { retcode?: number }).retcode === 1400);
  await assert.rejects(readFile(join(dataDir, 'connections.json'), 'utf8'), error => (error as { code?: string }).code === 'ENOENT');
  assert.equal(runtime.listenerCount('event'), 0);
  valid = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret', initial: initial.slice(0, 64) });
  await valid.start();
  assert.equal(valid.list().connections.length, 64);
  await valid.close();
  restored = new ConnectionManager(asRuntime(runtime), { dataDir, token: 'console-secret', initial: [] });
  await restored.start();
  assert.equal(restored.list().connections.length, 64);
  assert(restored.list().connections.every(connection => connection.status === 'stopped'));
});

test('automatic ports retry browser-blocked allocations before registering runtime resources', async t => {
  const originalAddress = Server.prototype.address;
  let addressCalls = 0;
  t.mock.method(Server.prototype, 'address', function (this: Server) {
    if (addressCalls++ === 0) return { address: '127.0.0.1', family: 'IPv4', port: 6000 };
    return originalAddress.call(this);
  });
  const listening = t.mock.method(Server.prototype, 'listen');
  const closing = t.mock.method(Server.prototype, 'close');
  const runtime = new FakeRuntime();
  const service = await startServer(asRuntime(runtime), { host: '127.0.0.1', port: 0, token: 'console-secret', heartbeatInterval: 0 });
  try {
    assert(listening.mock.callCount() >= 2);
    assert.equal(closing.mock.callCount(), listening.mock.callCount() - 1);
    assert.notEqual(service.port, 6000);
    assert.equal(runtime.listenerCount('event'), 1);
    assert.equal((await fetch(`http://127.0.0.1:${service.port}/health`)).status, 200);
  } finally { await service.close(); }
  assert.equal(runtime.listenerCount('event'), 0);
});
