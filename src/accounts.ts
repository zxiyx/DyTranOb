import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import type { NativeAdapter } from './adapters/types.js';
import { ActionFault } from './types.js';

export type AccountType = 'douyin' | 'mock';
export interface AccountConfig { id: string; type: AccountType }

const accountSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), type: z.enum(['douyin', 'mock']).default('douyin') }).strict();
const fileSchema = z.object({ accounts: z.array(accountSchema).min(1).max(64) }).strict();

/**
 * Reads the saved account list. `dataDir/accounts.json` (written by the WebUI) takes precedence over
 * the configuration file, the same way `connections.json` does.
 */
export function loadAccounts(dataDir: string, initial: AccountConfig[]): AccountConfig[] {
  let text: string;
  try { text = readFileSync(join(dataDir, 'accounts.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initial.map(account => ({ ...account }));
    throw error;
  }
  const accounts = fileSchema.parse(JSON.parse(text)).accounts;
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) throw new Error('accounts.json contains duplicate account IDs');
  return accounts;
}

/** Adds and removes runtime accounts and persists the list so it survives restarts. */
export class AccountManager {
  private readonly path: string;
  private readonly types = new Map<string, AccountType>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly runtime: Runtime, private readonly options: { dataDir: string; accounts: AccountConfig[]; createAdapter: (account: AccountConfig) => NativeAdapter }) {
    this.path = join(options.dataDir, 'accounts.json');
    for (const account of options.accounts) this.types.set(account.id, account.type);
  }

  list() { return this.runtime.accounts(); }

  create(input: unknown): Promise<ReturnType<Runtime['accounts']>[number]> {
    return this.enqueue(async () => {
      const parsed = accountSchema.safeParse(input);
      if (!parsed.success) throw new ActionFault(1400, 'Account ID must be 1–64 letters, digits, _ or -; type must be douyin or mock');
      const account = parsed.data;
      if (this.types.has(account.id)) throw new ActionFault(1409, 'Account ID already exists');
      if (this.types.size >= 64) throw new ActionFault(1400, 'At most 64 accounts are supported');
      await this.persist([...this.configs(), account]);
      this.types.set(account.id, account.type);
      try { await this.runtime.addAccount(account.id, this.options.createAdapter(account)); }
      catch (error) {
        this.types.delete(account.id);
        await this.persist(this.configs()).catch(() => {});
        throw error;
      }
      this.runtime.emit('diagnostic', { level: 'info', source: 'Accounts', message: `Added account ${account.id} (${account.type}); configuration saved` });
      return this.list().find(value => value.id === account.id)!;
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.types.has(id)) throw new ActionFault(1404, 'Unknown account_id');
      if (this.types.size === 1) throw new ActionFault(1400, 'At least one account must remain');
      await this.persist(this.configs().filter(account => account.id !== id));
      const type = this.types.get(id)!;
      this.types.delete(id);
      try { await this.runtime.removeAccount(id); }
      catch (error) { this.types.set(id, type); await this.persist(this.configs()).catch(() => {}); throw error; }
      this.runtime.emit('diagnostic', { level: 'info', source: 'Accounts', message: `Removed account ${id}; its local session data was kept` });
    });
  }

  private configs(): AccountConfig[] { return [...this.types].map(([id, type]) => ({ id, type })); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private async persist(accounts: AccountConfig[]): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ accounts }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } catch { throw new ActionFault(1500, 'Could not save accounts.json; the change was not applied'); }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
