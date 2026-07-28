# libsidplayfp WASM

[![npm](https://img.shields.io/npm/v/@chrisgleissner/libsidplayfp-wasm.svg)](https://www.npmjs.com/package/@chrisgleissner/libsidplayfp-wasm)
[![Build](https://img.shields.io/github/actions/workflow/status/chrisgleissner/libsidplayfp-wasm/ci.yaml)](https://github.com/chrisgleissner/libsidplayfp-wasm/actions/workflows/ci.yaml)
[![Codecov](https://codecov.io/gh/chrisgleissner/libsidplayfp-wasm/graph/badge.svg)](https://app.codecov.io/gh/chrisgleissner/libsidplayfp-wasm)
[![License: GPL v2 or later](https://img.shields.io/badge/License-GPL%20v2%2B-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Runtime](https://img.shields.io/badge/runtime-Browser%20%7C%20Node.js%20%7C%20Bun-forestgreen)](https://github.com/chrisgleissner/libsidplayfp-wasm#browsers-and-bundlers)

Play Commodore 64 SID music in the browser, Node.js, or Bun.

This is [libsidplayfp](https://github.com/libsidplayfp/libsidplayfp) — the
reference C64 SID player — compiled to WebAssembly, with TypeScript types and a
`SidAudioEngine` wrapper. Both SID emulations ship in every release, and each
build is compared sample-for-sample against a native build of the same source
before it is published.

```bash
npm install @chrisgleissner/libsidplayfp-wasm
```

## Play a SID

```ts
import { SidAudioEngine } from "@chrisgleissner/libsidplayfp-wasm";

const engine = new SidAudioEngine();
await engine.loadSidBuffer(new Uint8Array(sidFileBytes));

const pcm = await engine.renderSeconds(60); // interleaved 16-bit stereo PCM
engine.dispose();
```

`renderSeconds` returns a plain `Int16Array` you own. To stream instead of
rendering ahead, pull fixed-size blocks:

```ts
const block = await engine.renderFrames(4096); // 4096 frames, interleaved
```

Subtunes, seeking, and metadata:

```ts
const info = engine.getTuneInfo();       // songs, chips, clock, format, infoStrings…
await engine.selectSong(2);              // 0-based; clamped to the tune's range
await engine.seekSeconds(30);            // repositions playback, not just the counter
engine.getTimeMs();                      // libsidplayfp's own playback clock
engine.getTuneMd5();                     // key into HVSC Songlengths.md5
```

Call `dispose()` when finished. It deletes the underlying C++ object, which is
not garbage collected, and drops the reference to the WebAssembly heap so it
becomes collectable.

## Shaping the sound

A SID sounds different depending on the machine it is played back on. All of
libsidplayfp's emulation settings are available:

```ts
await engine.setEmulationConfig({
  c64Model: "NTSC",      // PAL | NTSC | OLD_NTSC | DREAN | PAL_M
  forceC64Model: true,   // ignore what the tune's header claims
  sidModel: "MOS8580",   // MOS6581 | MOS8580 — audibly very different chips
  forceSidModel: true,
  digiBoost: true,       // improves 8580 digi playback
});
```

Per-voice control and register read-back, for players and visualisers:

```ts
engine.mute(0, 2, true);            // silence voice 3 of the first chip
engine.setFilterEnabled(0, false);  // bypass its analogue filter
engine.getSidStatus(0);             // Uint8Array(32) of live register values
engine.getInstalledSids();          // 1, 2 or 3 for multi-SID tunes
```

The reSIDfp engine additionally models the analogue filter closely enough that
you can tune it toward a particular physical chip:

```ts
if (engine.supportsFilterConfig()) {
  engine.setFilterConfig({
    filter6581Curve: 0.5,         // 0.0 (dark) .. 1.0 (bright)
    filter6581Range: 0.5,
    old6581Caps: true,            // the leakier original capacitors
    combinedWaveforms: "AVERAGE", // AVERAGE | WEAK | STRONG
  });
}
```

> `filter6581Range` and `old6581Caps` are process-global inside reSIDfp: they
> reach a shared model through static methods, so they affect every player in
> the same WebAssembly instance. The rest are per chip.

## Engines

Both ship in every release; pick per instance.

| Engine  | Select with | Use it for |
| ------- | ----------- | ---------- |
| SIDLite | `"sidlite"` | The default. Fast, clean playback and bulk corpus work. |
| reSIDfp | `"residfp"` | Cycle-accurate reference fidelity and filter tuning. |

```ts
const reference = new SidAudioEngine({ engine: "residfp" });
```

`LIBSIDPLAYFP_WASM_ENGINE` sets a process-wide default; an explicit `engine`
option always wins.

## Lower-level access

The default export gives you libsidplayfp's `SidPlayerContext` directly. It is
the same object `SidAudioEngine` drives, minus the buffer management.

```ts
import loadLibsidplayfp from "@chrisgleissner/libsidplayfp-wasm";

const module = await loadLibsidplayfp({ engine: "residfp" });
const player = new module.SidPlayerContext();
try {
  player.configure(48_000, true);
  player.loadSidBuffer(new Uint8Array(sidFileBytes));
  // render() returns a view into WebAssembly memory: the next render()
  // overwrites it and a heap growth detaches it. Copy before doing anything else.
  const pcm = player.render(100_000).slice();
} finally {
  player.delete(); // WebAssembly objects are not garbage collected
}
```

`SidAudioEngine` copies for you; the transient-buffer contract applies only
here.

## Browsers and bundlers

The loader finds its `.wasm` beside its JavaScript. If your bundler relocates
static assets, say where they went:

```ts
const module = await loadLibsidplayfp({
  locateFile: (asset) => `/wasm/${asset}`,
});
```

Copy both `dist/libsidplayfp.*` and `dist/sidlite/libsidplayfp.*` if your users
can choose an engine. In Node-like runtimes `LIBSIDPLAYFP_WASM_PATH` overrides
the binary path.

The binaries use [WebAssembly exception
handling](https://webassembly.org/features/), so they need a runtime that
supports it. Every browser Playwright ships is verified on each commit, and the
packed package is installed and made to play a SID under **Node 20, 22 and 24**
on every commit. Bun works too — the test suite runs on it.

## C64 ROMs

Tunes that run as real C64 programs — RSID, and anything driven by interrupts or
BASIC — need the KERNAL, BASIC, and CHARGEN ROMs. Without them libsidplayfp
initialises the tune but never advances it, so it renders as silence or a single
held frame.

Those ROMs are copyrighted and are not distributed here. Supply legally obtained
images (KERNAL 8 KiB, BASIC 8 KiB, CHARGEN 4 KiB) and confirm they took effect:

```ts
await engine.setSystemROMs(kernal, basic, chargen);
engine.getRomStatus(); // { requested: true, active: true, … }
```

## Which libsidplayfp am I getting?

The package version and the libsidplayfp version inside it are related but not
always identical, so the build states what it contains:

```ts
import { LIBSIDPLAYFP_VERSION, LIBRESIDFP_VERSION } from "@chrisgleissner/libsidplayfp-wasm";
```

While this distribution settles, the package keeps its own `0.x` line: an
upstream engine bump takes a minor, a fix of our own takes a patch.

It will then switch to mirroring upstream, where a release that only advances
libsidplayfp carries upstream's exact version — `v3.0.2` publishes as `3.0.2`.
Because semver has no version between `3.0.2` and `3.0.3`, a fix to *this*
package takes the next free patch and keeps the same upstream pin, and a mirror
steps over any number already used:

| Version | Contains libsidplayfp | |
| ------- | --------------------- | --- |
| `3.0.2` | `v3.0.2` | exact mirror |
| `3.0.3` | `v3.0.2` | a fix here; upstream unchanged |
| `3.0.4` | `v3.0.3` | mirror, one ahead because `3.0.3` was used |
| `3.1.0` | `v3.1.0` | exact again — drift closes at every upstream minor |

The exported constants are always exact, whichever scheme is in force.

## How releases are verified

An emulator can produce plausible-sounding audio while being subtly wrong, so
correctness here is established by comparison against a reference rather than by
listening.

**On every commit**

- The full unit suite, with **100% line coverage** on production
  TypeScript, enforced locally, in CI, and on Codecov.
- **Native differential parity.** Both engines are compared sample-for-sample
  against a *native* build of libsidplayfp at the identical pinned source
  commit, over 29 tunes selected from HVSC #85, two seconds each. SIDLite
  matches bit for bit. reSIDfp stays above 0.99999 correlation with an error
  floor of −81 to −90 dBFS, which is below the SID's own noise floor and comes
  from a 1-ULP disagreement between C libraries in the filter-model tables.
- **Browsers**, via Playwright: Chromium and Firefox on the desktop, Chromium
  emulating a Pixel 5, and WebKit emulating an iPhone 13 — 7 tests each, both
  engines, including playback from module workers and two workers rendering
  concurrently.
- **Determinism**: the same tune renders identically on repeat and at any chunk
  size, so output never depends on how a host happens to pull audio.
- The packed npm tarball is installed into an empty project and made to play a
  SID through both engines and both public entry points.

**On every release, additionally**

- The unit suite three consecutive times.
- An **edge-case sweep**: 1,678 tunes selected from HVSC #85's 61,157, loaded
  and rendered through both engines, then compared against native builds. The
  selection takes *every* file in the categories most likely to break a player —
  all 364 multi-SID tunes, all 589 BASIC-driven RSIDs, all 76 with 32 or more
  subtunes — plus 400 each sampled evenly across the 3,924 RSID and 4,035
  zero-play-address files. Each is rendered for a fraction of a second, so this
  is a broad load-and-progress check rather than full playback of each tune.
- Both engines rebuilt from immutable upstream commits. The build aborts if an
  upstream tag no longer resolves to the commit this repository pins.
- Each binary is checked to contain the engine it claims and not the other one.
- After publishing, that exact version is **reinstalled from npm** into an empty
  directory and made to play a SID. The git tag and GitHub release are created
  only if that succeeds.

A weekly soak renders two hours of emulated playback per engine and requires the
WebAssembly heap to stay flat afterwards, so long-running players do not leak.

Every release ships a CycloneDX SBOM, SHA-256 checksums, and build provenance
attestation.

## Licence and attribution

GPL-2.0-or-later, the same as libsidplayfp.

The distributed `.wasm` binaries are object code covered by the GPL. They also
incorporate MIT-licensed components (Cra3z's `hashlib`, which provides the MD5
behind `getTuneMd5()`; musl; the Emscripten runtime) and LLVM runtime libraries
under Apache-2.0 with LLVM Exceptions.

* [`LICENSE`](LICENSE) — the GPL-2.0 text.
* [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — every component compiled
  into the binaries, with its licence and copyright.
* **`dist/complete-source.tar.gz`, inside this package** — the complete
  corresponding source for the binaries: both upstream projects at their exact
  pinned commits, the modifications applied to them, the bindings, and the
  build. The same archive is attached to every GitHub release.
* [`MODIFICATIONS.md`](MODIFICATIONS.md) — what this project changes in
  libsidplayfp and libresidfp before compiling them. Nothing there alters the
  emulation; the audio path is upstream's own.

`upstream.json`, the exported `UPSTREAM_COMMITS`, and the `UPSTREAM.json` file
beside each artifact record the exact commits a given binary was built from.

**This is an independent redistribution.** It is not an official libsidplayfp,
libresidfp, or SIDLite product, and it is not endorsed by or affiliated with
their authors. Report problems here, not upstream — unless a native sidplayfp
reproduces the same behaviour, in which case upstream is the right place.

No Commodore 64 ROMs, SID tunes, or music corpora are distributed. See
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md#not-distributed).

Contributing? See [`AGENTS.md`](AGENTS.md).
