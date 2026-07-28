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
  const pcm = player.render(100_000);
} finally {
  player.delete();
}
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

## C64 ROMs

Correct RSID/BASIC playback requires KERNAL (8 KiB), BASIC (8 KiB), and CHARGEN
(4 KiB) ROMs. They are not distributed with this package. Supply legally obtained
images through `player.setSystemROMs(kernal, basic, chargen)` or the corresponding
`SidAudioEngine` API.

## Verification and releases

Every release is built from exact `libsidplayfp` and `libresidfp` tags. CI checks
the public API, clean packed package, browser loader, invalid SID handling, engine
identity, repeated lifecycle operations, and real HVSC 85 playback. It compares
both WASM engines against native builds across a deterministic edge corpus before
publishing npm and GitHub Package versions or release assets.

Production TypeScript line coverage is required to remain at or above 95% locally,
in GitHub Actions, and in Codecov. Browser playback runs across desktop Chromium,
Firefox, and WebKit plus Chromium configured as a Pixel 5 viewport.
Every change also exercises concurrent players sharing each engine module. The
weekly Actions soak renders two virtual hours per engine and requires the WASM
linear heap to remain stable after warm-up; `bun run test:soak` runs the
30-minute local qualification interval.

The HVSC test corpus is downloaded once to `.cache/hvsc-85` (or
`LIBSIDPLAYFP_WASM_HVSC_CACHE`) and integrity-checked before use. It is never
included in the npm package. Playback tests also obtain checksum-pinned VICE
ROMs from `libretro/vice-libretro` into `.cache/vice-c64-roms`; those ROMs are
test-only, never committed, and never included in a release.

## License

GPL-2.0-or-later. The package includes modified libsidplayfp and libresidfp builds;
their source pins, build scripts, and license are included in this repository.
