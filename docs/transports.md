# 传输、SDK 与 MCP

## HTTP

默认控制台端口的 `/api/*` 与 SSE 使用 WebUI Token；标准 OneBot HTTP 动作 `/action`、`/<action>`、`POST /` 和 WS 使用 `server.onebotToken`，留空时不鉴权。连接管理创建的独立端口与出站连接仅使用各自的 `token`，留空不鉴权。设置 Token 后使用 `Authorization: Bearer <token>`。WebUI 静态资源、公开开发文档与最小 `/health` 检查不需要凭据。优先使用请求头，避免令牌进入浏览器历史或代理日志。

```sh
curl http://127.0.0.1:5088/api/action \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"get_status","params":{},"echo":"example"}'
```

| 入口 | 说明 |
| --- | --- |
| `POST /api/auth` | 验证 Bearer Token；成功时 `data: {authenticated:true}`，失败为 HTTP 401 |
| `POST /api/action` | WebUI / SDK / MCP 管理动作调试；默认端口使用 WebUI Token |
| `POST /action` 或 `POST /` | OneBot 标准动作对象 `{action, params, account_id?, self_id?, echo?}`；默认端口使用 `server.onebotToken` |
| `GET /<action>` 或 `POST /<action>` | OneBot 简写调用；参数平铺，账号选择器与 echo 保留 |
| `GET /api/status` | `data: {accounts,version,uptime}`；uptime 为秒 |
| `GET /api/actions` | `data: [{action,description,params}]`，params 为 JSON Schema |
| `GET /api/events?limit=100` | 本次运行最近事件，较早到较晚排列；最多实际保留 200 条 |
| `POST /api/accounts/:id/login/qr` | 启动或继续账号原生二维码登录 |
| `GET /api/accounts/:id/login` | 登录状态、二维码与待验证信息 |
| `GET /events` | `text/event-stream` 的实时事件流 |
| `GET /health` | 仅检查 HTTP 服务存活，不代表账号在线 |

`/api/*` 查询与登录接口均返回 `{status,retcode,data}` 包装，不能直接把 HTTP JSON 当成 `data` 使用。HTTP 请求体与 WS 消息最大为 24 MiB（支持 Base64 图片）。

登录状态的 `data` 包含 `state`、`online`，以及可选 `account`、`qrcodeBase64`、`qrcodeUrl`、`expireTime`、`qrStatus`、`error`、`verification`。`verification.url` 是需要手动打开的本机验证页面，按敏感数据处理。

## 连接管理 API

以下接口位于控制台端口，均要求控制台 Bearer Token，响应使用相同的 `{status,retcode,data}` 包装。新增的传输端口不开放管理接口。

| 入口 | 成功响应 |
| --- | --- |
| `GET /api/connections` | HTTP 200；`data: {revision,connections}` |
| `POST /api/connections` | HTTP 201；`data` 为创建后的连接视图 |
| `PUT /api/connections/:id` | HTTP 200；部分更新，`data` 为更新后的连接视图 |
| `DELETE /api/connections/:id` | HTTP 200；`data: null`，关闭连接并删除持久化配置 |

创建请求示例：

```json
{
  "name": "本地机器人",
  "type": "ws",
  "enabled": true,
  "host": "127.0.0.1",
  "port": 3001,
  "heartbeatInterval": 15000
}
```

`type` 支持 `http`、`ws`、`http_post`、`ws_reverse`；出站类型使用 `url`。可选 `token` 配置连接专用凭据；编辑省略该字段时保留，空字符串则关闭连接鉴权；创建时省略也不鉴权，不继承 WebUI Token。返回的视图不含 `token`，包含 `tokenConfigured`、`status`，以及适用时的 `actualPort` 和 `error`。状态为 `running`、`stopped`、`connecting`、`connected` 或 `error`；HTTP 上报的 `running` 表示上报通道已启用，不保证目标服务可达。

保存会立即应用并写入 `dataDir/connections.json`。校验失败返回 `1400`，未知 ID 返回 `1404`，重复 ID、端口占用或无法启动连接返回 `1409`；持久化失败返回 `1500`，变更不作为成功接受。完整字段、默认值与首次配置迁移规则见 [配置与运行](configuration.md)。

## 正向 WebSocket

