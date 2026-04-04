#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_IMAGE="${ROOT_DIR}/app icon.jpg"
BASE_ICON="${ROOT_DIR}/assets/icon.png"
MAC_ICON_DIR="${ROOT_DIR}/src-tauri/icons/macos"
ICONSET_DIR="${ROOT_DIR}/src-tauri/icons/Claudex.iconset"

if [[ ! -f "${SOURCE_IMAGE}" ]]; then
  echo "Source icon not found at ${SOURCE_IMAGE}" >&2
  exit 1
fi

mkdir -p "${ROOT_DIR}/assets" "${MAC_ICON_DIR}"

SOURCE_IMAGE="${SOURCE_IMAGE}" BASE_ICON="${BASE_ICON}" python3 - <<'PY'
from collections import deque
import os

import numpy as np
from PIL import Image

source = os.environ['SOURCE_IMAGE']
destination = os.environ['BASE_ICON']

img = Image.open(source).convert('RGBA')
arr = np.array(img)
rgb = arr[:, :, :3].astype(np.int16)

# Estimate the flat background from image corners.
corners = np.array([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]], dtype=np.int16)
background = np.median(corners, axis=0)

# Mark pixels that are close to background color.
diff = np.max(np.abs(rgb - background), axis=2)
background_like = diff <= 14

height, width = background_like.shape
visited = np.zeros((height, width), dtype=bool)
queue: deque[tuple[int, int]] = deque()

# Flood-fill from edges so only edge-connected background becomes transparent.
for x in range(width):
    if background_like[0, x] and not visited[0, x]:
        visited[0, x] = True
        queue.append((0, x))
    if background_like[height - 1, x] and not visited[height - 1, x]:
        visited[height - 1, x] = True
        queue.append((height - 1, x))

for y in range(height):
    if background_like[y, 0] and not visited[y, 0]:
        visited[y, 0] = True
        queue.append((y, 0))
    if background_like[y, width - 1] and not visited[y, width - 1]:
        visited[y, width - 1] = True
        queue.append((y, width - 1))

while queue:
    y, x = queue.popleft()
    if y > 0 and background_like[y - 1, x] and not visited[y - 1, x]:
        visited[y - 1, x] = True
        queue.append((y - 1, x))
    if y < height - 1 and background_like[y + 1, x] and not visited[y + 1, x]:
        visited[y + 1, x] = True
        queue.append((y + 1, x))
    if x > 0 and background_like[y, x - 1] and not visited[y, x - 1]:
        visited[y, x - 1] = True
        queue.append((y, x - 1))
    if x < width - 1 and background_like[y, x + 1] and not visited[y, x + 1]:
        visited[y, x + 1] = True
        queue.append((y, x + 1))

arr[visited, 3] = 0
rgba = Image.fromarray(arr)
alpha = np.array(rgba)[:, :, 3]
coords = np.argwhere(alpha > 0)
if coords.size == 0:
    raise RuntimeError('Unable to find non-background artwork in source icon.')

y_min, x_min = coords.min(axis=0)
y_max, x_max = coords.max(axis=0)
cropped = rgba.crop((int(x_min), int(y_min), int(x_max) + 1, int(y_max) + 1))

# Apply macOS-friendly inner padding (~13.5% margins per side).
canvas_size = 1024
artwork_size = 748
cropped.thumbnail((artwork_size, artwork_size), Image.Resampling.LANCZOS)

canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
x_offset = (canvas_size - cropped.width) // 2
y_offset = (canvas_size - cropped.height) // 2
canvas.paste(cropped, (x_offset, y_offset), cropped)
canvas.save(destination, format='PNG')
PY

(
  cd "${ROOT_DIR}"
  yarn --silent tauri icon "${BASE_ICON}"
)

for size in 16 32 128 256 512 1024; do
  sips -z "${size}" "${size}" "${BASE_ICON}" --out "${MAC_ICON_DIR}/${size}x${size}.png" >/dev/null
 done

rm -rf "${ICONSET_DIR}"
mkdir -p "${ICONSET_DIR}"

sips -z 16 16 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_16x16.png" >/dev/null
sips -z 32 32 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_32x32.png" >/dev/null
sips -z 64 64 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_128x128.png" >/dev/null
sips -z 256 256 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_256x256.png" >/dev/null
sips -z 512 512 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_512x512.png" >/dev/null
sips -z 1024 1024 "${BASE_ICON}" --out "${ICONSET_DIR}/icon_512x512@2x.png" >/dev/null

iconutil -c icns "${ICONSET_DIR}" -o "${ROOT_DIR}/src-tauri/icons/icon.icns"
rm -rf "${ICONSET_DIR}"

echo "Icons generated from ${SOURCE_IMAGE}"
