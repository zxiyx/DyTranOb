import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CookieJar } from 'douyin-im/protocol';

const header = z.string().max(32768).regex(/^[^\r\n]*$/);
const cookieValue = z.string().min(1).max(32768).regex(/^[\x21-\x3A\x3C-\x7E]+$/);
const schema = z.object({
  cookies: header.optional(), userAgent: header.optional(), msToken: header.optional(),
  webId: z.string().regex(/^\d{1,30}$/).optional(), uifid: cookieValue.optional(), fp: cookieValue.optional(), sessionTrait: header.optional(),
  UIFID: cookieValue.optional(), ttwid: cookieValue.optional(), s_v_web_id: cookieValue.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.UIFID && value.uifid && value.UIFID !== value.uifid) ctx.addIssue({ code: 'custom', path: ['UIFID'], message: 'Conflicting browser identity fields' });
  if (value.s_v_web_id && value.fp && value.s_v_web_id !== value.fp) ctx.addIssue({ code: 'custom', path: ['s_v_web_id'], message: 'Conflicting browser identity fields' });
}).transform(({ UIFID, s_v_web_id, ...value }) => ({ ...value, ...(UIFID ? { uifid: UIFID } : {}), ...(s_v_web_id ? { fp: s_v_web_id } : {}) }));
export type WebSessionOptions = z.infer<typeof schema>;
/** Browser cookies replace the IM cookie set when supplied. Explicit identity values override stale cookie values. */
export function resolveWebSession(options: WebSessionOptions, fallbackCookies: string): WebSessionOptions {
  const jar = new CookieJar(options.cookies ?? fallbackCookies);
  if (options.uifid) jar.set('UIFID', options.uifid);
  if (options.fp) jar.set('s_v_web_id', options.fp);
  if (options.ttwid) jar.set('ttwid', options.ttwid);
  return { ...options, cookies: jar.toHeader() };
}
/** Optional web-specific session fields; never exposed by the management API. */
export async function loadWebSession(dataDir: string): Promise<WebSessionOptions> {
  let raw: string;
  try { raw = await readFile(join(dataDir, 'web-session.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Unable to read web-session.json'); }
  if (raw.length > 65536) throw new Error('web-session.json is too large');
  try { return schema.parse(JSON.parse(raw.replace(/^\uFEFF/, ''))); }
  catch { throw new Error('Invalid web-session.json; see developer documentation'); }
}
