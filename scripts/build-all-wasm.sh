#!/usr/bin/env bash
# Build both distributable engines from the exact refs in upstream.json.
#
# One container run, not two. The reSIDfp and SIDLite artifacts differ only in a
# single em++ flag, so libresidfp and libsidplayfp are cross-compiled once and
# linked twice, which is roughly half the work of running the whole build per
# engine. reSIDfp lands in dist/, SIDLite in dist/sidlite/.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)

LIBSIDPLAYFP_WASM_ENGINE=both \
LIBSIDPLAYFP_WASM_DIST_DIR="${PACKAGE_ROOT}/dist" \
bash "${SCRIPT_DIR}/build.sh"
