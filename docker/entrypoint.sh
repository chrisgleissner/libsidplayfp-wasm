#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${EMSDK:-}" && -f "${EMSDK}/emsdk_env.sh" ]]; then
    source "${EMSDK}/emsdk_env.sh" >/dev/null
elif [[ -f /emsdk/emsdk_env.sh ]]; then
  source /emsdk/emsdk_env.sh >/dev/null
elif [[ -f /opt/emsdk/emsdk_env.sh ]]; then
  source /opt/emsdk/emsdk_env.sh >/dev/null
else
    echo "emsdk environment script not found" >&2
    exit 1
fi

BUILD_ROOT=/tmp/libsidplayfp
RESIDFP_BUILD_ROOT=/tmp/libresidfp
OUTPUT_ROOT=/dist
CACHE_ROOT=/opt/libsidplayfp-cache
CACHE_REPO="${CACHE_ROOT}/repo"
RESIDFP_CACHE_REPO="${CACHE_ROOT}/residfp"
UPSTREAM_SCRIPT=/opt/libsidplayfp-wasm/scripts/upstream.mjs

# Where the cross-compiled libresidfp is installed so that libsidplayfp's
# `PKG_CHECK_MODULES([RESIDFP], ...)` can find it during emconfigure.
SYSROOT_PREFIX=/opt/wasm-sysroot

rm -rf "${BUILD_ROOT}" "${RESIDFP_BUILD_ROOT}"
mkdir -p "${BUILD_ROOT}" "${RESIDFP_BUILD_ROOT}" "${OUTPUT_ROOT}" "${CACHE_ROOT}" "${SYSROOT_PREFIX}"

# The upstream mirrors under ${CACHE_ROOT} are a bind mount from the host. A CI
# cache restores them owned by the runner user while this container runs as
# root, and git then refuses to touch them ("detected dubious ownership",
# exit 128). The container is ephemeral, single-purpose, and the only thing in
# it is source we pinned, so trusting its own filesystem is not a concession.
git config --global --add safe.directory '*'

GIT_URL="https://github.com/libsidplayfp/libsidplayfp"
RESIDFP_GIT_URL="https://github.com/libsidplayfp/libresidfp"

# Pin upstream through the checked-in, immutable manifest. Overrides are for
# controlled diagnostics only; release automation always updates the manifest
# and records the exact resolved commit before a build can publish.
#
# The commit, not just the tag, is what upstream.json calls immutable — and git
# tags are not. Until sync_repo started comparing it the recorded commit had no
# reader at all, so a force-pushed upstream tag would have silently changed what
# we ship. An explicit ref override is a deliberate diagnostic and waives the
# check for that library alone, which is why the override has to be detected
# here, before the manifest default is substituted.
if [[ -n "${LIBSIDPLAYFP_REF:-}" ]]; then
    LIBSIDPLAYFP_COMMIT=""
else
    LIBSIDPLAYFP_REF="$(node "${UPSTREAM_SCRIPT}" get libsidplayfp.ref)"
    LIBSIDPLAYFP_COMMIT="$(node "${UPSTREAM_SCRIPT}" get libsidplayfp.commit)"
fi
if [[ -n "${LIBRESIDFP_REF:-}" ]]; then
    LIBRESIDFP_COMMIT=""
else
    LIBRESIDFP_REF="$(node "${UPSTREAM_SCRIPT}" get libresidfp.ref)"
    LIBRESIDFP_COMMIT="$(node "${UPSTREAM_SCRIPT}" get libresidfp.commit)"
fi

