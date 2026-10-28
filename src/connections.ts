import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { startServer } from './server.js';
import { ActionFault } from './types.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const fields = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(['http', 'ws', 'http_post', 'ws_reverse']),
  enabled: z.boolean().default(true),
  host: z.string().min(1).max(253).regex(/^[A-Za-z0-9_.:[\]-]+$/).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  url: z.string().max(4096).optional(),
  token: z.string().max(4096).regex(/^[\x21-\x7e]*$/).optional(),
  heartbeatInterval: z.number().int().min(0).max(3600000).optional(),
  allowRemote: z.boolean().optional(),
}).strict();

/** Secret-bearing configuration is persisted locally; management responses use ConnectionView. */
export interface ConnectionConfig {
  id: string;
  name: string;
  type: 'http' | 'ws' | 'http_post' | 'ws_reverse';
  enabled: boolean;
  host?: string;
  port?: number;
  url?: string;
  token?: string;
  heartbeatInterval?: number;
  allowRemote?: boolean;
}

export type ConnectionStatus = 'running' | 'stopped' | 'connecting' | 'connected' | 'error';
export interface ConnectionView extends Omit<ConnectionConfig, 'token'> {
  tokenConfigured: boolean;
  status: ConnectionStatus;
  actualPort?: number;
  error?: string;
}

export const connectionInputSchema = fields.superRefine((value, context) => {
  if (value.type === 'http' || value.type === 'ws') return;
  try {
    const url = new URL(value.url ?? '');
    const protocols = value.type === 'http_post' ? ['http:', 'https:'] : ['ws:', 'wss:'];
    if (!protocols.includes(url.protocol) || url.hash || url.username || url.password || [...url.searchParams.keys()].some(key => /^(?:token|access_token|authorization|password|secret)$/i.test(key))) {
      context.addIssue({ code: 'custom', path: ['url'], message: 'Use the correct URL protocol and put authentication in the token field' });
    }
  } catch { context.addIssue({ code: 'custom', path: ['url'], message: 'A valid destination URL is required' }); }
});

export function normalizeConnection(input: z.infer<typeof connectionInputSchema>, id: string): ConnectionConfig {
  const common = { id, name: input.name, type: input.type, enabled: input.enabled, heartbeatInterval: input.heartbeatInterval ?? 15000, ...(input.token === undefined ? {} : { token: input.token }) };
  return input.type === 'http' || input.type === 'ws'
    ? { ...common, host: input.host ?? '127.0.0.1', port: input.port ?? 3001, allowRemote: input.allowRemote ?? false }
    : { ...common, url: input.url! };
}

interface ActiveConnection {
  config: ConnectionConfig;
  status: ConnectionStatus;
  actualPort?: number;
  error?: string;
  service?: Awaited<ReturnType<typeof startServer>>;
}

function safeStartFailure(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'EADDRINUSE') return 'The listening address and port are already in use';
  if (code === 'EACCES') return 'Access to the listening address or port was denied';
  if (code === 'ENOTFOUND') return 'The listening host could not be resolved';
  return 'Connection could not start; check its address, port and remote binding settings';
}

const owners = new WeakMap<Runtime, ConnectionManager>();

