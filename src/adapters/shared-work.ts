import type { MessageEvent } from 'douyin-im';
import type { SharedWork } from './types.js';

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value.slice(0, 2000) : ''; }
function id(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  return /^\d{1,30}$/.test(result) ? result : undefined;
}
/** Preserve bare int64 IDs before JSON.parse; quoted strings (including digits in titles) are untouched. */
function rawCard(value: string): Record<string, unknown> {
  try {
    const json = value.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
      return /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
    });
    return record(JSON.parse(json));
  } catch { return {}; }
}
export function sharedWork(event: MessageEvent): SharedWork | undefined {
  const raw = rawCard(event.rawContent);
  if (event.content.kind !== 'share' && ![8,77].includes(event.messageType) && Number(raw.aweType ?? raw.awe_type) !== 800) return;
  const parsed = event.content.kind === 'share' ? event.content.share : undefined;
  const rawId = raw.itemId ?? raw.aweme_id ?? raw.item_id ?? raw.awemeId;
  const itemId = rawId === undefined ? id(parsed?.itemId) : id(rawId);
  if (!itemId) return;
  const kind = event.messageType === 77 || raw.awemeType === 68 ? 'images' : 'video';
  const authorUid = id(raw.uid) ?? id(parsed?.authorUid);
  const authorSecUid = text(raw.secUID) || text(parsed?.authorSecUid);
  const conversationShortId = id(event.conversationShortId);
  return { itemId, kind, url: `https://www.douyin.com/${kind === 'images' ? 'note' : 'video'}/${itemId}`, title: text(raw.content_title ?? raw.desc ?? raw.title) || text(parsed?.title), ...(authorUid ? { authorUid } : {}), ...(authorSecUid ? { authorSecUid } : {}), ...(conversationShortId ? { conversationShortId } : {}) };
}
export function sharedWorkText(work: SharedWork): string {
  return [`[抖音${work.kind === 'images' ? '图文' : '视频'}分享]`, ...(work.title ? [`标题：${work.title}`] : []), `作品ID：${work.itemId}`, work.url].join('\n');
}
