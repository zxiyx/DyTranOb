# DyTranOb：AstrBot 与机器人接口使用手册

适用版本：DyTranOb 0.1.0，包含作品详情、原生字幕动作的构建（45 个动作入口）。本文可直接交给机器人读取。接口存在不表示账号具有对应平台权限；参数以当前运行实例的 Schema 为准。

## 1. 机器人首先读取什么

- 本手册：`GET /docs/astrbot.md`，默认主服务地址 `http://127.0.0.1:5088/docs/astrbot.md`。
- 构建时生成的全部动作 JSON Schema：`GET /docs/actions.json`，响应为 `{ "version": 1, "actions": [...] }`。两个文档地址均为公开静态说明，不包含账号或凭据。
- 当前实例能力：OneBot 动作 `dy_get_capabilities`，检查 `data.actions` 中是否存在准备调用的动作。
- 当前实例参数：管理接口 `GET /api/actions`，需要 WebUI Token；MCP 客户端也可用 `douyin_actions` 读取。
- 账号状态：`dy_list_accounts` 和 `get_status`。需要查询作品的抖音账号必须在线；mock 账号不执行真实平台查询。

文档不会自动成为大模型工具。AstrBot 收到 OneBot 消息后，需要由现有插件中的工具函数调用动作，或配置下面的 MCP，让模型获得 `douyin_query`。仅把文档放进知识库，不会自动执行 HTTP 请求。

## 2. 连接、鉴权与账号选择

| 入口 | 调用方式 | 使用的 Token |
| --- | --- | --- |
| AstrBot 反向 WebSocket | DyTranOb 主动连到 AstrBot 的 OneBot v11 地址；AstrBot 在同一条连接调用动作 | WebUI「连接配置」中该连接的 Token，与 AstrBot 的反向 WS Token 相同；可同时为空 |
| 标准 HTTP | `POST /action`，JSON 中包含 action 和 params；或 `POST /动作名`，JSON 为参数 | 主服务的 `server.onebotToken` 或独立 HTTP 连接的 Token |
| 正向 WebSocket | 连接配置指定的地址，通常 `/ws` | 该 OneBot 连接 Token |
| WebUI / 管理 HTTP | `POST /api/action`、`GET /api/actions` | 固定的 WebUI Token |
| SDK 默认 call / MCP | 通过 `/api/action` 调用主服务 | WebUI Token，MCP 通过环境变量 `DYTRANOB_TOKEN` 提供 |

非空 Token 使用 `Authorization: Bearer YOUR_TOKEN`。不要把 WebUI Token、Cookie 或字幕签名 URL写进公开日志。AstrBot 的 OneBot Token 与 WebUI Token 是两套独立配置，不要混用。独立连接端口并不提供管理接口和文档页面。

以下例子的 `127.0.0.1` 表示调用程序所在机器。AstrBot 在容器或另一台机器时，应换成它能访问的 DyTranOb 主机地址。文档中的 `001`、作品 ID、用户 ID、会话短 ID 都是示例，按实际账号替换。

普通 HTTP / 正向 WS：多账号时在请求最外层填写 `account_id`（配置中的字符串 ID）或 `self_id`（OneBot 整数别名），不要放进 params。反向 WS 的连接已按账号绑定，AstrBot 的 `event.bot.call_action(...)` 无需额外传账号。不要在这个调用的 kwargs 中塞入 account_id，因为它会进入动作参数。

## 3. 通用请求与响应

```json
{
  "action": "dy_get_video_subtitles",
  "account_id": "001",
  "params": { "aweme_id": "7123456789012345678" },
  "echo": "subtitles-1"
}
```

HTTP：将上述 JSON POST 到 `/action`。WS：直接发送上述 JSON 帧，用 echo 匹配返回帧，同时处理异步事件。不要按返回顺序匹配请求。

```json
{
  "status": "ok",
  "retcode": 0,
  "data": { "available": false, "reason": "no_subtitle_metadata", "text": "", "cues": [] },
  "echo": "subtitles-1"
}
```

