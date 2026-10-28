import { AccountStore, ApiConnection, ImService, buildCardMessage } from 'douyin-im/protocol';
import { DYNAMIC_EMOJIS } from '../emoji-catalog.js';
import type { ExtensionAction } from '../extensions.js';
import { cdnUrl, decodeImageBase64, type MediaCache } from '../media.js';
import { ActionFault } from '../types.js';
import type { NativeMessage, NativeSegment } from './types.js';
import { DouyinWebApi, object } from './douyin-web.js';
import { loadWebSession, resolveWebSession } from './web-session.js';
import { readSubtitles, subtitleTracks } from './subtitles.js';

export interface ExtensionResult { data: unknown; message?: NativeMessage }
export interface ConversationAddress { threadId: string; conversationShortId: string; conversationType: number; inboxType: number; userId?: string }
export function assertNativeSuccess(response: { statusCode: number; checkCode?: number }): void {
  if (response.statusCode !== 0 || (response.checkCode !== undefined && response.checkCode !== 0)) throw new Error(`Douyin rejected operation (status=${response.statusCode}, check=${response.checkCode ?? 0})`);
}
export class DouyinExtensions {
  constructor(private readonly im: ImService, private readonly web: DouyinWebApi, private readonly self: { id: string; nickname: string }, private readonly media?: MediaCache, private readonly sent?: (message: NativeMessage, address: ConversationAddress) => void) {}
  static async forAccount(dataDir: string, self: { id: string; nickname: string }, media?: MediaCache, sent?: (message: NativeMessage, address: ConversationAddress) => void): Promise<DouyinExtensions> {
    const store = new AccountStore({ dataDir }); const stored = store.load(self.id);
    if (!stored) throw new Error('The account has no saved session; complete QR login first');
    const config = store.toClientConfig(stored); const client = new ApiConnection(config);
    const requestRaw = client.requestRaw.bind(client);
    client.requestRaw = (url, init, passportHeaders) => requestRaw(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20000) }, passportHeaders);
    const webOptions = resolveWebSession(await loadWebSession(dataDir), stored.session.cookies);
    const webClient = new ApiConnection({ ...config, initialCookies: webOptions.cookies ?? '', ...(webOptions.userAgent ? { userAgent: webOptions.userAgent } : {}), ...(webOptions.msToken ? { msToken: webOptions.msToken } : {}) });
    return new DouyinExtensions(new ImService(client, { platformUid: self.id, deviceId: client.getDeviceId(), guid: client.getGuid(), screenSize: client.getScreenSize() }), new DouyinWebApi(webClient, stored, fetch, webOptions), self, media, sent);
  }
  private async create(userId: string): Promise<ConversationAddress> {
    const response = await this.im.createPrivateConversation([userId]); assertNativeSuccess(response);
    const c = response.conversation; if (!c?.conversationId || !c.conversationShortId) throw new Error('Douyin did not confirm a conversation');
    return { threadId: c.conversationId, conversationShortId: c.conversationShortId, conversationType: c.conversationType, inboxType: c.inboxType ?? 0, userId };
  }
  private async address(p: Record<string, unknown>): Promise<ConversationAddress> {
    if (p.native_user_id) return this.create(String(p.native_user_id));
    return { threadId: String(p.conversation_id), conversationShortId: String(p.conversation_short_id), conversationType: p.is_group ? 2 : 1, inboxType: 0 };
  }
  private async send(address: ConversationAddress, content: string, msgType: number, segments: NativeSegment[]): Promise<ExtensionResult> {
    const response = await this.im.send({ ...address, content, msgType }); assertNativeSuccess(response);
    if (!response.serverMessageId || response.serverMessageId === '0') throw new Error('Douyin did not confirm a server message ID');
    const message: NativeMessage = { id: response.serverMessageId, userId: this.self.id, nickname: this.self.nickname, self: true, time: Math.floor(Date.now()/1000), segments, ...(address.conversationType === 2 ? { groupId: address.threadId } : {}) };
    this.sent?.(message, address);
    return { data: { native_message_id: message.id, conversation_id: address.threadId, conversation_short_id: address.conversationShortId }, message };
  }
  async recall(address: ConversationAddress, id: string): Promise<void> {
    const response = await this.im.recall({ ...address, serverMessageId: id }); assertNativeSuccess(response); if (!response.recalled) throw new Error('Douyin did not confirm recall');
  }
  private async videoDetail(p: Record<string, unknown>, seekSubtitles = false) {
    const id = String(p.aweme_id);
    const sources_checked: string[] = []; const warnings: string[] = [];
    const result = (detail: Record<string, unknown>, source: 'web' | 'im' | 'mobile') => ({ aweme_detail: detail, source, subtitle_tracks: subtitleTracks(detail), sources_checked, warnings });
    let candidate: ReturnType<typeof result> | undefined;
    // Reuse existing chat context only; a read never creates a conversation.
    const fromIm = async (shortId: string) => {
      sources_checked.push('im');
      const rows = await this.im.getSharedWorkDetails(shortId, [id]);
      const row = rows.find(row => row.workId === id);
      if (row?.filtered) throw new ActionFault(1404, 'WORK_UNAVAILABLE: Douyin filtered this work for the current account');
      const detail = object(row?.detail);
      if (String(detail.aweme_id ?? '') !== id) throw new Error('IM response missing matching work detail');
      return result(detail, 'im');
    };
    if (p.conversation_short_id) {
      try { candidate = await fromIm(String(p.conversation_short_id)); }
      catch (error) { if (error instanceof ActionFault) throw error; warnings.push('IM_DETAIL_UNAVAILABLE'); }
      if (candidate && (!seekSubtitles || candidate.subtitle_tracks.length)) return candidate;
    }
    sources_checked.push('web');
    try {
      const web = result(await this.web.videoDetail(id), 'web');
      if (!seekSubtitles || web.subtitle_tracks.length) return web;
      candidate = web;
    } catch (error) { warnings.push(error instanceof ActionFault && error.message.startsWith('WEB_DETAIL_UIFID_REQUIRED:') ? 'WEB_DETAIL_UIFID_REQUIRED' : 'WEB_DETAIL_UNAVAILABLE'); }
    if (!p.conversation_short_id) {
      try {
        const list = await this.im.listThreads({ count: 20 }); assertNativeSuccess(list);
        const context = list.conversations.find(c => /^\d{1,30}$/.test(c.conversationShortId));
        if (context) {
          const im = await fromIm(context.conversationShortId);
          if (!seekSubtitles || im.subtitle_tracks.length) return im;
          candidate ??= im;
        }
      } catch (error) { if (error instanceof ActionFault) throw error; warnings.push('IM_DETAIL_UNAVAILABLE'); }
    }
    sources_checked.push('mobile');
    try {
      const mobile = result(await this.web.mobileVideoDetail(id), 'mobile');
      if (mobile.subtitle_tracks.length || !candidate) return mobile;
    } catch { warnings.push('MOBILE_DETAIL_UNAVAILABLE'); }
    if (candidate) return candidate;
    throw new ActionFault(1500, 'WORK_DETAIL_FAILED: all detail sources unavailable; check login/web-session and provide conversation_short_id from the share event');
  }
  async execute(action: ExtensionAction, p: Record<string, unknown>): Promise<ExtensionResult> {
    switch (action) {
      case 'dy_get_video_detail': return { data: await this.videoDetail(p) };
      case 'dy_get_video_subtitles': {
        const detail = await this.videoDetail(p, true);
        return { data: { ...await readSubtitles(detail.aweme_detail, { ...(p.language ? { language: String(p.language) } : {}), ...(p.track_index !== undefined ? { track_index: Number(p.track_index) } : {}) }), source: detail.source, sources_checked: detail.sources_checked, warnings: detail.warnings } };
      }
      case 'dy_get_user_info': return { data: await this.web.request('/aweme/v1/web/user/profile/other/', { sec_user_id: String(p.sec_user_id) }) };
      case 'dy_get_user_posts': return { data: await this.web.posts(String(p.sec_user_id), String(p.max_cursor), Number(p.count)) };
      case 'dy_get_user_posts_count': return { data: await this.web.collectPosts(String(p.sec_user_id), Number(p.target_count)) };
      case 'dy_get_user_posts_page': return { data: await this.web.collectPosts(String(p.sec_user_id), Number(p.page_size), Number(p.page), Number(p.page_size)) };
      case 'dy_get_video_comments': return { data: await this.web.request('/aweme/v1/web/comment/list/', { aweme_id: String(p.aweme_id), cursor: String(p.cursor), count: String(p.count) }) };
      case 'dy_comment_video': return { data: await this.web.comment(String(p.aweme_id), String(p.text)) };
      case 'dy_comment_video_image': return { data: await this.web.comment(String(p.aweme_id), String(p.text), { uri: String(p.image_uri), width: Number(p.width), height: Number(p.height), format: String(p.image_format) }) };
      case 'dy_upload_comment_image': return { data: await this.web.uploadCommentImage(String(p.image_base64)) };
      case 'dy_upload_image_and_comment': {
        const image = await this.web.uploadCommentImage(String(p.image_base64));
        return { data: await this.web.comment(String(p.aweme_id), String(p.text), image) };
      }
      case 'dy_upload_image': return { data: await this.im.uploadImage(decodeImageBase64(String(p.image_base64))) };
      case 'dy_create_conversation': {
        const c = await this.create(String(p.native_user_id)); return { data: { conversation_id: c.threadId, conversation_short_id: c.conversationShortId, conversation_type: c.conversationType, native_user_id: c.userId } };
      }
      case 'dy_fetch_stranger_messages': {
        const [version = '0', position = '0'] = String(p.cursor).split(':');
        const offset = Number(position); const count = Number(p.count);
        if (p.conversation_short_id) {
          const response = await this.im.getStrangerMessages(String(p.conversation_short_id), false); assertNativeSuccess(response);
          const more = response.messages.length > offset + count;
          return { data: { messages: response.messages.slice(offset, offset + count), has_more: more, next_cursor: more ? `0:${offset + count}` : '0' } };
        }
        const latest = version === '0' ? '9223372036854775807' : version;
        const response = await this.im.getRecentStrangerMessages({ latestStrangerVersion: latest, earliestStrangerVersion: '0', inboxType: 1 }); assertNativeSuccess(response);
        const remaining = response.messages.length > offset + count;
        const next = remaining ? `${latest}:${offset + count}` : response.nextStrangerVersion;
        if (!remaining && response.hasMore && BigInt(response.nextStrangerVersion) >= BigInt(latest)) throw new Error('Stranger cursor did not advance');
        return { data: { conversations: response.messages.slice(offset, offset + count), next_cursor: next, has_more: remaining || response.hasMore } };
      }
      case 'dy_send_stranger_msg': {
        const user = await this.im.getUserProfile(String(p.sec_user_id)); if (!user?.uid) throw new Error('Douyin user not found');
        const text = String(p.text);
        return this.send(await this.create(user.uid), JSON.stringify({ text, aweType: 700 }), 7, [{ type: 'text', text }]);
      }
      case 'dy_send_conversation_msg': {
        const text = String(p.text); return this.send(await this.address(p), JSON.stringify({ text, aweType: 700 }), 7, [{ type: 'text', text }]);
      }
      case 'dy_list_dynamic_emojis': return { data: DYNAMIC_EMOJIS.map(e => ({ ...e, available: (!e.start || Date.now()/1000 >= Number(e.start)) && (!e.end || Date.now()/1000 < Number(e.end)) })) };
      case 'dy_send_dynamic_emoji': {
        const preset = DYNAMIC_EMOJIS.find(e => e.name === p.name);
        if (!preset && !p.url) throw new ActionFault(1400, 'Unknown emoji name; call dy_list_dynamic_emojis or supply url');
        if ((preset?.start && Date.now()/1000 < Number(preset.start)) || (preset?.end && Date.now()/1000 >= Number(preset.end))) throw new ActionFault(1400, 'Emoji is outside its availability window');
        const url = cdnUrl(String(p.url ?? preset?.url)).href;
        const content = { aweType: 507, display_name: p.name, width: p.width ?? preset?.width ?? 100, height: p.height ?? preset?.height ?? 100, image_type: p.image_type ?? preset?.imageType ?? 'png', image_id: 0, package_id: 0, resource_type: preset?.resourceType ?? 4, version: preset?.version ?? 2, biz_type: preset?.bizType ?? 1, show_notice: false, updateConversationTime: true, createdAt: 0, is_card: false, msgHint: '', url: { uri: url, url_list: [url], width: 0, height: 0, data_size: 0 }, ...(preset?.interaction ? { extra: { light_interaction: preset.interaction } } : {}) };
        return this.send(await this.address(p), JSON.stringify(content), 5, [{ type: 'image', url }]);
      }
      case 'dy_send_video_card': {
        const card = buildCardMessage({ type: 'share', work: { itemId: String(p.item_id), ...(p.title ? { title: String(p.title) } : {}) } });
        return this.send(await this.address(p), card.content, card.messageType, [{ type: 'text', text: `[抖音作品] ${p.title ?? ''} https://www.douyin.com/video/${p.item_id}` }]);
      }
      case 'dy_send_image': {
        const bytes = p.image_base64 ? decodeImageBase64(String(p.image_base64)) : undefined;
        const image = bytes ? await this.im.uploadImage(bytes) : object(p.image);
        const content = JSON.stringify({ resource_url: { oid: image.oid, skey: image.skey, data_size: image.dataSize, md5: image.md5 }, cover_width: image.width, cover_height: image.height, check_pics: [], md5: image.md5, from_gallery: 1, aweType: image.format === 'gif' ? 2703 : 2702 });
        const url = bytes && this.media ? this.media.put(bytes) : undefined;
        return this.send(await this.address(p), content, 27, [url ? { type: 'image', url } : { type: 'text', text: '[抖音图片：已上传资源]' }]);
      }
    }
  }
}
