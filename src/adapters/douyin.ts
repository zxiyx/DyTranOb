import type { Account, ChatContact, Client, Group, GroupJoinRequest, GroupMessageEvent, MessageEvent, PrivateMessageEvent, SendableMessage, SendableText, StrangerMessageEvent } from 'douyin-im';
import { NativeAdapter, UnsupportedAdapterOperation, type NativeMessage, type NativeSegment, type NativeTarget, type NativeUser, type NativeGroup } from './types.js';
import { emojiUrls, decodeImageBase64, type MediaCache } from '../media.js';
import type { ExtensionAction } from '../extensions.js';
import type { ExtensionResult, ConversationAddress } from './douyin-extensions.js';
import { sharedWork, sharedWorkText } from './shared-work.js';

export interface DouyinAdapterOptions { accountId: string; dataDir: string; media?: MediaCache }
/** SDK construction seam for embedding and isolated lifecycle tests. */
export interface DouyinAdapterDependencies { createClient?: (dataDir: string) => Promise<Client> }
export interface DouyinLoginState {
  state: string;
  online: boolean;
  account?: NativeUser;
  qrcodeBase64?: string;
  qrcodeUrl?: string;
  expireTime?: number;
  qrStatus?: string;
  error?: string;
  verification?: { methods: readonly string[]; operation: string; url?: string };
}

interface MessageRoute {
  target: NativeTarget;
  message: NativeMessage;
  messageType: number;
  serverId?: string;
  referenceUid?: string;
  senderSecUid?: string;
}

/** Translate the SDK's public event model; never round a platform identifier. */
export function incomingMessage(event: MessageEvent): NativeMessage {
  const id = event.serverMessageId || (event.clientMessageId ? `client:${event.clientMessageId}` : undefined);
  if (!id) throw new Error('Incoming message has no server or client identifier');
  const segments: NativeSegment[] = [];
  if (event.referenceInfo?.refMessageId) segments.push({ type: 'reply', messageId: event.referenceInfo.refMessageId });
  const content = event.content;
  const work = sharedWork(event);
  if (work) {
    segments.push({ type: 'text', text: sharedWorkText(work) });
  } else if (content.kind === 'share') {
    segments.push({ type: 'text', text: `[抖音作品分享：消息未提供有效作品ID]${content.share.title ? `\n${content.share.title}` : ''}` });
  } else if (content.kind === 'link') {
    let link = '';
    try { const url = new URL(content.link.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) link = url.href; } catch { /* No fabricated link for malformed cards. */ }
    segments.push({ type: 'text', text: ['[链接分享]', content.link.title, content.link.description, link].filter(Boolean).join('\n') });
  } else if (content.kind === 'text') {
    let cursor = 0;
    for (const mention of [...(content.mentions ?? [])].sort((a, b) => a.location - b.location)) {
      if (mention.location < cursor || mention.location < 0 || mention.length <= 0 || mention.location + mention.length > content.text.length) continue;
      if (mention.location > cursor) segments.push({ type: 'text', text: content.text.slice(cursor, mention.location) });
      segments.push({ type: 'at', userId: mention.uid, text: mention.text });
      cursor = mention.location + mention.length;
    }
    if (cursor < content.text.length) segments.push({ type: 'text', text: content.text.slice(cursor) });
    if (!segments.length) segments.push({ type: 'text', text: content.text });
  } else if (content.kind === 'image') {
    const url = [...content.image.originUrls, ...content.image.largeUrls, ...content.image.mediumUrls, ...content.image.thumbUrls].find(Boolean);
    segments.push(url ? { type: 'image', url } : { type: 'text', text: '[抖音图片：资源地址暂不可用]' });
  } else if (content.kind === 'emoji') {
    const url = emojiUrls(event.rawContent, content.url)[0];
    segments.push(url ? { type: 'image', url } : { type: 'text', text: '[抖音表情：资源地址暂不可用]' });
  } else {
    // Native videos expose tkey/skey rather than a playable URL. Do not invent one.
    segments.push({ type: 'text', text: content.text || `[抖音 ${content.kind} 消息：当前入口暂不支持此内容]` });
  }
  let nickname: string | undefined;
  if (event.chatType === 'group') nickname = (event as GroupMessageEvent).member.nickname;
  else if (event.chatType === 'private') nickname = (event as PrivateMessageEvent).friend.nickname;
  else nickname = (event as StrangerMessageEvent).stranger.nickname;
  return {
    id, userId: event.senderUid, time: event.time, segments,
    ...(work ? { sharedWork: work } : {}),
    ...(event.isGroup ? { groupId: event.threadId } : {}),
    ...(nickname ? { nickname } : {}),
    self: event.senderUid === event.account.uid || event.senderUid === event.account.imUid,
  };
}