/** Serializes persistence and transport changes so a failed edit retains the last working profile. */
export class ConnectionManager extends EventEmitter {
  private readonly entries = new Map<string, ActiveConnection>();
  private readonly path: string;
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(private readonly runtime: Runtime, private readonly options: { dataDir: string; initial?: ConnectionConfig[]; /** @deprecated Ignored: profiles never inherit the WebUI credential. */ token?: string }) {
    super();
    this.path = join(options.dataDir, 'connections.json');
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) throw new ActionFault(1500, 'Connection manager is closed');
      if (this.started) return;
      const owner = owners.get(this.runtime);
      if (owner && owner !== this) throw new ActionFault(1409, 'This runtime already has a connection manager');
      owners.set(this.runtime, this);
      try {
        await mkdir(this.options.dataDir, { recursive: true });
        let configs: ConnectionConfig[];
        let fresh = false;
        try {
          const saved = z.object({ revision: z.number().int().nonnegative(), connections: z.array(connectionInputSchema).max(64) }).strict().parse(JSON.parse(await readFile(this.path, 'utf8')));
          this.revision = saved.revision;
          configs = saved.connections.map((value, index) => normalizeConnection(value, value.id ?? `connection-${index + 1}`));
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new ActionFault(1500, 'Cannot read saved connections; repair connections.json before changing profiles');
          fresh = true;
          const initial = this.options.initial ?? [];
          if (initial.length > 64) throw new ActionFault(1400, 'At most 64 connections are supported');
          configs = initial.map((input, index) => this.parse(input, input.id ?? `connection-${index + 1}`));
        }
        if (new Set(configs.map(value => value.id)).size !== configs.length) throw new ActionFault(1409, 'Connection IDs must be unique');
        if (fresh) await this.persist(configs, this.revision);
        this.started = true;
        for (const config of configs) {
          const entry: ActiveConnection = { config, status: 'stopped' };
          this.entries.set(config.id, entry);
          try { await this.activate(entry); this.notify(entry); }
          catch (error) { entry.status = 'error'; entry.error = safeStartFailure(error); this.notify(entry); }
        }
      } catch (error) {
        owners.delete(this.runtime);
        throw error;
      }
    });
  }

  list(): { revision: number; connections: ConnectionView[] } {
    if (!this.started) throw new ActionFault(1500, 'Saved connection configuration is unavailable; repair connections.json and restart the runtime');
    return { revision: this.revision, connections: [...this.entries.values()].map(entry => this.view(entry)) };
  }

  create(input: unknown): Promise<ConnectionView> {
    return this.enqueue(async () => {
      this.assertReady();
      if (this.entries.size >= 64) throw new ActionFault(1400, 'At most 64 connections are supported');
      const config = this.parse(input, `connection-${randomUUID()}`);
      if (this.entries.has(config.id)) throw new ActionFault(1409, 'Connection ID already exists');
      this.checkBinding(config);
      const entry: ActiveConnection = { config, status: 'stopped' };
      try { await this.activate(entry); }
      catch (error) { throw new ActionFault(1409, safeStartFailure(error)); }
      try { await this.persist([...this.configs(), config], this.revision + 1); }
      catch { await this.deactivate(entry); throw new ActionFault(1500, 'Could not save connection; the change was not applied'); }
      this.entries.set(config.id, entry);
      this.revision++;
      this.notify(entry);
      return this.view(entry);
    });
  }

  update(id: string, input: unknown): Promise<ConnectionView> {
    return this.enqueue(async () => {
      this.assertReady();
      const previous = this.entries.get(id);
      if (!previous) throw new ActionFault(1404, 'Unknown connection ID');
      const partial = fields.omit({ enabled: true }).partial().extend({ enabled: z.boolean().optional() }).safeParse(input);
      if (!partial.success || (partial.data.id !== undefined && partial.data.id !== id)) throw new ActionFault(1400, 'Invalid connection settings');
      const config = this.parse({ ...previous.config, ...partial.data, id }, id);
      this.checkBinding(config, id);
      const entry: ActiveConnection = { config, status: 'stopped' };
      // A name-only edit keeps the socket and its clients intact.
      const sameTransport = JSON.stringify({ ...config, name: '' }) === JSON.stringify({ ...previous.config, name: '' });
      const mustRelease = !sameTransport && this.sameBinding(config, previous.config) && previous.service !== undefined;
      if (mustRelease) await this.deactivate(previous);
      try { if (!sameTransport) await this.activate(entry); }
      catch (error) {
        if (mustRelease) await this.restore(previous);
        throw new ActionFault(1409, `${safeStartFailure(error)}; the previous settings were retained`);
      }
      try { await this.persist(this.configs().map(value => value.id === id ? config : value), this.revision + 1); }
      catch {
        await this.deactivate(entry);
        if (mustRelease) await this.restore(previous);
        throw new ActionFault(1500, 'Could not save connection; the previous settings were retained');
      }
      if (sameTransport) previous.config = config;
      else { if (!mustRelease) await this.deactivate(previous); this.entries.set(id, entry); }
      this.revision++;
      const current = this.entries.get(id)!;
      this.notify(current);
      return this.view(current);
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertReady();
      const entry = this.entries.get(id);
      if (!entry) throw new ActionFault(1404, 'Unknown connection ID');
      try { await this.persist(this.configs().filter(value => value.id !== id), this.revision + 1); }
      catch { throw new ActionFault(1500, 'Could not save connections; the connection was retained'); }
      await this.deactivate(entry);
      this.entries.delete(id);
      this.revision++;
      this.runtime.emit('diagnostic', { level: 'info', source: 'Connections', message: `Removed connection ${entry.config.name}; configuration saved` });
      this.emit('change', this.list());
    });
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.entries.values()) await this.deactivate(entry);
      if (owners.get(this.runtime) === this) owners.delete(this.runtime);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private assertReady(): void {
    if (!this.started || this.closed) throw new ActionFault(1500, 'Connection manager is unavailable');
  }

  private parse(input: unknown, fallbackId: string): ConnectionConfig {
    const result = connectionInputSchema.safeParse(input);
    if (!result.success) throw new ActionFault(1400, 'Invalid connection settings; check name, type, address, port and destination URL');
    const config = normalizeConnection(result.data, result.data.id ?? fallbackId);
    if ((config.type === 'http' || config.type === 'ws') && !LOOPBACK.has(config.host!) && (!config.allowRemote || !config.token)) {
      throw new ActionFault(1400, 'Remote binding requires allowRemote=true and a nonempty access token');
    }
    return config;
  }

  private sameBinding(a: ConnectionConfig, b: ConnectionConfig): boolean {
    return ['http', 'ws'].includes(a.type) && ['http', 'ws'].includes(b.type) && a.host === b.host && a.port === b.port && a.port !== 0;
  }

  private checkBinding(config: ConnectionConfig, ignoreId?: string): void {
    if (!config.enabled) return;
    for (const entry of this.entries.values()) {
      if (entry.config.id !== ignoreId && entry.config.enabled && this.sameBinding(config, entry.config)) throw new ActionFault(1409, 'Another connection uses that listening address and port');
    }
  }

  private async activate(entry: ActiveConnection): Promise<void> {
    if (!entry.config.enabled) return;
    const config = entry.config;
    const inbound = config.type === 'http' || config.type === 'ws';
    entry.status = config.type === 'ws_reverse' ? 'connecting' : 'running';
    entry.error = undefined;
    entry.service = await startServer(this.runtime, {
      host: config.host ?? '127.0.0.1', port: config.port ?? 0,
      token: config.token ?? '', allowRemote: config.allowRemote,
      heartbeatInterval: config.heartbeatInterval,
      webui: false, management: false, httpActions: config.type === 'http', websocket: config.type === 'ws', listen: inbound,
      ...(config.type === 'http_post' ? { webhookUrls: [config.url!] } : {}),
      ...(config.type === 'ws_reverse' ? { reverseWsUrls: [config.url!] } : {}),
      onOutboundStatus: (status, error) => {
        if (this.closed) return;
        entry.status = status;
        entry.error = error;
        if (this.entries.get(config.id) === entry) this.notify(entry);
      },
    });
    if (inbound) entry.actualPort = entry.service.port;
  }

  private async deactivate(entry: ActiveConnection): Promise<void> {
    const service = entry.service;
    entry.service = undefined;
    if (service) await service.close();
    entry.status = 'stopped';
    entry.actualPort = undefined;
    entry.error = undefined;
  }

  private async restore(entry: ActiveConnection): Promise<void> {
    try { await this.activate(entry); }
    catch { entry.status = 'error'; entry.error = 'The previous connection could not restart; check whether its port is occupied'; }
    this.notify(entry);
  }

  private configs(): ConnectionConfig[] { return [...this.entries.values()].map(entry => entry.config); }

  private async persist(connections: ConnectionConfig[], revision: number): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ revision, connections }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
      this.runtime.emit('diagnostic', { level: 'info', source: 'Connections', message: `Saved connection configuration (revision ${revision})` });
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private view(entry: ActiveConnection): ConnectionView {
    const { token, ...config } = entry.config;
    return { ...config, tokenConfigured: Boolean(token), status: entry.status,
      ...(entry.actualPort === undefined ? {} : { actualPort: entry.actualPort }), ...(entry.error ? { error: entry.error } : {}) };
  }

  private notify(entry: ActiveConnection): void {
    this.emit('change', this.list());
    this.runtime.emit('diagnostic', { level: entry.status === 'error' ? 'error' : 'info', source: `Connection:${entry.config.id.slice(0, 8)}`, message: `${entry.config.name}: ${entry.status}${entry.error ? ` — ${entry.error}` : ''}` });
  }
}
