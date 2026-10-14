#!/usr/bin/env bash
# E2E 焦点守卫：跑 E2E 期间每秒采样一次 macOS 前台进程名，结束后统计。
# Pilion 的 E2E 模式（PILION_E2E_NO_FOCUS=1）不该再抢系统前台焦点——
# 如果采样里出现 Pilion，说明有地方漏接了 window-focus，判失败。
#
# 用法： scripts/e2e-focus-guard.sh <log-file>
# 只采样；E2E 本体由外层（如 pnpm test:e2e）启动。E2E 跑完后 touch 一次
# /tmp/e2e-focus-guard.stop 即结束。
set -euo pipefail

LOG="${1:-/tmp/e2e-focus-guard.log}"
: > "$LOG"

# 先把 TextEdit 放到前台，作为「用户正在用」的基线。
open -a TextEdit >/dev/null 2>&1 || true
sleep 1

sample() {
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null || echo "sample-error"
}

echo "focus-guard: start $(date)" | tee -a "$LOG"
while true; do
  name="$(sample)"
  echo "$(date +%s) $name" >> "$LOG"
  if [ -f /tmp/e2e-focus-guard.stop ]; then
    break
  fi
  sleep 1
done
echo "focus-guard: stop $(date)" | tee -a "$LOG"

echo "----- 前台进程计数 -----" | tee -a "$LOG"
awk '{print $2}' "$LOG" | sort | uniq -c | sort -rn | tee -a "$LOG"

# 判定：前台出现 Pilion 即失败。
# 说明：开发态 electron 二进制名字叫 "Electron"，和 Trae 等其它 Electron 应用重名、无法区分；
# 但本应用真抢到前台时 macOS 显示的是 "Pilion"（见上一轮对照），所以只匹配 Pilion。
if grep -Eq '^[0-9]+ Pilion' "$LOG"; then
  echo "focus-guard: FAIL — E2E 期间 Pilion 抢到了系统前台焦点" | tee -a "$LOG"
  exit 1
fi
echo "focus-guard: PASS — E2E 期间 Pilion 没有抢系统前台焦点" | tee -a "$LOG"
