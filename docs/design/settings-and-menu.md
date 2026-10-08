# Pilion 菜单栏 & 设置窗口 设计方案

> 状态：设计定稿，待实施  
> 版本：2026-10-08  
> 范围：Phase 1 全量 + Phase 2/3 边界说明

---

## 一、决策记录

在开始实施之前，以下三个问题已确认答案，不再重新讨论。

### 1. 设置窗口形态：独立窗口 + 懒创建

首次按 ⌘, 时才创建，此后关闭用 `win.hide()`，再次打开用 `win.show() + win.focus()`，仅在 app 退出时销毁。不影响现有 e2e——`tests/electron.e2e.ts:594/618/676` 的 `BrowserWindow.getAllWindows().length` 断言只在打开设置窗后才会变化，而测试不会触发 ⌘,。

Renderer 复用同一 bundle，通过 `?window=preferences` 只渲染设置树，preload 原样复用。

### 2. 安全相关开关：不暴露到设置

以下项是产品定义，不是用户偏好，任何版本都不进设置 UI：
- 审批开关（蒙层、inline approval）
- `full` 权限默认值
- 忽略证书错误（`main.ts:2709-2711` 的 permission handler）
- 私网拦截（RFC1918 拦截是设计选择，不是待实现功能）

设置里只做**只读展示**：当前权限策略说明、受控代理状态、操作台账入口（`host.sqlite` events）。

如果未来确实需要例外（如"允许特定私网 CIDR"），必须：放在高级页最底部 + 文案写明放弃了什么 + 二次确认对话框 + 日志记录，且单独评审。

### 3. Set as Default Browser：Phase 2，路由策略保守

Phase 2 上线时外部 http/https 链接的路由策略：**新标签页，落到当前 workspace，不自动交给 Agent**。用户在外部点链接的心智模型是"打开浏览器看页面"，而不是"让 Agent 处理"。想让 Agent 接管时，用户会在 Pilion 内主动操作。

自动交给 Agent 的开关（默认关）是 Phase 2b，等 Phase 2a 上线后根据用户反馈决定做不做。

---

## 二、快捷键漂移问题（Phase 1 前置）

**现状**：快捷键逻辑写了两份。`src/renderer/main.tsx:234-263` 的 `onShortcut` 回调处理从 main 进程转发来的全局快捷键；`main.tsx:265-330` 的 `keydown` listener 处理 renderer 内的键盘事件。两份各自独立，已有漂移（如 `key === ','` 在 onShortcut 里打开 settings surface，在 keydown 里用 `event.preventDefault()` 打开）。菜单的 `accelerator` 将是第三份。

**修法**：在 `src/shared/` 下新建 `keybindings.ts`，导出一个 `KEYBINDINGS` 常量数组作为唯一真源。菜单 template 从它读 accelerator，`onShortcut` 和 `keydown` 两个处理器都从它派生，消除重复。设置窗的"快捷键只读展示"页也从这里读。

---

## 三、菜单栏

用 `Menu.setApplicationMenu(Menu.buildFromTemplate(...))` 替换 Electron 默认菜单。放在 `app.whenReady()` 内、主窗口创建之后。

**保留 role 是最重要的约束**。Edit 菜单的 undo/redo/cut/copy/paste/selectAll 全部用 `role`，一个都不能省，否则地址栏和聊天输入框的系统剪贴板行为会失效。

### 菜单结构

| 菜单 | 项目 | 实现来源 |
|------|------|----------|
| **Pilion** | 关于 Pilion | `app.setAboutPanelOptions`（顺手改掉菜单栏显示"Electron"的问题） |
| | 设置… ⌘, | 打开/显示设置窗口 |
| | Services / 隐藏 / 隐藏其他 / 全部显示 / 退出 ⌘Q | 全部 `role` |
| **文件** | 新建标签页 ⌘T、重新打开关闭的标签页 ⇧⌘T、关闭标签页 ⌘W | 已有（`tabs:open/reopenClosed/close`） |
| | 新建对话 | 已有（`conversationNew`） |
| | 导入 Chrome Cookie… | 已有（`chromeCookieSources/Import`） |
| **编辑** | 撤销/重做/剪切/复制/粘贴/全选 | 全部 `role`，**不可省** |
| **显示** | 刷新 ⌘R、停止 | 已有（`tabs:reload`） |
| | 放大/缩小/实际大小 ⌘0 | 已有（`tabs:zoomIn/zoomOut/resetZoom`） |
| | 查找 ⌘F | renderer 侧状态，走 `app:command` 通道 |
| | 显示/隐藏侧边栏、显示/隐藏 Agent 面板 | renderer 侧状态，走 `app:command` 通道 |
| **历史记录** | 后退 ⌘[、前进 ⌘] | 已有（`tabs:back/forward`） |
| | 最近关闭的标签页（子菜单，上限 20） | 已有（`closedTabs`），动态重建 |
| | 显示全部历史 / 清除历史 | 已有（surface 切换 + `historyClear`） |
| **书签** | 添加/移除当前页 ⌘D | 已有（`bookmarkToggle`） |
| | 显示书签 | surface 切换 |
| **下载** | 显示下载、暂停/取消/在文件夹中显示 | 已有（`downloads:*`） |
| **Agent** | 连接 / 断开 / 接管浏览器 / 停止任务 / 继续任务 | 已有（`agents:*`） |
| | 开始/停止录制 | 已有（`recording*`） |
| | 技能库 | 已有（`skills*`） |
| **窗口** | 最小化 / 缩放 / 前置全部 | 全部 `role` |
| **帮助** | 快捷键一览、README、反馈 | `shell.openExternal`，二期补链接 |

