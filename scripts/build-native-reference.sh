#!/usr/bin/env bash
#
# Build a NATIVE libsidplayfp + libresidfp at exactly the refs the WASM artifact
# is pinned to, plus a small renderer configured identically to bindings.cpp.
#
# This is the control for the comparative engine analysis. Comparing the WASM
# build against a distro `sidplayfp` does not work: distros ship libsidplayfp
# 2.x, so any difference conflates "our build is wrong" with "upstream changed".
# The refs are read from upstream.json so there is exactly one place that
# decides which upstream the project targets.
#
# Output: <prefix>/bin/sidflow-native-render
# Re-running is cheap: it skips the build when the stamp matches.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)

PREFIX="${1:-${PACKAGE_ROOT}/.cache/native-reference}"
WORK="${PREFIX}/build"

run_in_container() {
    local image_name="libsidplayfp-wasm-native-reference:3.1.74"
    docker build -f "${PACKAGE_ROOT}/docker/native-reference.Dockerfile" -t "${image_name}" "${PACKAGE_ROOT}"
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        -e LIBSIDPLAYFP_WASM_NATIVE_REFERENCE_CONTAINER=1 \
        -e LIBSIDPLAYFP_REF \
        -e LIBRESIDFP_REF \
        -v "${PACKAGE_ROOT}:${PACKAGE_ROOT}" \
        -w "${PACKAGE_ROOT}" \
        "${image_name}" \
        bash scripts/build-native-reference.sh "${PREFIX}"
}

read_ref() {
    node "${SCRIPT_DIR}/upstream.mjs" get "$1.ref"
}

LIBSIDPLAYFP_REF="${LIBSIDPLAYFP_REF:-$(read_ref libsidplayfp)}"
LIBRESIDFP_REF="${LIBRESIDFP_REF:-$(read_ref libresidfp)}"

if [[ -z "${LIBSIDPLAYFP_REF}" || -z "${LIBRESIDFP_REF}" ]]; then
    echo "could not read pinned refs from ${PACKAGE_ROOT}/upstream.json" >&2
    exit 1
fi

STAMP_CONTENT="${LIBSIDPLAYFP_REF}|${LIBRESIDFP_REF}|$(sha256sum "${SCRIPT_DIR}/native-reference/render.cpp" | awk '{print $1}')"
STAMP_FILE="${PREFIX}/.build-stamp"

if [[ -x "${PREFIX}/bin/sidflow-native-render" && -f "${STAMP_FILE}" && "$(cat "${STAMP_FILE}")" == "${STAMP_CONTENT}" ]]; then
    echo "native reference already built for ${LIBSIDPLAYFP_REF} + ${LIBRESIDFP_REF}"
    echo "${PREFIX}/bin/sidflow-native-render"
    exit 0
fi

echo "building native reference: libsidplayfp ${LIBSIDPLAYFP_REF} + libresidfp ${LIBRESIDFP_REF}"

# libsidplayfp's configure only probes for `xa` (AC_CHECK_PROGS) and does not
# fail without it, so a missing assembler surfaces minutes later as an opaque
# `make: *** [src/psiddrv.bin] Error 1`. Name the missing tool up front instead.
missing=()
for tool in git autoreconf automake libtoolize pkg-config g++ make xa; do
    command -v "${tool}" >/dev/null 2>&1 || missing+=("${tool}")
done
if ((${#missing[@]})); then
    if [[ "${LIBSIDPLAYFP_WASM_NATIVE_REFERENCE_CONTAINER:-}" != "1" ]] && command -v docker >/dev/null 2>&1; then
        echo "native build tools are absent; using the maintained container fallback" >&2
        run_in_container
        exit 0
    fi
    echo "missing build tools: ${missing[*]}" >&2
    echo "on Debian/Ubuntu: apt-get install build-essential autoconf automake libtool pkg-config git xa65" >&2
    echo "(the xa65 package installs the 6502 assembler as 'xa')" >&2
    exit 1
fi

rm -rf "${WORK}"
mkdir -p "${WORK}" "${PREFIX}/bin"

git clone --quiet --branch "${LIBRESIDFP_REF}" --depth 1 \
    https://github.com/libsidplayfp/libresidfp "${WORK}/libresidfp"
(
    cd "${WORK}/libresidfp"
    autoreconf -fi >/dev/null 2>&1
    ./configure --prefix="${PREFIX}" --disable-shared --enable-static \
        --disable-dependency-tracking CXXFLAGS="-O2" >/dev/null
    make -j"$(nproc)" >/dev/null
    make install >/dev/null
)

git clone --quiet --branch "${LIBSIDPLAYFP_REF}" --depth 1 --recurse-submodules \
    https://github.com/libsidplayfp/libsidplayfp "${WORK}/libsidplayfp"
(
    cd "${WORK}/libsidplayfp"
    autoreconf -fi >/dev/null 2>&1
    PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig" ./configure --prefix="${PREFIX}" \
        --disable-shared --enable-static --without-gcrypt --without-exsid --without-usbsid \
        --disable-dependency-tracking CXXFLAGS="-O2" >/dev/null
    # The whole point of the control is that it uses reSIDfp, like the wasm build.
    if ! grep -q '^#define HAVE_RESIDFP 1' src/config.h; then
        echo "native reference configure did not find libresidfp" >&2
        exit 1
    fi
    make -j"$(nproc)" >/dev/null
    make install >/dev/null
)

g++ -O2 -std=c++17 -o "${PREFIX}/bin/sidflow-native-render" \
    "${SCRIPT_DIR}/native-reference/render.cpp" \
    -I"${PREFIX}/include" "${PREFIX}/lib/libsidplayfp.a" "${PREFIX}/lib/libresidfp.a"

printf '%s' "${STAMP_CONTENT}" >"${STAMP_FILE}"
rm -rf "${WORK}"

echo "${PREFIX}/bin/sidflow-native-render"