这个响应仅展示主要字段。HTTP 200 不等于动作成功：原始 HTTP/WS 客户端必须同时检查 `status == "ok"` 和 `retcode == 0`。失败响应为 `status: "failed"`、非零 retcode、`data: null`，并提供 message / wording。aiocqhttp 的 `call_action` 和 DyTranOb SDK 已解包成功的 data，失败时抛出异常；不要再对返回值取一次 data。

ID 规则：OneBot 的 user_id、group_id、message_id 使用本地稳定整数别名；抖音的 aweme_id、item_id、native_user_id、conversation_short_id 都必须使用十进制字符串。不要把 19 位作品 ID 转成 JavaScript Number；不要把消息 ID 当成作品 ID。sec_user_id 是主页的加密用户标识，也不等于数字 UID。

## 4. 从视频分享卡片读取字幕

1. 接收 `post_type: "message"` 的分享事件，读取 `dy.work.item_id`。避免处理自己的 message_sent 造成循环。
2. 若 AstrBot 适配器未保留 dy 字段，用当前消息的 OneBot message_id 调用 `get_msg`，读取 `data.dy.work`。本地最多缓存最近 5000 条消息，重启仍可保留已缓存的内容。
3. 调用 `dy_get_video_subtitles`，传入 `aweme_id: work.item_id`；有 `work.conversation_short_id` 时一并传入，优先使用原生私信详情接口。
4. 只有 `available: true` 才把 text 当作字幕；时间轴在 cues 中，单位为秒。
5. `available: false` 时查看 reason 和 warnings，说明当前没有取得字幕数据，不要用标题、作品描述、评论或视频画面文字假装字幕。

分享事件的关键字段如下，旧版本已缓存的分享可能没有 conversation_short_id，仍可仅传作品 ID。

```json
{
  "post_type": "message",
  "message_id": 208,
  "account_id": "001",
  "dy": {
    "work": {
      "item_id": "7123456789012345678",
      "kind": "video",
      "url": "https://www.douyin.com/video/7123456789012345678",
      "title": "作品原始标题",
      "conversation_short_id": "7123456789012345678"
    }
  }
}
```

只有链接时，从完整 `/video/数字ID` 或 `/note/数字ID` 路径提取字符串 ID。当前动作不接收 v.douyin.com 短链接，也不会把任意 URL 当作字幕下载地址。

### dy_get_video_detail：作品详情

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| aweme_id | string | 是 | 1–30 位十进制作品 ID |
| conversation_short_id | string | 否 | 原生会话短 ID，来自分享事件或已有会话；不是 OneBot group_id |

返回 data：

- `aweme_detail`：平台原始作品对象，包含可能存在的 desc、author、statistics、video、images 等字段，不承诺所有作品都有相同字段。访问字幕原始信息用 `aweme_detail.video.cla_info`。
- `subtitle_tracks`：归一化字幕列表，每项含 `index`、`language`、`format`、`urls`。index 从 0 开始，列表为空不证明视频没有画面字幕或人声。
- `source`：本次采用的详情来源，web / im / mobile。
- `sources_checked`：实际检查的来源；`warnings`：未成功来源的诊断码。

有会话短 ID 时优先使用 IM 详情，否则先用网页登录态。网页失败会读取已有私信会话上下文，再查询 IM 分享详情。仍无法取得详情时尝试官方移动端公开作品接口。不会为了查询而创建新会话。返回作品必须与请求 ID 精确匹配；过滤、缺失和请求失败不会生成假详情。

### dy_get_video_subtitles：原生字幕

与详情动作相同的两个参数，另有：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| language | string | 自动 | 最长 32 字符；精确匹配 language_code，不同地区变体并不自动互换 |
| track_index | integer | 自动 | 0–31，优先于 language；来自最新详情的 subtitle_tracks |