# Which SID emulation the artifact is built with.
#
#   residfp  cycle-accurate, what a C64 actually sounds like — the reference
#   sidlite  sounds good and renders ~an order of magnitude faster; the default
#            engine callers get unless they ask for reSIDfp
#
# libresidfp is cross-compiled either way: SIDLite lives inside libsidplayfp
# itself, and building both keeps the two artifacts identical apart from the
# emulation, which is the whole point of being able to compare them.
# `both` is the release path. The two artifacts differ only in one em++ flag, so
# compiling libresidfp and libsidplayfp once and linking twice halves the build
# instead of running this whole script per engine. reSIDfp lands in /dist and
# SIDLite in /dist/sidlite, matching how they are published.
SID_ENGINE="${LIBSIDPLAYFP_WASM_ENGINE:-${SIDFLOW_SID_ENGINE:-residfp}}"
case "${SID_ENGINE}" in
    residfp | sidlite | both) ;;
    *)
        echo "LIBSIDPLAYFP_WASM_ENGINE must be residfp, sidlite or both, got: ${SID_ENGINE}" >&2
        exit 1
        ;;
esac
echo "SID engine: ${SID_ENGINE}"

sync_repo() {
    local url="$1" dest="$2" ref="$3" expected_commit="${4:-}"
    if [[ ! -d "${dest}/.git" ]]; then
        git clone --recurse-submodules "${url}" "${dest}"
    else
        # --force so a retagged upstream release still lands here rather than
        # leaving a stale cached tag that quietly builds the wrong source.
        git -C "${dest}" fetch --tags --force origin
    fi
    git -C "${dest}" checkout --force "${ref}"
    git -C "${dest}" submodule update --init --recursive

    local actual
    actual="$(git -C "${dest}" rev-parse HEAD)"
    if [[ -n "${expected_commit}" && "${actual}" != "${expected_commit}" ]]; then
        echo "PIN CHECK FAILED: ${url} ${ref} resolves to ${actual}," >&2
        echo "but upstream.json pins ${expected_commit}. Git tags are mutable; this is" >&2
        echo "the check that notices. Re-derive the pin deliberately with" >&2
        echo "  node scripts/upstream.mjs update --ref ${ref} --commit ${actual}" >&2
        exit 1
    fi
    if [[ -n "${expected_commit}" ]]; then
        echo "pin check: ${url} ${ref} == ${expected_commit}"
    fi
}

# ---------------------------------------------------------------------------
# 1. Cross-compile libresidfp, the actual SID emulation.
#
# Without this, libsidplayfp's configure leaves HAVE_RESIDFP undefined and a
# residfp build would silently come out as SIDLite instead — the wrong engine,
# regardless of how either one sounds. bindings.cpp now #errors in that case, so
# this step is load-bearing rather than an optimisation. It runs for both
# engines so the two artifacts differ only in the emulation.
# ---------------------------------------------------------------------------
sync_repo "${RESIDFP_GIT_URL}" "${RESIDFP_CACHE_REPO}" "${LIBRESIDFP_REF}" "${LIBRESIDFP_COMMIT}"
echo "libresidfp pinned at ${LIBRESIDFP_REF} ($(git -C "${RESIDFP_CACHE_REPO}" rev-parse --short HEAD))"

rsync -a --delete "${RESIDFP_CACHE_REPO}/" "${RESIDFP_BUILD_ROOT}/"
cd "${RESIDFP_BUILD_ROOT}"

# reSIDfp builds its filter tables on helper threads. Since libsidplayfp v3.x
# those sources live in libresidfp, so the guard has to be applied here too.
python3 /opt/libsidplayfp-wasm/scripts/apply-thread-guards.py "${RESIDFP_BUILD_ROOT}"

# Diagnostic knob: e.g. SIDFLOW_EXTRA_FLAGS="-fsanitize=address" instruments the
# whole stack so an out-of-bounds access inside the emulation is reported with a
# stack trace instead of showing up as mysteriously wrong audio.
EXTRA_FLAGS="${LIBSIDPLAYFP_WASM_EXTRA_FLAGS:-${SIDFLOW_EXTRA_FLAGS:-}}"
if [[ -n "${EXTRA_FLAGS}" ]]; then
    echo "extra build flags: ${EXTRA_FLAGS}"
fi

