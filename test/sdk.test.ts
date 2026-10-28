import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { ActionError, DyTranObClient, createClient } from '../src/sdk.js';
import { startServer } from '../src/server.js';
import type { Runtime } from '../src/runtime.js';
import type { ActionRequest, ActionResponse, OneBotEvent } from '../src/types.js';

class FakeRuntime extends EventEmitter {
  readonly executed: ActionRequest[] = [];
  accounts() { return [{ id: 'main', kind: 'mock', online: true, self_id: 1 }]; }
  actions() { return [{ action: 'get_login_info', description: 'Current user', params: {} }]; }
  recentEvents() { return [{ time: 1, self_id: 1, post_type: 'notice' } satisfies OneBotEvent]; }
  async startQrLogin() { return { state: 'waiting' }; }
  async loginState() { return { state: 'online' }; }
  async execute(request: ActionRequest): Promise<ActionResponse> {
    this.executed.push(request);
    if (request.action === 'slow') await new Promise(resolve => setTimeout(resolve, 100));
    if (request.action === 'fail') return { status: 'failed', retcode: 1404, data: null, message: 'Unsupported action', echo: request.echo };
    return { status: 'ok', retcode: 0, data: { user_id: 1, action: request.action, params: request.params }, echo: request.echo };
  }
}

test('SDK calls HTTP and WebSocket actions, streams events and exposes typed failures', async t => {
  const runtime = new FakeRuntime();
  const server = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 0 });
  t.after(() => server.close());
  const client = createClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'secret', reconnect: false });
  t.after(() => client.close());
  assert.equal((await client.call<{ user_id: number }>('get_login_info', {}, { account_id: 'main' })).user_id, 1);
  assert.equal(runtime.executed[0]?.account_id, 'main');
  await assert.rejects(client.call('fail'), (error: unknown) => error instanceof ActionError && error.retcode === 1404);
  assert.equal((await client.status()).accounts[0]?.id, 'main');
  assert.equal((await client.actions()).length, 1);
  assert.equal((await client.recentEvents()).length, 1);
  await client.connect();
  assert.equal((await client.callWs<{ user_id: number }>('get_login_info')).user_id, 1);
  assert.equal(client.isConnected(), true); assert.equal(client.getConnectionStatus(), 'connected');
  await client.disconnect(); assert.equal(client.getConnectionStatus(), 'disconnected');
  await client.connect(); assert.equal(client.isConnected(), true);
  const event = once(client, 'event');
  runtime.emit('event', { time: 2, self_id: 1, post_type: 'message', message: 'hello' } satisfies OneBotEvent);
  assert.equal((await event)[0].message, 'hello');
  await assert.rejects(client.call('slow', {}, { timeout: 5 }), /timed out/);
  await assert.rejects(client.callWs('slow', {}, { timeout: 5 }), /timed out/);
  client.close();
  await assert.rejects(client.call('get_login_info'), /closed/);
});

test('SDK reconnects and resumes the event stream after the server restarts', async t => {
  const runtime = new FakeRuntime();
  let server = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'secret', heartbeatInterval: 0 });
  t.after(() => server.close());
  const port = server.port;
  const client = new DyTranObClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret', reconnectDelay: 20 });
  t.after(() => client.close());
  await client.connect();
  const disconnected = once(client, 'disconnected');
  const reconnected = once(client, 'connected');
  await server.close();
  await disconnected;
  server = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port, token: 'secret', heartbeatInterval: 0 });
  await reconnected;
  assert.equal((await client.callWs<{ user_id: number }>('get_login_info')).user_id, 1);
});

test('MCP uses the official protocol transport, restricts writes and validates account selectors', async t => {
  const runtime = new FakeRuntime();
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'secret-token', heartbeatInterval: 0 });
  t.after(() => service.close());
  const sdk = new DyTranObClient({ baseUrl: `http://127.0.0.1:${service.port}`, token: 'secret-token' });
  t.after(() => sdk.close());
  const server = createMcpServer(sdk);
  const client = new McpClient({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  t.after(() => server.close());
  const listing = await client.listTools();
  assert(listing.tools.some(tool => tool.name === 'douyin_query'));
  assert(!listing.tools.some(tool => tool.name === 'douyin_write'));
  const status = await client.callTool({ name: 'douyin_status', arguments: {} });
  assert.equal(status.isError, undefined);
  assert(!JSON.stringify(status).includes('secret-token'));
  const denied = await client.callTool({ name: 'douyin_query', arguments: { action: 'send_private_msg', params: { user_id: 1, message: 'blocked' } } });
  assert.equal(denied.isError, true);
  assert(!runtime.executed.some(request => request.action === 'send_private_msg'));
  const read = await client.callTool({ name: 'douyin_query', arguments: { action: 'get_login_info', account_id: 'main' } });
  assert.equal(read.isError, undefined);
  assert.equal(runtime.executed.at(-1)?.account_id, 'main');
  const resolve = await client.callTool({ name: 'douyin_resolve_id', arguments: { account_id: 'main', kind: 'user', native_id: '9007199254740993123' } });
  assert.equal(resolve.isError, undefined);
  assert.equal(runtime.executed.at(-1)?.params?.native_id, '9007199254740993123');
  const invalid = await client.callTool({ name: 'douyin_query', arguments: { action: 'get_login_info', self_id: 'not-a-number' } });
  assert.equal(invalid.isError, true);
});

test('MCP write tools are exposed only when explicitly enabled', async t => {
  const runtime = new FakeRuntime();
  const service = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: '', heartbeatInterval: 0 });
  t.after(() => service.close());
  const sdk = new DyTranObClient({ baseUrl: `http://127.0.0.1:${service.port}` });
  t.after(() => sdk.close());
  const server = createMcpServer(sdk, { allowWrite: true });
  const client = new McpClient({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(() => client.close()); t.after(() => server.close());
  assert((await client.listTools()).tools.some(tool => tool.name === 'douyin_write'));
  const result = await client.callTool({ name: 'douyin_write', arguments: { action: 'send_private_msg', params: { user_id: 12, message: 'authorized test' }, account_id: 'main' } });
  assert.equal(result.isError, undefined);
  assert.equal(runtime.executed.at(-1)?.action, 'send_private_msg');
});
