import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ActionFault, type OneBotEvent } from './types.js';

type Kind = 'user' | 'group' | 'message';
interface State {
  version: 1;
  nextId: number;
  ids: Array<[string, number]>;
  messages: Array<[number, { accountId: string; event: OneBotEvent }]>;
}

/** Exact native strings are persisted before their numeric aliases leave the process. */
export class RuntimeStore {
  private ids = new Map<string, number>();
  private reverse = new Map<number, [string, Kind, string]>();
  private messages = new Map<number, { accountId: string; event: OneBotEvent }>();
  private nextId = 1;
  private file: string;
  private lock: string;
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'onebot-store.json');
    this.lock = join(dataDir, 'runtime.lock');
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid data directory lock; inspect runtime.lock');
      try { process.kill(pid, 0); throw new Error('Data directory is already in use by another runtime'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        unlinkSync(this.lock);
      }
    }
    const fd = openSync(this.lock, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    try {
      if (existsSync(this.file)) {
        const state = JSON.parse(readFileSync(this.file, 'utf8')) as State;
        if (state.version !== 1 || !Number.isInteger(state.nextId) || state.nextId < 1 || !Array.isArray(state.ids) || !Array.isArray(state.messages)) throw new Error('Invalid persistent store');
        this.nextId = state.nextId;
        for (const [key, id] of state.ids) {
          const tuple = JSON.parse(key) as [string, Kind, string];
          if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every(v => typeof v === 'string') || !['user', 'group', 'message'].includes(tuple[1]) || !Number.isInteger(id) || id < 1 || id >= this.nextId || this.reverse.has(id) || this.ids.has(key)) throw new Error('Invalid ID mapping');
          this.ids.set(key, id); this.reverse.set(id, tuple);
        }
        this.messages = new Map(state.messages);
      }
    } catch (error) { this.close(); throw error; }
  }

  id(accountId: string, kind: Kind, native: string): number {
    if (typeof native !== 'string' || native.length === 0) throw new ActionFault(1400, 'Empty native ID');
    const key = JSON.stringify([accountId, kind, native]);
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    if (this.nextId > 2147483647) throw new ActionFault(1500, 'ID space exhausted');
    const id = this.nextId++;
    this.ids.set(key, id); this.reverse.set(id, [accountId, kind, native]);
    try { this.flush(); }
    catch (error) {
      this.ids.delete(key); this.reverse.delete(id); this.nextId = id;
      throw error;
    }
    return id;
  }

  native(accountId: string, kind: Kind, value: unknown): string {
    const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new ActionFault(1400, `${kind} ID must be a positive mapped integer`);
    const tuple = this.reverse.get(id);
    if (!tuple || tuple[0] !== accountId || tuple[1] !== kind) throw new ActionFault(1404, `Unknown ${kind} ID for this account; query its list or use dy_resolve_id first`);
    return tuple[2];
  }

  saveMessage(accountId: string, event: OneBotEvent): void {
    const previous = new Map(this.messages);
    this.messages.set(event.message_id as number, { accountId, event });
    while (this.messages.size > 5000) this.messages.delete(this.messages.keys().next().value!);
    try { this.flush(); } catch (error) { this.messages = previous; throw error; }
  }

  message(accountId: string, id: unknown): OneBotEvent {
    this.native(accountId, 'message', id);
    const record = this.messages.get(Number(id));
    if (!record || record.accountId !== accountId) throw new ActionFault(1404, 'Message is outside the local 5000-message cache');
    return structuredClone(record.event);
  }

  private flush(): void {
    if (this.closed) throw new Error('Store is closed');
    const state: State = { version: 1, nextId: this.nextId, ids: [...this.ids], messages: [...this.messages] };
    writeFileSync(this.file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (existsSync(this.lock)) unlinkSync(this.lock);
  }
}