默认优先中文轨道（zh / cmn 前缀），否则选第一个。字幕动作会在详情缺少字幕时继续检查其他详情来源。兼容 `video.cla_info.caption_info`、`caption_infos`、camelCase 变体及 `video.subtitle_infos`；从 url、url_list 等字段取下载地址。支持 VTT、SRT，以及带时间戳的 JSON utterances / cues / body。

成功取得字幕的示意响应 data（以下字幕为示例，不是上述测试作品的内容）：

```json
{
  "aweme_id": "7123456789012345678",
  "source": "web",
  "sources_checked": ["web"],
  "warnings": [],
  "available": true,
  "reason": null,
  "track_index": 0,
  "language": "zh-Hans",
  "tracks": [{ "index": 0, "language": "zh-Hans", "format": "webvtt", "urls": ["https://sf1.douyinstatic.com/example.vtt"] }],
  "text": "第一句字幕\n第二句字幕",
  "cues": [
    { "start": 0.64, "end": 2.12, "text": "第一句字幕" },
    { "start": 2.2, "end": 4.5, "text": "第二句字幕" }
  ]
}
```

| 状态 | 含义 | 调用端处理 |
| --- | --- | --- |
| available=true | 已下载并解析出有效时间轴文本 | 使用 text 或 cues |
| reason=no_subtitle_metadata | 已取得作品详情，但检查的接口没有给出可下载字幕轨道 | 提示未取得原生字幕；不推断视频完全无字幕 |
| reason=language_unavailable | 指定语言不存在 | 从 tracks 选语言，或去掉 language |
| SUBTITLE_TRACK_NOT_FOUND | index 超出当前轨道范围 | 刷新详情后重新选择 |
| SUBTITLE_DOWNLOAD_FAILED | 有地址，但网络、过期地址、未支持域名或格式导致下载解析失败 | 重新查询一次获取新地址；仍失败则报告错误 |
| WORK_DETAIL_FAILED | 所有详情来源都失败 | 检查登录状态、会话短 ID、网页会话和网络 |
| WORK_UNAVAILABLE | 平台明确过滤作品 | 不继续重试或声称已获取内容 |

`warnings` 可能包含 WEB_DETAIL_UIFID_REQUIRED、WEB_DETAIL_UNAVAILABLE、IM_DETAIL_UNAVAILABLE、MOBILE_DETAIL_UNAVAILABLE。WEB_DETAIL_UIFID_REQUIRED 表示网页端要求的 UIFID 缺失。私信已登录与完整网页登录态是两个条件；现有 `web-session.json` 配置方法见 [扩展文档](extensions.md)。同一浏览器的 Cookie、UA、UIFID、fp 需要匹配，不要随机填值。

机器人不需要持有这些凭据。由用户在 DyTranOb 本机的 `data/accounts/<账号ID>/web-session.json` 填写同一次浏览器会话的完整 cookies 和 userAgent，或补充原始字段 UIFID、ttwid、s_v_web_id（旧名 uifid/fp 仍兼容）。DyTranOb 会将这些值用于网页请求；机器人继续仅传 aweme_id 和可选 conversation_short_id。字段名是 `cla_info`，不是 `cal_info`。补齐浏览器标识后仍可能要求有效的网页签名，不能承诺补三个值就一定取得字幕。

每个字幕文件上限 2 MiB，最多 20000 个 cue、500000 字符文本；超限明确失败，不静默返回残缺文本。字幕下载总预算 30 秒，校验每次重定向的官方 CDN 域名，不携带账号 Cookie。字幕地址可能过期，应存储成功返回的文本，不把签名 URL 当永久地址。建议外部调用超时设为 130–180 秒；SDK 的详情/字幕默认超时分别为 90/125 秒。

本功能获取平台已有字幕，不执行 OCR 或语音转写。画面上压制的字幕、音乐歌词、视频描述不等于可下载字幕轨道；若平台不提供，需由 AstrBot 另行配置视频理解或语音识别工具，不能由此接口凭空生成。

## 5. AstrBot Python 调用示例

