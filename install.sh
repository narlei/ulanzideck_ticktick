#!/bin/bash
# TickTick Focus — installer for UlanziDeck
# Usage: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/narlei/ulanzideck-ticktick/main/install.sh)"
set -euo pipefail

PLUGIN_ID="com.narlei.ticktickfocus.ulanziPlugin"
GITHUB_REPO="narlei/ulanzideck-ticktick"
PLUGINS_DIR="$HOME/Library/Application Support/Ulanzi/UlanziDeck/Plugins"
APP_NAME="Ulanzi Studio"
APP_PATH="/Applications/${APP_NAME}.app"

# ── colors ──────────────────────────────────────────────────────────────────
tty_bold=''; tty_blue=''; tty_green=''; tty_yellow=''; tty_red=''; tty_reset=''
if [[ -t 1 ]]; then
  tty_bold=$'\033[1m'; tty_blue=$'\033[34m'; tty_green=$'\033[32m'
  tty_yellow=$'\033[33m'; tty_red=$'\033[31m'; tty_reset=$'\033[0m'
fi
step()  { echo "${tty_blue}==>${tty_reset} ${tty_bold}$*${tty_reset}"; }
ok()    { echo "${tty_green}  ✓${tty_reset} $*"; }
warn()  { echo "${tty_yellow}  !${tty_reset} $*"; }
abort() { echo "${tty_red}Error:${tty_reset} $*" >&2; exit 1; }

# ── preflight ─────────────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || abort "TickTick Focus requires macOS."
[[ -d "$APP_PATH" ]] || abort \
  "Ulanzi Studio not found at $APP_PATH. Install it first: https://www.ulanzi.com/pages/download"

# ── resolve download URL ──────────────────────────────────────────────────────
step "Checking latest release..."
LATEST_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/${PLUGIN_ID}.zip"
HTTP_CODE=$(curl -fsSL -o /dev/null -w "%{http_code}" -L --max-redirs 5 "$LATEST_URL" 2>/dev/null) || true
[[ "$HTTP_CODE" == "200" ]] || abort "Could not reach $LATEST_URL (HTTP $HTTP_CODE). Is the release published?"

# ── download ──────────────────────────────────────────────────────────────────
step "Downloading TickTick Focus..."
TMP_ZIP=$(mktemp /tmp/ttfocus-XXXXXX.zip)
trap 'rm -f "$TMP_ZIP"; rm -rf "${TMP_DIR:-}"' EXIT
curl -fsSL --progress-bar -L "$LATEST_URL" -o "$TMP_ZIP"
ok "Downloaded $(du -h "$TMP_ZIP" | cut -f1)"

# ── install ───────────────────────────────────────────────────────────────────
step "Installing to UlanziDeck plugins..."
TMP_DIR=$(mktemp -d /tmp/ttfocus-XXXXXX)
unzip -q "$TMP_ZIP" -d "$TMP_DIR"
[[ -d "$TMP_DIR/$PLUGIN_ID" ]] || abort "Unexpected ZIP structure — expected $PLUGIN_ID/ at root."

mkdir -p "$PLUGINS_DIR"
rm -rf "${PLUGINS_DIR:?}/$PLUGIN_ID"
mv "$TMP_DIR/$PLUGIN_ID" "$PLUGINS_DIR/$PLUGIN_ID"
ok "Installed to $PLUGINS_DIR/$PLUGIN_ID"

# ── unblock the native login helper ───────────────────────────────────────────
# The WKWebView login helper is an unsigned binary; strip the download quarantine
# so Gatekeeper lets it run, and make sure it stays executable.
step "Unblocking the native login helper..."
LOGIN_BIN="$PLUGINS_DIR/$PLUGIN_ID/resources/ticktick-login"
xattr -dr com.apple.quarantine "$PLUGINS_DIR/$PLUGIN_ID" 2>/dev/null || true
[[ -f "$LOGIN_BIN" ]] && chmod +x "$LOGIN_BIN" 2>/dev/null || true
ok "Login helper ready"

# ── node version check (informational only) ───────────────────────────────────
NODE_OK=false
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node node; do
  if command -v "$candidate" &>/dev/null; then
    MAJOR=$("$candidate" --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
    if [[ "${MAJOR:-0}" -ge 18 ]]; then NODE_OK=true; break; fi
  fi
done
[[ "$NODE_OK" == "true" ]] || warn "Node.js ≥ 18 not found — UlanziDeck ships its own Node, so this is usually fine."

# ── restart UlanziDeck ────────────────────────────────────────────────────────
step "Restarting ${APP_NAME}..."
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6; do
  pgrep -f "${APP_PATH}/" >/dev/null 2>&1 || break
  sleep 1
done
pkill -f "${APP_PATH}/" >/dev/null 2>&1 || true
sleep 1
open -a "${APP_NAME}"
ok "${APP_NAME} restarted"

echo ""
echo "${tty_bold}${tty_green}TickTick Focus installed!${tty_reset}"
echo "Open UlanziDeck, drag the ${tty_bold}Focus${tty_reset} button to your deck,"
echo "then open its settings and click ${tty_bold}Sign in to TickTick${tty_reset}."
echo ""
echo "Docs & setup: https://github.com/${GITHUB_REPO}#setup"
