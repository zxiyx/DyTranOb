import { createHash, createHmac, createECDH, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { ApiConnection, generateABogus, parseJsonResponse, type StoredAccount } from 'douyin-im/protocol';
import { boundedBytes, cdnUrl, decodeImageBase64, imageFormat } from '../media.js';
import type { WebSessionOptions } from './web-session.js';
import { ActionFault } from '../types.js';

type Json = Record<string, unknown>;
export function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function required(value: unknown, field: string): string { if (typeof value !== 'string' || !value) throw new Error(`Douyin response missing ${field}`); return value; }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const mac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** ImageX uses AWS Signature V4. Signing stays local; upload credentials never leave this module. */
export function signImageX(url: URL, method: string, credentials: { key: string; secret: string; token: string }, now = new Date()): Record<string, string> {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); const day = stamp.slice(0,8);
  const headers: Record<string, string> = { 'x-amz-date': stamp, 'x-amz-security-token': credentials.token };
  const signed = 'x-amz-date;x-amz-security-token';
  const query = [...url.searchParams].map(([k,v]) => `${encode(k)}=${encode(v)}`).sort().join('&');
  // All ImageX calls below use an empty body.
  const canonical = [method, '/', query, `x-amz-date:${stamp}\nx-amz-security-token:${credentials.token}\n`, signed, hash('')].join('\n');
  const scope = `${day}/cn-north-1/imagex/aws4_request`;
  const key = mac(mac(mac(mac(`AWS4${credentials.secret}`, day), 'cn-north-1'), 'imagex'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.key}/${scope}, SignedHeaders=${signed}, Signature=${mac(key, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).toString('hex')}`;
  return headers;
}
export function crc32(data: Buffer): string {
  let crc = 0xffffffff;
  for (const b of data) { crc ^= b; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** Fixed Douyin web endpoints with the logged-in account's current cookies/device profile. */
export class DouyinWebApi {
  constructor(private readonly client: ApiConnection, private readonly stored: StoredAccount, private readonly fetcher: typeof fetch = fetch, private readonly options: WebSessionOptions = {}) {}
  async request(path: string, params: Record<string, string> = {}, form?: Record<string, string>): Promise<Json> {
    if (!path.startsWith('/aweme/v1/web/') || path.includes('?')) throw new Error('Invalid Douyin API path');
    const profile = this.stored.deviceProfile;
    const ua = this.client.getUserAgent(); const windows = /Windows/.test(ua); const version = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '130.0.0.0';
    const query = new URLSearchParams({ device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1', version_code: '170400', version_name: '17.4.0', update_version_code: '170400', cookie_enabled: 'true', browser_language: 'zh-CN', browser_platform: windows ? 'Win32' : 'MacIntel', browser_name: 'Chrome', browser_version: version, browser_online: 'true', engine_name: 'Blink', engine_version: version, os_name: windows ? 'Windows' : 'Mac OS', os_version: windows ? '10' : '10.15.7', screen_width: String(profile.screenWidth ?? 1920), screen_height: String(profile.screenHeight ?? 1080), platform: 'PC', ...params });
    for (const [key, value] of Object.entries({ msToken: this.options.msToken ?? this.client.getMsToken(), webid: this.options.webId ?? this.client.jar.get('ttwid_webid'), uifid: this.options.uifid ?? this.client.jar.get('UIFID') ?? this.client.jar.get('UIFID_TEMP'), verifyFp: this.options.fp ?? this.client.jar.get('s_v_web_id'), fp: this.options.fp ?? this.client.jar.get('s_v_web_id') })) if (value) query.set(key, value);
    const body = form ? new URLSearchParams(form).toString() : '';
    query.set('a_bogus', generateABogus({ userAgent: ua, query: query.toString(), body, screenFingerprint: profile.screenFingerprint }));
    const url = `https://www.douyin.com${path}?${query}`;
    const headers: Record<string, string> = { Accept: 'application/json', Referer: /^\d{1,30}$/.test(params.aweme_id ?? '') ? `https://www.douyin.com/video/${params.aweme_id}` : 'https://www.douyin.com/', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.douyin.com' } : {}) };
    const uifid = this.options.uifid ?? this.client.jar.get('UIFID') ?? this.client.jar.get('UIFID_TEMP');
    if (uifid) headers.uifid = uifid;
    if (this.options.sessionTrait) headers['x-tt-session-dtrait'] = this.options.sessionTrait;
    if (form) {
      Object.assign(headers, this.ticketHeaders(path));
      const csrf = this.client.jar.get('passport_csrf_token'); if (csrf) headers['x-secsdk-csrf-token'] = csrf;
    }
    const response = await this.client.requestRaw(url, { method: form ? 'POST' : 'GET', headers, ...(form ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (path === '/aweme/v1/web/aweme/detail/' && response.status === 403 && response.rawText.includes('Uifid Not Found')) throw new ActionFault(1500, 'WEB_DETAIL_UIFID_REQUIRED: current browser session lacks the identity required by the web detail API');
    const result = object(parseJsonResponse(response, url, { preserveLargeIntegers: true }));
    if (Number(result.status_code) !== 0) throw new Error(`Douyin web API rejected request (status_code=${String(result.status_code).replace(/[^\d-]/g, '').slice(0,12) || 'missing'})`);
    return result;
  }
  private ticketHeaders(path: string): Record<string,string> {
    const guard = this.stored.session.desktopTicketGuard;
    const session = this.client.jar.get('sessionid') ?? '';
    if (!guard?.binding || guard.binding.sessionHash !== hash(session)) return {};
    const timestamp = Math.floor(Date.now() / 1000);
    const content = `ticket=${session}&path=${path.endsWith('/') ? path : `${path}/`}&timestamp=${timestamp}`;
    const scalar = Buffer.from(guard.privateKey, 'base64'); const ec = createECDH('prime256v1'); ec.setPrivateKey(scalar);
    const point = ec.getPublicKey(undefined, 'uncompressed');
    const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: scalar.toString('base64url'), x: point.subarray(1,33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
    const signature = sign('sha256', Buffer.from(content), { key, dsaEncoding: 'der' }).toString('base64');
    const publicKey = point.toString('base64');
    return { 'bd-ticket-guard-version': '2', 'bd-ticket-guard-web-version': '2', 'bd-ticket-guard-web-sign-type': '1', 'bd-ticket-guard-ree-public-key': publicKey, 'bd-ticket-guard-client-data': Buffer.from(JSON.stringify({ req_content: 'ticket,path,timestamp', req_sign_ree: signature, timestamp, ts_sign_ree: guard.binding.tsSignRee })).toString('base64') };
  }
  posts(secUid: string, cursor = '0', count = 20): Promise<Json> {
    return this.request('/aweme/v1/web/aweme/post/', { sec_user_id: secUid, max_cursor: cursor, count: String(count), locate_query: 'false', need_time_list: '1', time_list_query: '0', cut_version: '1', publish_video_strategy_type: '2', from_user_page: '1', show_live_replay_strategy: '1' });
  }
  async videoDetail(awemeId: string): Promise<Json> {
    const result = await this.request('/aweme/v1/web/aweme/detail/', { aweme_id: awemeId });
    const detail = object(result.aweme_detail);
    if (String(detail.aweme_id ?? '') !== awemeId) throw new Error('Douyin response missing matching aweme_detail');
    return detail;
  }
  async mobileVideoDetail(awemeId: string): Promise<Json> {
    // Fixed official public endpoints. No account cookies or authentication headers are forwarded.
    for (const host of ['api5-normal-c-hl.amemv.com', 'aweme.snssdk.com']) {
      try {
        const url = `https://${host}/aweme/v1/feed/?aweme_id=${encodeURIComponent(awemeId)}&aid=1128`;
        const response = await this.fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'com.ss.android.ugc.aweme/290101 (Linux; U; Android 10; zh_CN; Pixel 4; Build/QQ3A.200805.001; Cronet/TTNetVersion:5f9037be 2023-01-13 QuicVersion:4668bb42 2022-11-21)' } });
        if (!response.ok) { await response.body?.cancel(); continue; }
        const raw = (await boundedBytes(response, 5 * 1024 * 1024)).toString('utf8');
        const data = object(parseJsonResponse({ ok: true, status: response.status, headers: response.headers, data: raw, rawText: raw }, url, { preserveLargeIntegers: true }));
        if (Number(data.status_code) !== 0) continue;
        const detail = Array.isArray(data.aweme_list) ? data.aweme_list.map(object).find(row => String(row.aweme_id) === awemeId) : undefined;
        if (detail) return detail;
      } catch { /* A different official node may contain the requested public work. */ }
    }
    throw new ActionFault(1500, 'MOBILE_DETAIL_UNAVAILABLE: public feed did not return the requested work');
  }
  async collectPosts(secUid: string, target: number, page?: number, pageSize = 20): Promise<Json> {
    const rows: unknown[] = []; const ids = new Set<string>(); const cursors = new Set<string>(); let cursor = '0'; let more = false;
    for (let step = 1; step <= 50; step++) {
      cursors.add(cursor); const result = await this.posts(secUid, cursor, page ? pageSize : Math.min(100, target - rows.length));
      if (!Array.isArray(result.aweme_list)) throw new Error('Douyin response missing aweme_list');
      for (const row of result.aweme_list) { const id = String(object(row).aweme_id ?? ''); if (id && !ids.has(id)) { ids.add(id); if (!page || step === page) rows.push(row); } }
      const next = String(result.max_cursor ?? '0'); more = result.has_more === 1 || result.has_more === true;
      if (!more || cursors.has(next)) { cursor = next; break; }
      cursor = next;
      if (page ? step === page : rows.length >= target) break;
    }
    return { aweme_list: rows.slice(0, page ? pageSize : target), max_cursor: cursor, has_more: more, ...(page ? { page, page_size: pageSize } : { requested_count: target }), complete: page ? rows.length > 0 || !more : rows.length >= target || !more };
  }
  async comment(awemeId: string, text: string, image?: { uri: string; width: number; height: number; format: string }): Promise<Json> {
    const result = await this.request('/aweme/v1/web/comment/publish', {}, { aweme_id: awemeId, text, text_extra: '[]', one_level_comment_rank: '-1', paste_edit_method: 'non_paste', ...(image ? { image_uri_list: image.uri, image_widths: String(image.width), image_heights: String(image.height), image_formats: image.format } : {}) });
    if (!object(result.comment).cid) throw new Error('Douyin did not confirm a comment ID'); return result;
  }
  async uploadCommentImage(encoded: string): Promise<{ uri: string; width: number; height: number; format: string }> {
    const bytes = decodeImageBase64(encoded); const format = imageFormat(bytes);
    const auth = await this.request('/aweme/v1/web/comment/upload/auth/', { content_type: '0' });
    const credentials = { key: required(auth.access_key, 'access_key'), secret: required(auth.secret_key, 'secret_key'), token: required(auth.session_token, 'session_token') };
    const serviceId = required(auth.service_id, 'service_id');
    const invoke = async (action: string, method: string, extra: Record<string,string>) => {
      const url = new URL('https://imagex.bytedanceapi.com/'); url.search = new URLSearchParams({ Action: action, Version: '2018-08-01', ServiceId: serviceId, ...extra }).toString();
      const response = await this.fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { ...signImageX(url, method, credentials), 'Content-Type': 'application/json', Origin: 'https://www.douyin.com' }, ...(method === 'POST' ? { body: '' } : {}) });
      const json = object(JSON.parse((await boundedBytes(response, 1024 * 1024)).toString('utf8')));
      if (object(json.ResponseMetadata).Error || !json.Result) throw new Error('ImageX rejected upload'); return object(json.Result);
    };
    const applied = await invoke('ApplyImageUpload', 'GET', { s: randomBytes(8).toString('hex') });
    const address = object(applied.UploadAddress);
    const inner = object(applied.InnerUploadAddress);
    const node = object(Array.isArray(inner.UploadNodes) ? inner.UploadNodes[0] : undefined);
    const selected = Object.keys(node).length ? node : address;
    const info = object(Array.isArray(selected.StoreInfos) ? selected.StoreInfos[0] : selected.StoreInfos);
    const hosts = selected.UploadHosts;
    const host = required(selected.UploadHost ?? (Array.isArray(hosts) ? hosts[0] : undefined), 'UploadHost');
    const uri = required(info.StoreUri, 'StoreUri');
    const upload = cdnUrl(`https://${host}/upload/v1/${uri}`);
    const uploaded = await this.fetcher(upload, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: required(info.Auth, 'upload authorization'), 'Content-Type': 'application/octet-stream', 'content-crc32': crc32(bytes), 'Content-Disposition': 'attachment; filename="image"', 'x-storage-u': this.stored.platformUid, Origin: 'https://www.douyin.com' }, body: new Uint8Array(bytes) });
    const uploadedJson = object(JSON.parse((await boundedBytes(uploaded, 1024 * 1024)).toString('utf8')));
    if (Number(uploadedJson.code) !== 2000) throw new Error('Image storage rejected upload');
    const committed = await invoke('CommitImageUpload', 'POST', { SessionKey: required(selected.SessionKey, 'SessionKey') });
    const result = object(Array.isArray(committed.Results) ? committed.Results[0] : undefined);
    const plugin = object(Array.isArray(committed.PluginResult) ? committed.PluginResult[0] : result.PluginResult);
    const width = Number(plugin.ImageWidth); const height = Number(plugin.ImageHeight);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error('ImageX did not confirm image dimensions');
    return { uri: required(plugin.ImageUri ?? result.Uri, 'image URI'), width, height, format: typeof plugin.ImageFormat === 'string' ? plugin.ImageFormat.toLowerCase() : format };
  }
}