以下函数供已有 AstrBot 插件/工具调用，不会自动注册成大模型工具。适用 AstrBot 的 aiocqhttp / OneBot v11 事件；反向 WS 已绑定对应账号。

```python
import asyncio
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import AiocqhttpMessageEvent

async def read_shared_subtitles(event: AiocqhttpMessageEvent) -> dict:
    # call_action 返回解包后的 data，失败时抛出异常。
    cached = await event.bot.call_action(
        "get_msg", message_id=int(event.message_obj.message_id)
    )
    work = (cached.get("dy") or {}).get("work") or {}
    aweme_id = work.get("item_id")
    if not isinstance(aweme_id, str) or not aweme_id.isdecimal():
        return {"available": False, "reason": "message_has_no_work_id"}
    params = {"aweme_id": aweme_id}
    if work.get("conversation_short_id"):
        params["conversation_short_id"] = work["conversation_short_id"]
    result = await asyncio.wait_for(
        event.bot.call_action("dy_get_video_subtitles", **params), timeout=150
    )
    return result  # 给模型 text/cues/available/reason/warnings，按状态决定回答。
```

若已有作品 ID，可直接调用 `await event.bot.call_action("dy_get_video_subtitles", aweme_id="7123456789012345678")`。查询错误应交给调用工具的异常处理返回，不要写成空字符串并当作成功。AstrBot 自身的 OneBot API 超时也应大于查询预算；只增加 asyncio.wait_for 不会延长内部更短的超时。

## 6. HTTP、SDK、MCP 示例

标准 HTTP（只读，Token 改为该 OneBot HTTP 连接的值）：

```python
import httpx

async def subtitles_over_http(base_url: str, token: str, aweme_id: str):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(timeout=150) as client:
        response = await client.post(
            f"{base_url.rstrip('/')}/action", headers=headers,
            json={"action": "dy_get_video_subtitles", "account_id": "001",
                  "params": {"aweme_id": aweme_id}},
        )
        response.raise_for_status()
        envelope = response.json()
        if envelope.get("status") != "ok" or envelope.get("retcode") != 0:
            raise RuntimeError(f"{envelope.get('retcode')}: {envelope.get('message')}")
        return envelope["data"]
```

TypeScript SDK（主服务管理入口用 WebUI Token）：

```typescript
import { DyTranObClient } from './dist/sdk.js';
const client = new DyTranObClient({
  baseUrl: 'http://127.0.0.1:5088', token: process.env.DYTRANOB_TOKEN,
});
try {
  const detail = await client.getVideoDetail('7123456789012345678', {}, { account_id: '001' });
  const subtitles = await client.getVideoSubtitles('7123456789012345678', {}, { account_id: '001' });
  // 保存/处理返回数据，不在公开日志输出包含签名的字幕 URL。
} finally { client.close(); }
```

在 AstrBot 的 MCP 配置中添加 stdio 服务（需要 AstrBot 所在主机能启动此路径的 Node 进程）：

```json
{
  "mcpServers": {
    "dytranob": {
      "command": "node",
      "args": ["E:/DyTranOb/dist/cli.js", "mcp", "--url", "http://127.0.0.1:5088"],
      "env": { "DYTRANOB_TOKEN": "填写固定的WebUI Token" }
    }
  }
}
```

模型调用工具 `douyin_query` 的参数如下，不需要开启 --allow-write：

```json
{
  "action": "dy_get_video_subtitles",
  "account_id": "001",
  "params": { "aweme_id": "7123456789012345678" }
}
```

## 7. 其余动作速查：参数与返回值

下表写的是 data，不包括外层 status/retcode/echo。所有参数的精确类型、默认值、长度和可选字段可查 `actions.json` 或 `GET /api/actions`。除了特殊注明的默认值，其余动作必填参数见表。原生响应字段可能随抖音变化，读取时应检查字段是否存在。