### 动态项

- **Agent 菜单**：接管/停止任务按 `agentStatus` 和 `attachmentStatus` 灰显，在 `AppState` 变化时重建对应菜单项的 `enabled`。
- **最近关闭的标签页**：在 `closedTabs` 变化时重建子菜单，每项点击触发 `tabs.reopenClosed`。
- 两类动作的路由：main 侧可直接调用的（开/关/刷新/缩放/下载/录制/Agent）直接调；renderer 侧的状态变化（切 surface、查找栏、侧边栏/面板显示）走一条 `app:command` IPC 通道。`onShortcut` 已是这条通道的 renderer 端，可以复用或适当扩展，不用另开一套。

---

## 四、`settings.json` 存储

新建独立的全局设置文件，**不放进 `workspace.json`**——workspace 是"每个工作区"的数据（标签页/历史/书签/会话），设置是跨工作区全局的。

参考 `WorkspaceStore`（`src/main/workspace.ts`）的原子写模式，用 `write-file-atomic` 落盘，加 zod schema 校验。

```typescript
// src/main/settings-store.ts（新建）
import { z } from 'zod';

export const AppSettingsSchema = z.object({
  // 通用
  theme: z.enum(['light', 'dark', 'auto']).default('auto'),
  startupBehavior: z.enum(['restore', 'new']).default('restore'),
  searchEngine: z.enum(['google', 'bing', 'duckduckgo']).default('google'),
  downloadPath: z.string().optional(),            // undefined = 系统默认
  downloadPrompt: z.boolean().default(false),     // 每次询问
  quitOnWindowClose: z.boolean().default(false),  // false = 留在 Dock

  // Agent
  agentWindowBehavior: z.enum(['foreground', 'silent']).default('foreground'),

  // 未来扩展槽（Phase 2+）
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
```

IPC 暴露 `settings:get` 和 `settings:save`，renderer 通过 preload 访问，与 `getState`/`setState` 模式一致。

---

## 五、设置窗口页签与内容

### 1. 通用

| 项目 | 现状 | Phase 1 做法 |
|------|------|--------------|
| 主题（浅/深/跟随系统） | 存在 renderer `localStorage`，`main.tsx:116-119` | 迁移到 `settings.json`，启动时由 main 注入，移除 localStorage 依赖 |
| 启动行为 | 固定恢复，`main.ts:2688` | 新增"恢复上次标签页 / 新标签页"选项 |
| 默认搜索引擎 | 硬编码 Google，`src/renderer/ui.tsx` 的 `addressToUrl` | 新增 Google / Bing / DuckDuckGo 选项，`addressToUrl` 读设置 |
| 下载位置 | 固定 `app.getPath('downloads')`，`main.ts:2574` | 新增"系统默认 / 自定义路径 / 每次询问" |
| 关闭窗口时退出 | `window-all-closed` 无条件 `app.quit()`，`main.ts:3234` | 新增开关，false 时改为 `mainWindow.hide()` |

### 2. Agent（核心差异页）

将 `src/renderer/AgentSettings.tsx` 的全部内容搬进设置窗口，同时新增：

| 项目 | 现状 | Phase 1 做法 |
|------|------|--------------|
| 本地预设 / 自定义命令 / SSH | `AgentSettings.tsx` 已有 | 直接搬入 |
| Agent 操作时的窗口行为 | 无设置，始终抢占前台 | 新增"前台显示 / 后台静默"（见第六节） |
| 默认权限模式 | 会话级，逐会话选 | 可选迁移到全局默认，Phase 1 范围内判断 |

**Agent 操作时的窗口行为**放在 Agent 页的"任务执行"分组，紧跟权限模式：

```
Agent 操作时的窗口行为
  ○ 后台静默    操作在后台完成，窗口保持当前位置
  ● 前台显示    执行任务时窗口移至前台（默认）
```

