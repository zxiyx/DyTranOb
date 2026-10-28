# 动作与事件

DyTranOb 实现 OneBot v11 的实用子集，并提供 `dy_*` 扩展。运行中可通过 `GET /api/actions` 获取当前的 45 个动作及参数 JSON Schema。目录包含协议入口，不代表每个原生账号均有权限执行。

机器人接入的完整参数与返回说明见 [AstrBot 接口手册](astrbot.md)。静态机器可读 Schema 位于 `/docs/actions.json`；作品详情和字幕分别使用 `dy_get_video_detail`、`dy_get_video_subtitles`。

## 请求与响应

```json
{
  "action": "send_private_msg",
  "account_id": "main",
  "params": {
    "user_id": 2,
    "message": [{ "type": "text", "data": { "text": "你好" } }]
  },
  "echo": "request-1"
}
```

示例中的 `user_id: 2` 是示意值，请使用好友列表或 `dy_resolve_id` 返回的实际别名。请求里的数字 ID 均是当前运行时映射后的 OneBot ID。

```json
{
  "status": "ok",
  "retcode": 0,
  "data": { "message_id": 4 },
  "echo": "request-1"
}
```

失败响应的 `status` 为 `failed`，`data` 为 `null`，并提供 `message` / `wording`。HTTP 200 仍可能包含动作失败，调用端必须检查 `status` 与 `retcode`。`echo` 原样返回。多账号需使用 `account_id` 或 `self_id` 选择账号，详见架构文档。

## 动作兼容矩阵

| 动作 | 主要参数 | 原生抖音适配器范围 |
| --- | --- | --- |
| `get_version_info` | 无 | 版本与协议信息 |
| `get_status` | 无 | 全局或选定账号状态 |
| `get_login_info` | 无 | 已登录用户 |
| `get_friend_list` | 无 | 原生好友列表 |
| `get_group_list` | 无 | 原生群列表 |
| `get_group_info` | `group_id` | 从群列表查找；未知人数用 0 占位 |
| `get_group_member_list` | `group_id` | 原生群成员列表；未公开角色等字段采用占位值 |
| `get_group_member_info` | `group_id`, `user_id` | 从群成员列表查找 |
| `get_stranger_info` | `user_id` | 仅当前好友中的已知用户资料 |
| `send_private_msg` | `user_id`, `message` | 文本、@ / 引用、HTTPS / Base64 图片；图文和多图按原顺序拆分发送 |
| `send_group_msg` | `group_id`, `message` | 同上；受原生群权限约束 |
| `send_msg` | `message`，目标 ID | `message_type` 可选；同时存在两种目标时必须指定类型 |
| `get_msg` | `message_id` | 仅本地最近 5000 条消息缓存；账号离线仍可读取 |
| `delete_msg` | `message_id` | 当前运行期间已观察到路由与服务器 ID 的消息，受平台撤回限制 |
| `set_group_name` | `group_id`, `group_name` | 不支持：上游 1.1.0 无公开修改群名接口 |
| `set_group_leave` | `group_id` | 退出群；不支持 `is_dismiss: true` |
| `set_group_kick` | `group_id`, `user_id` | 受群权限约束；不支持 `reject_add_request: true` |
| `set_friend_add_request` | `flag`，可选 `approve` | 不支持：上游仅有好友申请通知 |
| `set_group_add_request` | `flag`，可选 `approve` | 仅当前进程收到的加群申请；不支持邀请审批及拒绝理由 |
| `can_send_image` | 无 | 返回 `yes: true`；具体图片与网络条件仍需检查 |
| `can_send_record` | 无 | 返回 `yes: false` |
| `dy_list_accounts` | 无 | 账号 ID、类型、在线状态与已知 self_id |
| `dy_get_capabilities` | 无 | 运行时动作目录与限制说明 |
| `dy_resolve_id` | `kind`, `native_id` | 原生字符串 ID → 稳定本地整数别名 |
| `dy_get_native_id` | `kind`, `id` | 按选定账号反查原生字符串 ID |

`no_cache` 参数可用于协议兼容，不保证改变上游 SDK 的缓存策略。群成员 `role`、`sex`、`age`、`card` 等 QQ 字段没有完整抖音对应数据，不能据此作权限判断。

QQ 专属功能（戳一戳、群荣誉、QQ 音乐卡片、QQ 空间、QQ 语音等）、群解散与其他未列出动作返回不支持。项目不包含插件系统。

## 消息格式

推荐使用消息段数组，亦接受文本或 CQ 字符串。`auto_escape: true` 时，字符串整体视为普通文本。

| 消息段 | OneBot 数据 | 原生适配器行为 |
| --- | --- | --- |
| `text` | `{ "text": "你好" }` | 支持 |
| `at` | `{ "qq": 2 }` | 使用映射后的用户 ID；群内 @；不支持全体 @ |
| `reply` | `{ "id": 4 }` | 引用当前进程中已观察到的消息 |
| `image` | `{ "file": "https://..." }` | 支持 HTTPS 或 base64:// 图片（最大 16 MiB）；图文 / 多图拆分发送，不接受服务端本地路径 |
| `video` | `{ "file": "https://..." }` | 运行时模型保留此类型，原生发送明确不支持 |

入站图片 / 表情会下载、按需解密后转换成临时缓存 URL，兼容 AstrBot；原生视频没有可靠播放 URL 时仍返回文本占位。新增网页作品、评论、陌生人、动态表情和图片上传动作的参数与完整对照见 [抖音扩展与媒体接入](extensions.md)。

## 事件

事件含 `time`（秒）、`self_id`、`post_type`，账号原生事件额外含 `account_id`。消息采用数组形式 `message`，并提供 CQ 表达的 `raw_message`。保留原生字符串 ID 的消息扩展字段位于 `dy`。

```json
{
  "time": 1700000000,
  "self_id": 1,
  "account_id": "main",
  "post_type": "message",
  "message_type": "private",
  "sub_type": "friend",
  "message_id": 4,
  "user_id": 2,
  "message": [{ "type": "text", "data": { "text": "你好" } }],
  "raw_message": "你好",
  "sender": { "user_id": 2, "nickname": "示例用户" },
  "dy": { "message_id": "90071992547409931234", "user_id": "12345678901234567890" }
}
```

- `message`：私信与群消息；群消息含 `group_id`。
- `message_sent`：本账号发出的消息回显，避免与入站消息混淆。
- `notice`：群成员增加 / 减少、好友增加、私信 / 群消息撤回，取决于上游事件与权限。
- `request`：好友或加群申请通知；`flag` 是申请句柄，不应当作用户 ID。好友通知不意味着可审批。
- `meta_event`：生命周期与心跳。未登录前的传输元事件可能使用 `self_id: 0`；在线后以实际映射 ID 为准。

## 错误码

| retcode | 含义 |
| --- | --- |
| `0` | 成功 |
| `1400` | 请求或参数无效、账号选择器冲突 |
| `1401` | 未认证或凭据错误 |
| `1403` | 跨源请求被拒绝 |
| `1404` | 不支持的动作 / 原生能力、未知账号或 ID、缓存中不存在 |
| `1405` | HTTP 方法不允许 |
| `1413` | 请求体超过限制 |
| `1500` | 原生操作或运行时失败；查看本地诊断 |
| `1503` | 账号离线，需要恢复会话或完成登录 |

SDK 会把失败转换为 `ActionError`，保留 `retcode` 和标准响应。MCP 仅返回经过简化的错误，不把请求头、令牌或原生凭据暴露给模型。
