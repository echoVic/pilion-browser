# Pilion Browser MVP

Electron + React/Vite 的安全浏览器壳，页面由独立 `WebContentsView` 承载，右侧提供本机 Agent 面板。

## 运行

```bash
pnpm install
pnpm run build
pnpm start
```

开发：`pnpm run dev`。

## ACP 边界

本 MVP 提供独立 stdio JSON-RPC transport 和显式协议适配边界。由于技术规格未指定 ACP 版本或已验证 SDK，程序**不会伪装 ACP 已连接**：Agent 必须响应 `initialize` 且返回 `protocolVersion: "pilion-acp-draft-1"` 及 `capabilities.tasks=true`、`capabilities.tools=true`，否则连接明确失败。该 draft adapter 仅用于集成探针，不声明兼容任何正式 ACP SDK/Agent。

Agent stdout 必须为逐行 JSON-RPC 2.0。Agent 可发送 `browser/tool` 请求，参数为 Browser Tool request；宿主返回结构化结果/错误。任务使用 `agent/task`，取消使用 `agent/cancel`。

## 安全

不可信页面启用 sandbox/contextIsolation/webSecurity，禁用 Node；无 preload；固定 IPC + Zod 校验；仅允许 HTTP(S)；拒绝设备权限、证书错误和非受控新窗口；子进程不经 shell，并仅继承最小环境白名单。