### 3–7. Phase 2+ 页签（边界说明）

Phase 1 只建骨架，不实现以下内容：

- **浏览器**：新标签行为、标签休眠、清除浏览数据、站点权限（只读展示）
- **录制与技能**：录制红框、快捷键、提炼模型、回放审批策略
- **快捷键**：只读展示 + 冲突提示（可改是 Phase 3）
- **高级**：日志面板、导出诊断、数据目录展示、导入导出配置、重置数据
- **关于**：版本、许可证、GitHub、更新检查

---

## 六、Agent 窗口行为：技术方案

### 问题根源

`src/main/main.ts:872` 和 `main.ts:920` 各有一处 `window.webContents.focus()` 调用，在 agent shield 锁定和 session 激活时将主窗口提到前台。这是窗口被抢占的直接原因。

### 为什么 CDP 路径不需要大改

`src/main/browser/electron-page-adapter.ts` 已经通过 `wc.debugger`（Electron 内置的 CDP 包装）发送所有浏览器操作指令（DOM 操作、截图、滚动等）。CDP 指令在协议层注入，**不要求窗口处于激活状态**。因此"静默模式"只需要让那两处 `webContents.focus()` 变成有条件的，不需要重构输入注入路径。

### 实施

```typescript
// src/main/main.ts，两处现有调用改为：

// main.ts:872（agent shield 锁定时）
if (agentShield?.locked) {
  if (settings.agentWindowBehavior !== 'silent') {
    window.webContents.focus();
  }
}

// main.ts:920（session 激活时）
if (settings.agentWindowBehavior !== 'silent') {
  window.webContents.focus();
}
```

`settings` 从 `SettingsStore` 读取，Phase 1 在存储层完成后接入。

### 注意事项

- 不建议加"可见但不抢焦点"（`win.showInactive()`）第三选项——macOS 上此模式跨版本行为不一致，踩坑风险高，价值有限。
- 静默模式下如果 Agent 任务需要用户在页面上手动授权（cert error、CAPTCHA 等），页面不会自动弹出。这是预期行为：用户选了静默就意味着接受这个 tradeoff，可以在设置说明里写清楚。

---

## 七、不放进设置的东西

这些是 Pilion 的安全承诺，做成选项等于把护城河降级成偏好：

- 审批开关（蒙层、inline approval 流程）
- `full` 权限模式作为全局默认
- 忽略 TLS 证书错误
- 私网访问拦截（RFC1918）——文档措辞应改为"Pilion 主动拒绝访问 RFC1918 私网，以保护局域网设备，这是设计选择"，而不是"暂无局域网例外设置"

---

## 八、分期实施

### Phase 1（当前）

按以下顺序实施，后项依赖前项：

1. **`src/shared/keybindings.ts`**：抽取快捷键真源，消除 `main.tsx:234-263`（`onShortcut`）与 `main.tsx:265-330`（`keydown`）的双表漂移，为菜单 accelerator 提供单一来源。

2. **`src/main/settings-store.ts`**：新建全局设置存储（zod schema + `write-file-atomic` 原子写），暴露 `settings:get` / `settings:save` IPC。

3. **关于面板**：`app.setAboutPanelOptions({ applicationName: 'Pilion', ... })`，顺手改掉菜单栏显示"Electron"的问题。

4. **菜单**：`Menu.buildFromTemplate`，role 全保留，accelerator 从 `keybindings.ts` 读，动态项挂 `AppState` 变化。

5. **设置窗口骨架**：懒创建 `BrowserWindow`，`?window=preferences` 路由，hide/show 复用，页签框架。

6. **设置内容实现**：
   - 通用页（主题迁移出 localStorage、搜索引擎、启动行为、下载位置、关闭行为）
   - Agent 页（搬入 `AgentSettings.tsx` + 新增窗口行为开关）

7. **接入 silent 模式**：`main.ts:872` 和 `main.ts:920` 两处 focus 调用改为读 `settings.agentWindowBehavior`。

**验收 e2e**：补一条"⌘, → 打开设置 → 改主题为深色 → 关闭设置 → ⌘Q 退出 → 重启 → 主题仍为深色"，同时确认现有三条窗口数断言（`tests/electron.e2e.ts:594/618/676`）在不打开设置窗的测试路径下不受影响。

### Phase 2

- 浏览器页（清除数据、标签行为）
- 录制与技能页
- 快捷键只读页
- Set as Default Browser（`CFBundleURLTypes` + `open-url` 处理，外部链接 → 新标签页）

### Phase 3

- 快捷键可改
- 多工作区 / Profiles（独立立项）
- 更新检查（需要 autoUpdater 支持）