# Exception ABI.
#
# -fwasm-exceptions uses the native WebAssembly exception-handling proposal
# (Chrome 95+, Firefox 100+, Safari 15.2+, Node 18+). The alternative,
# -sDISABLE_EXCEPTION_CATCHING=0, selects emscripten's *JavaScript* exception
# ABI, which wraps every call that might unwind in an invoke_* trampoline —
# the audio hot path included.
#
# Compiling upstream without either flag is not a neutral choice: its internal
# try/catch blocks are then compiled not to catch, so a parse error that
# libsidplayfp handles and reports through its status escapes to JavaScript as
# an opaque exception instead.
#
# It has to be identical for libresidfp, libsidplayfp and the bindings, because
# mixing the two ABIs across a static archive does not link. Hence one variable
# applied to all three. LIBSIDPLAYFP_WASM_LEGACY_EH=1 selects the JavaScript ABI
# for a runtime that predates the proposal.
if [[ "${LIBSIDPLAYFP_WASM_LEGACY_EH:-0}" == "1" ]]; then
    EH_FLAGS="-sDISABLE_EXCEPTION_CATCHING=0"
else
    EH_FLAGS="-fwasm-exceptions"
fi
echo "exception ABI: ${EH_FLAGS}"

autoreconf -vfi
emconfigure ./configure \
    --prefix="${SYSROOT_PREFIX}" \
    --disable-shared \
    --enable-static \
    --disable-dependency-tracking \
    CFLAGS="-O3 ${EXTRA_FLAGS}" \
    CXXFLAGS="-O3 ${EH_FLAGS} ${EXTRA_FLAGS}"
# libresidfp's configure hard-codes `-ffast-math -fno-unsafe-math-optimizations`
# into RESIDFP_CXXFLAGS (configure.ac), and appends them after any value passed
# in, so they cannot be overridden on the configure line. Rewriting the
# generated Makefile is the only way to vary them, which makes this the knob for
# investigating any suspected floating-point divergence from a native build.
RESIDFP_MATH_FLAGS="${LIBSIDPLAYFP_WASM_RESIDFP_MATH_FLAGS:-${SIDFLOW_RESIDFP_MATH_FLAGS:-}}"
if [[ -n "${RESIDFP_MATH_FLAGS}" ]]; then
    echo "overriding libresidfp math flags: ${RESIDFP_MATH_FLAGS}"
    find . -name Makefile -exec sed -i "s|^RESIDFP_CXXFLAGS = .*|RESIDFP_CXXFLAGS = ${RESIDFP_MATH_FLAGS}|" {} +
fi

emmake make -j"$(nproc)"
emmake make install

export PKG_CONFIG_PATH="${SYSROOT_PREFIX}/lib/pkgconfig${PKG_CONFIG_PATH:+:${PKG_CONFIG_PATH}}"

if ! pkg-config --exists libresidfp; then
    echo "libresidfp was built but pkg-config cannot see it in ${PKG_CONFIG_PATH}" >&2
    exit 1
fi
echo "pkg-config sees libresidfp $(pkg-config --modversion libresidfp)"

# ---------------------------------------------------------------------------
# 2. Cross-compile libsidplayfp against it.
# ---------------------------------------------------------------------------
sync_repo "${GIT_URL}" "${CACHE_REPO}" "${LIBSIDPLAYFP_REF}" "${LIBSIDPLAYFP_COMMIT}"
echo "libsidplayfp upstream pinned at ${LIBSIDPLAYFP_REF} ($(git -C "${CACHE_REPO}" rev-parse --short HEAD))"

rsync -a --delete "${CACHE_REPO}/" "${BUILD_ROOT}/"

cd "${BUILD_ROOT}"

git submodule update --init --recursive

python3 /opt/libsidplayfp-wasm/scripts/apply-thread-guards.py "${BUILD_ROOT}"
python3 /opt/libsidplayfp-wasm/scripts/apply-sid-write-hook.py "${BUILD_ROOT}"

if grep -q 'AC_MSG_ERROR("pthreads not found")' configure.ac; then
    sed -i 's/AX_PTHREAD(\[\], \[AC_MSG_ERROR("pthreads not found")\])/AX_PTHREAD([], [])/' configure.ac
fi

autoreconf -vfi

