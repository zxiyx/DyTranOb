import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { connectionInputSchema, normalizeConnection } from './connections.js';

const configSchema = z.object({
  server: z.object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(5088),
    token: z.string().default(''),
    onebotToken: z.string().max(4096).regex(/^[\x21-\x7e]*$/).default(''),
    allowRemote: z.boolean().default(false),
    mediaPublicUrl: z.url().refine(v => { const u = new URL(v); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, 'HTTP(S) base URL without credentials, query or fragment required').optional(),
  }).default({ host: '127.0.0.1', port: 5088, token: '', onebotToken: '', allowRemote: false }),
  dataDir: z.string().min(1).default('./data'),
  accounts: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    type: z.enum(['douyin', 'mock']).default('douyin'),
  })).min(1).default([{ id: 'main', type: 'douyin' }]),
  heartbeatInterval: z.number().int().min(1000).max(3600000).default(15000),
  webhookUrls: z.array(z.url().refine(v => /^https?:/.test(v), 'HTTP(S) URL required')).max(16).default([]),
  reverseWsUrls: z.array(z.url().refine(v => /^wss?:/.test(v), 'WS(S) URL required')).max(16).default([]),
  connections: z.array(connectionInputSchema).max(64).default([]),
}).strict();

export type RuntimeConfig = Omit<z.infer<typeof configSchema>, 'connections'> & { connections: ReturnType<typeof normalizeConnection>[] };

export function parseConfig(value: unknown, baseDir = process.cwd()): RuntimeConfig {
  const input = configSchema.parse(value);
  const connections = input.connections.map((connection, index) => normalizeConnection(connection, connection.id ?? `connection-${index + 1}`));
  for (const [index, url] of [...new Set(input.webhookUrls)].entries()) connections.push(normalizeConnection(connectionInputSchema.parse({ name: `HTTP event report ${index + 1}`, type: 'http_post', url, heartbeatInterval: input.heartbeatInterval }), `legacy-http-post-${index + 1}`));
  for (const [index, url] of [...new Set(input.reverseWsUrls)].entries()) connections.push(normalizeConnection(connectionInputSchema.parse({ name: `Reverse WebSocket ${index + 1}`, type: 'ws_reverse', url, heartbeatInterval: input.heartbeatInterval }), `legacy-ws-reverse-${index + 1}`));
  if (connections.length > 64 || new Set(connections.map(connection => connection.id)).size !== connections.length) throw new Error('Connection IDs must be unique; at most 64 profiles are supported');
  const config: RuntimeConfig = { ...input, connections };
  if (new Set(config.accounts.map(a => a.id)).size !== config.accounts.length) throw new Error('Account IDs must be unique');
  config.dataDir = resolve(baseDir, config.dataDir);
  config.server.token = process.env.DYTRANOB_TOKEN ?? config.server.token;
  return config;
}

export function loadConfig(path: string): RuntimeConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')), dirname(resolve(path)));
}
