<div align="center">

# DyTranOb

**让抖音接入你的机器人生态。**

基于 TypeScript 与 douyin-im 的抖音 OneBot v11 互操作运行时。

![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.5-339933?logo=nodedotjs&logoColor=white)
![OneBot](https://img.shields.io/badge/OneBot-v11-5865F2)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[快速开始](#-快速开始) · [AstrBot 接入](docs/astrbot.md) · [开发文档](docs/development.md) · [参考与致谢](#-参考与致谢)

</div>

## ✨ 能做什么

- **一个运行时，多种入口** — HTTP、正向 / 反向 WebSocket、WebUI、CMD、Node.js SDK、MCP。
- **消息互通** — 私信、群消息、图片、表情、引用与作品分享卡片，适配 AstrBot 图文消息。
- **45 个动作入口** — 消息与账号管理、作品详情、评论、图片上传、原生字幕文本与时间轴。
- **浅色 WebUI** — Token 登录、扫码登录、多账号、连接配置、事件查看与动作调试。
- **开箱即用的控制台** — Windows 启动器、规范化日志、固定 WebUI Token、独立 OneBot Token。

> 实现 OneBot v11 实用子集，不包含插件系统。视频文件发送、语音和部分 QQ 专属动作暂不支持；字幕依赖平台返回的原生轨道，不包含 OCR / 语音转写。完整范围见 [动作文档](docs/api.md)。

## 🚀 快速开始

需要 **Node.js ≥ 22.5** 和 npm。下载项目后：

**Windows：双击 `launcher.bat`。** 自动安装缺失依赖并构建，CMD 会显示 WebUI 地址、Token 和连接地址；手动打开 WebUI，填入 Token 后扫码登录。保持窗口运行，`Ctrl+C` 停止。

其他平台或命令行启动：

```sh
npm ci
npm run build
npm start
```

默认 WebUI：`http://127.0.0.1:5088`。想先体验界面？运行 `npm start -- --mock`，无需抖音账号。

**接入 AstrBot：** 在 WebUI 的「连接配置」添加反向 WebSocket，填写 AstrBot 的 OneBot v11 地址，两端 Token 保持一致。OneBot Token 与 WebUI Token 独立配置。详细步骤见 [AstrBot 接口手册](docs/astrbot.md)。

## 📖 文档

| 想做什么 | 从这里开始 |
| --- | --- |
| 配置账号、启动参数与部署 | [配置与运行](docs/configuration.md) |
| 接入 AstrBot / 让模型读取接口 | [AstrBot 手册](docs/astrbot.md) · [动作 Schema](docs/actions.json) |
| 查询作品、字幕与处理图片 | [抖音扩展与媒体](docs/extensions.md) |
| 使用 HTTP、WebSocket、SDK、MCP | [传输与 SDK](docs/transports.md) |
| 参与开发、了解架构 | [开发指南](docs/development.md) · [架构](docs/architecture.md) |

运行后也可访问 `/docs/readme.html` 浏览完整文档，或让机器人读取 `/docs/astrbot.md`。

开发检查：`npm run check`，包含类型检查、测试与构建。账号会话、Cookie、Token 和本地运行配置保存在本机，不应提交到仓库；详见 [安全与运维](docs/security.md)。

## 🙌 参考与致谢

感谢以下开源项目提供基础能力与实现参考：

- [zhinjs/douyin-im](https://github.com/zhinjs/douyin-im) — 原生抖音会话基础依赖。
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) · [NapCatQQ](https://github.com/NapNeko/NapCatQQ) — 运行时形态、控制台与 WebUI 交互参考。
- [Rockedw/douyin-web-api-sdk](https://github.com/Rockedw/douyin-web-api-sdk) — 网页接口与扩展能力参考。
- [ucmao/media-parser](https://github.com/ucmao/media-parser) — 作品详情、字幕字段与格式处理参考。
- [TeamBreakerr/douyin-chat-export](https://github.com/TeamBreakerr/douyin-chat-export) · [sisi0318/jumpbyte-bot](https://github.com/sisi0318/jumpbyte-bot) — 消息与媒体兼容研究参考。
- [OneBot v11](https://github.com/botuniverse/onebot-11) · [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — 协议与工具接入基础。

独立开发，与抖音及上述项目无隶属关系。仅使用你有权访问的账号与数据。

[MIT License](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)
