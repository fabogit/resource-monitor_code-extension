#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist/native"
mkdir -p "${OUT_DIR}"

NODE_EXEC="$(which node)"
NODE_PREFIX="$(dirname "$(dirname "${NODE_EXEC}")")"
NODE_INCLUDE="${NODE_PREFIX}/include/node"

if [ ! -f "${NODE_INCLUDE}/node_api.h" ]; then
  # Fallback to headers in nvm or current process directory
  NODE_INCLUDE="$(node -e "console.log(require('path').resolve(process.execPath, '../../include/node'))")"
fi

if [ ! -f "${NODE_INCLUDE}/node_api.h" ]; then
  echo "Error: Cannot find node_api.h in ${NODE_INCLUDE}" >&2
  exit 1
fi

echo "[compile.sh] Compiling darwin_telemetry.node using Clang..."
clang++ -O3 -std=c++17 -Wall -shared -undefined dynamic_lookup \
  -I"${NODE_INCLUDE}" \
  -framework CoreFoundation \
  -framework IOKit \
  "${SCRIPT_DIR}/src/addon.cc" \
  -o "${OUT_DIR}/darwin_telemetry.node"

echo "[compile.sh] Successfully built ${OUT_DIR}/darwin_telemetry.node"
