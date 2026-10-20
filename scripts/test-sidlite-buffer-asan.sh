#!/usr/bin/env bash
# Real-input ASAN regression. Supply local HVSC and legal ROM directories.
# LIBSIDPLAYFP_WASM_TEST_UNPATCHED=1 restores upstream for the negative control.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# == 2 ]] || { echo "Usage: $0 <C64Music> <ROM directory>" >&2; exit 2; }
input="$1/MUSICIANS/A/Andy/Justincase_part_6.sid"
expected=c71f6df2c987f591dc82f61d8e69180c05229c7cce4bdc04c1c6474eecd5d68c
[[ "$(sha256sum "$input" | cut -d' ' -f1)" == "$expected" ]] || { echo "Regression input identity differs" >&2; exit 1; }
archive="$root/dist/complete-source.tar.gz"
[[ -f "$archive" ]] || { echo "Run bun run build first (complete-source archive missing)" >&2; exit 1; }
work=$(mktemp -d "$root/.cache/sidlite-asan.XXXXXX")
# Retain diagnostics and native artifacts locally; never include them in Git/npm.
echo "Native ASAN evidence: $work"
tar -xf "$archive" -C "$work"
archive_root=$(tar -tf "$archive" | awk 'NR == 1 { print $0 }')
source_dir="$work/${archive_root%/}/libsidplayfp"
if [[ "${LIBSIDPLAYFP_WASM_TEST_UNPATCHED:-0}" != 1 ]]; then
    python3 "$root/scripts/apply-sidlite-buffer-guards.py" "$source_dir"
    # Idempotency is part of the patch contract.
    python3 "$root/scripts/apply-sidlite-buffer-guards.py" "$source_dir"
fi
(
    cd "$source_dir"
    autoreconf -fi
    PKG_CONFIG_LIBDIR=/nonexistent ./configure --disable-shared --enable-static \
      --without-exsid --without-usbsid \
      CXXFLAGS="-O1 -g -fsanitize=address -fno-omit-frame-pointer"
    make -j7 src/builders/sidlite-builder/sidlite/libsidlite.la
    make -j7 src/builders/sidlite-builder/libsidplayfp-sidlite.la
    make src/psiddrv.bin src/sidtune/sidplayer1.bin src/sidtune/sidplayer2.bin
    make -j7 src/libsidplayfp.la
) > "$work/build.log" 2>&1
g++ -O1 -g -fsanitize=address -fno-omit-frame-pointer -std=c++17 \
  "$root/scripts/native-reference/sidlite-buffer-repro.cpp" \
  -I"$source_dir/src" "$source_dir/src/.libs/libsidplayfp.a" -o "$work/repro"
for rate in 8000 48000; do
    for pull in 256 20000; do
        echo "ASAN: $rate Hz, $pull scheduler events"
        "$work/repro" "$input" "$2" "$rate" "$pull"
    done
done
