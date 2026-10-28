import { randomUUID } from 'node:crypto';
import { NativeAdapter, type NativeGroup, type NativeMessage, type NativeSegment, type NativeTarget, type NativeUser } from './types.js';

/** Explicit offline demonstration adapter. It never connects to Douyin. */
export class MockAdapter extends NativeAdapter {
  readonly kind = 'mock' as const;
  private online = false;
  private readonly accountId: string;
  private readonly messages = new Map<string, NativeMessage>();
  private readonly friends: NativeUser[] = [{ id: '10001', nickname: '演示好友' }, { id: '10002', nickname: '开发助手' }];
  private readonly groups = new Map<string, NativeGroup>([['20001', { id: '20001', name: 'DyTranOb 演示群', memberCount: 3 }]]);
  private readonly members = new Map<string, NativeUser[]>();

  constructor(options: { accountId?: string } = {}) {
    super();
    this.accountId = options.accountId ?? '10000';
    this.members.set('20001', [{ id: this.accountId, nickname: 'DyTranOb Demo' }, ...this.friends]);
  }

  async connect(): Promise<void> {
    if (this.online) return;
    this.online = true;
    this.publish({ type: 'connection', online: true });
  }

  async disconnect(): Promise<void> {
    if (!this.online) return;
    this.online = false;
    this.publish({ type: 'connection', online: false });
  }

  isOnline(): boolean { return this.online; }
  async getSelf(): Promise<NativeUser> { return { id: this.accountId, nickname: 'DyTranOb Demo' }; }

  async sendMessage(target: NativeTarget, segments: NativeSegment[]): Promise<NativeMessage> {
    this.assertOnline();
    if (Boolean(target.userId) === Boolean(target.groupId)) throw new Error('Exactly one userId or groupId is required');
    if (!segments.length) throw new Error('Cannot send an empty message');
    if (target.groupId) this.group(target.groupId);
    const message: NativeMessage = {
      id: randomUUID(), userId: this.accountId, time: Math.floor(Date.now() / 1000),
      ...(target.groupId ? { groupId: target.groupId } : {}),
      segments: structuredClone(segments), nickname: 'DyTranOb Demo', self: true,
    };
    this.messages.set(message.id, structuredClone(message));
    // Outgoing echoes are deliberately not incoming message events.
    return message;
  }

  injectMessage(message: NativeMessage): void {
    this.assertOnline();
    if (!message.id || !message.userId || !message.segments.length) throw new Error('Invalid mock message');
    const copy = structuredClone(message);
    this.messages.set(copy.id, copy);
    this.publish({ type: 'message', message: structuredClone(copy) });
  }

  async deleteMessage(id: string): Promise<void> {
    this.assertOnline();
    const message = this.messages.get(id);
    if (!message) throw new Error('Message not found');
    this.messages.delete(id);
    this.publish({ type: 'notice', notice: 'message_recall', userId: message.userId, operatorId: this.accountId, messageId: id, ...(message.groupId ? { groupId: message.groupId } : {}) });
  }

  async getFriends(): Promise<NativeUser[]> { this.assertOnline(); return structuredClone(this.friends); }
  async getGroups(): Promise<NativeGroup[]> { this.assertOnline(); return structuredClone([...this.groups.values()]); }
  async getGroupMembers(groupId: string): Promise<NativeUser[]> { this.assertOnline(); this.group(groupId); return structuredClone(this.members.get(groupId) ?? []); }
  async setGroupName(groupId: string, name: string): Promise<void> { this.assertOnline(); if (!name.trim()) throw new Error('Group name is required'); this.group(groupId).name = name; }
  async leaveGroup(groupId: string): Promise<void> {
    this.assertOnline(); this.group(groupId); this.groups.delete(groupId); this.members.delete(groupId);
    this.publish({ type: 'notice', notice: 'group_decrease', userId: this.accountId, groupId, operatorId: this.accountId });
  }

  async kickGroupMember(groupId: string, userId: string): Promise<void> {
    this.assertOnline(); this.group(groupId);
    const members = this.members.get(groupId) ?? [];
    if (!members.some(member => member.id === userId)) throw new Error('Member not found');
    const remaining = members.filter(member => member.id !== userId);
    this.members.set(groupId, remaining); this.group(groupId).memberCount = remaining.length;
    this.publish({ type: 'notice', notice: 'group_decrease', userId, groupId, operatorId: this.accountId });
  }

  async handleRequest(_kind: 'friend' | 'group', _flag: string, _approve: boolean): Promise<void> { this.assertOnline(); throw new Error('No pending request exists in the demo adapter'); }
  async startQrLogin(): Promise<unknown> { await this.connect(); return this.getLoginState(); }
  async getLoginState(): Promise<unknown> { return { state: this.online ? 'online' : 'offline', online: this.online, mode: 'mock', account: await this.getSelf() }; }
  private assertOnline(): void { if (!this.online) throw new Error('Adapter is offline'); }
  private group(id: string): NativeGroup { const group = this.groups.get(id); if (!group) throw new Error('Group not found'); return group; }
}
