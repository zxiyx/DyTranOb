import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Runtime } from './runtime.js';
import type { ConnectionManager } from './connections.js';
import type { AccountManager } from './accounts.js';
import type { MediaCache } from './media.js';
import { ActionFault, type ActionRequest, type ActionResponse, type OneBotEvent } from './types.js';

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  /** Standard OneBot routes; omitted preserves the programmatic API's single-token mode. */
  onebotToken?: string;
  webhookUrls?: string[];
  reverseWsUrls?: string[];
  heartbeatInterval?: number;
  allowRemote?: boolean;
  webui?: boolean;
  management?: boolean;
  httpActions?: boolean;
  websocket?: boolean;
  connections?: ConnectionManager;
  accounts?: AccountManager;
  media?: MediaCache;
  /** Internal outbound profiles use the dispatcher without creating a listening port. */
  listen?: boolean;
  onOutboundStatus?: (status: 'running' | 'connecting' | 'connected' | 'error', error?: string) => void;
}

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_PENDING = 256;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// https://fetch.spec.whatwg.org/#bad-port (Living Standard, 2026-10-19).
// WHATWG Fetch bad ports are also blocked by browsers. An automatically chosen
// listener must remain reachable through the same browser and fetch entry points.
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
const WS_PATHS = new Map([
  ['/', 'universal'], ['/ws', 'universal'], ['/api', 'api'], ['/ws/api', 'api'],
  ['/event', 'event'], ['/ws/event', 'event'],
]);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: '../webui/index.html', type: 'text/html; charset=utf-8' },
  '/ui.js': { file: '../webui/ui.js', type: 'text/javascript; charset=utf-8' },
  '/ui.css': { file: '../webui/ui.css', type: 'text/css; charset=utf-8' },
  '/docs/readme.html': { file: '../docs/readme.html', type: 'text/html; charset=utf-8' },
  '/docs/astrbot.md': { file: '../docs/astrbot.md', type: 'text/plain; charset=utf-8' },
  '/docs/actions.json': { file: '../docs/actions.json', type: 'application/json; charset=utf-8' },
};

function failure(retcode: number, message: string, echo?: unknown): ActionResponse {
  return { status: 'failed', retcode, data: null, message, wording: message, ...(echo === undefined ? {} : { echo }) };
}

function success(data: unknown): ActionResponse {
  return { status: 'ok', retcode: 0, data };
}

