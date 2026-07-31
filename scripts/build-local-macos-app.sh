#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "ATController local application builds require an Apple-silicon Mac." >&2
  exit 1
fi

yarn run tauri -- build --bundles app -- --locked

application="$project_root/src-tauri/target/release/bundle/macos/ATController.app"
executable="$application/Contents/MacOS/atcontroller"

test -d "$application"
test "$(lipo -archs "$executable")" = "arm64"
bash "$project_root/scripts/sign-local-macos-app.sh" "$application"

echo "Created $application"
