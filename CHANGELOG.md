# 更新日志

本文件记录每个发布版本的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。安装包见 [Releases](https://github.com/echoVic/pilion-browser/releases)。

## [0.1.3] - 2026-09-20

### 新增

- Agent 可以调用 `browser.request_human` 主动交还浏览器并说明原因。此前只有声明 goal 扩展的 Agent 能表达“我卡住了”，其余走标准 ACP 的 Agent 遇到登录墙或验证码时只能猜、循环，或用一段话结束回合。该工具不经过页面动作路径，直接把任务转入人工状态并保留现场
- 人工状态期间的标签页导航会记入任务，继续任务时作为一句交接说明随 prompt 发给 Agent，它不再需要重新摸索页面变化；输入框上方同时提示补充说明可跳过
- 一键从本机 Chrome 导入全部 cookie，入口在地址栏和「Agent 连接」设置页。仅支持 macOS：密钥取自钥匙串的 Chrome Safe Storage，数据库先复制再只读打开，因此 Chrome 运行时也能导。导入前会说明范围并要求确认

### 修复

- Agent 操作页面时，地址栏、前进后退、刷新、页内查找和缩放会变为禁用并显示禁用光标。此前它们保持可用且是正常光标，等于给了六个可以打断 Agent 的入口，而产品本意是只有「接管」这一个
- 未连接 Agent 时按回车不再把中栏网页换成设置页。原因现在显示在输入框正上方，Agent 选择器获得焦点，草稿保留
- 输入框旁未连接时的按钮不再伪装成发送键，改用描边的连接图标
- 首页的建议卡片在未连接时会直接把焦点指向 Agent 选择器，而不是一个发不出去的输入框
- 预设 Agent 需要安装适配器时，会在你点击之前说明首次可能需要几分钟
- 窄窗口下打开设置页时，Agent 面板让位，路径输入框不再被压到几个字符宽

## [0.1.2] - 2026-09-19

### 修复

- 代理 fake-IP 模式下无法打开任何网页。Clash、sing-box、Shadowrocket 的 fake-IP 会把所有域名解析到 `198.18.0.0/15`，而私网防护把这一段当成内网，于是每一次导航都被拒绝。现在解析结果落在这一段按代理转发处理，URL 里直接写该段地址仍然拒绝
- 地址栏可以输入 `example.com:8080`，不再被当成未知协议拒绝
- `localhost.` 这类带根点的写法不再绕过拦截
- IPv6 包裹私有 IPv4 的多种写法（6to4、NAT64、IPv4-compatible、IPv4-translated、未压缩写法、`fec0::/10`）不再绕过私网判断
- WebRTC 被限制为不允许非代理 UDP，不能再绕开受控代理暴露本机地址
- WebSocket 升级转发时会剥离 `proxy-authorization` 与 `proxy-connection`
- Agent 启动失败时立刻返回并清理进程，不再空等多轮终止超时，也不会留下永不释放的连接
- 连接错误会说明进程是退出码几还是被哪个信号终止，并保留 Agent stderr 的换行，不再压成一行
- 认证卡住按握手预算超时，不再占用十分钟
- Windows 上终止 Agent 会连同 npx 启动的子进程一起结束
- 适配器依赖装了一半时会识别为需要重新安装，不再显示为就绪后连接失败
- 输入法组合意外没有结束事件时，回车仍能发送，不再插入换行

## [0.1.1] - 2026-09-18

### 新增

- Orca 与 Blade 本地 Agent 预置，分别以 `orca --mode=acp` 和 `blade --acp` 启动，两者都会接入 Pilion 下发的浏览器 MCP 工具
- 新的 Pilion 标志与应用图标
- CI：每次推送和 PR 都跑类型检查、lint、单元测试和 Electron E2E

### 变更

- 运行时只保留 ACP SDK、MCP SDK 和 zod，应用内的 asar 从 43 MB 缩到 14 MB
- 依赖版本全部固定

### 修复

- 窗口失焦、缩放或最小化不再中断 Agent 正在进行的鼠标操作
- 系统开启「减少动态效果」时，光标仍会在目标上停留 240 毫秒再操作，保留人工接管的窗口

## [0.1.0] - 2026-09-18

首个公开版本。面向任意 ACP Agent 的桌面浏览器：左侧管理标签和工作记录，中间浏览网页，右侧通过 Agent Client Protocol 连接本地或 SSH 远端的 Claude Code、Codex、Gemini CLI、Grok Build、OpenCode、Pi。浏览器通过 MCP 把自己的标签页交给 Agent 操作，支持操作前确认、人工接管和会话恢复。

[0.1.3]: https://github.com/echoVic/pilion-browser/releases/tag/v0.1.3
[0.1.2]: https://github.com/echoVic/pilion-browser/releases/tag/v0.1.2
[0.1.1]: https://github.com/echoVic/pilion-browser/releases/tag/v0.1.1
[0.1.0]: https://github.com/echoVic/pilion-browser/releases/tag/v0.1.0