function json(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

function authenticated(request: IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true;
  const header = request.headers.authorization;
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('access_token') ?? '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sameOrigin(request: IncomingMessage): boolean {
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
}

function parseRequest(value: unknown): ActionRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const request = value as Record<string, unknown>;
  if (typeof request.action !== 'string' || !request.action || request.action.length > 128) return;
  if (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) return;
  if (request.account_id !== undefined && typeof request.account_id !== 'string') return;
  if (request.self_id !== undefined && (typeof request.self_id !== 'number' || !Number.isSafeInteger(request.self_id))) return;
  return request as unknown as ActionRequest;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BYTES) { request.resume(); throw new RangeError('Request body is too large'); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        chunks.length = 0;
        reject(new RangeError('Request body is too large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('Request aborted')));
    request.once('end', () => {
      if (size > MAX_BYTES) return;
      try { const body = Buffer.concat(chunks).toString('utf8'); resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
  });
}

function queryRequest(url: URL): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const numeric = new Set(['self_id', 'user_id', 'group_id', 'message_id', 'id']);
  const booleans = new Set(['auto_escape', 'no_cache', 'approve', 'is_dismiss', 'reject_add_request']);
  for (const [key, value] of url.searchParams) {
    if (key === 'access_token') continue;
    if (numeric.has(key) && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) params[key] = Number(value);
    else if (booleans.has(key) && (value === 'true' || value === 'false')) params[key] = value === 'true';
    else params[key] = value;
  }
  return params;
}

/** HTTP, forward/reverse OneBot WebSocket and HTTP event reporting share one dispatcher. */
export async function startServer(runtime: Runtime, options: ServerOptions): Promise<{ close(): Promise<void>; port: number }> {
  const onebotToken = options.onebotToken ?? options.token;
  if ([options.token, onebotToken].some(token => token.length > 4096 || !/^[\x21-\x7e]*$/.test(token))) throw new Error('Access tokens must contain only visible ASCII characters');
  if (!LOOPBACK.has(options.host) && (!options.allowRemote || !options.token)) {
    throw new Error('Remote binding requires allowRemote=true and a nonempty access token');
  }
  for (const address of options.webhookUrls ?? []) {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.username || url.password) throw new Error('Webhook URLs must use HTTP or HTTPS without credentials or fragments');
  }
  for (const address of options.reverseWsUrls ?? []) {
    const url = new URL(address);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.hash || url.username || url.password) throw new Error('Reverse WebSocket URLs must use WS or WSS without credentials or fragments');
  }
  const startedAt = Date.now();
  let closed = false;
  const sseClients = new Set<ServerResponse>();
  const sockets = new Set<WebSocket>();
  const modes = new WeakMap<WebSocket, string>();
  // Reverse sockets belong to one account (announced as X-Self-ID); they only carry that account's traffic.
  const boundSelf = new WeakMap<WebSocket, number>();
  const reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  const outboundControllers = new Set<AbortController>();
  const webhooks = [...new Set(options.webhookUrls ?? [])].map(url => ({ url, queue: [] as string[], running: false }));
  const diagnostic = (message: string) => runtime.emit('diagnostic', { level: 'warn', source: 'Connections', message });
  const selfIds = () => {
    const ids = runtime.accounts().map(account => ('self_id' in account && typeof account.self_id === 'number') ? account.self_id : 0);
    return [...new Set(ids.length ? ids : [0])];
  };
  const meta = (type: 'lifecycle' | 'heartbeat', selfId: number) => {
    const online = runtime.accounts().some(account => (account.self_id ?? 0) === selfId && account.online);
    return {
      time: Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'meta_event', meta_event_type: type,
      ...(type === 'lifecycle' ? { sub_type: 'connect' } : { status: { online, good: online }, interval: options.heartbeatInterval ?? 15000 }),
    } as OneBotEvent;
  };
  const send = (socket: WebSocket, value: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BYTES) { socket.close(1013, 'Client is too slow'); return; }
    socket.send(JSON.stringify(value));
  };
  const execute = async (request: ActionRequest): Promise<ActionResponse> => {
    try { return await runtime.execute(request); }
    catch { return failure(1500, 'Action execution failed', request.echo); }
  };
  const onMessage = async (socket: WebSocket, data: RawData) => {
    let value: unknown;
    try { value = JSON.parse(data.toString()); }
    catch { send(socket, failure(1400, 'Invalid JSON')); return; }
    const action = parseRequest(value);
    if (!action) { send(socket, failure(1400, 'Invalid action request', (value as Record<string, unknown> | null)?.echo)); return; }
    if (modes.get(socket) === 'event') { send(socket, failure(1404, 'Actions are unavailable on the event endpoint', action.echo)); return; }
    const bound = boundSelf.get(socket);
    if (bound !== undefined && action.account_id === undefined && action.self_id === undefined) action.self_id = bound;
    send(socket, await execute(action));
  };
  const attach = (socket: WebSocket, mode: string, selfId?: number) => {
    sockets.add(socket);
    modes.set(socket, mode);
    if (selfId !== undefined) boundSelf.set(socket, selfId);
    socket.on('message', data => { void onMessage(socket, data); });
    socket.on('error', () => { /* The close handler owns cleanup; never log URLs or credentials. */ });
    socket.once('close', () => sockets.delete(socket));
    if (mode !== 'api') for (const id of selfId === undefined ? selfIds() : [selfId]) send(socket, meta('lifecycle', id));
  };
  const deliverWebhook = async (target: typeof webhooks[number]) => {
    if (target.running || closed) return;
    target.running = true;
    try {
      while (!closed && target.queue.length) {
        const body = target.queue.shift()!;
        const controller = new AbortController();
        outboundControllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(target.url, {
            method: 'POST', body, redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'DyTranOb/0.1.0', ...(onebotToken ? { 'X-Signature': `sha1=${createHmac('sha1', onebotToken).update(body).digest('hex')}` } : {}) },
          });
          await response.body?.cancel();
          if (!response.ok) { diagnostic(`Webhook delivery returned HTTP ${response.status}`); options.onOutboundStatus?.('error', `Event delivery returned HTTP ${response.status}`); }
          else if (!closed) options.onOutboundStatus?.('running');
        } catch { if (!closed) { diagnostic('Webhook delivery failed'); options.onOutboundStatus?.('error', 'Event delivery failed'); } }
        finally { clearTimeout(timeout); outboundControllers.delete(controller); }
      }
    } finally { target.running = false; }
  };
  const broadcast = (event: OneBotEvent) => {
    const body = JSON.stringify(event);
    for (const socket of sockets) {
      const bound = boundSelf.get(socket);
      if (modes.get(socket) !== 'api' && (bound === undefined || bound === event.self_id)) send(socket, event);
    }
    // An account that just logged in (or changed identity) needs its own reverse connection.
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') syncReverse();
    for (const response of sseClients) {
      if (response.writableLength > MAX_BYTES) { response.end(); sseClients.delete(response); }
      else response.write(`data: ${body}\n\n`);
    }
    for (const target of webhooks) {
      if (target.queue.length >= MAX_PENDING) { diagnostic('Webhook queue is full; event dropped'); continue; }
      target.queue.push(body);
      void deliverWebhook(target);
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') { json(response, 200, { status: 'ok' }); return; }
      const staticFile = STATIC_FILES[url.pathname];
      if (options.webui !== false && request.method === 'GET' && staticFile) {
        try {
          const content = await readFile(new URL(staticFile.file, import.meta.url));
          response.writeHead(200, { 'Content-Type': staticFile.type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'", 'Cache-Control': 'no-cache' });
          response.end(content);
        } catch { json(response, 404, failure(1404, 'Resource not found')); }
        return;
      }
      if (options.media && url.pathname.startsWith('/media/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
        const image = options.media.get(url.pathname.slice('/media/'.length));
        if (!image) { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); return; }
        response.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        response.end(request.method === 'HEAD' ? undefined : image.bytes); return;
      }
      if (!sameOrigin(request)) { json(response, 403, failure(1403, 'Cross-origin requests are not allowed')); return; }
      const managementRoute = options.management !== false && (url.pathname.startsWith('/api/') || url.pathname === '/events');
      if (!authenticated(request, url, managementRoute ? options.token : onebotToken)) { json(response, 401, failure(1401, 'Unauthorized')); return; }
      if (options.management !== false && request.method === 'POST' && url.pathname === '/api/auth') { json(response, 200, success({ authenticated: true })); return; }
      const connectionPath = /^\/api\/connections(?:\/([^/]+))?$/.exec(url.pathname);
      if (connectionPath) {
        if (options.management === false || !options.connections) { json(response, 404, failure(1404, 'Resource not found')); return; }
        const id = connectionPath[1] ? decodeURIComponent(connectionPath[1]) : undefined;
        if (request.method === 'GET' && !id) json(response, 200, success(options.connections.list()));
        else if (request.method === 'POST' && !id) json(response, 201, success(await options.connections.create(await readJson(request))));
        else if (request.method === 'PUT' && id) json(response, 200, success(await options.connections.update(id, await readJson(request))));
        else if (request.method === 'DELETE' && id) { await options.connections.remove(id); json(response, 200, success(null)); }
        else json(response, 405, failure(1405, 'Method not allowed'));
        return;
      }
      if (options.management !== false && request.method === 'GET' && url.pathname === '/api/status') { json(response, 200, success({ accounts: runtime.accounts(), version: '0.1.0', uptime: Math.floor((Date.now() - startedAt) / 1000) })); return; }
      if (options.management !== false && request.method === 'GET' && url.pathname === '/api/actions') { json(response, 200, success(runtime.actions())); return; }
      if (options.management !== false && request.method === 'GET' && url.pathname === '/api/events') {
        const limit = Math.max(0, Math.min(1000, Number(url.searchParams.get('limit') ?? 100) || 0));
        json(response, 200, success(runtime.recentEvents(limit))); return;
      }
      if (options.management !== false && request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n');
        sseClients.add(response);
        for (const id of selfIds()) response.write(`data: ${JSON.stringify(meta('lifecycle', id))}\n\n`);
        response.once('close', () => sseClients.delete(response));
        return;
      }
      const accountPath = /^\/api\/accounts(?:\/([^/]+))?$/.exec(url.pathname);
      if (options.management !== false && accountPath) {
        const id = accountPath[1] ? decodeURIComponent(accountPath[1]) : undefined;
        if (request.method === 'GET' && !id) json(response, 200, success(runtime.accounts()));
        else if (!options.accounts) json(response, 404, failure(1404, 'Account management is unavailable'));
        else if (request.method === 'POST' && !id) json(response, 201, success(await options.accounts.create(await readJson(request))));
        else if (request.method === 'DELETE' && id) { await options.accounts.remove(id); json(response, 200, success(null)); }
        else json(response, 405, failure(1405, 'Method not allowed'));
        return;
      }
      const loginPath = /^\/api\/accounts\/([^/]+)\/login(\/qr)?$/.exec(url.pathname);
      if (options.management !== false && loginPath) {
        const accountId = decodeURIComponent(loginPath[1]!);
        if (request.method === 'POST' && loginPath[2]) { json(response, 200, success(await runtime.startQrLogin(accountId))); return; }
        if (request.method === 'GET' && !loginPath[2]) { json(response, 200, success(await runtime.loginState(accountId))); return; }
      }
      if (options.httpActions === false || ['/events', '/api/auth', '/api/status', '/api/actions', '/api/events', '/api/accounts'].includes(url.pathname)) { json(response, 404, failure(1404, 'Resource not found')); return; }
      if (request.method !== 'POST' && request.method !== 'GET') { json(response, 405, failure(1405, 'Method not allowed')); return; }
      const shorthand = /^\/([A-Za-z][A-Za-z0-9_]*)$/.exec(url.pathname);
      const unified = url.pathname === '/' || url.pathname === '/action' || url.pathname === '/api/action';
      if ((!unified && !shorthand) || (unified && request.method !== 'POST')) { json(response, 404, failure(1404, 'Resource not found')); return; }
      const input = request.method === 'POST' ? await readJson(request) : queryRequest(url);
      if (!input || typeof input !== 'object' || Array.isArray(input)) { json(response, 400, failure(1400, 'Invalid action request')); return; }
      let value = input;
      if (!unified && shorthand) {
        const { account_id, self_id, echo, ...params } = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
        value = { action: shorthand[1], params, ...(account_id === undefined ? {} : { account_id }), ...(self_id === undefined ? {} : { self_id }), ...(echo === undefined ? {} : { echo }) };
      }
      const action = parseRequest(value);
      if (!action) { json(response, 400, failure(1400, 'Invalid action request')); return; }
      json(response, 200, await execute(action));
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ActionFault) json(response, error.retcode >= 1400 && error.retcode < 1500 ? error.retcode - 1000 : 500, failure(error.retcode, error.message));
      else if (error instanceof RangeError) json(response, 413, failure(1413, 'Request body is too large'));
      else if (error instanceof SyntaxError || error instanceof URIError) json(response, 400, failure(1400, 'Invalid request encoding or JSON'));
      else json(response, 500, failure(1500, 'Request failed'));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number, message: string) => {
      const body = JSON.stringify(failure(status + 1000, message));
      socket.end(`HTTP/1.1 ${status} ${message}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    let url: URL;
    if (options.websocket === false) { reject(404, 'Not Found'); return; }
    try { url = new URL(request.url ?? '/', 'http://localhost'); } catch { reject(400, 'Bad Request'); return; }
    const mode = WS_PATHS.get(url.pathname.replace(/\/+$/, '') || '/');
    if (!mode) { reject(404, 'Not Found'); return; }
    if (!sameOrigin(request)) { reject(403, 'Forbidden'); return; }
    if (!authenticated(request, url, onebotToken)) { reject(401, 'Unauthorized'); return; }
    websocketServer.handleUpgrade(request, socket, head, client => attach(client, mode));
  });
  // Bot frameworks bind a reverse connection to the X-Self-ID sent in the handshake, so each logged-in
  // account gets its own connection, opened only once its self_id is known (never as self_id 0).
  const reverseUrls = [...new Set(options.reverseWsUrls ?? [])];
  const reverseLinks = new Map<string, { socket?: WebSocket; timer?: ReturnType<typeof setTimeout>; stopped: boolean }>();
  const reverseStatus = () => {
    if (closed || !reverseUrls.length) return;
    const links = [...reverseLinks.values()];
    if (!links.length) options.onOutboundStatus?.('connecting', 'Waiting for an account to log in before connecting');
    else options.onOutboundStatus?.(links.some(link => link.socket?.readyState === WebSocket.OPEN) ? 'connected' : 'connecting');
  };
  const connectReverse = (key: string, url: string, selfId: number, attempt = 0) => {
    const link = reverseLinks.get(key);
    if (closed || !link || link.stopped) return;
    const socket = new WebSocket(url, {
      maxPayload: MAX_BYTES, handshakeTimeout: 10000,
      headers: { 'X-Client-Role': 'Universal', 'X-Self-ID': String(selfId), 'User-Agent': 'DyTranOb/0.1.0', ...(onebotToken ? { Authorization: `Bearer ${onebotToken}` } : {}) },
    });
    link.socket = socket;
    sockets.add(socket);
    socket.once('open', () => { attempt = 0; attach(socket, 'universal', selfId); reverseStatus(); });
    socket.on('error', () => { /* Reconnect is driven once by close. */ });
    reverseStatus();
    socket.once('close', () => {
      sockets.delete(socket);
      if (link.socket === socket) link.socket = undefined;
      if (closed || link.stopped) return;
      reverseStatus();
      diagnostic('Reverse WebSocket disconnected; reconnect scheduled');
      const delay = Math.min(30000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 250);
      const timer = setTimeout(() => { reconnectTimers.delete(timer); link.timer = undefined; connectReverse(key, url, selfId, attempt + 1); }, delay);
      link.timer = timer;
      reconnectTimers.add(timer);
    });
  };
  const syncReverse = () => {
    if (closed || !reverseUrls.length) return;
    const ids = new Set(runtime.accounts().flatMap(account => typeof account.self_id === 'number' && account.self_id > 0 ? [account.self_id] : []));
    const wanted = new Map(reverseUrls.flatMap(url => [...ids].map(id => [`${id} ${url}` as string, { url, id }] as const)));
    for (const [key, link] of reverseLinks) {
      if (wanted.has(key)) continue;
      link.stopped = true;
      if (link.timer) { clearTimeout(link.timer); reconnectTimers.delete(link.timer); }
      link.socket?.close(1000, 'Account removed');
      reverseLinks.delete(key);
    }
    for (const [key, { url, id }] of wanted) {
      if (reverseLinks.has(key)) continue;
      reverseLinks.set(key, { stopped: false });
      connectReverse(key, url, id);
    }
    reverseStatus();
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    runtime.off('event', broadcast);
    if (reverseUrls.length) runtime.off('accounts', syncReverse);
    if (heartbeat) clearInterval(heartbeat);
    for (const timer of reconnectTimers) clearTimeout(timer);
    for (const controller of outboundControllers) controller.abort();
    for (const target of webhooks) target.queue.length = 0;
    for (const response of sseClients) response.end();
    for (const socket of sockets) socket.terminate();
    websocketServer.close();
    if (server.listening) {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  };
  try {
    if (options.listen !== false) {
      for (let attempt = 0; ; attempt++) {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
        });
        const bound = server.address();
        if (options.port !== 0 || !bound || typeof bound !== 'object' || !FETCH_BAD_PORTS.has(bound.port)) break;
        await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        if (attempt >= 31) throw new Error('Could not allocate a browser-accessible listening port');
      }
    }
    runtime.on('event', broadcast);
    if (reverseUrls.length) { runtime.on('accounts', syncReverse); syncReverse(); }
    heartbeat = (options.heartbeatInterval ?? 15000) > 0 ? setInterval(() => { for (const id of selfIds()) broadcast(meta('heartbeat', id)); }, options.heartbeatInterval ?? 15000) : undefined;
    heartbeat?.unref();
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  return { port: address && typeof address === 'object' ? address.port : options.port, close };
}
