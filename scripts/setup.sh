#!/bin/sh
# [2026-09-04]-[English localization: translate comments and messages; no logic change]
# opencode-switchman one-shot install/update bootstrap: downloads update-cli.mjs and runs it with node/bun
# Usage: curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
#        (optional args are passed through to the updater, e.g. --version x.y.z / --dry-run)
set -eu
BASE="https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/update-cli.mjs"
# [2026-09-01]-[BSD mktemp requires the X placeholders at the end of the template; a .mjs suffix would
#  create a literal-named file and wedge later runs]-
#  Use a temp directory + fixed file name instead
WORK="$(mktemp -d "${TMPDIR:-/tmp}/switchman-update.XXXXXXXX")"
TMP="$WORK/update-cli.mjs"
trap 'rm -rf "$WORK"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BASE" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$BASE"
else
  echo "[switchman] curl or wget is required to download the updater" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  exec node "$TMP" "$@"
fi
if command -v bun >/dev/null 2>&1; then
  exec bun "$TMP" "$@"
fi
echo "[switchman] node or bun is required to run the updater (opencode users usually have one of them)" >&2
exit 1
