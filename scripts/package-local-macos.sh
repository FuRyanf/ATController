#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "ATController local packages are built on an Apple-silicon Mac." >&2
  exit 1
fi

bash "$project_root/scripts/build-local-macos-app.sh"

application="$project_root/src-tauri/target/release/bundle/macos/ATController.app"
executable="$application/Contents/MacOS/atcontroller"
artifact_directory="$project_root/src-tauri/target/release-assets"

test -d "$application"
test "$(lipo -archs "$executable")" = "arm64"

temporary_root="$(mktemp -d /tmp/atcontroller-local-package.XXXXXX)"
case "$temporary_root" in
  /tmp/atcontroller-local-package.*) ;;
  *)
    echo "Unexpected temporary package path: $temporary_root" >&2
    exit 1
    ;;
esac

cleanup() {
  if [ -d "$temporary_root" ]; then
    rm -rf -- "$temporary_root"
  fi
}
trap cleanup EXIT

zip_path="$temporary_root/ATController.app.zip"
dmg_path="$temporary_root/ATController.dmg"
dmg_root="$temporary_root/dmg-root"

ditto -c -k --sequesterRsrc --keepParent "$application" "$zip_path"

mkdir -p "$dmg_root"
ditto "$application" "$dmg_root/ATController.app"
ln -s /Applications "$dmg_root/Applications"
hdiutil create \
  -volname ATController \
  -srcfolder "$dmg_root" \
  -format UDZO \
  "$dmg_path"

unzip -tq "$zip_path"
hdiutil verify "$dmg_path"

mkdir -p "$artifact_directory"
mv -f "$zip_path" "$artifact_directory/ATController.app.zip"
mv -f "$dmg_path" "$artifact_directory/ATController.dmg"

echo "Created native ATController packages:"
echo "  $artifact_directory/ATController.dmg"
echo "  $artifact_directory/ATController.app.zip"
