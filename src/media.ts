import { randomBytes, createDecipheriv } from 'node:crypto';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const CDN_SUFFIXES = ['douyinpic.com', 'douyinstatic.com', 'byteimg.com', 'ibytedtos.com', 'bytedance.com', 'bytedance.net', 'bytedanceapi.com', 'bytecdn.cn', 'pstatp.com', 'bytecdn.com', 'volces.com'];
export function cdnUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !CDN_SUFFIXES.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) throw new Error('Unsupported Douyin media host');
  return url;
}
export async function boundedBytes(response: Response, limit = MAX_IMAGE_BYTES): Promise<Buffer> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Media request failed'); }
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Media is too large'); }
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) throw new Error('Media is too large'); chunks.push(chunk.value); }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function downloadDouyinImage(source: string, fetcher: typeof fetch = fetch, abort?: AbortSignal): Promise<Buffer> {
  let url = cdnUrl(source);
  const signal = abort ? AbortSignal.any([abort, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  for (let i = 0; i < 4; i++) {
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { Referer: 'https://www.douyin.com/' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); const location = response.headers.get('location');
      if (!location) throw new Error('Invalid media redirect'); url = cdnUrl(new URL(location, url).href); continue;
    }
    return boundedBytes(response);
  }
  throw new Error('Too many media redirects');
}
export function imageFormat(data: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0,6).toString())) return 'gif';
  if (data.length >= 12 && data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP') return 'webp';
  throw new Error('Unsupported or encrypted image format');
}
export function decodeImageBase64(value: string): Buffer {
  const encoded = value.replace(/^base64:\/\//, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const firstPadding = encoded.indexOf('=');
  // Avoid repeated capture groups: multi-megabyte images can exhaust the regexp engine's stack.
  if (!encoded.length || encoded.length % 4 !== 0 || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || /[^A-Za-z0-9+/=]/.test(encoded) || (firstPadding !== -1 && firstPadding !== encoded.length - padding)) throw new Error('Invalid image base64');
  const data = Buffer.from(encoded, 'base64'); if (data.length > MAX_IMAGE_BYTES) throw new Error('Image is too large'); imageFormat(data); return data;
}

/** Random capability URLs expose only validated cached bytes, never a fetch-by-URL endpoint. */
export class MediaCache {
  private readonly entries = new Map<string, { bytes: Buffer; type: string; expires: number }>();
  private size = 0;
  private base?: string;
  constructor(private readonly options: { maxBytes?: number; ttlMs?: number; fetcher?: typeof fetch; now?: () => number } = {}) {}
  setBaseUrl(value: string): void {
    const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid media public URL');
    this.base = url.href.replace(/\/$/, '');
  }
  put(bytes: Buffer): string {
    if (!this.base) throw new Error('Media server has not started');
    const format = imageFormat(bytes); const max = this.options.maxBytes ?? 128 * 1024 * 1024;
    if (bytes.length > MAX_IMAGE_BYTES || bytes.length > max) throw new Error('Image exceeds cache limit');
    this.prune();
    while (this.size + bytes.length > max) this.remove(this.entries.keys().next().value!);
    const key = `${randomBytes(24).toString('hex')}.${format}`;
    this.entries.set(key, { bytes: Buffer.from(bytes), type: `image/${format}`, expires: this.now() + (this.options.ttlMs ?? 3600000) }); this.size += bytes.length;
    return `${this.base}/media/${key}`;
  }
  get(key: string): { bytes: Buffer; type: string } | undefined { this.prune(); return this.entries.get(key); }
  clear(): void { this.entries.clear(); this.size = 0; }
  async resolve(urls: readonly string[], skey?: string, signal?: AbortSignal): Promise<string> {
    for (const url of [...new Set(urls)].slice(0, 4)) {
      signal?.throwIfAborted();
      try {
        let bytes = await downloadDouyinImage(url, this.options.fetcher, signal);
        // Some thumbnails are already plaintext even when the original has a key.
        try { imageFormat(bytes); } catch {
          if (!skey || !/^[a-f\d]{64}$/i.test(skey) || bytes.length < 29) throw new Error('Missing image decryption key');
          const decipher = createDecipheriv('aes-256-gcm', Buffer.from(skey, 'hex'), bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(-16)); bytes = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
        }
        return this.put(bytes);
      } catch { /* Try the next CDN variant without logging signed URLs or keys. */ }
    }
    throw new Error('Unable to download or decrypt Douyin image');
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private remove(key: string): void { const entry = this.entries.get(key); if (entry) this.size -= entry.bytes.length; this.entries.delete(key); }
  private prune(): void { for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.remove(key); }
}

/** Prefer concrete URL lists to the opaque `uri` that douyin-im 1.1.0 selects. */
export function emojiUrls(raw: unknown, parsed = ''): string[] {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  const urls: string[] = [];
  function visit(value: unknown, depth: number): void {
    if (depth > 5 || !value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const name of ['animate_url', 'url_list', 'url', 'static_url', 'uri']) {
      const child = record[name];
      if (typeof child === 'string' && /^https:\/\//.test(child)) urls.push(child);
      else if (Array.isArray(child)) for (const item of child) { if (typeof item === 'string' && /^https:\/\//.test(item)) urls.push(item); else visit(item, depth + 1); }
      else visit(child, depth + 1);
    }
  }
  visit(raw, 0); if (/^https:\/\//.test(parsed)) urls.push(parsed); return [...new Set(urls)];
}
