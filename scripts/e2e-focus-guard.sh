#!/usr/bin/env bash
# E2E 焦点守卫：跑 E2E 期间每秒采样一次 macOS 前台进程，结束后统计。
# Pilion 的 E2E 模式（PILION_E2E_NO_FOCUS=1）不该再抢系统前台焦点。
#
# 关键：开发态 electron 二进制名字叫 "Electron"，和 Trae/CorpLink 等别的 Electron 应用重名，
# 只按进程名匹配会误判。这里拿到前台进程的 unix id（pid），再判断它是不是「我们这个 worktree
# 启动的 pilion electron」——用 ps 看该 pid 的命令行是否含本 worktree 路径。是才算抢焦点。
#
# 用法： scripts/e2e-focus-guard.sh <log-file> [worktree-dir]
# 只采样；E2E 本体由外层（如 pnpm test:e2e）启动。E2E 跑完后 touch 一次
# /tmp/e2e-focus-guard.stop 即结束。
set -euo pipefail

LOG="${1:-/tmp/e2e-focus-guard.log}"
WT="${2:-/Users/bytedance/Documents/GitHub/pilion-wt-fix-e2e-stability}"
: > "$LOG"

# 先把 TextEdit 放到前台，作为「用户正在用」的基线。
open -a TextEdit >/dev/null 2>&1 || true
sleep 1

# 前台进程名 + 它的 unix id（以 | 连接）。
sample() {
  osascript <<'APPLESCRIPT' 2>/dev/null || echo "sample-error|0"
tell application "System Events"
  set p to first process whose frontmost is true
  return (name of p) & "|" & (unix id of p as string)
end tell
APPLESCRIPT
}

# 该 pid 命令行里是否含本 worktree（说明是我们启动的 pilion electron）。
is_our_pilion() {
  local pid="$1"
  [ "$pid" != "0" ] && ps -p "$pid" -o command= 2>/dev/null | grep -qF "$WT"
}

echo "focus-guard: start $(date)" | tee -a "$LOG"
our_samples=0
total=0
while true; do
  line="$(sample)"
  name="${line%%|*}"
  pid="${line##*|}"
  total=$((total + 1))
  printf '%s %s pid=%s\n' "$(date +%s)" "$name" "$pid" >> "$LOG"
  if is_our_pilion "$pid"; then
    our_samples=$((our_samples + 1))
    printf '%s PILION-FOREGROUND pid=%s\n' "$(date +%s)" "$pid" >> "$LOG"
  fi
  if [ -f /tmp/e2e-focus-guard.stop ]; then
    break
  fi
  sleep 1
done
echo "focus-guard: stop $(date)" | tee -a "$LOG"

echo "----- 判定 -----" | tee -a "$LOG"
echo "总采样 ${total:-0}，其中我们自己的 pilion 抢到前台 ${our_samples:-0} 次" | tee -a "$LOG"
if [ "${our_samples:-0}" -gt 0 ]; then
  echo "focus-guard: FAIL — E2E 期间我们的 Pilion 进程抢到了系统前台焦点" | tee -a "$LOG"
  exit 1
fi
echo "focus-guard: PASS — E2E 期间我们的 Pilion 进程没有抢系统前台焦点" | tee -a "$LOG"
