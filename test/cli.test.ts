import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Runtime } from '../src/runtime.js';
import { MockAdapter } from '../src/adapters/mock.js';
import { startServer } from '../src/server.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.ts');

test('console startup reports the effective token and actual listening address', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dytranob-cli-test-'));
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    server: { port: 0, token: 'config-token-must-be-overridden' },
    dataDir: './state', accounts: [{ id: 'console-demo', type: 'mock' }],
  }));
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
    cli, '--config', configFile,
  ], { env: { ...process.env, DYTRANOB_TOKEN: 'console-fixture-token' }, windowsHide: true, stdio: 'pipe' });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  const exited = once(child, 'exit');
  try {
    const address = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup banner was not printed')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Runtime exited before startup: ${stderr}`)); });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
        const found = /WebUI 地址\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
        if (found && stderr.includes('按 Ctrl+C 停止')) { clearTimeout(timer); resolveReady(found[1]!); }
      });
    });
    assert.match(stderr, /WebUI Token\s+console-fixture-token/);
    assert(!stderr.includes('config-token-must-be-overridden'));
    assert.match(stderr, /console-demo · mock · 在线/);
    assert.match(stderr, /HTTP API\s+http:\/\/127\.0\.0\.1:\d+\/action/);
    assert.match(stderr, /WebSocket\s+ws:\/\/127\.0\.0\.1:\d+\/ws/);
    assert.match(stderr, /Ctrl\+C/);
    assert.notEqual(new URL(address).port, '0');
    const response = await fetch(`${address}/api/status`, { headers: { Authorization: 'Bearer console-fixture-token' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { accounts: Array<{ id: string }> } }).data.accounts[0]?.id, 'console-demo');
    const friends = await (await fetch(`${address}/get_friend_list`)).json() as { data: Array<{ user_id: number }> };
    assert.equal((await fetch(`${address}/api/action`, { method: 'POST', body: '{}' })).status, 401);
    const sent = await (await fetch(`${address}/send_private_msg`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: friends.data[0]!.user_id, message: 'CLI 回归：消息正文' }),
    })).json() as { retcode: number };
    assert.equal(sent.retcode, 0);
    // Child stderr can arrive after the HTTP response on Windows pipes.
    for (let i = 0; i < 100 && !stderr.includes('CLI 回归：消息正文'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(stderr, /发出私聊消息.*message_id=\d+ · 内容=CLI 回归：消息正文/);
    assert.equal(stdout, '');
    for (const line of stderr.trimEnd().split('\n')) assert.match(line, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[(?:INFO |WARN |ERROR|DEBUG)\] \[[^\]]+\]\s+/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'dytranob-cli-test-'))) throw new Error('Invalid cleanup target');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI calls a real runtime and MCP stdio stays valid JSON-RPC end to end', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dytranob-cli-test-'));
  const runtime = new Runtime({ dataDir: dir, accounts: [{ id: 'demo', adapter: new MockAdapter({ accountId: 'demo' }) }] });
  await runtime.start();
  const server = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'cli-fixture-token' });
  const url = `http://127.0.0.1:${server.port}`;
  const env = { ...process.env, DYTRANOB_TOKEN: 'cli-fixture-token' };
  const client = new Client({ name: 'dytranob-cli-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, 'mcp', '--url', url], cwd: process.cwd(), env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += String(data); });
  try {
    const status = await exec(process.execPath, ['--import', 'tsx', cli, 'status', '--url', url], { env, timeout: 10000 });
    assert.equal(JSON.parse(status.stdout).data.online, true);
    const paramFile = join(dir, 'params.json');
    writeFileSync(paramFile, JSON.stringify({ kind: 'user', native_id: '922337203685477580712345' }));
    const mapped = await exec(process.execPath, ['--import', 'tsx', cli, 'call', 'dy_resolve_id', '--params-file', paramFile, '--account', 'demo', '--url', url], { env, timeout: 10000 });
    assert.equal(JSON.parse(mapped.stdout).status, 'ok');
    assert.equal(typeof JSON.parse(mapped.stdout).data.id, 'number');
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some(tool => tool.name === 'douyin_status'));
    assert(!tools.tools.some(tool => tool.name === 'douyin_write'));
    const result = await client.callTool({ name: 'douyin_status', arguments: {} });
    assert.notEqual(result.isError, true);
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal(JSON.parse(content[0]!.text!).accounts[0].id, 'demo');
    assert(!stderr.includes('cli-fixture-token'));
  } finally {
    await client.close(); await transport.close(); await server.close(); await runtime.stop();
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'dytranob-cli-test-'))) throw new Error('Invalid cleanup target');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restarting the CLI reuses the saved WebUI token and accepts the same login', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dytranob-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ server: { port: 0 }, dataDir: './state', accounts: [{ id: 'stable', type: 'mock' }] }));
  const env = { ...process.env };
  delete env.DYTRANOB_TOKEN;
  const launch = async (previous?: string): Promise<string> => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, '--config', configFile], { env, windowsHide: true, stdio: 'pipe' });
    const exited = once(child, 'exit');
    let output = '';
    try {
      const ready = await new Promise<{ url: string; token: string }>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Startup timed out')), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Runtime exited before ready')); });
        child.stderr.on('data', chunk => {
          output += String(chunk);
          const url = /WebUI 地址\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
          const token = /WebUI Token\s+([a-f0-9]{48})/.exec(output)?.[1];
          if (url && token && output.includes('按 Ctrl+C 停止')) { clearTimeout(timer); resolveReady({ url, token }); }
        });
      });
      if (previous) assert.equal(ready.token, previous);
      const response = await fetch(`${ready.url}/api/auth`, { method: 'POST', headers: { Authorization: `Bearer ${previous ?? ready.token}` } });
      assert.equal(response.status, 200);
      assert.match(output, /Token 已固定保存/);
      return ready.token;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    }
  };
  await launch(await launch());
});
