import type { OneBotEvent } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Render text without CQ escaping; describe media without dumping URLs or base64 data. */
export function formatMessageLog(event: OneBotEvent): string {
  const body = Array.isArray(event.message) ? event.message.map(segment => {
    if (!segment || typeof segment !== 'object') return '[未知消息]';
    const data = segment.data ?? {};
    switch (segment.type) {
      case 'text': return String(data.text ?? '');
      case 'at': return data.qq === 'all' ? '[@全体成员]' : `[@${data.qq}]`;
      case 'reply': return `[回复:${data.id}]`;
      case 'image': return '[图片]';
      case 'video': return '[视频]';
      case 'record': return '[语音]';
      case 'file': return `[文件:${data.name ?? '附件'}]`;
      default: return `[${segment.type ?? '未知消息'}]`;
    }
  }).join('') : String(event.raw_message ?? event.message ?? '');
  const sender = event.sender && typeof event.sender === 'object' ? event.sender as Record<string, unknown> : {};
  return `${event.post_type === 'message_sent' ? '发出' : '收到'}${event.message_type === 'group' ? '群聊' : '私聊'}消息 · user_id=${event.user_id}${event.group_id === undefined ? '' : ` · group_id=${event.group_id}`}${sender.nickname ? ` · 昵称=${sender.nickname}` : ''} · message_id=${event.message_id} · 内容=${body || '[空消息]'}`;
}

export function normalizeLogLevel(value: unknown): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

function safeText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Diagnostic messages may contain native errors; credentials have a separate console-only path. */
export function redactLogMessage(value: string): string {
  return safeText(value)
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(/((?:access[_-]?token|token|password|cookie|authorization|sessionid)["']?\s*[:=]\s*)(?:(?:"[^"]*")|(?:'[^']*')|[^\s,;}]+)/gi, '$1[redacted]');
}

function timestamp(date: Date): string {
  const pad = (n: number, length = 2) => String(n).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatLogLine(level: LogLevel, source: string, message: string, date = new Date(), color = false): string {
  const plainLevel = level.toUpperCase().padEnd(5);
  const colors = { debug: 90, info: 36, warn: 33, error: 31 };
  const label = color ? `\x1b[${colors[level]}m${plainLevel}\x1b[0m` : plainLevel;
  const origin = `[${safeText(source).replace(/[\r\n]/g, '').slice(0, 30)}]`.padEnd(22);
  const prefix = `[${timestamp(date)}] [${label}] ${origin} `;
  return safeText(message).split('\n').map(line => prefix + line).join('\n');
}

/** Runtime text goes to stderr, leaving action JSON and MCP stdout machine-readable. */
export class ConsoleLogger {
  constructor(private readonly options: {
    write?: (line: string) => void;
    now?: () => Date;
    color?: boolean;
  } = {}) {}

  log(level: LogLevel, source: string, message: string): void {
    this.output(level, source, redactLogMessage(message));
  }
  info(source: string, message: string): void { this.log('info', source, message); }
  warn(source: string, message: string): void { this.log('warn', source, message); }
  error(source: string, message: string): void { this.log('error', source, message); }

  credential(source: string, label: string, token: string): void {
    // Never route this through runtime diagnostics, event subscribers or persistent logs.
    this.output('info', source, `${label} ${safeText(token).replace(/[\r\n]/g, '')}`);
  }

  private output(level: LogLevel, source: string, message: string): void {
    const color = this.options.color ?? Boolean(process.stderr.isTTY && !process.env.NO_COLOR);
    const line = formatLogLine(level, source, message, this.options.now?.() ?? new Date(), color) + '\n';
    try { (this.options.write ?? (value => { process.stderr.write(value); }))(line); }
    catch { /* Console output must not fail a native message or shutdown. */ }
  }
}
