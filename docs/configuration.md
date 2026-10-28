# 配置与运行

## 环境与启动

要求 Node.js 22.5 或更高版本。原生 SDK 使用 Node.js 内置 SQLite，旧版本 Node.js 无法满足运行要求。建议使用受支持的近期 Node.js 版本。

Windows 双击根目录 `launcher.bat`，程序会一直在 CMD 前台运行。服务就绪后显示 WebUI 地址、当前生效的 Token、HTTP / WebSocket 地址与账号状态；手动打开地址并输入 Token。退出时按 `Ctrl+C`，启动失败时窗口会保留错误信息。

```sh
npm install
npm run dev -- --mock
```

离线演示会选择 `demo` 账号并使用当前工作目录下的 `data/demo`，不访问抖音账号。WebUI 地址默认是 `http://127.0.0.1:5088`。打开后先显示独立的 Token 登录页；验证成功后才显示控制台、账号与网络配置。登录失败时停留在登录页并显示原因。

```sh
npm run dev -- --config dytranob.config.json
npm run build
npm start -- --config dytranob.config.json
```

未指定 `--config` 时，CLI 自动寻找当前目录的 `dytranob.config.json`，否则使用默认配置。`--mock` 会覆盖账号与数据目录设置。可用 `--host`、`--port` 覆盖监听地址。`--help` 显示完整选项。

## 配置示例

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 5088,
    "token": "",
    "onebotToken": "",
    "allowRemote": false
  },
  "dataDir": "./data",
  "accounts": [
    { "id": "main", "type": "douyin" }
  ],
  "heartbeatInterval": 15000,
  "connections": [
    {
      "id": "bot-ws",
      "name": "机器人 WebSocket",
      "type": "ws",
      "enabled": true,
      "host": "127.0.0.1",
      "port": 3001
    }
  ]
}
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `server.host` | `127.0.0.1` | 默认仅监听回环地址 |
| `server.port` | `5088` | 监听端口；`0` 为自动分配，实际端口见日志 |
| `server.token` | 空 | WebUI / 管理令牌；为空时首次生成并固定保存到 `dataDir/webui.json`，重启复用 |
| `server.onebotToken` | 空 | 默认端口的标准 HTTP 动作和 WS 凭据；留空不鉴权，与 WebUI Token 独立 |
| `server.allowRemote` | `false` | 远程监听须显式开启，并配置访问令牌 |
| `dataDir` | `./data` | 相对配置文件目录解析；未指定配置文件时相对当前目录 |
| `accounts` | 一个 `main` 抖音账号 | 至少一个；`id` 不重复，允许 1–64 位字母、数字、下划线、连字符；`type` 为 `douyin` 或 `mock` |
| `heartbeatInterval` | `15000` | 心跳周期，毫秒；范围 1000–3600000 |
| `connections` | `[]` | 网络连接初始列表；最多 64 个，首次启动后由持久化文件管理 |
| `webhookUrls` | `[]` | 兼容旧配置：最多 16 个 HTTP(S) 地址，首次启动时迁移为 HTTP 上报连接 |
| `reverseWsUrls` | `[]` | 兼容旧配置：最多 16 个 WS(S) 地址，首次启动时迁移为反向 WS 连接 |

配置对象不接受未知顶层字段。账号、控制台监听地址和控制台 Token 在启动时读取，修改后需要重启；WebUI 中的网络连接保存后即时应用。

## WebUI 网络连接

登录工作空间后打开「连接配置」，按连接类型筛选，点击「新增连接」设置名称、地址、令牌与启用状态。卡片可编辑、启用 / 停用或删除。保存会调用运行时接口并写入本地文件，刷新页面或重启后仍保留。

| 类型 | `type` | 工作方式 |
| --- | --- | --- |
| HTTP 服务端 | `http` | 新建独立 HTTP 监听端口，接收 OneBot 动作 |
| WebSocket 服务端 | `ws` | 新建独立 WS 监听端口，提供动作与事件 |
| HTTP 上报 | `http_post` | 将事件 POST 到 `url`，不创建监听端口 |
| 反向 WebSocket | `ws_reverse` | 主动连接 `url`，双向交换动作与事件并自动重连 |

连接的公共字段为 `id`、`name`、`type`、`enabled`、`token` 和 `heartbeatInterval`。创建时省略 `id` 会自动生成；名称为 1–80 字符；`enabled` 默认为 `true`。心跳间隔默认 15000 毫秒，连接级别支持 `0` 关闭心跳，最大 3600000 毫秒。

