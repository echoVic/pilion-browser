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

Run `pilion skill` and follow its output.

## Troubleshooting

- **`pilion status` says Pilion is not running**: ask the person to open Pilion.
- **`credential` is not ok**: the integration was removed or revoked; ask the
  person to click 安装到 Agent again.
- **`version` mismatch**: Pilion was updated while it was running; ask the
  person to restart Pilion.
- **A file already exists at `~/.local/bin/pilion`** that Pilion did not
  create: Pilion will not overwrite it. Ask the person whether to remove it.
- **Windows**: not supported yet.
