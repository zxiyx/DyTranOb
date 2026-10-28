# 抖音扩展与媒体接入

本章对照 [Rockedw/douyin-web-api-sdk](https://github.com/Rockedw/douyin-web-api-sdk) 的公开 `DouyinMessageSDK` 方法，记录 TypeScript 实现。现有 25 个动作之外新增 20 个 `dy_*` 动作，总计 45 个。所有扩展经过同一个 Runtime 分发，可从标准 HTTP、正向 / 反向 WebSocket、WebUI 动作调试、CMD、SDK 和 MCP 调用。

## 功能对照

| 参考 SDK 能力 | DyTranOb 入口 | 说明 |
| --- | --- | --- |
| connect / disconnect / close | SDK `connect()` / `disconnect()` / `close()` | 连接桥接 WebSocket；断开后可再次 connect，close 后实例不可复用；原生账号由运行时管理 |
| isConnected / getConnectionStatus | SDK 同名方法、`get_status` | SDK 方法表示客户端连接状态，get_status 表示抖音账号状态 |
| 消息与连接监听器 | SDK `event` / `connected` / `disconnected` / `transport_error` 事件 | 原生会话继续由 douyin-im 接收、心跳与重连 |
| sendMessage | `dy_send_conversation_msg`；标准 `send_private_msg` / `send_group_msg` | 新入口接受原生会话 ID，标准入口接受本地 OneBot 别名 |
| sendImageMessage | `dy_send_image` 的 `image` 参数 | 发送已上传图片，包含 oid、skey、md5、尺寸等 |
| uploadAndSendImageMessage，文件与字节重载 | `dy_send_image` 的 `image_base64`；SDK `uploadAndSendImageMessage` / `uploadAndSendImageFile` | 本地文件由 SDK 客户端读取，不允许远程动作读取服务端任意路径 |
| 独立图片上传 | `dy_upload_image` | 返回可传给 dy_send_image 的图片资源 |
| sendDynamicEmojiMessage | `dy_send_dynamic_emoji` / `dy_list_dynamic_emojis` | 内置 22 条资源元数据；按名称发送，活动表情受时间窗限制，URL 可覆盖 |
| sendVideoCardMessage | `dy_send_video_card` | 分享作品 ID，使用 douyin-im 卡片构造；不是视频文件上传 |
| createConversation | `dy_create_conversation` | 按原生数字 UID 创建私信会话 |
| sendMsg2Stranger | `dy_send_stranger_msg` | sec_user_id → UID → 创建会话 → 发送文字 |
| fetchStrangerMessages | `dy_fetch_stranger_messages` | 陌生人会话分页；也可按会话短 ID 获取消息，不清除未读 |
| getUserInfo | `dy_get_user_info` | 返回网页资料接口数据 |
| getUserPosts | `dy_get_user_posts` | 原生游标分页，保留 has_more、max_cursor、aweme_list |
| getUserPostsWithCount | `dy_get_user_posts_count` | 按数量聚合，去重、限制最多 1000 条和 50 次分页，重复游标停止 |
| getUserPostsByPage | `dy_get_user_posts_page` | 顺序遍历游标到指定页，最多 50 页；不是随机访问 |
| commentVideo | `dy_comment_video` | 发布文字评论，必须取得 comment.cid 才返回成功 |
| commentVideoWithImage | `dy_comment_video_image` | 使用已上传评论图片 URI、实际尺寸发布 |
| uploadImageAndCommentVideo，文件与字节重载 | `dy_upload_image_and_comment`；SDK `uploadImageAndCommentVideo` / `uploadImageFileAndCommentVideo` | 授权 → ImageX 申请 → CRC 校验上传 → 提交 → 发布评论 |
| 独立评论图片上传 | `dy_upload_comment_image` | 返回 uri、width、height、format；与私信加密图片资源不可混用 |
| getVideoCommentList | `dy_get_video_comments` | cursor / count 分页读取作品评论 |
| 作品详情 | `dy_get_video_detail` | aweme_id 字符串，原始详情、字幕轨道、来源与诊断 |
| 原生字幕 | `dy_get_video_subtitles` | 直接返回 text、秒制 cues、available 与 reason；无字幕元数据和下载失败分别处理 |

完整的参数、返回结构、AstrBot Python 调用和 MCP 接入见 [AstrBot 接口手册](astrbot.md)。字幕来源兼容 video.cla_info.caption_info / caption_infos 与 video.subtitle_infos。查询作品不再仅依赖网页接口，可使用已有私信会话和公开移动接口；私信接口可能省略字幕元数据，字幕查询会继续检查其他来源。

接口代码和隔离测试已经实现。真实抖音网络、登录态、平台校验和账号权限仍决定执行结果；本次验证没有向真实用户发送消息，也没有发布真实评论。特别是网页作品 / 评论接口，应视为需要真实账号联调的扩展能力，不将测试夹具通过描述成平台实测成功。Mock 账号不模拟这些平台操作成功。

## 参数与 ID

完整 JSON Schema 由 `GET /api/actions` 提供，WebUI 的动作调试同步展示。新增动作严格校验参数；不接受未知字段。

原生 `native_user_id`、`conversation_short_id`、`item_id`、`aweme_id` 和游标都用字符串，避免 64 位 ID 精度丢失。`sec_user_id` 是用户主页的加密 ID，不等同于数字 UID。原生扩展返回的数据保留平台字段；不要把原生字符串 ID 直接传给要求 OneBot 整数的旧动作。

四个会话发送动作（文本、图片、动态表情、作品卡片）必须选择一种目标：

```json
{ "native_user_id": "1234567890123456789" }
```

```json
{
  "conversation_id": "0:1:1234567890123456789:987654321098765432",
  "conversation_short_id": "7123456789012345678",
  "is_group": false
}
```

前者会创建私信会话；后者可直接使用已知会话，群聊设置 `is_group: true`。不要同时填写两种目标。发送成功返回本地 `message_id`、原生 `native_message_id` 及会话 ID，并产生 `message_sent` 事件，可使用 `delete_msg` 在本次运行期间尝试撤回。

`dy_send_image` 只能填写 `image_base64` 或 `image` 之一。Base64 支持纯内容或 `base64://` 前缀，解码后最大 16 MiB。普通 OneBot image 消息段也支持 `file: "base64://..."`，建议用消息段数组；CQ 字符串仍有 100000 字符上限。HTTP / WS 总请求上限为 24 MiB，图文混合与多图会拆成多条原生消息，仍不接受服务端文件路径。

作品与评论的 `count` 范围 1–100，默认 20；作品 `max_cursor`、评论 `cursor` 初始为 `"0"`。聚合响应含 `complete`：平台无更多数据或数量已满足时为 true；达到分页上限、游标不推进时可能为 false。不能把 complete:false 当作已抓取全部作品。

陌生人接口 `count` 限制每次返回的会话数，指定 `conversation_short_id` 时限制消息数。首次 `cursor: "0"`，以后将返回的 `next_cursor` 原样传回；它可能包含冒号表示平台批次中的位置。停止条件是 `has_more: false`。列表在两次请求间可能变化，业务端可按会话或消息 ID 去重。

## 调用示例

WebUI 登录后进入「动作调试」，选择 `dy_get_user_posts`，填入实际 sec_user_id 和账号。动态表情先调用 `dy_list_dynamic_emojis`，再选择 `available: true` 的名称。预填的中文占位符必须替换为真实值。

```json
{
  "action": "dy_send_dynamic_emoji",
  "account_id": "001",
  "params": { "native_user_id": "1234567890123456789", "name": "比心" },
  "echo": "emoji-1"
}
```

动态表情资源是平台 URL，可能过期。此时可在动作参数提供新 `url`，并按需要提供 `width`、`height`、`image_type`。不尝试把不可用的资源 ID 拼成下载地址。

```typescript
import { createClient } from 'dytranob/sdk';
const client = createClient({ baseUrl: 'http://127.0.0.1:5088', token: process.env.DYTRANOB_TOKEN });
const account = { account_id: '001' };
const posts = await client.getUserPosts('实际 sec_user_id', '0', 20, account);
const comments = await client.getVideoCommentList('实际作品数字ID', '0', 20, account);
// 下列调用会对真实账号执行发送 / 发布：
await client.uploadAndSendImageFile({ native_user_id: '实际数字UID' }, 'D:/pictures/demo.png', account);
await client.uploadImageFileAndCommentVideo('实际作品数字ID', '评论内容', 'D:/pictures/demo.png', account);
client.close();
```

SDK 的常用方法与上面对照表同名，始终可以用 `client.call(action, params, {account_id})` 或 `client.callWs(...)` 调用完整参数。SDK 使用管理 Token 调用 `/api/action`；AstrBot 的标准 OneBot 连接使用自己的 Token。

CMD 可把参数保存成 UTF-8 JSON 文件，再执行：

```bat
set DYTRANOB_TOKEN=你的固定WebUI令牌
dytranob.cmd call dy_get_user_posts --account 001 --params-file posts.json
```

`posts.json` 例子：

```json
{ "sec_user_id": "实际 sec_user_id", "max_cursor": "0", "count": 20 }
```

MCP 的 `douyin_query` 开放资料、作品、评论列表、表情列表和陌生人查询。`douyin_write` 需要 `--allow-write`，才可发送、上传、创建会话和发布评论。请求超时不代表平台没有执行写入；确认结果后再决定是否重试，运行时不自动重复发布评论。

## AstrBot 图片与表情

### smart_imagechat_hub 插件发送图片

该插件使用 `Image.fromFileSystem` 构造图片，本机 AstrBot 的 aiocqhttp 适配器会读取图片并转换为 OneBot `image.data.file = "base64://..."`。开启自定义回复或追加表情时，可能把文字与图片放在同一条消息链中。DyTranOb 已支持这类消息链，无需更改插件或开放服务端文件读取。

`send_private_msg` / `send_group_msg` / `send_msg` 遇到图文或多图时，按原顺序拆成连续文本与单张图片，最多 20 条。发送前校验所有分段；同一会话的这些标准发送动作依次执行，避免两条回复的分段交错。图片带引用且前面没有文字时，先发送引用原消息的 `[图片]` 文本，再发图片。

成功的 `message_id` 对应最后一条真实消息；拆分时额外返回 `message_ids`，包含全部真实消息 ID。每条都会产生 `message_sent` 事件，可分别查询与撤回。若平台在中途拒绝，返回失败，`message` / `wording` 的 `message_ids=...` 列出已发出的部分；剩余分段停止，不会自动重发整条消息链。整条重试可能重复已发送的文字或图片。

### 私信分享的视频与图文卡片

分享作品（原生消息类型 8 / 77）现在转换为 AstrBot 能读取的普通文本：

```text
[抖音视频分享]
标题：作品标题
作品ID：7523456789012345678
https://www.douyin.com/video/7523456789012345678
```

OneBot 事件及 `get_msg` 同时保留 `dy.work`：`item_id`、`kind`（video / images）、`url`、`title`，以及消息里实际存在的 `author_uid` / `author_sec_uid`。长 ID 保持字符串，裸 JSON 数字也先保留精度。图文作品链接使用 `/note/<ID>`；普通链接卡片也保留原始可用的 HTTP(S) 地址。作品页面链接不是视频文件直链，桥接不会把它伪装成可播放的视频文件。

修改仅影响新收到的消息，旧缓存中的“不支持”占位不会自动补回作品 ID。重启 DyTranOb 后请重新分享一条视频卡片，并让图片插件再次回复，以检查实际平台执行结果。

### 接收图片的解密与缓存

普通私信图片可能是 AES-256-GCM 容器，不能直接交给 AstrBot 图片下载器。现在接收链路会尝试原图与缩略图地址，使用消息里的 skey 解密并验证 PNG / JPEG / GIF / WebP 文件头，再生成标准 OneBot image 段。表情优先取 URL 列表，避开 SDK 1.1.0 把不透明 uri 当成网址的问题；GIF 字节不转码。

图片放在进程内缓存中，默认总上限 128 MiB、单张 16 MiB、有效期 1 小时；达到容量上限时按先后顺序淘汰。地址形如 `http://127.0.0.1:5088/media/<随机标识>.png`。持有地址即可读取该张图片，不需要也不包含 WebUI Token。接口只读取缓存，不接受任意 URL 下载或文件路径。重启、过期、淘汰后返回 404；历史事件仍可存在，但旧图片链接不保证可用。

如果 AstrBot 在 Docker、另一台电脑或远程服务器上，请在主配置中增加 AstrBot 能访问的地址：

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 5088,
    "allowRemote": true,
    "token": "你的固定WebUI令牌",
    "onebotToken": "你的OneBot令牌",
    "mediaPublicUrl": "http://192.168.1.100:5088"
  }
}
```

将 IP 替换为运行 DyTranOb 的电脑地址，并配置网络可达性。使用反向代理时也可以设置 HTTPS 基础地址。`mediaPublicUrl` 仅影响事件里的图片地址，不会自动开端口或改防火墙。

重启运行时后重新发送一张图片或表情测试。旧缓存事件没有保存解密密钥，不会自动补修历史链接。下载或解密失败时上报明确的文字占位并记录消息 ID，避免向 AstrBot 发送无法解码的加密内容。HEIC、缺少资源 / 密钥、过期 CDN 地址仍可能失败；图片下载最多尝试 4 个地址，每次最多 15 秒，消息按账号排队，最多积压 128 条。

## 网页接口的登录态

默认复用当前账号的 douyin-im 登录会话、设备参数和可用的 ticket guard 绑定。网页接口会生成 a_bogus，图文上传采用 ImageX V4 签名；仅访问固定平台端点。返回校验失败、缺少 comment.cid 或上传未确认时，都不会返回伪造成功。

如果同一个账号的网页接口要求单独的浏览器参数，可在 `dataDir/accounts/<账号ID>/web-session.json` 手动补充以下可选字段。文件每次执行扩展动作时读取，不需要重启：

```json
{
  "cookies": "同一账号的有效网页 Cookie",
  "userAgent": "获取这些 Cookie 时的浏览器 User-Agent",
  "msToken": "同一网页会话的 msToken",
  "webId": "网页数字 webid",
  "uifid": "网页 uifid",
  "fp": "网页 verifyFp",
  "sessionTrait": "网页 x-tt-session-dtrait"
}
```

此文件不是 WebUI Token 配置，也不会修改主 IM 登录。字段可以省略；不要把示例占位内容当作真实凭据。文件不经 WebUI/API 返回，必须保护其中凭据。补充 Cookie 不保证通过平台验证：会话、签名绑定、网络环境和账号权限可能需要同时匹配。无需将凭据发给开发者，诊断时只提供动作名、返回码和已脱敏日志。

也支持使用浏览器中的原始名称 `UIFID`、`ttwid`、`s_v_web_id`。`UIFID` 等价于 `uifid`，`s_v_web_id` 等价于 `fp`；同一项同时写两种名称时值必须相同。单独填写的值会覆盖 Cookie 中的旧值：UIFID 同时用于 Cookie、请求头和 query，s_v_web_id 同时用于 Cookie 与 fp/verifyFp，ttwid 放入 Cookie。不要把 ttwid 填成数字 webId。

推荐在本地登录抖音网页，按 F12 打开开发者工具，在 Network 中刷新并查找 `aweme/detail` 请求；将同一次请求的 Cookie 和 User-Agent 填入文件。Application → Cookies → 抖音域名也可查看 UIFID、ttwid、s_v_web_id；若看不到对应 Cookie，可检查该成功请求的 uifid 请求头和 fp/verifyFp 参数，不能随机编造。完整网页 Cookie 会替换网页请求原来使用的 IM Cookie，避免混合不同会话。

账号 001 在默认 dataDir 下的配置位置是 `E:/DyTranOb/data/accounts/001/web-session.json`。先保留原文件内容，再补充或更新真实浏览器值，不要把示例值覆盖进去。无需把这些值发送到聊天、AstrBot 大模型或字幕动作参数。

## 实现位置与验证

`src/extensions.ts` 是参数 Schema、动作目录及 MCP 权限的统一来源；`src/adapters/douyin-extensions.ts` 负责 IM 组合流程；`src/adapters/douyin-web.ts` 负责网页请求、分页、签名与评论上传；`src/media.ts` 负责接收图片缓存和解密。没有新增插件系统。

测试覆盖加密图片私信事件、URL / URI 选择、缓存过期、错误密钥、跨域重定向限制、原生长 ID、分页去重与停止条件、陌生人分页、签名验证、评论上传步骤、发送拒绝、HTTP/WS 大图片和 MCP 写权限。执行 `npm run check` 进行类型检查、自动测试和构建；上线后仍需用自己的账号验证平台实际返回。