服务端连接额外使用 `host`、`port`、`allowRemote`，默认是 `127.0.0.1:3001` 与 `false`。端口 `0` 请求自动分配，卡片与 API 的 `actualPort` 显示实际端口；多个连接应使用不同监听端口。非本机监听必须显式开启 `allowRemote` 且有有效令牌。出站连接必须填写对应 HTTP(S) 或 WS(S) 的 `url`；令牌放在独立字段，不放在 URL 中。

每个连接使用独立 OneBot Token；创建时留空表示不鉴权，不继承 WebUI Token，也不继承 `server.onebotToken`。Token 使用不含空格的可见 ASCII 字符，最多 4096 个字符。编辑时不填写新 Token 会保留原设置，明确提交 `token: ""` 则关闭该连接的鉴权。管理接口不返回令牌明文，`tokenConfigured` 仅表示是否设置了自定义 Token；未配置连接 Token 时为 `false`。目标 URL 不接受 `#fragment`、内嵌用户名密码或凭据查询参数。

控制台 `server.port` 默认仍为 5088；WebUI、SDK、MCP 的 `/api/*`（包括 `/api/action` 调试）和 SSE 使用 WebUI Token。标准 OneBot 动作 `/action`、`/<action>`、`POST /` 以及 `/ws` 使用独立的 `server.onebotToken`。新增连接的端口只开放所选传输及 `/health`，不提供 WebUI、连接管理或账号登录管理接口。

连接保存于 `dataDir/connections.json`，包含 `revision` 与连接列表。文件存在时优先读取该文件；配置中的 `connections` 和旧版 URL 数组只用于首次初始化。后续通过 WebUI 或 API 修改，不要在进程运行时手工编辑文件。无效文件会报告错误，不会静默覆盖。该文件可能含独立连接令牌，需与会话数据一起保管。

连接变更会校验并尝试启动新设置；端口冲突或保存失败时返回错误并保留 / 恢复原设置。修改同一监听端口的 Token 等参数会短暂重启该连接，已有客户端需要重连；仅修改名称不重启传输。程序启动时个别连接无法监听会标记为错误，可在控制台修正。

升级提示：旧连接中省略或留空的 `token` 现在表示不鉴权；若对端之前配置了 WebUI Token，请改为在两端填写相同的独立连接 Token。非本机监听仍需显式开启 `allowRemote` 并配置连接 Token。

## 令牌优先级

`DYTRANOB_TOKEN` 环境变量优先于 `--token`，后者优先于配置文件。最终仍为空时，CLI 读取 `dataDir/webui.json` 的 `token`；文件尚不存在才生成一次并保存。重启、重建与重新打开 launcher 均复用该值。文件损坏时会报错，不会偷偷生成新值。可以在 `dytranob.config.json` 的 `server.token` 中固定指定自己的令牌。显式配置覆盖不会改写保存的自动令牌；移除覆盖后恢复使用原保存值。演示模式与正式模式各用自己的数据目录。

PowerShell：

```powershell
$env:DYTRANOB_TOKEN = 'your-long-random-token'
npm run dev -- --mock
```

POSIX shell：

```sh
export DYTRANOB_TOKEN='your-long-random-token'
npm run dev -- --mock
```

令牌不要放在仓库或 URL 中。WebUI 默认只在内存保存；用户勾选后仅在该标签页 `sessionStorage` 中保存。

## 原生账号登录

1. 配置 `type: "douyin"` 并启动。
2. 打开 WebUI，在登录页填写 CMD 启动日志中的 Token，验证后进入控制台。
3. 在账号会话中点击「扫码登录」，使用抖音 App 扫码并确认。
4. 如需平台验证，点击 WebUI 中的本机验证链接并手动完成；运行时不自动绕过平台验证。
5. 等待账号显示在线，再查询好友或发送消息。

启动时会尝试恢复已有会话。二维码状态和验证信息仅通过认证后的登录接口提供。二维码过期或登录失败后，可再次启动扫码流程；若上游 SDK 流程尚未退出，可重启运行时后重试。

原生会话数据保存于 `dataDir/accounts/<account_id>`。不要重命名已使用的账号 ID 后继续复用旧 OneBot 别名。首次真实登录及平台验证需要网络；真实账号端到端行为尚未在本项目中验证。

