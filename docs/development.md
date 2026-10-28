# 扩展与测试

## 本地开发

```sh
npm install
npm run dev -- --mock
npm run typecheck
npm test
npm run build
```

`npm run dev` 使用 tsx 运行源码；`npm run build` 将 TypeScript 与类型声明写入 `dist`；WebUI 为原生静态文件，无独立前端打包步骤。`npm run check` 串行运行类型检查、测试和构建。

构建还会从编译后的运行时动作定义生成 `docs/actions.json`，并把 `docs/astrbot.md` 等章节合并为 `docs/readme.html`。修改动作后运行完整 `npm run build`，避免机器可读文档与运行时代码不同步；单独的 `npm run docs:build` 使用现有 dist。

Windows 可通过仓库根目录 `start.cmd` 启动真实账号运行时、`start-mock.cmd` 启动离线演示、`dytranob.cmd` 查询状态与调用动作、`mcp.cmd` 启动 MCP 桥接。使用前先安装依赖；MCP 需要已启动的运行时与相同 `DYTRANOB_TOKEN`。命令行帮助见 `npm run dev -- --help`。

## 嵌入运行时

```ts
import { Runtime, MockAdapter, startServer } from 'dytranob';

const runtime = new Runtime({
  dataDir: './data/embedded',
  accounts: [{ id: 'demo', adapter: new MockAdapter({accountId:'demo'}) }],
});
runtime.on('event', event => console.log(event));
runtime.on('diagnostic', item => console.error(item));
await runtime.start();
const server = await startServer(runtime, {
  host: '127.0.0.1', port: 5088,
  token: process.env.DYTRANOB_TOKEN || 'set-a-long-random-token',
});
// 应用退出时先 await runtime.stop()，再 await server.close()。
```

仅需要程序内动作时可直接 `await runtime.execute({action:'get_status'})`，不启动 HTTP 服务。直接嵌入的 `startServer` 调用者负责提供访问令牌；CLI 会自动补齐空令牌。

需要与 CLI 相同的动态连接管理时，创建 `ConnectionManager(runtime,{dataDir,token,initial})`，调用 `start()`，并把实例通过 `startServer` 的 `connections` 选项提供给管理服务。`list`、`create`、`update`、`remove` 对应 WebUI 管理能力；关闭时调用 `close()` 释放独立传输。连接专用服务不能再次开放管理功能，以免凭据权限扩散。

关闭时，`runtime.stop()` 拒绝新动作，并等待已接受的动作与二维码请求完成，再断开适配器和存储；随后关闭传输，使已在处理中的动作有机会返回确认。

## 添加适配器

适配器是编译时源码扩展，项目不提供插件加载、插件市场或第三方脚本执行系统。遵循 `src/adapters/types.ts` 中的 `NativeAdapter`：

1. 实现 `connect`、`disconnect`、`isOnline`，保证可清理监听器和原生资源。
2. 实现用户、好友、群、成员查询；所有平台 ID 保持字符串。
3. 将原生消息转为 `NativeMessage`，使用 `publish({type:'message',message})` 发布。
4. 通过 `publish` 提供连接、请求与通知事件；适配器内不直接生成 OneBot wire 对象。
5. 实现 `sendMessage`、撤回、群操作与申请操作。缺失能力抛出 `UnsupportedAdapterOperation`，不要返回假成功。
6. 实现 `startQrLogin` / `getLoginState` 或适合平台的状态描述。
7. 在 `Runtime` 构造参数中注册适配器；若需配置与 CLI 创建，同时扩展配置枚举和构造工厂。

当前 `kind` 类型限制为 `douyin | mock`，添加其他平台时需要相应扩大联合类型。`DouyinAdapter` 的 `createClient` 依赖注入点用于隔离原生 SDK 生命周期测试，避免测试访问真实账号。

适配器发布诊断应使用 `diagnostic`；禁止将 Cookie、令牌、QR 内容、平台验证链接和请求头写入诊断。运行时进一步做有限脱敏，不能代替适配器自身约束。

## 增加动作

动作应在 `src/runtime.ts` 的目录中定义名称、描述与 JSON Schema，并在调度器实现参数校验与行为。WebUI 会从 `/api/actions` 动态加载，无需手工添加动作按钮。

当前 Schema 用于发现和编辑提示，运行时仍需明确校验所有新参数；不要依赖前端校验。若动作允许通过 MCP 使用，应同时检查 `READ_ACTIONS` / `WRITE_ACTIONS` 白名单、输入 Schema 与工具注解，避免读取通道间接触发平台写操作。

## 验证策略

- 使用 Mock 验证消息转换、OneBot 行为、多账号、ID 持久化、动作错误与传输组合。
- 注入上游 SDK 替身验证原生登录状态机、清理、事件映射与不支持能力。
- 使用临时独立数据目录，不与已登录原生会话共用目录。
- 测试传输鉴权、跨源拒绝、WS echo、SSE 事件、webhook 签名、MCP 写入默认关闭与 SDK 超时 / 重连。
- 验证连接 CRUD 的真实监听、重启持久化、Token 不回传、端口冲突回滚与管理入口隔离；登录页在校验成功前不加载工作空间，401 后清除受保护视图。
- 真实账号验收单独进行：扫码登录、会话恢复、私信 / 群文本、图片、群管理与平台验证均需账号权限确认。自动化测试通过不表示这些步骤已完成。

## 文档与 WebUI

源文档位于 `docs/*.md`，WebUI 文档入口为 `/docs/readme.html`。修改源文档后执行：

```sh
node docs/build.mjs
```

生成的静态文档无第三方脚本，可通过服务端打开或直接在浏览器打开文件。WebUI 使用固定浅色设计与 CSS 变量；账号和事件数据写入 DOM 时必须使用 `textContent`，不得把原生消息插入 `innerHTML`。保持键盘焦点、表单标签与窄屏布局可用。

SDK 示例位于 `examples/sdk.ts`；嵌入示例位于 `examples/embedded.ts`。先执行 `npm run build`，再使用 `npm exec tsx examples/sdk.ts` 或 `npm exec tsx examples/embedded.ts`。示例默认不向真实联系人发送消息。
