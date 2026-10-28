import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MediaCache, boundedBytes, cdnUrl, decodeImageBase64, downloadDouyinImage, emojiUrls } from '../src/media.js';
import { startServer } from '../src/server.js';
import type { Runtime } from '../src/runtime.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZsAAAAASUVORK5CYII=', 'base64');
test('encrypted Douyin photos become ordinary image bytes readable without the WebUI token', async t => {
  const key = randomBytes(32); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(png), cipher.final(), cipher.getAuthTag()]);
  const cache = new MediaCache({ fetcher: async (_url, init) => { assert.equal(new Headers(init?.headers).get('cookie'), null); return new Response(encrypted); } });
  const runtime = Object.assign(new EventEmitter(), { accounts: () => [] });
  const server = await startServer(runtime as unknown as Runtime, { host: '127.0.0.1', port: 0, token: 'private-management', onebotToken: 'private-bot', heartbeatInterval: 0, media: cache });
  t.after(() => server.close()); const base = `http://127.0.0.1:${server.port}`; cache.setBaseUrl(base);
  const url = await cache.resolve(['https://p3-sign.douyinpic.com/photo.image'], key.toString('hex'));
  assert.match(url, /\/media\/[a-f0-9]{48}\.png$/);
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/media/unknown')).status, 404);
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), String(png.length));
  cache.clear(); assert.equal((await fetch(url)).status, 404);
});
test('emoji URI does not override an actual URL and GIF bytes remain animated-format bytes', async () => {
  const urls = emojiUrls(JSON.stringify({ url: { uri: 'opaque-resource-id', url_list: ['https://p3.douyinpic.com/a.gif'] } }), 'opaque-resource-id');
  assert.deepEqual(urls, ['https://p3.douyinpic.com/a.gif']);
  const gif = Buffer.from('GIF89a0000000000'); const cache = new MediaCache({ fetcher: async () => new Response(gif) }); cache.setBaseUrl('http://localhost:5088');
  const url = await cache.resolve(urls); assert.ok(url.endsWith('.gif')); assert.deepEqual(cache.get(url.split('/').at(-1)!)?.bytes, gif);
});
test('cache is bounded and expiring; corrupt ciphertext never becomes an image', async () => {
  let now = 0; const cache = new MediaCache({ maxBytes: png.length, ttlMs: 20, now: () => now, fetcher: async () => new Response('bad ciphertext') });
  cache.setBaseUrl('http://localhost:5088'); const first = cache.put(png); const second = cache.put(png);
  assert.equal(cache.get(first.split('/').at(-1)!), undefined); assert.ok(cache.get(second.split('/').at(-1)!)); now = 21; assert.equal(cache.get(second.split('/').at(-1)!), undefined);
  await assert.rejects(cache.resolve(['https://p3.douyinpic.com/a'], '0'.repeat(64)), /decrypt/);
  assert.throws(() => decodeImageBase64('file:///secret')); assert.deepEqual(decodeImageBase64(`base64://${png.toString('base64')}`), png);
  await assert.rejects(boundedBytes(new Response(new Uint8Array(10)), 9), /large/);
});
test('media downloader rejects local hosts and redirects outside platform CDNs', async () => {
  for (const url of ['http://p3.douyinpic.com/a', 'https://127.0.0.1/a', 'https://douyinpic.com.evil.test/a', 'https://user:pass@p3.douyinpic.com/a']) assert.throws(() => cdnUrl(url));
  await assert.rejects(downloadDouyinImage('https://p3.douyinpic.com/a', async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })), /Unsupported/);
});

test('maximum-size base64 validation stays bounded without regexp stack overflow', () => {
  const data = Buffer.alloc(16 * 1024 * 1024); png.copy(data);
  assert.equal(decodeImageBase64(`base64://${data.toString('base64')}`).length, data.length);
  assert.throws(() => decodeImageBase64(Buffer.concat([data,Buffer.from([0])]).toString('base64')), /large/);
  for (const bad of ['AAAA=AAA', 'AA=A', 'A===']) assert.throws(() => decodeImageBase64(bad), /Invalid/);
});