通用入口：`ws://127.0.0.1:5088/ws`，发送标准动作 JSON，接收带 echo 的响应与实时事件。纯动作入口为 `/ws/api`，纯事件入口为 `/ws/event`；兼容别名为 `/api`、`/event` 与通用 `/`。

通过连接管理创建的 `ws` 服务端使用自己的监听端口，提供同样的 WS 路径。`http` 服务端只接收动作，支持 `POST /action`、`POST /api/action`、`POST /` 与 `GET /<action>` / `POST /<action>`，不提供 WS、SSE 或管理接口。

```ts
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:5088/ws', {
  headers: { Authorization: `Bearer ${process.env.DYTRANOB_ONEBOT_TOKEN}` },
});
ws.on('open', () => ws.send(JSON.stringify({
  action: 'get_status', params: {}, echo: 'ws-1',
})));
ws.on('message', data => console.log(JSON.parse(data.toString())));
```

以 `post_type` 区分事件，以 `echo` 关联动作。事件入口拒绝动作请求，纯动作入口不推送事件。SDK 可以处理连接重建与请求关联。

浏览器原生 WebSocket 不能自定义请求头。服务端兼容 `access_token` 查询参数，但 WebUI 采用带 Bearer 的 `fetch` SSE，以免把令牌写入 URL。自行构建浏览器客户端时也建议使用该方式。

## SSE

`GET /events` 返回 `data: <OneBot JSON>`。客户端使用带认证请求头的 `fetch`，并按 SSE 帧分隔读取。WebUI 实现位于 `webui/ui.js`，包含断线重连。SSE 无持久化 cursor，重连可能存在间隙；`GET /api/events` 只补充有界最近事件。

## 反向 WebSocket 与 webhook

`ws_reverse` 连接的目标由运行时主动建立通用 WS 连接。握手含 `X-Client-Role: Universal`、`X-Self-ID`、`User-Agent`，仅在该连接设置了 Token 时发送 Bearer 头；留空时不携带 Authorization，不发送 WebUI Token。每个已登录账号各建立一条连接，`X-Self-ID` 为该账号的 OneBot `self_id`；账号登录完成前不会连接（不会以 `X-Self-ID: 0` 握手），新增或移除账号时自动建立或关闭对应连接。每条连接只推送所属账号的事件，未指定 `account_id`/`self_id` 的动作默认由该账号执行。失败后采用有上限的退避重连；接收端用标准动作对象回调运行时。旧配置 `reverseWsUrls` 首次启动时迁移为此类连接。

`http_post` 连接向目标发送 OneBot 事件的 HTTP POST。使用有效令牌时，`X-Signature` 为 `sha1=` 加上使用该连接令牌对原始请求体计算的 HMAC-SHA1 十六进制值。接收端验证签名时必须使用原始字节，不要重新序列化 JSON。旧配置 `webhookUrls` 首次启动时迁移为此类连接。

每个 webhook 目标使用独立有界队列；积压超过 256 条会丢弃新事件，单次请求超时 10 秒，失败不保证重试。当前版本不提供持久化可靠投递。

当前版本不解析 webhook 响应体，**不支持 OneBot webhook 快速操作**。接收事件后如需回复或审批，请通过认证后的 HTTP 或 WS 动作入口调用。接收端应返回成功 HTTP 状态，并自行处理持久化与幂等。

## AstrBot 对接

AstrBot 的 OneBot v11 适配器接收反向 WebSocket。先在 AstrBot 创建 OneBot v11 机器人并启动监听，再在本 WebUI「连接配置」新增「反向 WebSocket」，URL 填写 AstrBot 提供的完整地址（包含其路径）。两端在同一台机器时可用 `ws://127.0.0.1:6199/ws`，端口和路径以你的 AstrBot 配置为准；容器部署填写运行时能访问的宿主机地址。

- AstrBot 的 `ws_reverse_token` 为空：本连接 Token 也留空。
- AstrBot 设置了 `ws_reverse_token`：本连接填写完全相同的固定 Token。
- WebUI 登录 Token 只用于管理，不填写到 AstrBot，除非你主动为连接选用了相同字符串。

连接成功后，AstrBot 使用同一条 WS 发送 `{ "action": "get_friend_list", "params": {}, "echo": "request-1" }`，并按 echo 接收动作结果；不需要访问 `/api/actions` 或登录 WebUI。45 个动作入口共用同一分发器；原生 SDK 未支持的能力仍返回不支持错误，详见动作文档。

