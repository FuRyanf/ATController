#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
application="${1:-$project_root/src-tauri/target/release/bundle/macos/ATController.app}"
signing_identity="${ATCONTROLLER_LOCAL_SIGNING_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ATController macOS signing must run on macOS." >&2
  exit 1
fi

test -d "$application"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$application/Contents/Info.plist")" = "com.furyanf.atcontroller"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$application/Contents/Info.plist")" = "ATController"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$application/Contents/Info.plist")" = "ATController"
test -n "$(/usr/libexec/PlistBuddy -c 'Print :NSDesktopFolderUsageDescription' "$application/Contents/Info.plist")"
test -n "$(/usr/libexec/PlistBuddy -c 'Print :NSDocumentsFolderUsageDescription' "$application/Contents/Info.plist")"
test -n "$(/usr/libexec/PlistBuddy -c 'Print :NSDownloadsFolderUsageDescription' "$application/Contents/Info.plist")"

if [ -n "$signing_identity" ]; then
  available_identities="$(security find-identity -v -p codesigning)"
  if [[ "$available_identities" != *"\"$signing_identity\""* ]]; then
    echo "The requested ATController signing identity is not available: $signing_identity" >&2
    exit 1
  fi
  codesign \
    --force \
    --deep \
    --sign "$signing_identity" \
    --identifier com.furyanf.atcontroller \
    --timestamp=none \
    "$application"
  echo "Signed ATController.app with the persistent identity: $signing_identity"
else
  # A sealed ad-hoc signature verifies locally, but its code requirement changes
  # whenever the executable changes. macOS may therefore ask for protected-folder
  # access again after a rebuild. Set ATCONTROLLER_LOCAL_SIGNING_IDENTITY to a
  # local code-signing identity when permission persistence matters.
  codesign \
    --force \
    --deep \
    --sign - \
    --identifier com.furyanf.atcontroller \
    --timestamp=none \
    "$application"
  echo "Signed ATController.app ad hoc. Protected-folder permissions may be requested again after a rebuild." >&2
fi

codesign --verify --deep --strict --verbose=2 "$application"
