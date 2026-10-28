import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsoleLogger, formatLogLine, formatMessageLog } from '../src/logger.js';

test('console records align timestamp, level and source, including multiline errors', () => {
  const date = new Date(2026, 9, 26, 12, 34, 56, 7);
  const info = formatLogLine('info', 'WebUI', 'ready', date);
  const error = formatLogLine('error', 'HTTP', 'failed\nreason', date);
  assert.match(info, /^\[12:34:56\.007\] \[INFO \] \[WebUI\]\s+ready$/);
  for (const line of error.split('\n')) assert.match(line, /^\[12:34:56\.007\] \[ERROR\] \[HTTP\]\s+/);
  assert.equal(info.indexOf('ready'), error.indexOf('failed'));
});

test('message logs include readable incoming/outgoing content, group context and segment summaries', () => {
  const event = { time: 1, self_id: 1, post_type: 'message' as const, message_type: 'group', user_id: 5, group_id: 8, message_id: 208,
    sender: { nickname: '测试用户' }, message: [
      { type: 'text', data: { text: '你好 [世界] & 第二行\n继续\x1b[31m' } },
      { type: 'image', data: { file: 'base64://huge-private-data' } },
      { type: 'video', data: { url: 'https://example.test/private-video' } },
      { type: 'at', data: { qq: 9 } }, { type: 'reply', data: { id: 7 } },
    ] };
  const records: string[] = [];
  new ConsoleLogger({ write: line => records.push(line), color: false }).info('Account:001', formatMessageLog(event));
  assert.match(records[0]!, /收到群聊消息 · user_id=5 · group_id=8 · 昵称=测试用户 · message_id=208 · 内容=你好 \[世界\] & 第二行/);
  assert.match(records[0]!, /继续\[图片\]\[视频\]\[@9\]\[回复:7\]/);
  assert(!records[0]!.includes('private'));
  assert(!records[0]!.includes('\x1b'));
  assert.match(records[0]!.split('\n')[1]!, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO \] \[Account:001\]/);
  assert.match(formatMessageLog({ ...event, post_type: 'message_sent', message_type: 'private', group_id: undefined, message: '回复正文' }), /发出私聊消息.*内容=回复正文/);
});

test('diagnostics redact secrets while explicit startup credentials stay console-only', () => {
  const records: string[] = [];
  const logger = new ConsoleLogger({ write: line => records.push(line), color: false });
  logger.warn('Native', 'token=very-secret authorization: Bearer another-secret');
  assert(!records[0]!.includes('very-secret'));
  assert(!records[0]!.includes('another-secret'));
  logger.info('WebUI', '输入 Token 登录工作空间');
  assert.match(records.pop()!, /输入 Token 登录工作空间/);
  logger.credential('WebUI', 'WebUI Token', 'actual-login-token');
  assert.match(records[1]!, /WebUI Token actual-login-token/);
  logger.info('Name\n\x1b[31mINJECT', 'hello\x07\x1b[31m');
  assert(!records[2]!.includes('\x1b'));
  assert(!records[2]!.includes('\x07'));
  assert.equal(records[2]!.trimEnd().split('\n').length, 1);
});
