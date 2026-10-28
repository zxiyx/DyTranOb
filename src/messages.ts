import { ActionFault, type MessageSegment } from './types.js';

function unescapeCQ(value: string, param = false): string {
  const decoded = param ? value.replace(/&#44;/g, ',') : value;
  return decoded.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}
function escapeCQ(value: string, param = false): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
  return param ? escaped.replace(/,/g, '&#44;') : escaped;
}

export function parseMessage(value: unknown, autoEscape = false): MessageSegment[] {
  if (typeof value === 'string') {
    if (!value.length) throw new ActionFault(1400, 'message must not be empty');
    if (value.length > 100000) throw new ActionFault(1400, 'message is too long');
    if (autoEscape) return [{ type: 'text', data: { text: value } }];
    const segments: MessageSegment[] = [];
    let offset = 0;
    const regex = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
    for (const match of value.matchAll(regex)) {
      if (match.index! > offset) segments.push({ type: 'text', data: { text: unescapeCQ(value.slice(offset, match.index)) } });
      const data: Record<string, string> = {};
      for (const pair of match[2]!.split(',').slice(1)) {
        const i = pair.indexOf('=');
        if (i < 1) throw new ActionFault(1400, 'Malformed CQ parameter');
        data[pair.slice(0, i)] = unescapeCQ(pair.slice(i + 1), true);
      }
      segments.push({ type: match[1]!, data });
      offset = match.index! + match[0].length;
    }
    if (offset < value.length) segments.push({ type: 'text', data: { text: unescapeCQ(value.slice(offset)) } });
    return validate(segments);
  }
  return validate(value);
}

function validate(value: unknown): MessageSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new ActionFault(1400, 'message must contain 1–100 segments');
  return value.map((segment: unknown) => {
    if (!segment || typeof segment !== 'object' || !('type' in segment) || !('data' in segment)) throw new ActionFault(1400, 'Invalid message segment');
    const { type, data } = segment;
    if (typeof type !== 'string' || !data || typeof data !== 'object' || Array.isArray(data)) throw new ActionFault(1400, 'Invalid segment type or data');
    if (!['text', 'image', 'video', 'at', 'reply'].includes(type)) throw new ActionFault(1400, `Unsupported message segment: ${type}`);
    const d = data as Record<string, unknown>;
    if (type === 'text' && (typeof d.text !== 'string' || !d.text.length)) throw new ActionFault(1400, 'text segment requires text');
    if (['image', 'video'].includes(type) && (typeof (d.file ?? d.url) !== 'string' || !String(d.file ?? d.url).length)) throw new ActionFault(1400, `${type} requires file or url`);
    if (type === 'at' && !['string', 'number'].includes(typeof d.qq)) throw new ActionFault(1400, 'at requires qq');
    if (type === 'reply' && !['string', 'number'].includes(typeof d.id)) throw new ActionFault(1400, 'reply requires id');
    return { type, data: { ...d } };
  });
}

export function toCQ(segments: MessageSegment[]): string {
  return segments.map(s => s.type === 'text' ? escapeCQ(String(s.data.text)) : `[CQ:${s.type}${Object.entries(s.data).map(([k, v]) => `,${k}=${escapeCQ(String(v), true)}`).join('')}]`).join('');
}
