# Pilion Browser MVP

Electron + React/Vite 的安全浏览器壳。网页运行在独立、沙箱化的 `WebContentsView` 中，右侧保留 Agent 面板并提供显式 Attach / Detach、审批状态和可读错误。

## 运行与验证

```bash
pnpm install
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
pnpm start
```

开发模式：`pnpm dev`。

## 集成架构

- `AgentProcessManager` 启动并回收本机 Agent；stdio transport 只接受逐行 JSON-RPC 2.0。
- `DurableHostStore` 使用 SQLite 持久化 Session、Attachment、Action、Attempt、Approval、Result、Event 与 Outbox。
- 每个 Tool Call 都由 Host 推导 `principal` 和 `profileId`，执行顺序为：
  - 观察/导航类：Intent → Policy allow/Approval → Prepare → ExecutionGrant → 受控 Browser 操作 → Result/Outbox。
  - 点击/输入类：Intent → Policy allow/Approval → Prepare → ExecutionGrant → `BrowserService.prepareEffect` → `markDispatched` → `markEffectStarted` → `executePrepared` → Result/Outbox。
- `BrowserService` 统一执行 Tab ACL、元素 epoch/fingerprint、一次性 Grant、prepare token 与 fencing 校验。
- Electron adapter 仅实现固定的 DOM 观察、鼠标和文本输入 CDP 命令；不存在 `executeJavaScript` 或调用方可控的脚本/CDP 旁路。
- 应用退出先进入全局 draining，再停止 Agent 进程并关闭 SQLite。

## 安全边界

- Renderer preload 只暴露固定 IPC 方法；所有 payload 使用 Zod 校验，主进程校验 sender、main frame 与 origin。Renderer 不能提交 `principal` / `profileId`。
- 不可信网页启用 sandbox、contextIsolation、webSecurity，禁用 Node、webview 与新窗口；`persist:pilion-default` 强制经过仅监听 loopback 的受控 HTTP/HTTPS CONNECT 代理。代理对每个请求只解析一次 DNS、拒绝私网/loopback/link-local/metadata 地址，并把实际 socket 固定到已校验 IP；Host 与端到端 TLS SNI 保持原域名。`webRequest` 与顶层导航检查继续作为纵深防御，代理异常 fail-closed。
- 默认拒绝权限请求、权限检查与证书异常；preload 不暴露 clipboard。
- 生产页面 CSP 以 `default-src 'none'` 为基线。
- 高风险或语义不确定操作进入独立可信 Approval `BrowserWindow`。响应绑定审批窗口 sender/origin、一次性 nonce、actionDigest 和短时用户手势 token；页面 document epoch/origin 改变会使审批 stale。
- Attach 建立持久化 Attachment 并授予 Agent 对已有 Tab 的 operator ACL；Detach 会撤销全部 Agent Tab ACL。

## ACP 边界

当前仅提供 **`pilion-acp-draft-1` Spike adapter**，用于验证私有 stdio 集成。它不是正式 ACP 实现，也不声明兼容任何正式 ACP SDK/Agent。Agent 必须回显一次性握手 secret 和精确协议版本，否则连接显式失败。

Agent 可发送固定的 `browser/tool` 请求；任务使用 `agent/task`，取消使用 `agent/cancel`。任意其他 RPC 方法或未声明 Browser Tool 都会被拒绝。
