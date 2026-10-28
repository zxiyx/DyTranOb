import { boundedBytes } from '../media.js';
import { ActionFault } from '../types.js';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const str = (value: unknown) => typeof value === 'string' ? value : '';
export interface SubtitleTrack { index: number; language: string; format: string; urls: string[] }
export interface SubtitleCue { start: number; end: number; text: string }
export interface SubtitleResult { aweme_id: string; tracks: SubtitleTrack[]; available: boolean; reason: 'no_subtitle_metadata' | 'language_unavailable' | null; text: string; cues: SubtitleCue[]; track_index?: number; language?: string }
const CDN = ['douyinstatic.com', 'bytednsdoc.com', 'bytecdn.cn', 'bytecdn.com', 'ibytedtos.com', 'bytedance.com', 'pstatp.com', 'douyinvod.com', 'volces.com'];
export function subtitleUrl(value: string): URL {
  const url = new URL(value.startsWith('//') ? `https:${value}` : value);
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !CDN.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Untrusted subtitle host');
  return url;
}
export function subtitleTracks(detail: Json): SubtitleTrack[] {
  const video = obj(detail.video); const cla = obj(video.cla_info ?? video.claInfo);
  const tracks: SubtitleTrack[] = []; const seen = new Set<string>();
  for (const source of [cla.caption_info, cla.caption_infos, cla.captionInfos, cla.captions, video.subtitle_infos, video.subtitleInfos]) {
    for (const raw of Array.isArray(source) ? source : source ? [source] : []) {
      const cap = obj(raw); const list = cap.url_list ?? cap.urlList;
      const urls = [...new Set([cap.url, cap.subtitle_url, ...(Array.isArray(list) ? list : [])].filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192))].slice(0, 3);
      if (!urls.length || seen.has(urls[0]!)) continue;
      seen.add(urls[0]!);
      tracks.push({ index: tracks.length, language: str(cap.language_code ?? cap.languageCode ?? cap.language ?? cap.lang), format: str(cap.format ?? cap.format_type), urls });
      if (tracks.length === 32) return tracks;
    }
  }
  return tracks;
}
function clean(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, v => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[v]!)).trim();
}
function seconds(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}
export function parseSubtitles(raw: string): SubtitleCue[] {
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('Subtitle exceeds 2 MiB');
  const input = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(); const cues: SubtitleCue[] = [];
  const add = (start: number, end: number, text: unknown) => {
    const value = clean(str(text));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || !value) return;
    cues.push({ start, end, text: value });
    if (cues.length > 20000) throw new Error('Too many subtitle cues');
  };
  if (/^[{[]/.test(input)) {
    const json: unknown = JSON.parse(input); const root = obj(json);
    // Douyin/ASR utterance timestamps use milliseconds; normalized cues/body use seconds.
    const utterances = root.utterances ?? obj(root.result).utterances;
    const rows = Array.isArray(utterances) ? utterances : Array.isArray(json) ? json : root.cues ?? root.body;
    if (Array.isArray(rows)) for (const row of rows) {
      const item = obj(row); const millis = Array.isArray(utterances) || item.start_time !== undefined;
      add(Number(item.start_time ?? item.start ?? item.from) / (millis ? 1000 : 1), Number(item.end_time ?? item.end ?? item.to) / (millis ? 1000 : 1), item.text ?? item.content);
    }
  } else {
    const timing = /^((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(?:\s.*)?$/;
    for (const block of input.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] ?? '')) continue;
      const index = lines.findIndex(line => timing.test(line.trim()));
      if (index < 0) continue;
      const match = timing.exec(lines[index]!.trim())!;
      add(seconds(match[1]!), seconds(match[2]!), lines.slice(index + 1).join('\n'));
    }
  }
  if (!cues.length) throw new Error('Subtitle has no supported timed text');
  cues.sort((a, b) => a.start - b.start);
  if (cues.reduce((size, cue) => size + cue.text.length, 0) > 500000) throw new Error('Subtitle text exceeds limit');
  return cues;
}
export async function readSubtitles(detail: Json, options: { language?: string; track_index?: number } = {}, fetcher: typeof fetch = fetch): Promise<SubtitleResult> {
  const tracks = subtitleTracks(detail);
  const base = { aweme_id: String(detail.aweme_id), tracks };
  if (!tracks.length) return { ...base, available: false, reason: 'no_subtitle_metadata', text: '', cues: [] };
  let track: SubtitleTrack | undefined;
  if (options.track_index !== undefined) {
    track = tracks[options.track_index];
    if (!track) throw new ActionFault(1400, 'SUBTITLE_TRACK_NOT_FOUND: refresh dy_get_video_detail and use a valid track index');
  } else if (options.language) {
    track = tracks.find(t => t.language.toLowerCase() === options.language!.toLowerCase());
    if (!track) return { ...base, available: false, reason: 'language_unavailable', text: '', cues: [] };
  } else track = tracks.find(t => /^(zh|cmn)(-|$)/i.test(t.language)) ?? tracks[0];
  const signal = AbortSignal.timeout(30000);
  for (const candidate of track!.urls) {
    try {
      let url = subtitleUrl(candidate);
      for (let hop = 0; hop <= 3; hop++) {
        const response = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: 'text/vtt, application/json, text/plain, */*', Referer: 'https://www.douyin.com/' } });
        if ([301,302,303,307,308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || hop === 3) throw new Error('Invalid subtitle redirect');
          url = subtitleUrl(new URL(location, url).href); continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error('Subtitle HTTP failure'); }
        const cues = parseSubtitles((await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
        return { ...base, available: true, reason: null, track_index: track!.index, language: track!.language, text: cues.map(c => c.text).join('\n'), cues };
      }
    } catch { if (signal.aborted) break; }
  }
  throw new ActionFault(1500, 'SUBTITLE_DOWNLOAD_FAILED: subtitle URL expired, host unsupported, network failed, or subtitle format invalid; refresh detail and retry once');
}
