import { EventEmitter } from 'node:events';
import type { ExtensionAction } from '../extensions.js';
import type { ExtensionResult } from './douyin-extensions.js';

/** Platform identifiers stay strings; Douyin IDs exceed JavaScript safe integers. */
export type NativeId = string;

export interface NativeSegment {
  type: 'text' | 'image' | 'video' | 'at' | 'reply';
  text?: string;
  url?: string;
  userId?: string;
  messageId?: string;
}

export interface NativeMessage {
  id: string;
  userId: string;
  groupId?: string;
  time: number;
  segments: NativeSegment[];
  nickname?: string;
  self?: boolean;
  sharedWork?: SharedWork;
}
export interface SharedWork { itemId: string; kind: 'video' | 'images'; url: string; title: string; authorUid?: string; authorSecUid?: string; conversationShortId?: string }

export interface NativeUser { id: string; nickname: string }
export interface NativeGroup { id: string; name: string; memberCount?: number }
export type NativeTarget = { userId?: string; groupId?: string };

export type NativeEvent =
  | { type: 'message'; message: NativeMessage }
  | { type: 'notice'; notice: 'group_increase' | 'group_decrease' | 'friend_add' | 'message_recall'; userId: string; groupId?: string; messageId?: string; operatorId?: string }
  | { type: 'request'; request: 'friend' | 'group'; flag: string; userId: string; groupId?: string; comment?: string }
  | { type: 'connection'; online: boolean };

export interface AdapterDiagnostic { level: 'debug' | 'info' | 'warn' | 'error'; message: string }

export class UnsupportedAdapterOperation extends Error {
  readonly code = 'UNSUPPORTED_OPERATION';
  constructor(message: string) { super(message); this.name = 'UnsupportedAdapterOperation'; }
}

/** A transport independent boundary: adapters never emit OneBot wire objects. */
export abstract class NativeAdapter extends EventEmitter {
  abstract readonly kind: 'douyin' | 'mock';
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isOnline(): boolean;
  abstract getSelf(): Promise<NativeUser>;
  abstract sendMessage(target: NativeTarget, segments: NativeSegment[]): Promise<NativeMessage>;
  /** Confirm each physical message immediately, including those preceding a later failure. */
  async sendMessages(target: NativeTarget, segments: NativeSegment[], confirmed: (message: NativeMessage) => Promise<void>): Promise<void> {
    await confirmed(await this.sendMessage(target, segments));
  }
  abstract deleteMessage(id: string): Promise<void>;
  abstract getFriends(): Promise<NativeUser[]>;
  abstract getGroups(): Promise<NativeGroup[]>;
  abstract getGroupMembers(groupId: string): Promise<NativeUser[]>;
  abstract setGroupName(groupId: string, name: string): Promise<void>;
  abstract leaveGroup(groupId: string): Promise<void>;
  abstract kickGroupMember(groupId: string, userId: string): Promise<void>;
  abstract handleRequest(kind: 'friend' | 'group', flag: string, approve: boolean): Promise<void>;
  abstract startQrLogin(): Promise<unknown>;
  abstract getLoginState(): Promise<unknown>;
  async executeExtension(_action: ExtensionAction, _params: Record<string, unknown>): Promise<ExtensionResult> { throw new UnsupportedAdapterOperation('抖音扩展动作需要原生抖音账号，Mock 不会模拟真实发布成功'); }

  protected publish(event: NativeEvent): void { this.emit('event', event); }
  protected diagnostic(level: AdapterDiagnostic['level'], message: string): void { this.emit('diagnostic', { level, message } satisfies AdapterDiagnostic); }
}
