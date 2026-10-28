import { z } from 'zod';
import { ActionFault, type ActionDefinition } from './types.js';

const id = z.string().regex(/^\d{1,30}$/);
const sec = z.string().min(1).max(200);
const text = z.string().min(1).max(10000);
const count = z.number().int().min(1).max(100).default(20);
const cursor = id.default('0');
const base64 = z.string().min(4).max(22369641);
const dimension = z.number().int().positive().max(32768);
const target = { conversation_id: z.string().min(1).max(200).optional(), conversation_short_id: id.optional(), is_group: z.boolean().default(false), native_user_id: id.optional() };
const asset = z.object({ oid: text, skey: z.string().regex(/^[a-f\d]{64}$/i), md5: z.string().regex(/^[a-f\d]{32}$/i), dataSize: z.number().int().positive().max(16777216), width: dimension, height: dimension, format: z.enum(['jpeg', 'png', 'gif', 'webp', 'heic']).optional() }).strict();
const definitions = {
  dy_get_video_detail: { description: '读取作品原始详情与字幕轨道；网页失败时使用私信分享详情接口', write: false, schema: z.object({ aweme_id: id, conversation_short_id: id.optional() }).strict() },
  dy_get_video_subtitles: { description: '读取作品原生字幕，返回纯文本和秒制时间轴（不执行语音识别）', write: false, schema: z.object({ aweme_id: id, conversation_short_id: id.optional(), language: z.string().min(1).max(32).optional(), track_index: z.number().int().min(0).max(31).optional() }).strict() },
  dy_get_user_info: { description: '按 sec_user_id 查询抖音用户资料', write: false, schema: z.object({ sec_user_id: sec }).strict() },
  dy_get_user_posts: { description: '游标分页查询用户作品', write: false, schema: z.object({ sec_user_id: sec, max_cursor: cursor, count }).strict() },
  dy_get_user_posts_count: { description: '按数量聚合用户作品（最多 1000 条）', write: false, schema: z.object({ sec_user_id: sec, target_count: z.number().int().min(1).max(1000) }).strict() },
  dy_get_user_posts_page: { description: '按页码查询用户作品（顺序遍历游标）', write: false, schema: z.object({ sec_user_id: sec, page: z.number().int().min(1).max(50), page_size: count }).strict() },
  dy_create_conversation: { description: '为原生用户 UID 创建私信会话', write: true, schema: z.object({ native_user_id: id }).strict() },
  dy_fetch_stranger_messages: { description: '分页获取陌生人会话或指定会话的消息（不清除未读）', write: false, schema: z.object({ count, cursor: z.string().regex(/^\d{1,19}(?::\d{1,6})?$/).default('0'), conversation_short_id: id.optional() }).strict() },
  dy_send_stranger_msg: { description: '按 sec_user_id 创建会话并发送私信', write: true, schema: z.object({ sec_user_id: sec, text }).strict() },
  dy_send_conversation_msg: { description: '按原生会话信息发送文本', write: true, schema: z.object({ ...target, text }).strict() },
  dy_upload_image: { description: '上传私信图片并返回加密图片资源', write: true, schema: z.object({ image_base64: base64 }).strict() },
  dy_send_image: { description: '向会话发送已上传资源或 Base64 图片', write: true, schema: z.object({ ...target, image_base64: base64.optional(), image: asset.optional() }).strict() },
  dy_list_dynamic_emojis: { description: '列出内置动态表情名称及资源信息', write: false, schema: z.object({}).strict() },
  dy_send_dynamic_emoji: { description: '向会话发送动态表情，可指定新资源 URL', write: true, schema: z.object({ ...target, name: z.string().min(1).max(100), url: z.url().max(4096).optional(), width: dimension.optional(), height: dimension.optional(), image_type: z.enum(['png', 'gif', 'webp', 'jpeg']).optional() }).strict() },
  dy_send_video_card: { description: '向会话分享抖音作品卡片', write: true, schema: z.object({ ...target, item_id: id, title: z.string().max(1000).optional() }).strict() },
  dy_get_video_comments: { description: '分页获取作品评论', write: false, schema: z.object({ aweme_id: id, cursor, count }).strict() },
  dy_comment_video: { description: '发布文字评论', write: true, schema: z.object({ aweme_id: id, text }).strict() },
  dy_comment_video_image: { description: '使用已上传的评论图片发布图文评论', write: true, schema: z.object({ aweme_id: id, text: z.string().max(10000).default(''), image_uri: text, width: dimension, height: dimension, image_format: z.enum(['jpeg', 'png', 'gif', 'webp']).default('jpeg') }).strict() },
  dy_upload_comment_image: { description: '上传评论图片并返回 URI 和实际尺寸', write: true, schema: z.object({ image_base64: base64 }).strict() },
  dy_upload_image_and_comment: { description: '上传图片并发布图文评论', write: true, schema: z.object({ aweme_id: id, text: z.string().max(10000).default(''), image_base64: base64 }).strict() },
} as const;
export type ExtensionAction = keyof typeof definitions;
export const EXTENSION_READ_ACTIONS = Object.keys(definitions).filter(k => !definitions[k as ExtensionAction].write) as ExtensionAction[];
export const EXTENSION_WRITE_ACTIONS = Object.keys(definitions).filter(k => definitions[k as ExtensionAction].write) as ExtensionAction[];
const examples: Partial<Record<ExtensionAction, Record<string, unknown>>> = {
  dy_send_conversation_msg: { native_user_id: '请替换为抖音数字UID', text: '你好' },
  dy_send_image: { native_user_id: '请替换为抖音数字UID', image_base64: '请替换为图片Base64内容' },
  dy_send_dynamic_emoji: { native_user_id: '请替换为抖音数字UID', name: '比心' },
  dy_send_video_card: { native_user_id: '请替换为抖音数字UID', item_id: '请替换为作品数字ID' },
};
export const EXTENSION_ACTIONS: ActionDefinition[] = Object.entries(definitions).map(([action, value]) => ({ action, description: value.description, params: { ...z.toJSONSchema(value.schema, { target: 'draft-7', io: 'input' }), ...(examples[action as ExtensionAction] ? { examples: [examples[action as ExtensionAction]] } : {}) } }));
export function isExtensionAction(action: string): action is ExtensionAction { return Object.hasOwn(definitions, action); }
export function extensionParams(action: ExtensionAction, value: unknown): Record<string, unknown> {
  const result = definitions[action].schema.safeParse(value);
  if (!result.success) throw new ActionFault(1400, `Invalid ${action} parameters: ${result.error.issues.map(i => i.path.join('.') || 'params').join(', ')}`);
  const p = result.data as Record<string, unknown>;
  if (['dy_send_image', 'dy_send_dynamic_emoji', 'dy_send_video_card', 'dy_send_conversation_msg'].includes(action)) {
    if (p.native_user_id ? (p.conversation_id || p.conversation_short_id || p.is_group) : (!p.conversation_id || !p.conversation_short_id)) throw new ActionFault(1400, 'Supply native_user_id OR both conversation_id and conversation_short_id');
  }
  if (action === 'dy_send_image' && Boolean(p.image_base64) === Boolean(p.image)) throw new ActionFault(1400, 'Supply exactly one image or image_base64');
  return p;
}
