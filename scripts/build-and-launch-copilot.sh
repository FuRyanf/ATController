#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="ATController Copilot"
BUNDLE_IDENTIFIER="${ATCONTROLLER_COPILOT_BUNDLE_IDENTIFIER:-com.atcontroller.copilot}"
CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/atcontroller-copilot-tauri.XXXXXX.json")"
INSTALL=0

cleanup() {
  rm -f "$CONFIG_FILE"
}
trap cleanup EXIT

for arg in "$@"; do
  case "$arg" in
    --install)
      INSTALL=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: scripts/build-and-launch-copilot.sh [--install]" >&2
      exit 2
      ;;
  esac
done

cat > "$CONFIG_FILE" <<JSON
{
  "productName": "$APP_NAME",
  "identifier": "$BUNDLE_IDENTIFIER",
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "$APP_NAME",
        "width": 1320,
        "height": 860,
        "minWidth": 1024,
        "minHeight": 720,
        "resizable": true
      }
    ]
  },
  "bundle": {
    "icon": [
      "icons/copilot/32x32.png",
      "icons/copilot/128x128.png",
      "icons/copilot/128x128@2x.png",
      "icons/copilot/icon.icns"
    ]
  }
}
JSON

export ATCONTROLLER_AGENT_PROVIDER=copilot
export VITE_ATCONTROLLER_AGENT_PROVIDER=copilot

yarn tauri build --bundles app --config "$CONFIG_FILE"

APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "Could not find built app bundle: $APP_PATH" >&2
  exit 1
fi

xattr -dr com.apple.quarantine "$APP_PATH" >/dev/null 2>&1 || true

if [[ "$INSTALL" -eq 1 ]]; then
  DEST_PATH="/Applications/$APP_NAME.app"
  rm -rf "$DEST_PATH"
  ditto "$APP_PATH" "$DEST_PATH"
  xattr -dr com.apple.quarantine "$DEST_PATH" >/dev/null 2>&1 || true
  APP_PATH="$DEST_PATH"
fi

/usr/bin/open -n "$APP_PATH"

echo "Launched $APP_PATH"
