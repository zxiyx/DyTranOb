import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ActionRequest, ActionResponse, MessageSegment, OneBotEvent } from './types.js';
import type { SubtitleResult, SubtitleTrack } from './adapters/subtitles.js';

export interface WorkDetailResult { aweme_detail: Record<string, unknown>; source: 'web' | 'im' | 'mobile'; subtitle_tracks: SubtitleTrack[]; sources_checked: string[]; warnings: string[] }
export interface WorkSubtitleResult extends SubtitleResult { source: 'web' | 'im' | 'mobile'; sources_checked: string[]; warnings: string[] }

const EXTENDED_TIMEOUTS: Record<string, number> = { dy_get_video_detail: 90000, dy_get_video_subtitles: 125000, dy_get_user_posts_count: 180000, dy_get_user_posts_page: 180000, dy_upload_image: 60000, dy_send_image: 90000, dy_upload_comment_image: 90000, dy_upload_image_and_comment: 120000 };

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  timeout?: number;
  reconnect?: boolean;
  reconnectDelay?: number;
  websocketUrl?: string;
}

export interface CallOptions {
  account_id?: string;
  self_id?: number;
  echo?: unknown;
  timeout?: number;
}
export type ConversationTarget = { native_user_id: string } | { conversation_id: string; conversation_short_id: string; is_group?: boolean };
export interface UploadedImage { oid: string; skey: string; md5: string; dataSize: number; width: number; height: number; format?: 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' }

/** A OneBot failure retains its retcode and safe server response for programmatic handling. */
export class ActionError extends Error {
  readonly retcode: number;
  constructor(readonly response: ActionResponse, readonly httpStatus?: number) {
    super(response.message || response.wording || `OneBot action failed (${response.retcode})`);
    this.name = 'ActionError';
    this.retcode = response.retcode;
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Node.js SDK. `call` uses HTTP; `connect` streams events and enables `callWs`. */
export class DyTranObClient extends EventEmitter {
  private readonly options: ClientOptions;
  private readonly base: URL;
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private closed = false;
  private paused = false;
  private readonly controllers = new Set<AbortController>();
  private readonly pending = new Map<string, Pending>();

  constructor(options: ClientOptions) {
    super();
    this.options = options;
    this.base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    if (!['http:', 'https:'].includes(this.base.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
    if (this.base.username || this.base.password) throw new TypeError('Use the token option for authentication');
  }

  private async request<T>(path: string, method: 'GET' | 'POST', body?: unknown, timeout = this.options.timeout ?? 15000): Promise<T> {
    if (this.closed) throw new Error('Client is closed');
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(path.replace(/^\//, ''), this.base), {
        method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json() as ActionResponse<T>;
      if (!value || !['ok', 'failed'].includes(value.status) || typeof value.retcode !== 'number') throw new Error('Invalid OneBot response');
      if (!response.ok || value.status === 'failed' || value.retcode !== 0) throw new ActionError(value, response.status);
      return value.data as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(this.closed ? 'Client is closed' : 'Request timed out');
      throw error;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    const { timeout, ...selector } = options;
    return this.request<T>('/api/action', 'POST', { action, params, ...selector }, timeout ?? this.options.timeout ?? EXTENDED_TIMEOUTS[action]);
  }

  status<T = { accounts: Array<{ id: string; kind: string; online: boolean; self_id?: number }>; version: string; uptime: number }>(): Promise<T> {
    return this.request<T>('/api/status', 'GET');
  }
  actions<T = Array<{ action: string; description: string; params: Record<string, unknown> }>>(): Promise<T> {
    return this.request<T>('/api/actions', 'GET');
  }
  recentEvents(limit = 100): Promise<OneBotEvent[]> {
    return this.request(`/api/events?limit=${Math.max(0, Math.min(1000, Math.floor(limit)))}`, 'GET');
  }
  startQrLogin(accountId: string): Promise<unknown> {
    return this.request(`/api/accounts/${encodeURIComponent(accountId)}/login/qr`, 'POST', {});
  }
  loginState(accountId: string): Promise<unknown> {
    return this.request(`/api/accounts/${encodeURIComponent(accountId)}/login`, 'GET');
  }
  sendPrivateMessage(userId: number, message: string | MessageSegment[], options: CallOptions = {}): Promise<{ message_id: number; message_ids?: number[] }> {
    return this.call('send_private_msg', { user_id: userId, message }, options);
  }
  sendGroupMessage(groupId: number, message: string | MessageSegment[], options: CallOptions = {}): Promise<{ message_id: number; message_ids?: number[] }> {
    return this.call('send_group_msg', { group_id: groupId, message }, options);
  }
  getUserInfo(secUserId: string, options: CallOptions = {}) { return this.call('dy_get_user_info', { sec_user_id: secUserId }, options); }
  getVideoDetail(awemeId: string, params: { conversation_short_id?: string } = {}, options: CallOptions = {}) { return this.call<WorkDetailResult>('dy_get_video_detail', { aweme_id: awemeId, ...params }, options); }
  getVideoSubtitles(awemeId: string, params: { conversation_short_id?: string; language?: string; track_index?: number } = {}, options: CallOptions = {}) { return this.call<WorkSubtitleResult>('dy_get_video_subtitles', { aweme_id: awemeId, ...params }, options); }
  getUserPosts(secUserId: string, maxCursor = '0', count = 20, options: CallOptions = {}) { return this.call('dy_get_user_posts', { sec_user_id: secUserId, max_cursor: maxCursor, count }, options); }
  getUserPostsWithCount(secUserId: string, targetCount: number, options: CallOptions = {}) { return this.call('dy_get_user_posts_count', { sec_user_id: secUserId, target_count: targetCount }, { timeout: 180000, ...options }); }
  getUserPostsByPage(secUserId: string, page: number, pageSize = 20, options: CallOptions = {}) { return this.call('dy_get_user_posts_page', { sec_user_id: secUserId, page, page_size: pageSize }, { timeout: 180000, ...options }); }
  createConversation(nativeUserId: string, options: CallOptions = {}) { return this.call<{ conversation_id: string; conversation_short_id: string }>('dy_create_conversation', { native_user_id: nativeUserId }, options); }
  sendMessage(target: ConversationTarget, text: string, options: CallOptions = {}) { return this.call('dy_send_conversation_msg', { ...target, text }, options); }
  sendMsg2Stranger(secUserId: string, text: string, options: CallOptions = {}) { return this.call('dy_send_stranger_msg', { sec_user_id: secUserId, text }, options); }
  fetchStrangerMessages(count = 20, cursor = '0', options: CallOptions = {}) { return this.call('dy_fetch_stranger_messages', { count, cursor }, options); }
  listDynamicEmojis(options: CallOptions = {}) { return this.call('dy_list_dynamic_emojis', {}, options); }
  sendDynamicEmojiMessage(target: ConversationTarget, name: string, options: CallOptions = {}) { return this.call('dy_send_dynamic_emoji', { ...target, name }, options); }
  sendVideoCardMessage(target: ConversationTarget, itemId: string, options: CallOptions = {}) { return this.call('dy_send_video_card', { ...target, item_id: itemId }, options); }
  uploadImage(data: Uint8Array, options: CallOptions = {}) { return this.call<UploadedImage>('dy_upload_image', { image_base64: Buffer.from(data).toString('base64') }, { timeout: 60000, ...options }); }
  sendImageMessage(target: ConversationTarget, image: UploadedImage, options: CallOptions = {}) { return this.call('dy_send_image', { ...target, image }, options); }
  uploadAndSendImageMessage(target: ConversationTarget, data: Uint8Array, options: CallOptions = {}) { return this.call('dy_send_image', { ...target, image_base64: Buffer.from(data).toString('base64') }, { timeout: 60000, ...options }); }
  async uploadAndSendImageFile(target: ConversationTarget, path: string, options: CallOptions = {}) { return this.uploadAndSendImageMessage(target, await this.readImageFile(path), options); }
  getVideoCommentList(awemeId: string, cursor = '0', count = 20, options: CallOptions = {}) { return this.call('dy_get_video_comments', { aweme_id: awemeId, cursor, count }, options); }
  commentVideo(awemeId: string, text: string, options: CallOptions = {}) { return this.call('dy_comment_video', { aweme_id: awemeId, text }, options); }
  commentVideoWithImage(awemeId: string, text: string, image: { uri: string; width: number; height: number; format?: string }, options: CallOptions = {}) { return this.call('dy_comment_video_image', { aweme_id: awemeId, text, image_uri: image.uri, width: image.width, height: image.height, image_format: image.format ?? 'jpeg' }, options); }
  uploadCommentImage(data: Uint8Array, options: CallOptions = {}) { return this.call<{ uri: string; width: number; height: number; format: string }>('dy_upload_comment_image', { image_base64: Buffer.from(data).toString('base64') }, { timeout: 60000, ...options }); }
  uploadImageAndCommentVideo(awemeId: string, text: string, data: Uint8Array, options: CallOptions = {}) { return this.call('dy_upload_image_and_comment', { aweme_id: awemeId, text, image_base64: Buffer.from(data).toString('base64') }, { timeout: 90000, ...options }); }
  async uploadImageFileAndCommentVideo(awemeId: string, text: string, path: string, options: CallOptions = {}) { return this.uploadImageAndCommentVideo(awemeId, text, await this.readImageFile(path), options); }
  private async readImageFile(path: string): Promise<Uint8Array> {
    const { open } = await import('node:fs/promises'); const file = await open(path, 'r');
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Image must be a regular file up to 16 MiB'); return await file.readFile(); } finally { await file.close(); }
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Client is closed'));
    this.paused = false;
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const url = this.options.websocketUrl ? new URL(this.options.websocketUrl) : new URL('ws', this.base);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(url.protocol)) return Promise.reject(new TypeError('websocketUrl must use WS or WSS'));
    const socket = new WebSocket(url, { maxPayload: 24 * 1024 * 1024, handshakeTimeout: this.options.timeout ?? 15000, headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {} });
    this.socket = socket;
    const opening = new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.once('open', () => {
        if (this.closed || this.socket !== socket) { socket.terminate(); reject(new Error('Client is closed')); return; }
        opened = true; this.attempt = 0; this.opening = undefined; this.emit('connected'); resolve();
      });
      socket.on('message', data => {
        let value: unknown;
        try { value = JSON.parse(data.toString()); } catch { this.emit('transport_error', new Error('Invalid WebSocket JSON')); return; }
        if (!value || typeof value !== 'object') return;
        if ('post_type' in value) { this.emit('event', value as OneBotEvent); return; }
        const response = value as ActionResponse;
        if (typeof response.echo !== 'string') return;
        const pending = this.pending.get(response.echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.echo);
        if (response.status === 'ok' && response.retcode === 0) pending.resolve(response.data);
        else pending.reject(new ActionError(response));
      });
      socket.on('error', () => {
        const error = new Error('WebSocket connection failed');
        this.emit('transport_error', error);
        if (!opened) reject(error);
      });
      socket.once('close', (code) => {
        if (this.socket !== socket) { if (!opened) reject(new Error('WebSocket connection was replaced')); return; }
        this.socket = undefined;
        this.opening = undefined;
        if (!opened) reject(new Error('WebSocket closed before connecting'));
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('WebSocket disconnected')); }
        this.pending.clear();
        this.emit('disconnected', code);
        if (!this.closed && !this.paused && this.options.reconnect !== false) {
          const delay = Math.min(30000, (this.options.reconnectDelay ?? 500) * 2 ** Math.min(this.attempt++, 6));
          this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(() => {}); }, delay);
          this.reconnectTimer.unref();
        }
      });
    });
    this.opening = opening;
    return opening;
  }

