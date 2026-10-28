import { EventEmitter } from 'node:events';
import { RuntimeStore } from './store.js';
import { parseMessage, toCQ } from './messages.js';
import { ActionFault, type ActionDefinition, type ActionRequest, type ActionResponse, type MessageSegment, type OneBotEvent } from './types.js';
import type { NativeAdapter, NativeEvent, NativeMessage, NativeSegment, NativeUser } from './adapters/types.js';
import { EXTENSION_ACTIONS, isExtensionAction, extensionParams } from './extensions.js';
import { decodeImageBase64 } from './media.js';

interface AccountState {
  id: string;
  adapter: NativeAdapter;
  self?: NativeUser;
  listener: (event: NativeEvent) => void;
  diagnostic: (value: { level: string; message: string; source?: string }) => void;
  queue: Promise<void>;
}

export interface RuntimeOptions {
  dataDir: string;
  accounts: Array<{ id: string; adapter: NativeAdapter }>;
}

const idSchema = { type: 'integer', minimum: 1 };
const stringSchema = { type: 'string', minLength: 1 };
const messageSchema = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] };
function definition(action: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ActionDefinition {
  return { action, description, params: { type: 'object', properties, required, additionalProperties: false } };
}
export const ACTIONS: ActionDefinition[] = [
  ...EXTENSION_ACTIONS,
  definition('get_version_info', '运行时版本'),
  definition('get_status', '账号在线状态'),
  definition('get_login_info', '当前登录用户'),
  definition('get_friend_list', '好友列表'),
  definition('get_group_list', '群列表'),
  definition('get_group_info', '查询群信息', { group_id: idSchema, no_cache: { type: 'boolean' } }, ['group_id']),
  definition('get_group_member_list', '群成员列表', { group_id: idSchema }, ['group_id']),
  definition('get_group_member_info', '查询群成员', { group_id: idSchema, user_id: idSchema, no_cache: { type: 'boolean' } }, ['group_id', 'user_id']),
  definition('get_stranger_info', '查询已知用户资料（当前好友）', { user_id: idSchema, no_cache: { type: 'boolean' } }, ['user_id']),
  definition('send_private_msg', '发送私信', { user_id: idSchema, message: messageSchema, auto_escape: { type: 'boolean' } }, ['user_id', 'message']),
  definition('send_group_msg', '发送群消息', { group_id: idSchema, message: messageSchema, auto_escape: { type: 'boolean' } }, ['group_id', 'message']),
  definition('send_msg', '发送消息', { message_type: { enum: ['private', 'group'] }, user_id: idSchema, group_id: idSchema, message: messageSchema, auto_escape: { type: 'boolean' } }, ['message']),
  definition('get_msg', '读取本地消息缓存', { message_id: idSchema }, ['message_id']),
  definition('delete_msg', '撤回消息', { message_id: idSchema }, ['message_id']),
  definition('set_group_name', '修改群名（原生适配器暂不支持）', { group_id: idSchema, group_name: stringSchema }, ['group_id', 'group_name']),
  definition('set_group_leave', '退出群组', { group_id: idSchema, is_dismiss: { type: 'boolean' } }, ['group_id']),
  definition('set_group_kick', '移除群成员', { group_id: idSchema, user_id: idSchema, reject_add_request: { type: 'boolean' } }, ['group_id', 'user_id']),
  definition('set_friend_add_request', '处理好友申请（原生适配器暂不支持）', { flag: stringSchema, approve: { type: 'boolean' }, remark: { type: 'string' } }, ['flag']),
  definition('set_group_add_request', '审核加群申请', { flag: stringSchema, sub_type: { enum: ['add', 'invite'] }, type: { enum: ['add', 'invite'] }, approve: { type: 'boolean' }, reason: { type: 'string' } }, ['flag']),
  definition('can_send_image', '是否提供图片动作'),
  definition('can_send_record', '是否提供语音动作'),
  definition('dy_list_accounts', '列出运行中的账号'),
  definition('dy_get_capabilities', '动作及消息段兼容范围'),
  definition('dy_resolve_id', '将原生字符串 ID 映射为 OneBot ID', { kind: { enum: ['user', 'group', 'message'] }, native_id: stringSchema }, ['kind', 'native_id']),
  definition('dy_get_native_id', '还原原生字符串 ID', { kind: { enum: ['user', 'group', 'message'] }, id: idSchema }, ['kind', 'id']),
];

function textParam(params: Record<string, unknown>, key: string): string {
  if (typeof params[key] !== 'string' || !params[key].length || params[key].length > 10000) throw new ActionFault(1400, `${key} must be a nonempty string`);
  return params[key];
}
function booleanParam(params: Record<string, unknown>, key: string, fallback = false): boolean {
  if (params[key] === undefined) return fallback;
  if (typeof params[key] !== 'boolean') throw new ActionFault(1400, `${key} must be boolean`);
  return params[key];
}

export class Runtime extends EventEmitter {
  private readonly store: RuntimeStore;
  private readonly state = new Map<string, AccountState>();
  private readonly history: OneBotEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private shutdown?: Promise<void>;
  private stopped = false;
  private started = false;

  constructor(options: RuntimeOptions) {
    super();
    if (!options.accounts.length || new Set(options.accounts.map(a => a.id)).size !== options.accounts.length) throw new Error('At least one uniquely named account is required');
    this.store = new RuntimeStore(options.dataDir);
    for (const { id, adapter } of options.accounts) this.state.set(id, this.accountState(id, adapter));
  }

  private accountState(id: string, adapter: NativeAdapter): AccountState {
    const account: AccountState = {
      id, adapter, queue: Promise.resolve(),
      listener: event => {
        account.queue = account.queue.then(() => this.onNativeEvent(account, event)).catch(error => this.reportError(id, error));
      },
      diagnostic: value => this.emit('diagnostic', { level: value.level, source: `Account:${id}`, message: this.redact(value.message) }),
    };
    return account;
  }

  private async attachAccount(account: AccountState): Promise<void> {
    account.adapter.on('event', account.listener);
    account.adapter.on('diagnostic', account.diagnostic);
    try {
      await account.adapter.connect();
      if (account.adapter.isOnline()) await this.selfId(account);
    } catch (error) { this.reportError(account.id, error); }
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Runtime is stopped');
    if (this.started) return;
    this.started = true;
    await Promise.all([...this.state.values()].map(account => this.attachAccount(account)));
  }

  /** Adds an account while running; its adapter connects (or restores a saved session) immediately. */
  async addAccount(id: string, adapter: NativeAdapter): Promise<void> {
    if (this.stopped) throw new ActionFault(1500, 'Runtime is stopped');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new ActionFault(1400, 'Account ID must be 1–64 letters, digits, _ or -');
    if (this.state.has(id)) throw new ActionFault(1409, 'Account ID already exists');
    const account = this.accountState(id, adapter);
    this.state.set(id, account);
    if (this.started) await this.attachAccount(account);
    this.emit('accounts', this.accounts());
  }

  /** Stops an account's adapter. Its local session data stays on disk so it can be added back. */
  async removeAccount(id: string): Promise<void> {
    const account = this.accountById(id);
    if (this.state.size === 1) throw new ActionFault(1400, 'At least one account must remain');
    this.state.delete(id);
    account.adapter.off('event', account.listener);
    account.adapter.off('diagnostic', account.diagnostic);
    await account.queue;
    try { await account.adapter.disconnect(); } catch (error) { this.reportError(id, error); }
    if (account.self) this.publish({ time: Math.floor(Date.now() / 1000), self_id: this.store.id(id, 'user', account.self.id), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable', account_id: id });
    this.emit('accounts', this.accounts());
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    this.shutdown = this.shutdownRuntime();
    return this.shutdown;
  }

  private async shutdownRuntime(): Promise<void> {
    // Accepted actions may already have changed the platform; preserve their acknowledgements.
    await Promise.allSettled([...this.inFlight]);
    for (const account of this.state.values()) {
      account.adapter.off('event', account.listener);
      account.adapter.off('diagnostic', account.diagnostic);
    }
    await Promise.allSettled([...this.state.values()].map(async account => { await account.queue; await account.adapter.disconnect(); }));
    this.store.close();
  }

  accounts(): Array<{ id: string; kind: string; online: boolean; self_id?: number; nickname?: string }> {
    return [...this.state.values()].map(a => ({ id: a.id, kind: a.adapter.kind, online: a.adapter.isOnline(), ...(a.self ? { self_id: this.store.id(a.id, 'user', a.self.id), nickname: a.self.nickname } : {}) }));
  }
  recentEvents(limit = 100): OneBotEvent[] {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : 0;
    return count === 0 ? [] : structuredClone(this.history.slice(-count));
  }
  actions(): ActionDefinition[] { return structuredClone(ACTIONS); }
  async startQrLogin(accountId: string): Promise<unknown> {
    if (this.stopped) throw new ActionFault(1500, 'Runtime is stopped');
    return this.track(this.accountById(accountId).adapter.startQrLogin());
  }
  async loginState(accountId: string): Promise<unknown> { return this.accountById(accountId).adapter.getLoginState(); }

  execute(request: ActionRequest): Promise<ActionResponse> { return this.track(this.executeRequest(request)); }

  private track<T>(task: Promise<T>): Promise<T> {
    this.inFlight.add(task);
    void task.then(() => this.inFlight.delete(task), () => this.inFlight.delete(task));
    return task;
  }

  private async executeRequest(request: ActionRequest): Promise<ActionResponse> {
    let echo: Record<string, unknown> = {};
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new ActionFault(1400, 'Action request must be an object');
      if (Object.hasOwn(request, 'echo')) echo = { echo: request.echo };
      if (this.stopped) throw new ActionFault(1500, 'Runtime is stopped');
      if (typeof request.action !== 'string' || !ACTIONS.some(a => a.action === request.action)) throw new ActionFault(1404, 'Unsupported action');
      const params = request.params === undefined ? {} : request.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ActionFault(1400, 'params must be an object');
      const data = await this.dispatch(request.action, params, request);
      return { status: 'ok', retcode: 0, data: data ?? null, ...echo };
    } catch (error) {
      const unsupported = error instanceof Error && (error.name === 'UnsupportedAdapterOperation' || (error as Error & { code?: string }).code === 'UNSUPPORTED_OPERATION');
      const fault = error instanceof ActionFault ? error : unsupported ? new ActionFault(1404, this.redact((error as Error).message)) : new ActionFault(1500, 'Native operation failed; consult local diagnostics');
      if (!(error instanceof ActionFault) && !unsupported) this.reportError(request?.account_id ?? 'runtime', error);
      return { status: 'failed', retcode: fault.retcode, data: null, message: fault.message, wording: fault.message, ...echo };
    }
  }

  private async dispatch(action: string, p: Record<string, unknown>, request: ActionRequest): Promise<unknown> {
    if (action === 'get_version_info') return { app_name: 'DyTranOb', app_version: '0.1.0', protocol_version: 'v11', impl: 'douyin-im' };
    if (action === 'dy_list_accounts') return this.accounts();
    if (action === 'dy_get_capabilities') return {
      platform: 'douyin', onebot_version: '11', actions: ACTIONS.map(a => a.action),
      segments: ['text', 'image', 'video', 'at', 'reply'],
      image_chains: { split_in_order: true, max_parts: 20, result_message_id: 'last', additional_ids: 'message_ids' },
      shared_works: { text_includes: ['item_id', 'title', 'url'], metadata: 'dy.work', detail_action: 'dy_get_video_detail', subtitle_action: 'dy_get_video_subtitles', conversation_context: 'dy.work.conversation_short_id', documentation: '/docs/astrbot.md' },
      limitations: ['Not all segment combinations are supported by the native SDK', 'set_group_name and set_friend_add_request are unavailable on douyin-im 1.1.0', 'get_msg reads the local 5000-message cache', 'QQ-only features and voice are unsupported'],
    };
    if (action === 'get_status' && request.account_id === undefined && request.self_id === undefined) {
      const accounts = this.accounts(); return { online: accounts.some(a => a.online), good: accounts.every(a => a.online), accounts };
    }
    const a = await this.selectAccount(request);
    if (action === 'get_status') return { online: a.adapter.isOnline(), good: a.adapter.isOnline() };
    if (action === 'dy_resolve_id' || action === 'dy_get_native_id') {
      const kind = p.kind;
      if (kind !== 'user' && kind !== 'group' && kind !== 'message') throw new ActionFault(1400, 'kind must be user, group or message');
      return action === 'dy_resolve_id' ? { id: this.store.id(a.id, kind, textParam(p, 'native_id')) } : { native_id: this.store.native(a.id, kind, p.id) };
    }
    if (action === 'can_send_image') return { yes: true };
    if (action === 'can_send_record') return { yes: false };
    if (action === 'get_msg') {
      const event = this.store.message(a.id, p.message_id);
      return { time: event.time, message_type: event.message_type, message_id: event.message_id, real_id: event.message_id, sender: event.sender, message: event.message, raw_message: event.raw_message, dy: event.dy, ...(event.group_id ? { group_id: event.group_id } : {}) };
    }
    if (!a.adapter.isOnline()) throw new ActionFault(1503, 'Account is offline; restore its session or complete QR login');
    if (isExtensionAction(action)) {
      const result = await a.adapter.executeExtension(action, extensionParams(action, p));
      if (result.message) {
        const event = await this.messageEvent(a, result.message); this.publishMessage(a, result.message.id, event);
        return { ...(result.data as Record<string, unknown>), message_id: event.message_id };
      }
      return result.data;
    }
    if (action === 'get_login_info') { const self = await a.adapter.getSelf(); return { user_id: this.store.id(a.id, 'user', self.id), nickname: self.nickname }; }
    if (action === 'get_friend_list') return (await a.adapter.getFriends()).map(u => this.user(a, u));
    if (action === 'get_group_list' || action === 'get_group_info') {
      const groups = await a.adapter.getGroups();
      const rows = groups.map(g => ({ group_id: this.store.id(a.id, 'group', g.id), group_name: g.name, member_count: g.memberCount ?? 0, max_member_count: 0 }));
      if (action === 'get_group_list') return rows;
      const native = this.store.native(a.id, 'group', p.group_id);
      const group = rows.find((_, i) => groups[i]!.id === native);
      if (!group) throw new ActionFault(1404, 'Group not found'); return group;
    }
    if (action === 'get_group_member_list' || action === 'get_group_member_info') {
      const members = await a.adapter.getGroupMembers(this.store.native(a.id, 'group', p.group_id));
      const rows = members.map(u => ({ ...this.user(a, u), group_id: Number(p.group_id), card: '', role: 'member', sex: 'unknown', age: 0, area: '', level: '', title: '', unfriendly: false, card_changeable: false }));
      if (action === 'get_group_member_list') return rows;
      const userId = this.store.native(a.id, 'user', p.user_id);
      const row = rows.find((_, i) => members[i]!.id === userId);
      if (!row) throw new ActionFault(1404, 'Member not found'); return row;
    }
    if (action === 'get_stranger_info') {
      const native = this.store.native(a.id, 'user', p.user_id);
      const user = (await a.adapter.getFriends()).find(u => u.id === native);
      if (!user) throw new ActionFault(1404, 'User is outside the known friend list');
      return { ...this.user(a, user), sex: 'unknown', age: 0 };
    }
    if (['send_private_msg', 'send_group_msg', 'send_msg'].includes(action)) {
      let group = action === 'send_group_msg';
      if (action === 'send_msg') {
        if (p.message_type !== undefined && p.message_type !== 'private' && p.message_type !== 'group') throw new ActionFault(1400, 'message_type must be private or group');
        if (p.message_type === undefined && p.group_id !== undefined && p.user_id !== undefined) throw new ActionFault(1400, 'Specify message_type when both user_id and group_id are supplied');
        group = p.message_type === 'group' || (p.message_type === undefined && p.group_id !== undefined);
      }
      const target = group ? { groupId: this.store.native(a.id, 'group', p.group_id) } : { userId: this.store.native(a.id, 'user', p.user_id) };
      const segments = this.toNative(a, parseMessage(p.message, booleanParam(p, 'auto_escape')));
      const ids: number[] = [];
      try {
        await a.adapter.sendMessages(target, segments, async result => {
          const event = await this.messageEvent(a, { ...result, self: true });
          this.publishMessage(a, result.id, event); ids.push(event.message_id as number);
        });
      } catch (error) {
        if (!ids.length) throw error;
        this.reportError(a.id, error);
        throw new ActionFault(1500, `Partial delivery: ${ids.length} message(s) sent; message_ids=${ids.join(',')}. Remaining parts were not sent. Do not retry the entire message.`);
      }
      if (!ids.length) throw new ActionFault(1500, 'Adapter did not confirm a sent message');
      return { message_id: ids.at(-1), ...(ids.length > 1 ? { message_ids: ids } : {}) };
    }
    if (action === 'delete_msg') { await a.adapter.deleteMessage(this.store.native(a.id, 'message', p.message_id)); return null; }
    if (action === 'set_group_name') { await a.adapter.setGroupName(this.store.native(a.id, 'group', p.group_id), textParam(p, 'group_name')); return null; }
    if (action === 'set_group_leave') {
      if (booleanParam(p, 'is_dismiss')) throw new ActionFault(1404, 'Group dismissal is unsupported');
      await a.adapter.leaveGroup(this.store.native(a.id, 'group', p.group_id)); return null;
    }
    if (action === 'set_group_kick') {
      if (booleanParam(p, 'reject_add_request')) throw new ActionFault(1404, 'reject_add_request is unsupported');
      await a.adapter.kickGroupMember(this.store.native(a.id, 'group', p.group_id), this.store.native(a.id, 'user', p.user_id)); return null;
    }
    if (action === 'set_friend_add_request' || action === 'set_group_add_request') {
      if (p.remark || p.reason) throw new ActionFault(1404, 'Request remarks and rejection reasons are unsupported');
      if (p.sub_type === 'invite' || p.type === 'invite') throw new ActionFault(1404, 'Group invitation approval is unsupported');
      await a.adapter.handleRequest(action === 'set_friend_add_request' ? 'friend' : 'group', textParam(p, 'flag'), booleanParam(p, 'approve', true)); return null;
    }
    throw new ActionFault(1404, 'Unsupported action');
  }

  private accountById(id: string): AccountState {
    const account = this.state.get(id);
    if (!account) throw new ActionFault(1404, 'Unknown account_id');
    return account;
  }
  private async selectAccount(request: ActionRequest): Promise<AccountState> {
    if (request.account_id !== undefined) {
      const a = this.accountById(request.account_id);
      if (request.self_id !== undefined && request.self_id !== await this.selfId(a)) throw new ActionFault(1400, 'account_id and self_id refer to different accounts');
      return a;
    }
    if (request.self_id !== undefined) {
      if (!Number.isSafeInteger(request.self_id) || request.self_id < 1) throw new ActionFault(1400, 'self_id must be a positive integer');
      for (const a of this.state.values()) if (a.self && this.store.id(a.id, 'user', a.self.id) === request.self_id) return a;
      throw new ActionFault(1404, 'Unknown self_id');
    }
    if (this.state.size === 1) return this.state.values().next().value!;
    // Several configured accounts but only one logged in: that one is the unambiguous default.
    const online = [...this.state.values()].filter(a => a.adapter.isOnline());
    if (online.length === 1) return online[0]!;
    throw new ActionFault(1400, 'Multiple accounts: specify account_id or self_id');
  }
  private async selfId(a: AccountState): Promise<number> {
    if (!a.self) a.self = await a.adapter.getSelf();
    return this.store.id(a.id, 'user', a.self.id);
  }
  private user(a: AccountState, u: NativeUser) { return { user_id: this.store.id(a.id, 'user', u.id), nickname: u.nickname, remark: '' }; }

  private toNative(a: AccountState, segments: MessageSegment[]): NativeSegment[] {
    return segments.map(s => {
      if (s.type === 'text') return { type: 'text', text: String(s.data.text) };
      if (s.type === 'at') return { type: 'at', userId: s.data.qq === 'all' ? 'all' : this.store.native(a.id, 'user', s.data.qq) };
      if (s.type === 'reply') return { type: 'reply', messageId: this.store.native(a.id, 'message', s.data.id) };
      const url = String(s.data.file ?? s.data.url);
      if (s.type === 'image' && url.startsWith('base64://')) {
        try { decodeImageBase64(url); } catch { throw new ActionFault(1400, 'Invalid or oversized base64 image'); }
        return { type: 'image', url };
      }
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new ActionFault(1400, 'Media requires an HTTP(S) URL'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ActionFault(1400, 'Media requires an HTTP(S) URL without credentials');
      return { type: s.type as 'image' | 'video', url };
    });
  }

  private fromNative(a: AccountState, segments: NativeSegment[]): MessageSegment[] {
    return segments.map(s => {
      if (s.type === 'text') return { type: 'text', data: { text: s.text ?? '' } };
      if (s.type === 'at') return { type: 'at', data: { qq: s.userId === 'all' ? 'all' : this.store.id(a.id, 'user', s.userId!) } };
      if (s.type === 'reply') return { type: 'reply', data: { id: this.store.id(a.id, 'message', s.messageId!) } };
      return { type: s.type, data: { file: s.url ?? '', url: s.url ?? '' } };
    });
  }

  private async messageEvent(a: AccountState, m: NativeMessage): Promise<OneBotEvent> {
    const selfId = await this.selfId(a);
    const segments = this.fromNative(a, m.segments);
    const userId = this.store.id(a.id, 'user', m.userId);
    const event: OneBotEvent = {
      time: Math.floor(m.time > 1e12 ? m.time / 1000 : m.time), self_id: selfId,
      post_type: m.self || m.userId === a.self!.id ? 'message_sent' : 'message',
      message_type: m.groupId ? 'group' : 'private', sub_type: m.groupId ? 'normal' : 'friend',
      message_id: this.store.id(a.id, 'message', m.id), user_id: userId,
      message: segments, raw_message: toCQ(segments), font: 0,
      sender: { user_id: userId, nickname: m.nickname ?? '', sex: 'unknown', age: 0, ...(m.groupId ? { role: 'member', card: '' } : {}) },
      ...(m.groupId ? { group_id: this.store.id(a.id, 'group', m.groupId), anonymous: null } : {}),
      account_id: a.id,
      dy: { message_id: m.id, user_id: m.userId, ...(m.groupId ? { group_id: m.groupId } : {}), ...(m.sharedWork ? { work: { item_id: m.sharedWork.itemId, kind: m.sharedWork.kind, url: m.sharedWork.url, title: m.sharedWork.title, ...(m.sharedWork.authorUid ? { author_uid: m.sharedWork.authorUid } : {}), ...(m.sharedWork.authorSecUid ? { author_sec_uid: m.sharedWork.authorSecUid } : {}), ...(m.sharedWork.conversationShortId ? { conversation_short_id: m.sharedWork.conversationShortId } : {}) } } : {}) },
    };
    this.store.saveMessage(a.id, event);
    return event;
  }

  private publishMessage(a: AccountState, nativeId: string, event: OneBotEvent): void {
    const key = JSON.stringify([a.id, nativeId]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
    this.publish(event);
  }
  private publish(event: OneBotEvent): void {
    this.history.push(structuredClone(event));
    if (this.history.length > 200) this.history.shift();
    this.emit('event', structuredClone(event));
  }
  private async onNativeEvent(a: AccountState, e: NativeEvent): Promise<void> {
    if (e.type === 'connection') {
      if (e.online) { a.self = await a.adapter.getSelf(); await this.selfId(a); }
      if (a.self) this.publish({ time: Math.floor(Date.now() / 1000), self_id: await this.selfId(a), post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: e.online ? 'enable' : 'disable', account_id: a.id });
      return;
    }
    if (e.type === 'message') { this.publishMessage(a, e.message.id, await this.messageEvent(a, e.message)); return; }
    const base = { time: Math.floor(Date.now() / 1000), self_id: await this.selfId(a), user_id: this.store.id(a.id, 'user', e.userId), account_id: a.id };
    const group = e.groupId ? { group_id: this.store.id(a.id, 'group', e.groupId) } : {};
    if (e.type === 'notice') {
      const notice = e.notice === 'message_recall' ? (e.groupId ? 'group_recall' : 'friend_recall') : e.notice;
      this.publish({ ...base, ...group, post_type: 'notice', notice_type: notice,
        ...(['group_increase', 'group_decrease'].includes(notice) ? { sub_type: notice === 'group_increase' ? 'approve' : 'leave' } : {}),
        ...(e.operatorId ? { operator_id: this.store.id(a.id, 'user', e.operatorId) } : {}),
        ...(e.messageId ? { message_id: this.store.id(a.id, 'message', e.messageId) } : {}),
      });
    } else this.publish({ ...base, ...group, post_type: 'request', request_type: e.request, ...(e.request === 'group' ? { sub_type: 'add' } : {}), flag: e.flag, comment: e.comment ?? '' });
  }

  private redact(value: string): string {
    return String(value).replace(/(bearer\s+)\S+/gi, '$1[redacted]').replace(/((?:cookie|token|password|sessionid|authorization)["'\s:=]+)[^\s,;}]+/gi, '$1[redacted]').replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500);
  }
  private reportError(accountId: string, error: unknown): void {
    const name = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64) : 'UnknownError';
    // Native errors such as SendMessageError carry the platform status text; it is redacted, never raw.
    const detail = error instanceof Error && error.message ? ` — ${this.redact(error.message).slice(0, 200)}` : '';
    this.emit('diagnostic', { level: 'error', source: `Account:${accountId}`, message: `${name}: native operation failed${detail}` });
  }
}
