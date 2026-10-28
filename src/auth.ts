import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Explicit configuration wins; otherwise reuse a locally saved WebUI credential. */
export function resolveWebUiToken(dataDir: string, configured: string): string {
  const validate = (token: unknown): string => {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('WebUI Token must contain 1–4096 visible ASCII characters without spaces');
    return token;
  };
  if (configured) return validate(configured);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'webui.json');
  const read = () => {
    try { return validate((JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }).token); }
    catch { throw new Error('Cannot read saved WebUI Token; repair dataDir/webui.json or configure server.token'); }
  };
  try { readFileSync(path); return read(); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const token = randomBytes(24).toString('hex');
  try { writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return read();
    throw new Error('Could not persist WebUI Token; check data directory permissions');
  }
  return token;
}