| 动作 | 参数 | 返回 / 限制 |
| --- | --- | --- |
| get_version_info | 无 | app_name、app_version、protocol_version、impl |
| get_status | 无 | online、good；未选择账号时还含 accounts |
| dy_list_accounts | 无 | 账号数组：id、kind、online，可选 self_id/nickname |
| dy_get_capabilities | 无 | actions、segments、limitations；segments 是协议模型，不保证原生支持全部发送 |
| get_login_info | 无 | user_id、nickname |
| get_friend_list | 无 | 好友数组，含映射 user_id、nickname 等 |
| get_stranger_info | user_id，可选 no_cache | 已知好友信息；不是任意陌生 UID 查询 |
| get_group_list | 无 | 群数组，含 group_id/group_name/member_count |
| get_group_info | group_id，可选 no_cache | 单个群；未知人数可能为 0 |
| get_group_member_list | group_id | 成员数组；role/sex/age 等 QQ 字段可能为占位值 |
| get_group_member_info | group_id、user_id，可选 no_cache | 单个成员；不得拿占位 role 判断权限 |
| get_msg | message_id | 本地缓存的 message、raw_message、sender、dy 等；不是远程历史消息搜索 |
| dy_resolve_id | kind、native_id | 返回 id；kind=user/group/message，创建本地 ID 映射 |
| dy_get_native_id | kind、id | 返回 native_id；只反查本账号已知映射 |
| can_send_image | 无 | yes=true；不保证每个图片地址或格式可用 |
| can_send_record | 无 | yes=false |
| send_private_msg | user_id、message，可选 auto_escape | message_id；拆分时还有 message_ids |
| send_group_msg | group_id、message，可选 auto_escape | 同上，受原生群权限约束 |
| send_msg | message、目标 ID，可选 message_type | 两种 ID 都给时必须选 private/group |
| delete_msg | message_id | 成功 data=null；只可撤回本次运行已知路由且平台允许的消息 |
| set_group_leave | group_id，可选 is_dismiss=false | 成功 null；解散群不支持 |
| set_group_kick | group_id、user_id，可选 reject_add_request=false | 成功 null；拒绝未来申请不支持 |
| set_group_add_request | flag，可选 approve=true、sub_type/type=add | 成功 null；仅本次运行收到的加群申请，不支持邀请审批、拒绝理由 |
| set_group_name | group_id、group_name | 当前原生 SDK 不支持，返回失败 |
| set_friend_add_request | flag，可选 approve=true、remark | 当前原生 SDK 不支持，返回失败 |

四个原生会话发送动作共用目标参数：二选一填写 `native_user_id`，或同时填写 `conversation_id` + `conversation_short_id`；后者可加 `is_group: true`，默认 false。不要混用两种目标。前者会创建/取得私信会话，属于平台写入。以下称为“会话目标”。

| 动作 | 参数 | 返回 / 限制 |
| --- | --- | --- |
| dy_get_user_info | sec_user_id | 网页用户资料对象；一般从 user 字段读取 |
| dy_get_user_posts | sec_user_id，max_cursor="0"，count=20 | aweme_list、max_cursor、has_more 等 |
| dy_get_user_posts_count | sec_user_id、target_count | 聚合 aweme_list、complete、has_more；target_count=1–1000 |
| dy_get_user_posts_page | sec_user_id、page，page_size=20 | aweme_list、page/page_size、complete；page=1–50，内部顺序遍历游标 |
| dy_get_video_comments | aweme_id，cursor="0"，count=20 | comments、cursor、has_more 等原始评论响应 |
| dy_fetch_stranger_messages | count=20、cursor="0"，可选 conversation_short_id | 不给短 ID 返回 conversations；给短 ID 返回 messages；均含 next_cursor/has_more，不清除未读 |
| dy_list_dynamic_emojis | 无 | 表情名称和资源元数据数组，选择 available=true 的名称 |
| dy_create_conversation | native_user_id | conversation_id、conversation_short_id、conversation_type、native_user_id |
| dy_send_stranger_msg | sec_user_id、text | 创建会话并发送；返回 message_id、native_message_id、会话 ID |
| dy_send_conversation_msg | 会话目标、text | 同上 |
| dy_upload_image | image_base64 | oid、skey、md5、dataSize、width、height、可选 format |
| dy_send_image | 会话目标；image_base64 或 image 二选一 | 发送结果与会话 ID；image 为上一个上传动作返回的完整资源对象 |
| dy_send_dynamic_emoji | 会话目标、name，可选 url/width/height/image_type | 发送结果与会话 ID；内置资源可能受活动时间限制 |
| dy_send_video_card | 会话目标、item_id，可选 title | 发送作品卡片；不是上传视频文件 |
| dy_comment_video | aweme_id、text | 原始评论发布响应；须存在 comment.cid 才成功 |
| dy_upload_comment_image | image_base64 | uri、width、height、format；与私信加密图片资源不同 |
| dy_comment_video_image | aweme_id、image_uri、width、height，text=""、image_format="jpeg" | 使用已有评论图片发布；返回原始评论响应 |
| dy_upload_image_and_comment | aweme_id、image_base64，text="" | 上传后发布；返回原始评论响应 |

