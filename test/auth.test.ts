import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveWebUiToken } from '../src/auth.js';

test('WebUI token persists, explicit overrides do not erase it, and invalid saved config is retained', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dytranob-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = resolveWebUiToken(dir, '');
  assert.match(first, /^[a-f0-9]{48}$/);
  assert.equal(resolveWebUiToken(dir, ''), first);
  assert.equal(resolveWebUiToken(dir, 'fixed-config-token'), 'fixed-config-token');
  assert.equal(JSON.parse(readFileSync(join(dir, 'webui.json'), 'utf8')).token, first);
  assert.throws(() => resolveWebUiToken(dir, 'bad token'), /visible ASCII/);
  writeFileSync(join(dir, 'webui.json'), '{invalid');
  assert.throws(() => resolveWebUiToken(dir, ''), /Cannot read saved/);
  assert.equal(readFileSync(join(dir, 'webui.json'), 'utf8'), '{invalid');
});
