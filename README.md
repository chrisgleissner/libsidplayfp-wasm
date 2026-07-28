# libsidplayfp WASM

[![npm](https://img.shields.io/npm/v/@chrisgleissner/libsidplayfp-wasm.svg)](https://www.npmjs.com/package/@chrisgleissner/libsidplayfp-wasm)
[![Build](https://img.shields.io/github/actions/workflow/status/chrisgleissner/libsidplayfp-wasm/ci.yaml)](https://github.com/chrisgleissner/libsidplayfp-wasm/actions/workflows/ci.yaml)
[![Codecov](https://codecov.io/gh/chrisgleissner/libsidplayfp-wasm/graph/badge.svg)](https://app.codecov.io/gh/chrisgleissner/libsidplayfp-wasm)
[![License: GPL v2 or later](https://img.shields.io/badge/License-GPL%20v2%2B-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Runtime](https://img.shields.io/badge/runtime-Browser%20%7C%20Node.js%20%7C%20Bun-forestgreen)](https://github.com/chrisgleissner/libsidplayfp-wasm#browser-assets)

`@chrisgleissner/libsidplayfp-wasm` is a verified WebAssembly distribution of
[libsidplayfp](https://github.com/libsidplayfp/libsidplayfp), a Commodore 64 SID
music player. It includes the WASM binaries and the TypeScript loader and
`SidAudioEngine` wrapper needed to use them in Node.js, Bun, or a browser.

## Install

```bash
npm install @chrisgleissner/libsidplayfp-wasm
```

The package is also available from GitHub Packages. Configure its registry before
installing from there:

```ini
@chrisgleissner:registry=https://npm.pkg.github.com
```

## Play a SID

```ts
import { SidAudioEngine } from "@chrisgleissner/libsidplayfp-wasm";

const engine = new SidAudioEngine({ engine: "sidlite" });
await engine.loadSidBuffer(new Uint8Array(sidFileBytes));
const pcm = await engine.renderSeconds(60); // Interleaved 16-bit PCM
engine.dispose();
```

For direct control, the default export creates an embind module with
`SidPlayerContext`. Contexts must be explicitly deleted.

```ts
import loadLibsidplayfp from "@chrisgleissner/libsidplayfp-wasm";

const module = await loadLibsidplayfp({ engine: "residfp" });
const player = new module.SidPlayerContext();
try {
  player.configure(48_000, true);
  player.loadSidBuffer(new Uint8Array(sidFileBytes));
  player.selectSong(0);
  // render() returns a view into WASM memory: the next render() overwrites it,
  // and a heap growth detaches it. Copy before doing anything else.
  const pcm = player.render(100_000).slice();
} finally {
  player.delete();
}
```

`SidAudioEngine` copies for you; the transient-buffer contract applies only to
the module's own `render()`.

## Emulation control

The full `SidConfig` surface is available, so a tune can be rendered as the
machine it was written for:

```ts
await engine.setEmulationConfig({
  c64Model: "NTSC",      // PAL | NTSC | OLD_NTSC | DREAN | PAL_M
  forceC64Model: true,
  sidModel: "MOS8580",   // MOS6581 | MOS8580
  forceSidModel: true,
  digiBoost: true,       // 8580 digi playback
  powerOnDelay: 8191,    // <= 8191 is deterministic, 8192 randomises
});
```

reSIDfp additionally exposes the analogue tuning that makes one 6581 sound
unlike another. The SIDLite artifact has no equivalent and rejects these, so
check `engine.supportsFilterConfig()` first.

```ts
engine.setFilterConfig({
  filter6581Curve: 0.5,         // 0.0 .. 1.0
  filter6581Range: 0.5,
  filter8580Curve: 0.5,
  old6581Caps: true,
  combinedWaveforms: "AVERAGE", // AVERAGE | WEAK | STRONG
});
```

Per-voice control, the playback clock, register read-back, and the HVSC
songlength key are all exposed:

```ts
engine.mute(0, 2, true);           // silence voice 3 of the first chip
engine.setFilterEnabled(0, false); // bypass its filter
engine.getTimeMs();                // libsidplayfp's own playback clock
engine.getSidStatus(0);            // Uint8Array(32), for visualisers
engine.getTuneMd5();               // key into HVSC Songlengths.md5
engine.getInstalledSids();         // chips actually instantiated
```

## Engines

Both engines ship in every package release.

| Engine  | Select with | Use case                                                |
| ------- | ----------- | ------------------------------------------------------- |
| SIDLite | `"sidlite"` | Default. Fast, clean everyday playback and corpus work. |
| reSIDfp | `"residfp"` | Cycle-accurate reference playback and audio comparison. |

`LIBSIDPLAYFP_WASM_ENGINE` can set a process-wide default. Passing `engine`
explicitly always wins. `SIDFLOW_SID_ENGINE` remains an alias for existing
SIDFlow callers. Each binary is checked to ensure it contains its requested
builder and not the other engine.

## Browser assets

The loader resolves its `.wasm` beside its JavaScript by default. When a bundler
relocates static assets, provide `locateFile`:

```ts
const module = await loadLibsidplayfp({
  locateFile: (asset) => `/wasm/${asset}`,
  engine: "sidlite",
});
```

Copy both `dist/libsidplayfp.*` and `dist/sidlite/libsidplayfp.*` when users can
choose engines. `LIBSIDPLAYFP_WASM_PATH` overrides the binary path in Node-like
runtimes; `SIDFLOW_LIBSIDPLAYFP_WASM_PATH` remains an alias.

The artifacts use the WebAssembly exception-handling proposal, so they need
Chrome 95+, Firefox 100+, Safari 15.2+, or Node 18+.

## C64 ROMs

Correct RSID/BASIC playback requires KERNAL (8 KiB), BASIC (8 KiB), and CHARGEN
(4 KiB) ROMs. They are not distributed with this package. Supply legally obtained
images through `player.setSystemROMs(kernal, basic, chargen)` or the corresponding
`SidAudioEngine` API, and confirm they took effect with `engine.getRomStatus()`.

## Versioning

The npm version and the libsidplayfp version inside a build are related but not
always identical. **`upstream.json` and the exported `LIBSIDPLAYFP_VERSION` are
the authority for what a build contains; the npm version never is.**

```ts
import { LIBSIDPLAYFP_VERSION, PACKAGE_VERSION } from "@chrisgleissner/libsidplayfp-wasm";
```

`upstream.json` carries a `versioning.mode` selecting one of two schemes.

**`independent` (current).** The package owns its own `0.x` semver while the
distribution settles. An upstream engine bump takes a minor release, a fix of our
own takes a patch. No claim is made about matching upstream's number.

**`mirror`.** A release that only advances upstream takes the pinned
libsidplayfp version verbatim — upstream `v3.0.2` publishes as `3.0.2`. A fix to
this repository's own code takes the next free patch and keeps the pin.

Semver has no version strictly between `3.0.2` and `3.0.3`, so a scheme that
always mirrors exactly cannot also ship downstream fixes. A prerelease such as
`3.0.3-1` sorts *below* `3.0.3` and is excluded from `^` ranges, so a fix
published that way would never reach anyone on `^3.0.2`. Downstream fixes
therefore consume real patch numbers, and a mirror steps over any number already
taken:

| npm version | libsidplayfp pin | What it is |
| ----------- | ---------------- | ---------- |
| `3.0.2`     | `v3.0.2`         | Mirror — exact match |
| `3.0.3`     | `v3.0.2`         | Our fix; upstream unchanged |
| `3.0.4`     | `v3.0.3`         | Mirror of `v3.0.3`; `3.0.3` was taken, so it runs one ahead |
| `3.1.0`     | `v3.1.0`         | Mirror — drift closes at every upstream minor or major |

Drift is bounded by the patch series and never accumulates across one, because
any upstream minor or major is above every patch below it.

`.github/workflows/upstream-watch.yaml` polls for stable upstream releases and
opens a pin-update PR; merging it starts the release qualification. Every rule
above lives in `scripts/upstream.mjs`, so no workflow derives a version by hand:

```bash
node scripts/upstream.mjs verify        # invariants; runs in CI and in preflight
node scripts/upstream.mjs bump          # downstream-only fix release
node scripts/upstream.mjs adopt-mirror  # leave 0.x, start mirroring upstream
```

## Verification and releases

Every release is built from exact `libsidplayfp` and `libresidfp` tags, and the
build aborts if a tag no longer resolves to the commit `upstream.json` pins.

The release pipeline is strictly ordered and each stage gates the next:

1. **Preflight** — the release commit's own `Verify` run must have concluded
   `success`, and the version must satisfy the rules above and be unpublished.
2. **Qualify** — rebuild both engines, then run the full unit suite three times,
   the 95% coverage gate, browser tests across Chromium (desktop and Pixel 5),
   Firefox, and WebKit, the clean-package check, the complete HVSC #85 edge
   sweep, and native differential parity for both engines.
3. **Publish** — npm via GitHub OIDC trusted publishing (no repository secret is
   involved) and GitHub Packages.
4. **Smoke** — install that version **from the registry** into an empty directory
   and play a SID through both engines and both entry points.
5. **Promote** — the git tag and GitHub release, only once the registry copy has
   proved itself.

npm versions are immutable and cannot be unpublished, so the guard is to smoke
test the exact bytes before they are published and the registry copy immediately
after. `latest` is not held back to do it: npm's OIDC credential authenticates
`npm publish` alone, so staging through a `next` dist-tag would reintroduce the
long-lived token this flow exists to avoid.

### One-time npm setup

npm cannot configure a trusted publisher for a package that does not exist yet,
so the very first release of a new package name needs one human step, run once
from a machine logged in to npm:

```bash
npm trust github @chrisgleissner/libsidplayfp-wasm \
  --repo chrisgleissner/libsidplayfp-wasm \
  --file release.yaml
```

After that every release authenticates through GitHub's OIDC token. No npm
credential is ever stored in the repository.

Production TypeScript line coverage is required to remain at or above 95%
locally, in GitHub Actions, and in Codecov. The weekly Actions soak renders two
virtual hours of playback per engine and requires the WASM linear heap to remain
stable after warm-up; `bun run test:soak` runs the 30-minute local qualification
interval.

The HVSC test corpus is downloaded once to `.cache/hvsc-85` (or
`LIBSIDPLAYFP_WASM_HVSC_CACHE`) and integrity-checked before use. It is never
included in the npm package. Playback tests also obtain checksum-pinned VICE
ROMs from `libretro/vice-libretro` into `.cache/vice-c64-roms`; those ROMs are
test-only, never committed, and never included in a release.

## License

GPL-2.0-or-later. The package includes modified libsidplayfp and libresidfp builds;
their source pins, build scripts, and license are included in this repository.