实现参考：[AstrBot OneBot v11 适配器](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py)、[SnowLuma OneBot 鉴权](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/network/utils.ts)。

## Node.js SDK

SDK 的管理方法及默认 `call()` 使用 `/api/*` 和 WebUI Token。若给默认 WS 单独设置了 `server.onebotToken`，请使用第二个 SDK 实例（`token` 为该 OneBot Token）调用 `connect()` / `callWs()`；连接到独立 HTTP 端口时 `call()` 使用该连接 Token，管理查询不开放。程序化 `startServer()` 的 `onebotToken` 省略时保留旧的单 Token 模式；CLI 始终显式传入独立配置。

SDK 是 Node.js 客户端，使用 `EventEmitter` 和 `ws`，不直接作为浏览器脚本加载。

```ts
import { DyTranObClient, ActionError } from 'dytranob/sdk';

const client = new DyTranObClient({
  baseUrl: 'http://127.0.0.1:5088',
  token: process.env.DYTRANOB_TOKEN,
  timeout: 15000,
  reconnect: true,
});

try {
  const status = await client.status();
  console.log(status.accounts);
  const friends = await client.call<Array<{user_id:number;nickname:string}>>(
    'get_friend_list', {}, { account_id: 'main' },
  );
  console.log(friends);
} catch (error) {
  if (error instanceof ActionError) console.error(error.retcode);
  else throw error;
}

client.on('event', event => console.log(event));
client.on('transport_error', error => console.error(error.message));
client.on('connected', () => console.log('connected'));
client.on('disconnected', code => console.log('disconnected', code));
await client.connect();
const version = await client.callWs('get_version_info');
console.log(version);
// 在应用退出时调用 client.close()，终止 WS、重连与挂起请求。
```

`client.call`、`callWs` 与辅助方法返回已解包的 `data`，失败时抛异常。`call` 使用 HTTP，`connect` 订阅 WS 事件，`callWs` 在通用 WS 上调用动作。断线后挂起的 WS 动作会失败，不自动重发，以避免重复发送消息。

辅助方法：`status`、`actions`、`recentEvents`、`startQrLogin`、`loginState`、`sendPrivateMessage`、`sendGroupMessage`。`createClient(options)` 等价于构造 `DyTranObClient`。动作选择器命名为 `account_id` / `self_id`。

仓库内先执行 `npm run build`，再运行 `npm exec tsx examples/sdk.ts`；发布或本地安装包后可使用 `dytranob/sdk` 包导入。当前文档不假设该名称已经发布到 npm。

## MCP

先单独启动运行时，再启动 stdio 桥接进程。桥接本身不创建第二个抖音会话。

```sh
npm run build
node dist/cli.js mcp --url http://127.0.0.1:5088
```

通过环境变量 `DYTRANOB_TOKEN` 提供与运行时相同的令牌。开发模式亦可使用 `npm run mcp -- --url http://127.0.0.1:5088`。需要发送与管理能力时显式增加 `--allow-write`。

| 工具 | 默认提供 | 用途 |
| --- | --- | --- |
| `douyin_status` | 是 | 运行时与账号状态 |
| `douyin_actions` | 是 | 动作目录及参数 Schema |
| `douyin_events` | 是 | 最近事件 |
| `douyin_query` | 是 | 白名单查询动作；ID 映射只影响本地元数据 |
| `douyin_resolve_id` | 是 | 创建稳定 ID 别名，不发送消息 |
| `douyin_write` | 否 | `--allow-write` 开启后的发送、撤回与群管理白名单 |

虽然默认禁止平台写入，ID 映射仍可写入本地元数据。`douyin_write` 不会绕过原生适配器的权限和不支持能力。MCP stdout 仅用于协议；日志写入 stderr。

MCP 客户端配置示例，路径需改为你的绝对路径：

```json
{
  "mcpServers": {
    "dytranob": {
      "command": "node",
      "args": ["E:/DyTranOb/dist/cli.js", "mcp", "--url", "http://127.0.0.1:5088"],
      "env": { "DYTRANOB_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

也可从 `dytranob/mcp` 导入 `createMcpServer(client,{allowWrite:false})`，使用官方 SDK 的 `StdioServerTransport` 连接；使用后需关闭 MCP server 与 SDK client。
