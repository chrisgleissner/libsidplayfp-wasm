#!/usr/bin/env bash
# Build both distributable engines from the exact refs in upstream.json.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)

LIBSIDPLAYFP_WASM_ENGINE=residfp \
LIBSIDPLAYFP_WASM_DIST_DIR="${PACKAGE_ROOT}/dist" \
bash "${SCRIPT_DIR}/build.sh"

LIBSIDPLAYFP_WASM_ENGINE=sidlite \
LIBSIDPLAYFP_WASM_DIST_DIR="${PACKAGE_ROOT}/dist/sidlite" \
bash "${SCRIPT_DIR}/build.sh"
