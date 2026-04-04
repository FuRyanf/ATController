#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ATController.app"
DMG_PATH="${1:-$HOME/Downloads/ATController.dmg}"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH"
  echo "Usage: scripts/install-unsigned-macos.sh /path/to/ATController.dmg"
  exit 1
fi

echo "Mounting DMG: $DMG_PATH"
MOUNT_DIR="$(hdiutil attach "$DMG_PATH" -nobrowse | sed -n 's|^.*\(/Volumes/.*\)$|\1|p' | head -n 1)"

if [[ -z "${MOUNT_DIR:-}" ]]; then
  echo "Failed to mount DMG."
  exit 1
fi

cleanup() {
  hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

APP_SOURCE="$MOUNT_DIR/$APP_NAME"
APP_DEST="/Applications/$APP_NAME"

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "App bundle not found in mounted DMG: $APP_SOURCE"
  exit 1
fi

echo "Installing app to: $APP_DEST"
ditto "$APP_SOURCE" "$APP_DEST"

echo "Clearing quarantine attribute..."
xattr -dr com.apple.quarantine "$APP_DEST" || true

echo "Launch check..."
open "$APP_DEST"

echo "Done."