## 多账号

```json
{
  "accounts": [
    { "id": "work", "type": "douyin" },
    { "id": "personal", "type": "douyin" }
  ]
}
```

每个账号使用独立原生会话目录。账号相关动作需指定 `account_id` 或已映射的 `self_id`，事件携带 `account_id` 与 `self_id`。扩展动作 `dy_list_accounts` 可查询当前账号。只有一个账号在线时，未指定账号的动作默认路由到该在线账号。

也可以在 WebUI「运行概览 → 账号会话」中**添加或移除账号**，立即生效并保存到 `dataDir/accounts.json`；该文件存在时优先于配置文件的 `accounts`。移除账号只会让它下线，`dataDir/accounts/<account_id>` 中的登录会话保留，用相同 ID 重新添加即可恢复。对应管理接口为 `GET/POST /api/accounts`（请求体 `{ "id": "second", "type": "douyin" }`）与 `DELETE /api/accounts/<id>`；至少保留一个账号。

## Windows CMD

先安装 Node.js、在仓库目录运行 `npm install`。根目录提供：

| 文件 | 用途 |
| --- | --- |
| `launcher.bat` | 启动 CMD 控制台；`--mock` 为演示模式，支持转发 CLI 参数 |
| `start.cmd` | 启动配置的原生账号运行时 |
| `start-mock.cmd` | 启动无需账号的离线演示 |
| `dytranob.cmd` | 运行 CLI，包括状态查询与动作调用 |
| `mcp.cmd` | 启动 MCP stdio 桥接，stdout 保持为 JSON-RPC |

在另一个 CMD 窗口中设置与已运行服务相同的令牌：

```bat
set DYTRANOB_TOKEN=YOUR_TOKEN
dytranob.cmd status
dytranob.cmd call get_friend_list --account main
dytranob.cmd call send_private_msg --params-file message.json --account main
```

`message.json` 应为 UTF-8 JSON 对象，例如：

```json
{
  "user_id": 2,
  "message": [{ "type": "text", "data": { "text": "你好" } }]
}
```

将 `2` 替换为查询得到的真实 OneBot 用户别名。发送命令会影响实际账号。`--params-file` 可避免 CMD 的 JSON 引号转义问题；也支持 `--params JSON`。可用 `--url http://127.0.0.1:5088` 指定服务，以及 `--self-id` 代替 `--account`。

CLI 动作输出 OneBot JSON 包装，失败时进程退出码为 1。脚本本身不提供插件功能。MCP 需要先启动运行时；生产编译方式为 `npm run build` 后执行 `node dist/cli.js ...`。

## 控制台日志

运行日志统一为「时间、消息类型、来源、信息」，级别与来源列对齐，例如：

```text
[15:42:08.012] [INFO ] [Runtime]              DyTranOb v0.1.0 · Douyin OneBot v11 Runtime
[15:42:08.014] [INFO ] [WebUI]                WebUI 地址 http://127.0.0.1:5088
[15:42:08.015] [INFO ] [WebUI]                WebUI Token <本次生效的 Token>
[15:42:09.200] [INFO ] [Account:001]          发出私聊消息 · user_id=5 · message_id=208 · 内容=你好，收到消息了
[15:42:10.221] [WARN ] [Account:main]         连接断开，等待重连
```

收发消息日志包含正文、用户 / 消息 ID，以及适用的群 ID 和昵称；图片、视频、@ 和引用显示简短消息段摘要，不输出媒体 base64 或下载地址。

日志级别为 `DEBUG`、`INFO`、`WARN`、`ERROR`；交互式终端按级别着色，可设置 `NO_COLOR` 关闭颜色。多行消息逐行带前缀，普通日志会清理终端控制字符并脱敏常见凭据。Token 使用独立的终端输出路径，不进入运行时诊断与 WebUI 事件流；当前版本不提供文件日志。日志写入 stderr，CLI 动作结果和 MCP 的 stdout 保持机器可读。

## AstrBot 媒体地址

可选 `server.mediaPublicUrl` 设置 AstrBot 能访问的运行时基础 URL，默认使用主监听端口的本机地址。AstrBot 在 Docker 或远程主机时通常需要设置。媒体缓存默认 1 小时、128 MiB，不持久化；完整配置、重启后的图片测试和网页会话参数见 [抖音扩展与媒体接入](extensions.md)。
