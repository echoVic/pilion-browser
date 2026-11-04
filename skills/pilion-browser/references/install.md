# Install Pilion and connect it to agents

Read this file only when `pilion` is not found, when `pilion skill` reports
an unknown command, when `pilion status` reports a problem, or when the user
asks to set Pilion up. For day-to-day browser work, run `pilion skill` and
follow its output.

The `pilion` command is provided by the Pilion desktop app. Pilion runs on
macOS and Linux; its external channel is not available on Windows yet.

## 1. Install the app

Before downloading or asking the person for setup, check `command -v pilion`
and `test -x "$HOME/.local/bin/pilion"`. If the second succeeds, prepend
`$HOME/.local/bin` to PATH and run `pilion status --json`. A PATH export in
one shell call may not persist to another: use the absolute executable or
prepend PATH again as needed. Do not edit shell startup files merely to
complete a browser task.

If both checks fail, check whether Pilion is already installed. An existing
app may only need **安装到 Agent** below. Download when the app is absent or
its version lacks that feature.

Download the latest release from
https://github.com/echoVic/pilion-browser/releases — a `.dmg` on macOS, an
`.AppImage` or `.deb` on Linux — install it and open Pilion.

## 2. Connect Pilion to agents

This step is done by the person in Pilion's window. Ask them to open
**设置 › 通用 › 对外控制** and click **安装到 Agent**, then wait for them to
confirm. That button:

- turns on Pilion's local external channel;
- issues a credential for command-line agents;
- installs the `pilion` command at `~/.local/bin/pilion`;
- copies this skill into the agents' skills directories it finds.

## 3. Check the command

```bash
command -v pilion
```

If it is not found, `~/.local/bin` is not on this shell's PATH. Fix it for
this session and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v pilion
```

Then verify the connection:

```bash
pilion status --json
```

Success is exit 0 and one JSON object with `"ok":true`. On failure, inspect
entries in `checks` with `"ok":false` and follow their `detail`.
Text mode (`pilion status`) prints `item<TAB>ok/FAIL<TAB>detail`; `ok` is
the second column, not the end of the line.

## 4. Return to the original task

Run `pilion skill` and follow its output: create one Space for this
conversation, record its ID, pass `--space` on browser commands (or explicitly
export `PILION_SPACE` in each shell), and use actual task tab IDs. At task
completion, close only that recorded Space; its tabs remain for the person.

## Troubleshooting

- **`SPACE_REQUIRED`**：集成客户端的浏览器命令需要 `--space` 参数（或
  在当前 shell 显式导出的 `PILION_SPACE`）。使用本对话已记录的 id；尚未创建时
  才运行 `pilion space new "<任务名>"`。不要沿用其他任务的环境变量或逐条新建。
- **`Space 已结束` / `SPACE_ENDED`**：已关闭或被用户停止的 Space 不能恢复。
  不要重试、静默新建或切换 Space；报告中断和未确定的操作结果，等待用户同意后
  再为本任务新建。用户接管同样需要先取得同意。
- **`SPACE_NOT_FOUND`**：id 不存在或不属于本客户端；接管后变成用户 Space，
  当前也返回此错误。检查本任务记录和 `pilion space list --json`，报告实际情况，
  不要静默换 id 或重建。
- **空闲 / 重启**：60 分钟没有已接纳的工具请求会以 `idle` 结束，每次已接纳
  的请求重置计时；重启以 `restart` 结束。再次连接可恢复这两类仍保留的 Space，
  受活跃上限约束。只恢复本任务的记录，重新读取页面、获取 ref 并核实先前结果；
  恢复连接不代表可以重做效果操作。
- **`SPACE_LIMIT`**：全局最多 8 个活跃 Agent Space，创建和恢复均受此限制。
  `pilion space list --json` 只列本客户端，但可能包含其他对话。仅可关闭本任务
  已记录且工作已完成的 Space：`pilion space close <本任务实际-id>`。不要结束
  其他任务来腾位置；本任务无可结束的 Space 时，报告限制，让用户在侧栏决定
  停止哪项工作。不要循环新建或恢复。
- **`pilion status` says Pilion is not running**: ask the person to open Pilion.
- **`credential` is not ok**: the integration was removed or revoked; ask the
  person to click 安装到 Agent again.
- **`version` mismatch**: Pilion was updated while it was running; ask the
  person to restart Pilion.
- **A file already exists at `~/.local/bin/pilion`** that Pilion did not
  create: Pilion will not overwrite it. Ask the person whether to remove it.
- **Windows**: not supported yet.