  async callWs<T = unknown>(action: string, params: Record<string, unknown> = {}, options: Omit<CallOptions, 'echo'> = {}): Promise<T> {
    await this.connect();
    const echo = randomUUID();
    const { timeout, ...selector } = options;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('WebSocket action timed out')); }, timeout ?? this.options.timeout ?? EXTENDED_TIMEOUTS[action] ?? 15000);
      this.pending.set(echo, { resolve: value => resolve(value as T), reject, timer });
      const request: ActionRequest = { action, params, ...selector, echo };
      try {
        if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('WebSocket disconnected');
        this.socket.send(JSON.stringify(request), error => {
          if (!error) return;
          clearTimeout(timer); this.pending.delete(echo); reject(new Error('WebSocket send failed'));
        });
      } catch (error) { clearTimeout(timer); this.pending.delete(echo); reject(error); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const controller of this.controllers) controller.abort();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Client is closed')); }
    this.pending.clear();
    this.socket?.terminate();
    this.socket = undefined;
  }
  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  getConnectionStatus(): 'connected' | 'connecting' | 'disconnected' | 'closed' {
    return this.closed ? 'closed' : this.isConnected() ? 'connected' : this.opening || this.reconnectTimer ? 'connecting' : 'disconnected';
  }
  async disconnect(): Promise<void> {
    this.paused = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.terminate(); });
  }
}

export function createClient(options: ClientOptions): DyTranObClient { return new DyTranObClient(options); }