emconfigure ./configure \
    --disable-shared \
    --enable-static \
    --without-gcrypt \
    --without-exsid \
    --without-usbsid \
    --disable-dependency-tracking \
    CFLAGS="-O3 ${EXTRA_FLAGS}" \
    CXXFLAGS="-O3 ${EH_FLAGS} ${EXTRA_FLAGS}" \
    RESIDFP_CFLAGS="$(pkg-config --cflags libresidfp)" \
    RESIDFP_LIBS="$(pkg-config --libs libresidfp)"

# configure only warns when libresidfp is missing, so assert the result rather
# than discovering it later in `strings` output.
if ! grep -q '^#define HAVE_RESIDFP 1' src/config.h 2>/dev/null && \
   ! grep -q '^#define HAVE_RESIDFP 1' config.h 2>/dev/null; then
    echo "configure did not define HAVE_RESIDFP — libsidplayfp would build without reSIDfp" >&2
    exit 1
fi
echo "HAVE_RESIDFP is defined; libsidplayfp will build the reSIDfp builder"

emmake make -j"$(nproc)"

cp /opt/libsidplayfp-wasm/src/bindings/bindings.cpp "${BUILD_ROOT}/"

PACKAGE_VERSION="$(node -p "require('/opt/libsidplayfp-wasm/package.json').version")"

# Emscripten turns assertions off at -O3 for a reason: they cost a check on
# every runtime call. LIBSIDPLAYFP_WASM_DEBUG=1 selects the diagnostic build
# without editing this file.
if [[ "${LIBSIDPLAYFP_WASM_DEBUG:-0}" == "1" ]]; then
    echo "building the diagnostic (assertions on) artifact"
    OPTIMISATION_FLAGS=(-sASSERTIONS=2 -O1 -g2)
else
    OPTIMISATION_FLAGS=(-sASSERTIONS=0 -O3)
fi

