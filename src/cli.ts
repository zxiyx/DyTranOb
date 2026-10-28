#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, parseConfig } from './config.js';
import { ConsoleLogger, formatMessageLog, normalizeLogLevel } from './logger.js';
import { resolveWebUiToken } from './auth.js';

const logger = new ConsoleLogger();

const help = `DyTranOb 0.1.0 · Douyin OneBot interoperability runtime

Usage:
  dytranob [--config dytranob.config.json] [--mock] [--host HOST] [--port PORT]
  dytranob mcp [--url http://127.0.0.1:5088] [--allow-write]
  dytranob call ACTION [--params JSON | --params-file PATH] [--account ID]
  dytranob status [--account ID]

Options:
  --token TOKEN       WebUI/management token; prefer DYTRANOB_TOKEN or server.token
  --mock              Offline demo, isolated data in ./data/demo
  --config PATH       JSON configuration; relative paths resolve beside this file
  --allow-write       Enable MCP tools that send messages or change group state
  --account ID        Route a CLI action to a configured account
  --self-id ID        Route a CLI action by its mapped OneBot self_id
  --params-file PATH  Read action parameters as UTF-8 JSON (convenient in CMD)
  --help              Print this help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: {
    config: { type: 'string' }, mock: { type: 'boolean' }, host: { type: 'string' }, port: { type: 'string' },
    token: { type: 'string' }, url: { type: 'string' }, 'allow-write': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    params: { type: 'string' }, 'params-file': { type: 'string' }, account: { type: 'string' }, 'self-id': { type: 'string' },
  }, allowPositionals: true });
  if (values.help) { console.log(help); return; }
  const mode = positionals[0];
  if (mode !== undefined && !['mcp', 'call', 'status'].includes(mode)) throw new Error('Unknown command; run --help');
  if (positionals.length > (mode === 'call' ? 2 : 1)) throw new Error('Unexpected argument');
  if (mode === 'call' || mode === 'status') {
    const { DyTranObClient, ActionError } = await import('./sdk.js');
    const action = mode === 'status' ? 'get_status' : positionals[1];
    if (!action) throw new Error('Supply an action, for example: dytranob call get_friend_list');
    if (values.params !== undefined && values['params-file'] !== undefined) throw new Error('Use either --params or --params-file');
    const params: unknown = JSON.parse(values['params-file'] ? readFileSync(values['params-file'], 'utf8').replace(/^\uFEFF/, '') : values.params ?? '{}');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Action parameters must be a JSON object');
    const selfId = values['self-id'] === undefined ? undefined : Number(values['self-id']);
    if (selfId !== undefined && (!Number.isSafeInteger(selfId) || selfId < 1)) throw new Error('--self-id must be a positive mapped integer');
    const client = new DyTranObClient({ baseUrl: values.url ?? 'http://127.0.0.1:5088', token: process.env.DYTRANOB_TOKEN ?? values.token ?? '' });
    try {
      const data = await client.call(action, params as Record<string, unknown>, { account_id: values.account, self_id: selfId });
      console.log(JSON.stringify({ status: 'ok', retcode: 0, data }, null, 2));
    } catch (error) {
      if (!(error instanceof ActionError)) throw error;
      console.log(JSON.stringify(error.response, null, 2)); process.exitCode = 1;
    } finally { client.close(); }
    return;
  }
  if (mode === 'mcp') {
    const [{ DyTranObClient }, { createMcpServer }, { StdioServerTransport }] = await Promise.all([
      import('./sdk.js'), import('./mcp.js'), import('@modelcontextprotocol/sdk/server/stdio.js'),
    ]);
    const client = new DyTranObClient({ baseUrl: values.url ?? 'http://127.0.0.1:5088', token: process.env.DYTRANOB_TOKEN ?? values.token ?? '' });
    const server = createMcpServer(client, { allowWrite: values['allow-write'] ?? false });
    await server.connect(new StdioServerTransport());
    const close = async () => { client.close(); await server.close(); };
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
    return;
  }
  const path = values.config ?? (existsSync('dytranob.config.json') ? 'dytranob.config.json' : undefined);
  const config = path ? loadConfig(path) : parseConfig(values.mock ? { dataDir: './data/demo', accounts: [{ id: 'demo', type: 'mock' }] } : {});
  if (values.mock) { config.accounts = [{ id: 'demo', type: 'mock' }]; config.dataDir = resolve('./data/demo'); }
  if (values.host) config.server.host = values.host;
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535');
    config.server.port = port;
  }
  if (values.token !== undefined && process.env.DYTRANOB_TOKEN === undefined) config.server.token = values.token;
  const savedToken = !config.server.token;
  config.server.token = resolveWebUiToken(config.dataDir, config.server.token);
  const [{ Runtime }, { startServer }, { DouyinAdapter }, { MockAdapter }, { ConnectionManager }, { AccountManager, loadAccounts }] = await Promise.all([
    import('./runtime.js'), import('./server.js'), import('./adapters/douyin.js'), import('./adapters/mock.js'), import('./connections.js'), import('./accounts.js'),
  ]);
  // Accounts added or removed in the WebUI are saved to dataDir/accounts.json and override config.accounts.
  config.accounts = loadAccounts(config.dataDir, config.accounts);
  const { MediaCache } = await import('./media.js');
  const media = new MediaCache();
  const createAdapter = (a: { id: string; type: 'douyin' | 'mock' }) => a.type === 'mock' ? new MockAdapter({ accountId: a.id }) : new DouyinAdapter({ accountId: a.id, dataDir: resolve(config.dataDir, 'accounts', a.id), media });
  const runtime = new Runtime({ dataDir: config.dataDir, accounts: config.accounts.map(a => ({ id: a.id, adapter: createAdapter(a) })) });
  const accounts = new AccountManager(runtime, { dataDir: config.dataDir, accounts: config.accounts, createAdapter });
  runtime.on('diagnostic', d => logger.log(normalizeLogLevel(d.level), d.source ?? 'Runtime', d.message));
  runtime.on('event', event => {
    const source = `Account:${event.account_id ?? event.self_id}`;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      logger.info(source, formatMessageLog(event));
    } else if (event.post_type === 'notice' || event.post_type === 'request') {
      logger.info(source, `${event.post_type === 'notice' ? '通知' : '申请'} · ${event.notice_type ?? event.request_type} · user_id=${event.user_id}`);
    } else if (event.meta_event_type === 'lifecycle') logger.info(source, `账号状态 · ${event.sub_type}`);
  });
  const connections = new ConnectionManager(runtime, { dataDir: config.dataDir, initial: config.connections });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer(runtime, { ...config.server, heartbeatInterval: config.heartbeatInterval, connections, accounts, media });
    const mediaHost = ['0.0.0.0', '::'].includes(config.server.host) ? '127.0.0.1' : config.server.host;
    media.setBaseUrl(config.server.mediaPublicUrl ?? `http://${mediaHost.includes(':') ? `[${mediaHost}]` : mediaHost}:${server.port}`);
    await runtime.start();
    try { await connections.start(); }
    catch (error) { logger.error('Connections', error instanceof Error ? error.message : '无法载入连接配置；请修复保存的配置文件。'); }
    const browserHost = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host === '::' ? '::1' : config.server.host;
    const authority = `${browserHost.includes(':') ? `[${browserHost}]` : browserHost}:${server.port}`;
    const modeLabel = config.accounts.every(a => a.type === 'mock') ? '离线演示 / Mock' : '抖音原生会话 / Douyin';
    logger.info('Runtime', 'DyTranOb v0.1.0 · Douyin OneBot v11 Runtime');
    logger.info('Runtime', `运行模式 ${modeLabel}`);
    logger.info('Config', `配置文件 ${path ? resolve(path) : '默认配置'}`);
    logger.info('Storage', `数据目录 ${config.dataDir}`);
    logger.info('WebUI', `WebUI 地址 http://${authority}`);
    logger.credential('WebUI', 'WebUI Token', config.server.token);
    logger.info('HTTP', `HTTP API http://${authority}/action`);
    logger.info('WebUI', `管理动作调试 http://${authority}/api/action（使用 WebUI Token）`);
    logger.info('WebSocket', `WebSocket ws://${authority}/ws`);
    logger.info('Docs', `开发文档 http://${authority}/docs/readme.html`);
    for (const a of runtime.accounts()) logger.info(`Account:${a.id}`, `账号 ${a.id} · ${a.kind} · ${a.online ? '在线' : '等待登录'}`);
    if (savedToken) logger.info('WebUI', `Token 已固定保存在 ${resolve(config.dataDir, 'webui.json')}，重启继续使用；可用 server.token 或 DYTRANOB_TOKEN 覆盖。`);
    logger.info('OneBot', config.server.onebotToken ? '默认 HTTP / WS 使用 server.onebotToken；各独立连接使用自己的 Token。' : '默认 HTTP / WS 未启用 Token；各独立连接使用自己的 Token，不继承 WebUI Token。');
    logger.info('WebUI', '手动打开 WebUI，输入 Token 登录工作空间。');
    logger.info('Connections', '在 WebUI「连接管理」中新增、编辑或启停 OneBot 连接，保存后立即生效。');
    logger.info('Runtime', '保持此 CMD 窗口运行，按 Ctrl+C 停止。');
  } catch (error) { await runtime.stop(); await connections.close(); await server?.close(); throw error; }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    logger.info('Runtime', '正在停止运行时，等待已接收的动作完成……');
    await runtime.stop(); await connections.close(); await server?.close(); media.clear();
    logger.info('Runtime', '运行时已停止。');
  };
  process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
}

main().catch(error => {
  // Configuration failures are local; native failures are already sanitized by the runtime.
  logger.error('Launcher', error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