/** Real douyin-im 1.1.0 adapter. Login runs in the background for WebUI access. */
export class DouyinAdapter extends NativeAdapter {
  readonly kind = 'douyin' as const;
  private client?: Client;
  private account?: Account;
  private initialization?: Promise<Account>;
  private loginTask?: Promise<void>;
  private lifecycle = 0;
  private state: DouyinLoginState = { state: 'idle', online: false };
  // Bounded runtime routes support recall and quote only for observed messages.
  private readonly routes = new Map<string, MessageRoute>();
  private readonly requests = new Map<string, GroupJoinRequest>();
  private readonly extensionRoutes = new Map<string, ConversationAddress>();
  private mediaQueue: Promise<void> = Promise.resolve();
  private mediaAbort = new AbortController();
  private pendingMessages = 0;
  private readonly sendQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: DouyinAdapterOptions, private readonly dependencies: DouyinAdapterDependencies = {}) { super(); }

  async connect(): Promise<void> {
    if (this.mediaAbort.signal.aborted) this.mediaAbort = new AbortController();
    const requestedLifecycle = this.lifecycle;
    const account = await this.initialize();
    if (requestedLifecycle !== this.lifecycle) return;
    if (this.loginTask || account.online) return;
    const lifecycle = ++this.lifecycle;
    this.state = { state: 'logging-in', online: false };
    const task = account.login();
    this.loginTask = task;
    void task.catch(() => {
      if (lifecycle !== this.lifecycle) return;
      this.state = { state: 'error', online: false, error: '抖音登录失败，请检查网络或重新启动二维码登录。' };
      this.diagnostic('error', '抖音登录失败，请检查网络、平台验证与账号状态。');
    }).finally(() => { if (this.loginTask === task) this.loginTask = undefined; });
  }

  async disconnect(): Promise<void> {
    this.lifecycle++;
    this.mediaAbort.abort();
    const account = this.account ?? await this.initialization?.catch(() => undefined);
    await account?.logout();
    this.loginTask = undefined;
    this.state = { state: 'offline', online: false };
    this.requests.clear();
    this.routes.clear();
    this.extensionRoutes.clear();
  }

  isOnline(): boolean { return this.account?.state === 'online'; }

  async getSelf(): Promise<NativeUser> {
    if (!this.account?.uid) throw new Error('The Douyin account identity is not available until login');
    return { id: this.account.uid, nickname: this.account.nickname ?? this.account.uid };
  }

  async startQrLogin(): Promise<DouyinLoginState> { await this.connect(); return this.getLoginState(); }
  async getLoginState(): Promise<DouyinLoginState> {
    return structuredClone({ ...this.state, online: this.isOnline(), ...(this.account?.uid ? { account: await this.getSelf() } : {}) });
  }

  async sendMessage(target: NativeTarget, segments: NativeSegment[]): Promise<NativeMessage> {
    this.onlineAccount();
    if (Boolean(target.groupId) === Boolean(target.userId)) throw new Error('Exactly one userId or groupId is required');
    const contact = await this.contact(target);
    const payload = await this.prepareMessage(target, segments);
    return this.sendPrepared(target, segments, contact, payload);
  }

  override async sendMessages(target: NativeTarget, segments: NativeSegment[], confirmed: (message: NativeMessage) => Promise<void>): Promise<void> {
    const key = JSON.stringify(target);
    const previous = this.sendQueues.get(key) ?? Promise.resolve();
    const task = previous.then(async () => {
      this.onlineAccount();
      if (Boolean(target.groupId) === Boolean(target.userId)) throw new Error('Exactly one userId or groupId is required');
      const contact = await this.contact(target);
      const parts = this.splitImages(segments);
      // Validate every part before the first send, so invalid later segments do not cause partial delivery.
      const prepared = [];
      for (const part of parts) prepared.push({ part, payload: await this.prepareMessage(target, part) });
      for (const { part, payload } of prepared) await confirmed(await this.sendPrepared(target, part, contact, payload));
    });
    const settled = task.catch(() => {});
    this.sendQueues.set(key, settled);
    try { await task; } finally { if (this.sendQueues.get(key) === settled) this.sendQueues.delete(key); }
  }

  private splitImages(segments: NativeSegment[]): NativeSegment[][] {
    if (!segments.some(s => s.type === 'image') || segments.length === 1) return [segments];
    if (segments.some(s => !['text', 'at', 'reply', 'image'].includes(s.type))) throw new UnsupportedAdapterOperation('图片混合消息仅支持文字、@、引用和图片');
    const replies = segments.filter(s => s.type === 'reply');
    if (replies.length > 1) throw new UnsupportedAdapterOperation('一条消息只能引用一条原消息');
    const parts: NativeSegment[][] = []; let run: NativeSegment[] = [];
    for (const segment of segments) {
      if (segment.type === 'reply') continue;
      if (segment.type === 'image') { if (run.length) { parts.push(run); run = []; } parts.push([segment]); }
      else run.push(segment);
    }
    if (run.length) parts.push(run);
    if (replies.length) {
      // Douyin's public SDK supports quotes only with text. Keep the quote as a small leading message for image-only replies.
      if (parts[0]?.[0]?.type === 'image') parts.unshift([replies[0]!, { type: 'text', text: '[图片]' }]);
      else parts[0]!.unshift(replies[0]!);
    }
    if (parts.length > 20) throw new UnsupportedAdapterOperation('单次图文请求最多拆分为 20 条抖音消息');
    return parts;
  }

  private async sendPrepared(target: NativeTarget, segments: NativeSegment[], contact: ChatContact, payload: SendableMessage): Promise<NativeMessage> {
    const response = await contact.sendMsg(payload);
    this.assertSuccess(response);
    if (!response.serverMessageId || response.serverMessageId === '0') throw new Error('Douyin did not confirm a server message identifier');
    const self = await this.getSelf();
    const safeSegments = segments.map(s => {
      if (s.type !== 'image' || !s.url?.startsWith('base64://')) return s;
      try { return this.options.media ? { type: 'image' as const, url: this.options.media.put(decodeImageBase64(s.url)) } : { type: 'text' as const, text: '[已发送图片]' }; }
      catch { return { type: 'text' as const, text: '[已发送图片：预览暂不可用]' }; }
    });
    const message: NativeMessage = { id: response.serverMessageId, userId: self.id, time: Math.floor(Date.now() / 1000), segments: structuredClone(safeSegments), nickname: self.nickname, self: true, ...(target.groupId ? { groupId: target.groupId } : {}) };
    this.remember(message.id, { target: { ...target }, message, serverId: response.serverMessageId, referenceUid: this.account?.imUid ?? self.id, messageType: segments[0]?.type === 'image' ? 27 : 7 });
    return message;
  }

  async deleteMessage(id: string): Promise<void> {
    const extension = this.extensionRoutes.get(id);
    if (extension) { await (await this.extensions()).recall(extension, id); this.extensionRoutes.delete(id); return; }
    const route = this.routes.get(id);
    if (!route?.serverId) throw new UnsupportedAdapterOperation('撤回仅支持当前运行期间收发并已取得服务器 ID 的消息');
    const response = await (await this.contact(route.target)).recallMsg(route.serverId);
    this.assertSuccess(response);
    if (!response.recalled) throw new Error('Douyin did not confirm that the message was recalled');
  }

  async getFriends(): Promise<NativeUser[]> {
    const entries = await this.onlineAccount().getFriendList();
    return [...entries.values()].map(friend => ({ id: friend.uid, nickname: friend.nickname ?? friend.uid }));
  }

  async getGroups(): Promise<NativeGroup[]> {
    const entries = await this.onlineAccount().getGroupList();
    return [...entries.values()].map(group => ({ id: group.groupId, name: group.name ?? group.groupId, ...(group.memberCount !== undefined ? { memberCount: group.memberCount } : {}) }));
  }

  async getGroupMembers(groupId: string): Promise<NativeUser[]> {
    const entries = await (await this.group(groupId)).getMemberList();
    return [...entries.values()].map(member => ({ id: member.uid, nickname: member.nickname ?? member.uid }));
  }

  async setGroupName(_groupId: string, _name: string): Promise<void> { throw new UnsupportedAdapterOperation('douyin-im 1.1.0 未公开修改群名接口'); }
  async leaveGroup(groupId: string): Promise<void> { this.assertSuccess(await (await this.group(groupId)).leave()); }
  async kickGroupMember(groupId: string, userId: string): Promise<void> { this.assertSuccess(await (await this.group(groupId)).removeMembers([userId])); }

  async handleRequest(kind: 'friend' | 'group', flag: string, approve: boolean): Promise<void> {
    this.onlineAccount();
    if (kind === 'friend') throw new UnsupportedAdapterOperation('douyin-im 1.1.0 的好友申请只有通知，未公开审批接口');
    const request = this.requests.get(flag);
    if (!request) throw new UnsupportedAdapterOperation('群申请标识不存在或已过期；只能处理当前运行期间收到的申请');
    this.assertSuccess(await (approve ? request.approve() : request.reject()));
    this.requests.delete(flag);
  }

  private async initialize(): Promise<Account> {
    if (this.account) return this.account;
    if (this.initialization) return this.initialization;
    const task = this.createAccount();
    this.initialization = task;
    try { return await task; } finally { if (this.initialization === task) this.initialization = undefined; }
  }

  private async extensions() {
    this.onlineAccount();
    const { DouyinExtensions } = await import('./douyin-extensions.js');
    return DouyinExtensions.forAccount(this.options.dataDir, await this.getSelf(), this.options.media, (message, address) => {
      this.extensionRoutes.set(message.id, address);
      while (this.extensionRoutes.size > 10000) this.extensionRoutes.delete(this.extensionRoutes.keys().next().value!);
    });
  }
  async executeExtension(action: ExtensionAction, params: Record<string, unknown>): Promise<ExtensionResult> { return (await this.extensions()).execute(action, params); }

  private async resolveMedia(event: MessageEvent, message: NativeMessage): Promise<void> {
    if (!this.options.media || !['image', 'emoji'].includes(event.content.kind)) return;
    const content = event.content;
    const urls = content.kind === 'image' ? [...content.image.originUrls, ...content.image.largeUrls, ...content.image.mediumUrls, ...content.image.thumbUrls] : content.kind === 'emoji' ? emojiUrls(event.rawContent, content.url) : [];
    try {
      const url = await this.options.media.resolve(urls, content.kind === 'image' ? content.image.skey : undefined, this.mediaAbort.signal);
      message.segments = [...message.segments.filter(s => s.type === 'reply'), { type: 'image', url }];
    } catch {
      message.segments = [...message.segments.filter(s => s.type === 'reply'), { type: 'text', text: '[抖音图片/表情：下载或解密失败]' }];
      this.diagnostic('warn', `图片或表情下载/解密失败 · message_id=${message.id}`);
    }
  }

  private async createAccount(): Promise<Account> {
    // Lazy import lets offline demo/SDK clients run without initializing native SQLite.
    if (this.dependencies.createClient) this.client = await this.dependencies.createClient(this.options.dataDir);
    else {
      const { createClient } = await import('douyin-im');
      this.client = createClient({ dataDir: this.options.dataDir, autoLoad: false });
    }
    const account = this.client.createAccount({ ...(this.options.accountId ? { accountId: this.options.accountId } : {}), login: { method: 'qr' } });
    this.account = account;
    this.bindEvents(account);
    return account;
  }

  private bindEvents(account: Account): void {
    account.on('system.login.qrcode', info => {
      this.state = { state: 'logging-in', online: false, qrcodeBase64: info.qrcodeBase64, ...(info.qrcodeIndexUrl ? { qrcodeUrl: info.qrcodeIndexUrl } : {}), expireTime: info.expireTime };
      // continueLogin polls the QR flow; waiting for login() here would deadlock.
      void account.continueLogin().catch(() => this.diagnostic('warn', '二维码登录已结束，请查看登录状态或重新登录。'));
    });
    account.on('system.login.qrcode.status', payload => { this.state.qrStatus = payload.status; });
    account.on('system.online', () => {
      this.state = { state: 'online', online: true };
      this.publish({ type: 'connection', online: true });
    });
    account.on('system.reconnecting', () => {
      this.state = { state: 'reconnecting', online: false };
      this.publish({ type: 'connection', online: false });
    });
    account.on('system.offline', () => {
      this.state = { state: 'offline', online: false };
      this.requests.clear();
      this.routes.clear();
      this.publish({ type: 'connection', online: false });
    });
    account.on('system.handler.error', () => this.diagnostic('error', 'douyin-im 事件处理失败。'));
    account.on('system.login.verification', ({ verification }) => {
      this.state.verification = { methods: [...verification.methods], operation: verification.operation };
      // This URL is a capability: only authenticated management callers may see it.
      void verification.openUrl({ openBrowser: false }).then(url => {
        if (this.state.verification?.operation === verification.operation) this.state.verification.url = url;
      }).catch(() => this.diagnostic('warn', '登录安全验证未完成。'));
    });
    account.on('message', event => {
      const lifecycle = this.lifecycle;
      if (this.pendingMessages >= 128) { this.diagnostic('warn', '消息转换队列已满，一条消息未上报。'); return; }
      this.pendingMessages++;
      const deliver = async () => {
      try {
        if (lifecycle !== this.lifecycle) return;
        const message = incomingMessage(event);
        // SDK 1.1.0 filters self echoes before `message`; retain this guard so a
        // future SDK cannot overwrite a sent private message's peer with self.
        if (message.self) return;
        await this.resolveMedia(event, message);
        if (lifecycle !== this.lifecycle) return;
        const peer = event.chatType === 'private' ? (event as PrivateMessageEvent).friend.uid : event.chatType === 'stranger' ? (event as StrangerMessageEvent).stranger.uid : undefined;
        this.remember(message.id, { target: message.groupId ? { groupId: message.groupId } : { userId: peer ?? event.senderUid }, message, messageType: event.messageType, serverId: event.serverMessageId, referenceUid: event.senderUid, senderSecUid: event.senderSecUid });
        this.publish({ type: 'message', message });
      } catch { this.diagnostic('warn', '无法转换一条缺少标识的抖音消息。'); }
      finally { this.pendingMessages--; }
      };
      this.mediaQueue = this.mediaQueue.then(deliver).catch(() => this.diagnostic('warn', '抖音消息处理失败。'));
    });
    account.on('notice.group.member-increase', event => this.publish({ type: 'notice', notice: 'group_increase', userId: event.member.uid, groupId: event.group.groupId, ...(event.operator ? { operatorId: event.operator.uid } : {}) }));
    account.on('notice.group.member-decrease', event => this.publish({ type: 'notice', notice: 'group_decrease', userId: event.member.uid, groupId: event.group.groupId, ...(event.operator ? { operatorId: event.operator.uid } : {}) }));
    account.on('notice.friend.increase', event => this.publish({ type: 'notice', notice: 'friend_add', userId: event.peerUid }));
    account.on('notice.friend.add-request', event => this.publish({ type: 'request', request: 'friend', flag: `friend:${event.applicantUid}:${event.time}`, userId: event.applicantUid, ...(event.content ? { comment: event.content } : {}) }));
    account.on('request.group.join', request => {
      const flag = `${request.group.groupId}:${request.requestId}`;
      this.requests.set(flag, request);
      this.publish({ type: 'request', request: 'group', flag, userId: request.applicantUid, groupId: request.group.groupId, ...(request.reason ? { comment: request.reason } : {}) });
    });
    account.on('notice.message.recall', event => {
      const route = event.serverMessageId ? this.routes.get(event.serverMessageId) : undefined;
      if (!route) return;
      this.publish({ type: 'notice', notice: 'message_recall', userId: route.message.userId, messageId: route.message.id, ...(route.target.groupId ? { groupId: route.target.groupId } : {}) });
    });
  }

  private onlineAccount(): Account {
    if (!this.account || !this.isOnline()) throw new Error('Douyin account is offline');
    return this.account;
  }

  private async group(groupId: string): Promise<Group> {
    const account = this.onlineAccount();
    let group = account.pickGroup(groupId);
    if (!group) { await account.getGroupList(); group = account.pickGroup(groupId); }
    if (!group) throw new Error('Douyin group not found');
    return group;
  }

  private async contact(target: NativeTarget): Promise<ChatContact> {
    if (target.groupId) return this.group(target.groupId);
    if (!target.userId) throw new Error('Message target is required');
    const account = this.onlineAccount();
    let contact = account.pickFriend(target.userId) ?? account.pickStranger(target.userId);
    if (!contact) { await account.getFriendList(); contact = account.pickFriend(target.userId) ?? account.pickStranger(target.userId); }
    if (!contact) throw new Error('Douyin friend or stranger conversation not found');
    return contact;
  }

  private async prepareMessage(target: NativeTarget, segments: NativeSegment[]): Promise<SendableMessage> {
    if (!segments.length) throw new Error('Cannot send an empty message');
    const reply = segments.find(item => item.type === 'reply');
    if (reply) {
      if (segments.filter(item => item.type === 'reply').length !== 1 || segments.some(item => item.type !== 'reply' && item.type !== 'text')) throw new UnsupportedAdapterOperation('引用消息目前只能与文本组合');
      const route = reply.messageId ? this.routes.get(reply.messageId) : undefined;
      if (!route?.serverId || route.target.groupId !== target.groupId || route.target.userId !== target.userId) throw new UnsupportedAdapterOperation('引用必须指向当前会话、当前运行期间已接收或发送的消息');
      return { type: 'reply', text: segments.filter(item => item.type === 'text').map(item => item.text ?? '').join(''), referencedMessageId: route.serverId, referencedMessageType: route.messageType, referencedUid: route.referenceUid ?? route.message.userId, ...(route.senderSecUid ? { referencedSecUid: route.senderSecUid } : {}), referencedText: route.message.segments.filter(item => item.type === 'text').map(item => item.text ?? '').join('') };
    }
    if (segments.length === 1 && segments[0]?.type === 'image') {
      const source = segments[0].url;
      if (source?.startsWith('base64://')) return { type: 'image', data: decodeImageBase64(source) };
      if (!source || new URL(source).protocol !== 'https:') throw new UnsupportedAdapterOperation('抖音图片发送目前只接受 HTTPS URL，不允许本地文件路径');
      return { type: 'image', data: source };
    }
    if (segments.some(item => item.type !== 'text' && item.type !== 'at')) throw new UnsupportedAdapterOperation('当前支持文本与 @ 组合、单张 HTTPS 图片及文本引用；视频发送需要封面，暂未映射');
    const text: SendableText[] = [];
    for (const item of segments) {
      if (item.type === 'text') { text.push({ type: 'text', text: item.text ?? '' }); continue; }
      if (!target.groupId || !item.userId || !/^\d+$/.test(item.userId)) throw new UnsupportedAdapterOperation('@ 仅支持群内数字 UID，不支持 @all');
      const group = await this.group(target.groupId);
      let member = group.pickMember(item.userId);
      if (!member) { await group.getMemberList(); member = group.pickMember(item.userId); }
      if (!member) throw new Error('Mentioned group member not found');
      text.push({ type: 'at', uid: member.uid, name: member.displayName });
    }
    return text;
  }

  private assertSuccess(response: { statusCode: number; statusMsg: string; checkCode?: number }): void {
    if (response.statusCode !== 0 || (response.checkCode !== undefined && response.checkCode !== 0)) throw new Error('Douyin rejected the requested operation');
  }

  private remember(id: string, route: MessageRoute): void {
    this.routes.delete(id); this.routes.set(id, route);
    while (this.routes.size > 10_000) { const oldest = this.routes.keys().next().value; if (oldest !== undefined) this.routes.delete(oldest); }
  }
}