# Link one engine, prove it is the engine it claims to be, prove it renders, and
# emit the artifact's metadata beside it.
link_engine() {
    local engine="$1" output_root="$2"
    mkdir -p "${output_root}"
    echo "=== linking ${engine} into ${output_root} ==="

    local engine_flags=()
    if [[ "${engine}" == "sidlite" ]]; then
        engine_flags=(-DSIDFLOW_SID_ENGINE_SIDLITE=1)
    fi

    em++ bindings.cpp src/.libs/libsidplayfp.a \
        "${engine_flags[@]}" \
        -I./src \
        -I./src/sidplayfp \
        -I./src/sidtune \
        -I./src/builders/sidlite-builder \
        -I./src/builders/residfp-builder \
        $(pkg-config --cflags libresidfp) \
        $(pkg-config --libs libresidfp) \
        ${EXTRA_FLAGS} \
        --bind \
        ${EH_FLAGS} \
        "${OPTIMISATION_FLAGS[@]}" \
        -sMODULARIZE=1 \
        -sEXPORT_NAME="createLibsidplayfp" \
        -sEXPORT_ES6=1 \
        -sALLOW_MEMORY_GROWTH=1 \
        -sFORCE_FILESYSTEM=1 \
        -sENVIRONMENT=web,worker,node \
        -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='[$ccall,$cwrap]' \
        -sEXPORTED_RUNTIME_METHODS='[FS,PATH,cwrap,ccall]' \
        -o "${output_root}/libsidplayfp.js"

    # An artifact can end up as SIDLite whenever HAVE_RESIDFP is undefined, and
    # nothing about the build output says so. Check the built binary, not the
    # build inputs, so the claim is about what shipped.
    #
    # Materialise the symbol dump first: piping `strings` into `grep -q` makes
    # grep exit on the first match, which SIGPIPEs strings, which under
    # `set -o pipefail` reports the pipeline as failed even though it matched.
    local symbols want unwanted
    symbols=$(strings "${output_root}/libsidplayfp.wasm")
    if [[ "${engine}" == "residfp" ]]; then
        want="WasmReSIDfp"; unwanted="WasmSIDLite"
    else
        want="WasmSIDLite"; unwanted="WasmReSIDfp"
    fi
    if ! grep -q "${want}" <<<"${symbols}"; then
        echo "ARTIFACT CHECK FAILED: libsidplayfp.wasm does not contain ${want}" >&2
        exit 1
    fi
    if grep -q "${unwanted}" <<<"${symbols}"; then
        echo "ARTIFACT CHECK FAILED: libsidplayfp.wasm also contains ${unwanted}; the artifact is not a pure ${engine} build" >&2
        exit 1
    fi
    echo "artifact check: ${engine} confirmed (${want}), ${unwanted} absent"

    # A strings check proves what was linked, not that it works. reSIDfp's
    # filter-table threads can throw at load time in exactly this configuration,
    # producing an artifact that passes every static check and emits no samples.
    node /opt/libsidplayfp-wasm/scripts/smoke-render.mjs "${output_root}" /opt/libsidplayfp-wasm/test-tone-c4.sid

    # The GPL text that governs the binary, alongside the notices for the
    # third-party components compiled into it and the changes made to upstream.
    # Every directory that carries a .wasm carries these too, so an artifact
    # copied out of the package on its own is still compliant.
    cp COPYING "${output_root}/LICENSE"
    cp /opt/libsidplayfp-wasm/THIRD-PARTY-NOTICES.md "${output_root}/THIRD-PARTY-NOTICES.md"
    cp /opt/libsidplayfp-wasm/MODIFICATIONS.md "${output_root}/MODIFICATIONS.md"

    # Record exactly which upstream commits this binary was built from, beside
    # the binary itself, so the corresponding source is identifiable from the
    # artifact alone.
    node -e '
const { writeFileSync, readFileSync } = require("node:fs");
const [target, upstreamPath, version] = process.argv.slice(1);
const upstream = JSON.parse(readFileSync(upstreamPath, "utf8"));
writeFileSync(target, `${JSON.stringify({
  package: "@chrisgleissner/libsidplayfp-wasm",
  version,
  libsidplayfp: upstream.libsidplayfp,
  libresidfp: upstream.libresidfp,
  note: "Complete corresponding source: see THIRD-PARTY-NOTICES.md.",
}, null, 2)}\n`);
' "${output_root}/UPSTREAM.json" /opt/libsidplayfp-wasm/upstream.json "${PACKAGE_VERSION}"

    # The artifact's package metadata, type surface and README come from
    # checked-in files, so the public contract is reviewed alongside bindings.cpp
    # instead of living in an un-type-checked heredoc. The version is read from
    # the real package.json.
    node -e '
const { writeFileSync } = require("node:fs");
const [target, version] = process.argv.slice(1);
writeFileSync(target, `${JSON.stringify({
  // Scoped and private: this manifest exists only so Node treats the sibling
  // .js as ESM and resolves its types. It is not a publishable package, and an
  // unscoped "libsidplayfp-wasm" here would read as an official upstream build.
  name: "@chrisgleissner/libsidplayfp-wasm-artifact",
  version,
  private: true,
  description: "Build artifact of @chrisgleissner/libsidplayfp-wasm. Not an official libsidplayfp release.",
  type: "module",
  main: "./libsidplayfp.js",
  module: "./libsidplayfp.js",
  types: "./libsidplayfp.d.ts",
  sideEffects: false,
}, null, 2)}\n`);
' "${output_root}/package.json" "${PACKAGE_VERSION}"

    cp /opt/libsidplayfp-wasm/src/bindings/libsidplayfp.d.ts "${output_root}/libsidplayfp.d.ts"
    cp /opt/libsidplayfp-wasm/src/bindings/ARTIFACT.md "${output_root}/README.md"
}

if [[ "${SID_ENGINE}" == "both" ]]; then
    link_engine residfp "${OUTPUT_ROOT}"
    link_engine sidlite "${OUTPUT_ROOT}/sidlite"
else
    link_engine "${SID_ENGINE}" "${OUTPUT_ROOT}"
fi

rm -rf "${BUILD_ROOT}"
