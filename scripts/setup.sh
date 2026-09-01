#!/bin/sh
# opencode-switchman 一键安装/更新引导：下载 update-cli.mjs 并用 node/bun 执行
# 用法：curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
#       （可选参数透传给更新器，如 --version x.y.z / --dry-run）
set -eu
BASE="https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/update-cli.mjs"
# [2026-09-01]-[BSD mktemp 要求 X 占位符在模板末尾，带 .mjs 后缀会创建字面量文件并卡死后续运行]-
#  改用临时目录 + 固定文件名
WORK="$(mktemp -d "${TMPDIR:-/tmp}/switchman-update.XXXXXXXX")"
TMP="$WORK/update-cli.mjs"
trap 'rm -rf "$WORK"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BASE" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$BASE"
else
  echo "[switchman] 需要 curl 或 wget 下载更新器" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  exec node "$TMP" "$@"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun "$TMP" "$@"
fi
echo "[switchman] 需要 node 或 bun 运行更新器（opencode 用户通常已具备其一）" >&2
exit 1
