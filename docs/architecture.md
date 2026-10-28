# 架构

DyTranOb 将原生会话与外部接入分离。HTTP、WebSocket、WebUI、SDK 与 MCP 最终进入同一个 `Runtime.execute`，避免各入口各自维护业务行为。

```text
抖音 IM / Mock
      │ NativeAdapter：字符串 ID、原生事件与操作
      ▼
Runtime：账号选择 → ID 映射 → OneBot 事件 / 动作
      │                      │
      │ RuntimeStore         └─ 动作调度 → NativeAdapter
      ▼
HTTP / WS / SSE / webhook / 反向 WS
      │
      ├─ 浅色 WebUI
      ├─ Node.js SDK
      └─ MCP stdio 服务
```

## 核心模块

| 模块 | 职责 |
| --- | --- |
| `src/adapters/types.ts` | 与传输无关的 `NativeAdapter`、消息、用户、群与事件类型 |
| `src/adapters/douyin.ts` | `douyin-im@1.1.0` 公开接口、二维码登录、原生消息与操作 |
| `src/adapters/mock.ts` | 无需真实账号的可复现开发适配器 |
| `src/runtime.ts` | 账号隔离、动作目录、OneBot 转换、消息去重 |
| `src/store.ts` | ID 别名和最近消息持久化、数据目录锁 |
| `src/messages.ts` | CQ 字符串与消息段数组的解析、转义与输出 |
| `src/server.ts` | 认证、HTTP / WS / SSE、webhook、反向 WS、静态文件 |
| `src/connections.ts` | 网络连接 CRUD、独立传输生命周期、配置持久化与变更回滚 |
| `src/logger.ts` | 时间 / 级别 / 来源格式、凭据脱敏、独立终端凭据输出 |
| `src/sdk.ts` | Node.js HTTP / WebSocket 客户端 |
| `src/mcp.ts` | MCP 工具白名单与读写边界 |
| `src/config.ts`、`src/cli.ts` | 配置校验、命令行、生命周期 |

## 事件流与动作流

适配器发布 `NativeEvent`。每个账号使用独立的 Promise 队列处理原生事件，保留该账号内的处理顺序；运行时将用户、群与消息字符串 ID 映射为数字，生成 OneBot 事件，并写入本地缓存后向接入层发布。

动作请求包含 `action`、`params`，以及可选 `account_id` / `self_id`。调度器选定账号、反查数字 ID、解析消息段，再调用原生适配器。响应统一为 `status`、`retcode`、`data` 与可选 `echo`。请求和事件里的 `account_id` 是本项目扩展字段。

单账号时省略账号选择器即可；多账号的账号相关动作必须指定 `account_id` 或 `self_id`。同时填写两个选择器时，二者必须指向同一个账号。`get_status` 无选择器时返回全局状态。

## ID 与存储模型

抖音 ID 可能超过 JavaScript 安全整数范围，因此原生 ID 始终保持字符串。禁止对原生 ID 使用 `Number()`、`parseInt()` 或浮点 JSON 字段。

映射键是 `[account_id, kind, native_id]`，其中 `kind` 为 `user`、`group` 或 `message`。运行时为其分配 1 到 2147483647 的递增整数别名。相同原生 ID 在不同账号或不同类型中拥有独立映射；反查错误类型、未知 ID 或跨账号 ID 会失败。

映射与最近 5000 条消息保存到 `dataDir/onebot-store.json`。新增映射先写临时文件再重命名，成功后才对外返回别名。保留相同 `account_id` 与数据目录可在重启后继续使用原有别名。更换数据目录或删除映射后，旧别名不可继续使用。该文件包含消息正文，备份时按会话敏感数据处理。

数据目录使用 `runtime.lock` 防止两个进程同时写入。发现旧锁时会检查进程是否仍然存在；不要让多个实例共用数据目录。

`ConnectionManager` 由 CLI 启动，复用相同的 `Runtime`，为每个网络连接管理独立的传输生命周期；新增连接不会创建额外的抖音会话。连接列表与递增修订号原子保存到 `dataDir/connections.json`。变更按顺序执行，持久化或监听失败时不接受新设置；WebUI 的配置状态以服务端返回为准。

控制台端口提供管理 API、WebUI 与文档；连接级别的 HTTP / WS 监听只提供对应 OneBot 入口与最小存活检查，不开放管理 API。WebUI 在 Token 验证成功后才初始化账号、动作、事件与连接视图；每次访问数据接口仍独立校验 Bearer 凭据。

## 缓存与投递保证

- `get_msg` 读取本地最近 5000 条消息，不查询完整云端历史。
- HTTP 最近事件保留本次运行的最近 200 条；WebUI 只在标签页内保留最近 300 条。
- 同一账号的原生消息 ID 用于有限去重。去重集合有界，重启后重新建立。
- WS、SSE 与 webhook 提供在线事件分发，不提供持久化消费位点、完整补发或恰好一次保证。业务消费者应按账号与 `message_id` 自行去重。
- 原生撤回和引用所需的会话路由仅在当前进程中保留；重启后的旧消息即使仍能 `get_msg`，也不保证可撤回或引用。

## 设计边界

OneBot 是互操作接口，并不使抖音具备 QQ 的全部功能。不存在的原生能力必须返回明确错误，不能用本地假成功替代。Mock 模式用于开发协议行为，不作为原生能力的证据。真实账号依赖上游 SDK、平台状态、权限与验证流程。