分页 count/page_size 范围 1–100，默认 20。作品/评论游标为字符串；陌生人 next_cursor 可能含冒号，必须原样回传。has_more=false 时停止；complete=false 时不能声称已经获取全部。结果可按原生 ID 去重，不要无限重试重复游标。

发送 message 推荐使用 OneBot 数组，例如 `[{"type":"text","data":{"text":"你好"}}]`。图片使用 `{"type":"image","data":{"file":"base64://图片内容"}}` 或可访问的 HTTPS 地址；最大 16 MiB。AstrBot 本地文件应由客户端读成 Base64，不能把 Windows 路径交给 DyTranOb 服务读取。图文和多图会按顺序拆为最多 20 条原生消息；返回 message_id 是最后一条，message_ids 包含所有已成功发送的 ID。部分失败会在 message 中列出已发送 ID，不能重试整条消息以免重复。

原生文本参数通常为 1–10000 字符。原生视频文件、语音、QQ 专属功能和插件系统不在当前实现范围。reply 引用需要当前运行已观察到的消息路由；图片带引用可能先发送引用占位文字再发送图片。

## 8. 错误处理与机器人调用规则

| retcode | 常见原因 | 建议 |
| --- | --- | --- |
| 1400 | 参数错误、错误 ID 类型、多账号未选择 | 查 Schema 后修正；不要盲目重试 |
| 1401 | Token 不正确或缺失 | 检查入口和 Token 类型 |
| 1404 | 动作不支持、ID 不存在、平台过滤作品 | 查能力和目标；不能声称操作成功 |
| 1500 | 原生请求或字幕下载失败、部分发送 | 读取 message；只读请求最多有限重试，写动作不要自动重放 |
| 1503 | 账号离线 | 恢复账号会话后再试 |

建议给模型的调用约定：先查询能力和账号；从分享事件取精确作品字符串 ID；需要视频内容时用 dy_get_video_subtitles，只有 available=true 才引用字幕文本。遇到 no_subtitle_metadata，明确告知“接口暂未提供可读取的原生字幕”，可建议配置视频理解/语音转写。不要把普通作品描述、评论或字幕文件 URL 当作已读视频内容。只在用户要求时执行发送、评论、撤回和群管理。

## 9. 验证范围与参考

只读联调中，网页详情可能因 UIFID 缺失而失败，IM 分享详情与移动端公开详情可返回匹配作品，但可能省略字幕轨道。这不证明视频没有画面字幕。本手册中的作品 ID 与成功字幕 JSON 均为格式示例。

字幕解析、备用地址、HTTP/WS 分发和失败状态由隔离测试验证。真实平台接口、登录态和作品发布设置仍可能影响结果。参考 [douyin-im](https://github.com/zhinjs/douyin-im)、[media-parser 的抖音接口与字幕说明](https://github.com/ucmao/media-parser/blob/main/docs/parsers/douyin.md)；本项目不使用第三方解析服务代传账号 Cookie。
