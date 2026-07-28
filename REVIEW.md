# Adversarial review — `@chrisgleissner/libsidplayfp-wasm`

Reviewed commit: `3561b31` (`main`, the merge of PR #1), which declared version
`3.0.2`.
Upstream pins reviewed: libsidplayfp `v3.0.2` (`d7f7f0e7`), libresidfp `v1.1.2` (`a5cd8f24`).

Every claim below was reproduced locally against the checked-in artifacts, the
cached upstream sources in `.cache/upstream/repo`, or the emscripten toolchain in
`docker/`. Where a claim could not be reproduced it is recorded as **refuted**,
with the evidence.

Baseline before any change: `348 pass, 1 skip, 0 fail`, production TypeScript
line coverage `99.36% (619/623)`.

---

## 1. Verdict

The package is in far better shape than its size suggests. The build asserts
which emulation it linked, the mixer re-initialisation hazard is understood and
documented at the call site, the upstream patch scripts fail loudly rather than
silently no-op'ing, and the native differential parity gate is a genuinely strong
correctness authority — stronger than what most WASM audio wrappers ship.

The defects that remain cluster in three places:

1. **The TypeScript wrapper's seek/cache subsystem is partly non-functional.** It
   fails silently and no test observes the failure, because the tests assert
   return values rather than resulting audio position.
2. **The release pipeline has two paths that cannot have been executed** — the
   GitHub Packages publish and, structurally, any downstream-only fix.
3. **Roughly two thirds of libsidplayfp's public surface is not exposed.** For a
   package whose stated purpose is "a WebAssembly distribution of libsidplayfp",
   the missing parts (per-voice mute, playback clock, chip/model selection,
   register read-back, HVSC MD5) are the parts a SID player actually needs.

| Axis | Assessment |
| --- | --- |
| Correctness | 2 high-severity silent-wrong-answer bugs in `SidAudioEngine`; C++ core is sound |
| Deduplication | 6 real duplications; the public `.d.ts` is authored inside a bash heredoc |
| Performance | Release artifact built with debug-grade emscripten flags; trace export is O(n) across the JS boundary |
| Resiliency | Unbounded trace buffer; ambiguous `selectSong` failure signal; supply-chain pin is decorative |
| Feature exposure | Substantial gaps — see §6 |

---

## 2. Adjudication of the PR #1 review comments

PR #1 was merged before review. `kilo-code-bot` posted 4 CRITICAL and 3 WARNING
findings after the merge. Independently verified:

| # | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | `bindings.cpp:708` — `SidPlayerContext` "is exposed with no deleter"; `delete?.()` is always undefined and every context leaks | **Refuted** | embind synthesises `delete()`/`isDeleted()` on every `class_<>` binding via its `RegisteredPointer` base. Probed the shipped artifact: `typeof p.delete === "function"`, `typeof p.isDeleted === "function"`, and `p.isDeleted() === true` after `p.delete()`. `dist/libsidplayfp.d.ts` also declares it. No leak. |
| 2 | `soak.yaml:15` — `timeout-minutes: 50` kills the "two-hour" soak declared by `LIBSIDPLAYFP_WASM_SOAK_SECONDS: 7200` | **Refuted** | `LIBSIDPLAYFP_WASM_SOAK_SECONDS` is *virtual* playback seconds, not wall clock — the README and AGENTS.md both say "virtual". Measured: 600 virtual seconds × 2 engines = **41.5 s wall clock**, so 7200 s ≈ **8.5 minutes**, comfortably inside 50. |
| 3 | `release.yaml:199` — a legacy `NPM_TOKEN` in `.npmrc` conflicts with `--provenance` and fails with `EPUBLISH` | **Refuted as stated, but the step is broken for a different reason** | npm supports `--provenance` with token auth; the OIDC token is used for the attestation, not for registry auth, and `id-token: write` is granted. The real defect is [C3](#c3) below: `actions/setup-node` exports `NPM_CONFIG_USERCONFIG=$RUNNER_TEMP/.npmrc`, so the workflow's `printf … > "$HOME/.npmrc"` is read by nothing and the **GitHub Packages publish cannot authenticate**. |
| 4 | `realtime-playback.test.ts:152` — `expect(true).toBe(true)` + `return` passes for any zero-sample run | **Confirmed** | Verbatim. Fixed as [M8](#m8). Severity is low, not critical: the guard fires only when the tune produces no samples at all, which the surrounding suite would already catch. |
| 5 | `player.ts:299` — `romFailureLogged = false` sits after the early return, so a pre-context call permanently suppresses the warning | **Confirmed** | `src/player.ts:299` sets `romSupportDisabled`, returns at 304–306 when there is no context, and only resets `romFailureLogged` at 308. Fixed as [M4](#m4). |
| 6 | `player.ts:711` — `buildCacheBuffer` holds `chunks[]` *and* `combined`, peaking near 211 MiB at the 600 s default | **Confirmed** | 600 s × 44 100 × 2 ch × 2 B = 105.8 MiB, held twice at the join. Fixed as [P4](#p4). |
| 7 | `.codecov.yml` — missing `carryforward: true`/`flags` will fail the 95% patch gate on doc-only PRs | **Refuted** | `carryforward` applies to *flag-partitioned* uploads; this project makes a single unflagged upload covering all of `src/`. Codecov reports a patch with no coverable lines as passing. No change made. |

Net: **3 of 4 "CRITICAL" findings do not reproduce.** Two of them (the deleter
and the soak) are misreadings of, respectively, embind semantics and the
virtual-versus-wall-clock distinction that the README states explicitly. The
genuinely critical defects in this repository were not found by that review.

---

## 3. Correctness

### C1 — `seekSeconds()` overshoots its budget and lands ~15× short, silently &nbsp;·&nbsp; **High**

`src/player.ts:615` `fastForwardContext()` caps its render loop with

```ts
const maxIterations = Math.max(32, Math.ceil(targetSamples / cyclesPerChunk) * 4);
```

This divides **samples** by **cycles**. They are not the same quantity and the
ratio is not a constant: `Player::play()` clamps every call to `MAX_CYCLES`
(20 000), so one `render(100000)` advances ~20.3 ms of PAL time and returns
~1 790 stereo samples — not 100 000 of anything.

Reproduced on the shipped artifact:

```
seekSeconds(60) -> 348630 samples = 3.95s  (expected 60s = 5292000 samples)
shortfall factor: 15.2x
```

The method returns the short count as if it were the achieved position, so a
caller has no way to detect it. `renderFrames()` carries the same
dimensional error in `emptyReadLimit`, where it is currently harmless only
because the `Math.max(32, …)` floor dominates.

**Fix:** budget on samples actually skipped plus a consecutive-empty-read stall
detector, and drop the cycles-derived iteration count entirely.

### C2 — `seekSeconds()` is a no-op whenever a render cache exists &nbsp;·&nbsp; **High**

`useCachePlayback` and `cacheCursor` are assigned in five places
(`src/player.ts:550,551,561,562,567,654,655,759`) and **read in none**. The
cached branch of `seekSeconds()` sets them, returns a sample index, and leaves
the live `SidPlayerContext` exactly where it was. Every subsequent
`renderSeconds()`/`renderFrames()` therefore continues from the *unseeked*
position while the return value claims otherwise.

`test/player-lifecycle.test.ts:174-176` asserts only the returned integer, never
the audio that follows, so the suite is blind to it.

**Fix:** delete the dead cache-playback state and make `seekSeconds()`
authoritative on the live context in all cases. Mixing cached PCM (rendered by a
*second*, independently reset context in `buildCacheBuffer`) into the live
stream would splice two different emulation timelines anyway; the cache's honest
role is random-access waveform read-out through `getCachedSegment()`.

### C3 — GitHub Packages publish cannot authenticate <a id="c3"></a> &nbsp;·&nbsp; **High**

`.github/workflows/release.yaml:157` runs `actions/setup-node` with
`registry-url: https://registry.npmjs.org`. That action writes its `.npmrc` to
`$RUNNER_TEMP/.npmrc` and **exports `NPM_CONFIG_USERCONFIG` pointing at it**
(confirmed in `actions/setup-node`'s `authutil.ts`). The later step therefore
writes a file npm never reads:

```bash
printf '%s\n' "@chrisgleissner:registry=https://npm.pkg.github.com" \
  "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" > "$HOME/.npmrc"
```

`npm publish --registry=https://npm.pkg.github.com` then finds no
`//npm.pkg.github.com/:_authToken` and fails `ENEEDAUTH`. A secondary hazard on
the same file: setup-node writes the literal string `${NODE_AUTH_TOKEN}`, and
npm aborts with *"Failed to replace env in config"* on any command run in a step
that does not define that variable — which includes the artifact-verification
step's `npm install`.

This path has never run (no release has been published from this workflow), so
the failure is latent rather than observed.

**Fix:** stop letting setup-node own the config. Point `NPM_CONFIG_USERCONFIG`
at a workflow-managed file explicitly for each publish, and always define
`NODE_AUTH_TOKEN`.

### C3b — `npm publish` is handed a relative path npm reads as a GitHub repo &nbsp;·&nbsp; **High**

Run [30318872997](https://github.com/chrisgleissner/libsidplayfp-wasm/actions/runs/30318872997),
job `publish`, step *Publish verified tarball to npm with provenance*:

```
npm error code 128
npm error command git --no-replace-objects ls-remote \
    ssh://git@github.com/release/chrisgleissner-libsidplayfp-wasm-3.0.2.tgz.git
npm error git@github.com: Permission denied (publickey).
```

`TARBALL=$(find release -maxdepth 1 -name '*.tgz' …)` yields the **relative**
path `release/chrisgleissner-libsidplayfp-wasm-3.0.2.tgz`. npm's argument
parser treats any bare `foo/bar` argument as the GitHub `owner/repo` shorthand,
so it tried to clone a repository called `release/chrisgleissner-…tgz` instead
of publishing the file. Both publish steps and the artifact-verification step
share the bug.

**Fix:** resolve the tarball to an absolute path (or prefix `./`).

### C3c — The release path does not require the repository's own CI to be green &nbsp;·&nbsp; **High**

At `3561b31` the `Verify` workflow on `main` **failed**
([30318864721](https://github.com/chrisgleissner/libsidplayfp-wasm/actions/runs/30318864721))
while `Qualify and release` ran one minute later and proceeded all the way to
`npm publish`. Nothing links the two: `release.yaml` re-runs its own
qualification in a separate job and never consults the commit's CI status.

The `Verify` failure was itself infrastructural — a Docker Hub timeout pulling
`emscripten/emsdk:3.1.74`:

```
ERROR: failed to solve: DeadlineExceeded: emscripten/emsdk:3.1.74:
  failed to resolve source metadata … dial tcp 34.233.246.80:443: i/o timeout
```

so both a real regression *and* a flaky base-image pull can leave `main` red
while a release proceeds.

**Fix (three parts):**

1. Preflight refuses to release unless the `Verify` workflow concluded
   `success` for the exact commit being released.
2. The Docker base-image pull retries with backoff, so a registry hiccup does
   not red an otherwise good build.
3. **Publish to the `next` dist-tag, re-install the published package from the
   registry, smoke-test it, and only then promote it to `latest`.** npm
   versions are immutable, so the only way to make a bad publish harmless is to
   never let it become the default install. The same promotion gate runs for
   GitHub Packages, and the git tag and GitHub release are created only after
   the published artifact has proved itself.

### C4 — The "immutable commit" pin is never enforced &nbsp;·&nbsp; **High**

`upstream.json` records a 40-character commit for each dependency, `scripts/upstream.mjs`
validates its shape, and `AGENTS.md` calls it "the single source of truth …
immutable commits". The build does not use it:

```bash
# docker/entrypoint.sh
LIBSIDPLAYFP_REF="${LIBSIDPLAYFP_REF:-$(node "${UPSTREAM_SCRIPT}" get libsidplayfp.ref)}"
…
git -C "${dest}" fetch --tags origin
git -C "${dest}" checkout --force "${ref}"
```

Only the **tag** is used, and git tags are mutable. A force-pushed upstream tag
silently changes what this project ships, and the recorded commit — the thing
that would have caught it — is never compared. `upstream.mjs get
libsidplayfp.commit` exists and has no caller.

**Fix:** resolve and `git rev-parse --verify` the pinned commit for both
repositories and abort on mismatch.

### C5 — Versioning makes downstream fixes structurally impossible &nbsp;·&nbsp; **High**

`scripts/upstream.mjs update` sets `package.json.version = ref.slice(1)`, and
`release.yaml` preflight enforces `test "$VERSION" = "$PIN"`. The package version
is therefore *defined* as the upstream version, so there is no version number
available for a fix to this repository's own TypeScript, loader, bindings, or
packaging. See §7 for the replacement scheme.

### C6 — `render()` hands out a live view into WASM memory &nbsp;·&nbsp; **Medium**

`SidPlayerContext::render()` returns `emscripten::typed_memory_view(...)` over
`mixBuffer`. The returned `Int16Array` is a window onto the heap, not a copy: it
is clobbered by the next `render()`, and would be detached outright by a heap
growth. Measured:

```
chunk A buffer === chunk B buffer: true
A[0..5] before second render: -815,-815,-817,-817,-815,-815
A[0..5] after  second render: -16168,340,-16168,340,0,0
```

`SidAudioEngine` copies correctly (`renderCycles()` calls `.slice()`), but the
**documented public example does not**:

```ts
const pcm = player.render(100_000);   // README, "For direct control"
```

Neither `dist/libsidplayfp.d.ts` nor the README says the buffer is transient.
Zero-copy is the right default for a hot path; leaving it undocumented is not.

**Fix:** document it prominently on the binding, in the `.d.ts`, and in the
README example.

### C7 — `selectSong()` cannot report failure &nbsp;·&nbsp; **Low**

`bindings.cpp:329` returns `0U` for "no tune loaded", for "`player.load()`
failed", and for "song 0 selected successfully". A caller cannot distinguish
them; only `getLastError()` hints, and it is not cleared on success.

### C9 — Upstream is compiled with exception handling disabled, defeating its own error reporting &nbsp;·&nbsp; **High**

`docker/entrypoint.sh` configures libresidfp and libsidplayfp with
`CXXFLAGS="-O3"` and no exception flag, then links the bindings with
`-sDISABLE_EXCEPTION_CATCHING=0`. Compiling with neither `-fexceptions` nor
`-fwasm-exceptions` is not a neutral choice under emscripten: upstream's
`try`/`catch` blocks are compiled *not to catch*.

The observable consequence is in the existing test suite, which asserted it as
if it were the contract:

```ts
expect(() => context.loadSidBuffer(new Uint8Array(128))).toThrow();
```

libsidplayfp is designed to catch its own `loadError`, record it on the tune's
status, and let `SidTune::statusString()` explain it. With catching compiled
out, that `throw` instead unwound through `SidTuneBase::read` and out across the
WASM boundary as an opaque exception. Every malformed-input path in libsidplayfp
behaves this way, not just this one.

Building all three units with `-fwasm-exceptions` restores upstream's intended
behaviour — `loadSidBuffer` returns `false` and `getLastError()` explains why —
and is also the faster ABI, since the JavaScript ABI wraps every potentially
unwinding call site in an `invoke_*` trampoline.

Measured effect of the flag change alone, with native parity still green:

| Artifact | Before | After |
| --- | --- | --- |
| `libsidplayfp.js` | 143 943 B | 105 863 B (−26%) |
| `libsidplayfp.wasm` (reSIDfp) | 428 709 B | 360 296 B (−16%) |
| `libsidplayfp.wasm` (SIDLite) | 392 416 B | 319 941 B (−18%) |

### C10 — The engine glue and its binary are a matched pair, and a test mixed them &nbsp;·&nbsp; **Medium**

`test/index.test.ts` loaded the default module — SIDLite — and pointed
`locateFile` at `../dist/libsidplayfp.wasm`, the reSIDfp binary. The two glue
files are byte-identical, so this appeared to work; it is not valid, and the
rebuilt artifacts reject it:

```
BindingError: Cannot use deleted val. handle = 0
    at __emval_set_property
    at callRuntimeCallbacks
```

The test asserted only `expect(module).toBeDefined()`, so it had no way to
notice which binary it had loaded.

### C11 — reSIDfp filter tuning has two different scopes, and upstream does not say so &nbsp;·&nbsp; **Medium**

`ReSIDfpBuilder::filter6581Curve()`, `filter8580Curve()`, and
`combinedWaveformsStrength()` are applied per chip. `filter6581Range()` and
`enableOld6581caps()` are not — they reach `FilterModelConfig6581`, a
**singleton**, through `static` methods (`libresidfp/src/Filter6581.h:374`,
`:386`):

```cpp
static void setFilterRange(double adjustment)
{
    FilterModelConfig6581::getInstance()->setFilterRange(adjustment);
}
```

So those two settings apply to every SID instance sharing a WASM module,
including instances created before the call and instances belonging to other
`SidPlayerContext` objects. Nothing in reSIDfp's own API documentation
distinguishes them.

This is observable: a test that set them on the shared default module changed
the audio of every later reSIDfp render in the same process, which is how it was
found — four golden comparisons that pass in isolation failed in a full-suite
run. Both the binding and the `.d.ts` now state the scope, and the test that
exercises them takes its own module instance.

### C8 — `patchStartSong()` trusts unvalidated bytes &nbsp;·&nbsp; **Low**

`src/player.ts:223` rewrites offsets `0x10`/`0x11` of any buffer ≥ 0x12 bytes
without checking the `PSID`/`RSID` magic, then hands the mutated bytes to the
loader. A non-SID input produces a confusing downstream error rather than a
clear one. Separately, the wrapper changes subtune by *reloading and
re-initialising the whole tune* rather than calling the already-bound
`SidPlayerContext::selectSong()`, which is both slower and leaves that binding
dead on the wrapper path.

---

## 4. Deduplication

### D1 — The public `.d.ts` is authored inside a bash heredoc &nbsp;·&nbsp; **Medium**

`docker/entrypoint.sh:219-286` emits `libsidplayfp.d.ts` from a shell heredoc,
once per engine, so the type surface of the package exists as two generated
copies and one un-type-checked shell string. `src/index.ts` then imports its
types from `../dist/libsidplayfp.js` — i.e. `tsc` depends on the output of a
Docker build. The same heredoc pattern emits `dist/package.json` and
`dist/README.md`.

Consequences observed:

* `dist/package.json` declares `"version": "0.1.0"` and is shipped inside the
  npm tarball at every release.
* `dist/README.md` instructs the reader to look in `packages/libsidplayfp-wasm/`
  — a path from the SIDFlow monorepo that does not exist in this repository.
* Any binding added to `bindings.cpp` must be hand-mirrored into the heredoc,
  with no compiler to catch a mismatch.

**Fix:** make `src/bindings/libsidplayfp.d.ts` the single checked-in source and
have the build copy it.

### D2 — ROM failure handling duplicated verbatim &nbsp;·&nbsp; **Medium**

`src/player.ts:184-221` (`applySystemROMs`) and `src/player.ts:311-347`
(`setSystemROMs`) contain the same try / disable / warn-once / reset-to-built-in
sequence, differing only in which context object they touch. This is exactly
where finding [M4](#m4) hides.

### D3 — Four independent render loops

`src/player.ts:renderFrames`, `test/helpers/engine-fixtures.ts:renderWith`,
`scripts/smoke-render.mjs`, and `scripts/native-reference/render.cpp` each
re-implement "pull chunks until N samples, tolerate up to K empty reads". The
last one must stay separate (it is the native control), but the JS trio can
share one helper — and today they do not agree on the empty-read limit (64, 64,
and a computed value).

### D4 — CI and release workflows duplicate the whole toolchain block

`ci.yaml:20-63` and `release.yaml:60-110` repeat the same apt install, cache
restore, bun install, and dual-engine build with only the cache key differing.

### D5 — `docker/entrypoint.sh` and `scripts/build-native-reference.sh`

Both clone and build libresidfp + libsidplayfp at the same pins with the same
patch scripts. Divergence between them silently weakens the parity gate, which
`AGENTS.md` already flags as a manual-alignment obligation.

### D6 — SIDFlow naming throughout the extracted code

`SIDFLOW_USE_SIDLITE`, `SIDFLOW_ALLOW_SIDLITE`, `sidflow_sid_write_hook`,
`SidflowInlineThread`, `sidflow-libsidplayfp-wasm:latest`, `sidflow-parity-*`,
`SIDFLOW_RUN_WASM_PERF_TESTS`, `SIDFLOW_CHUNK_CYCLES`. The *public* aliases
(`SIDFLOW_SID_ENGINE`, `SIDFLOW_LIBSIDPLAYFP_WASM_PATH`) are deliberate
compatibility and should stay; the internal ones are extraction residue. Note
that `SIDFLOW_RUN_WASM_PERF_TESTS` is *undocumented* — see [P5](#p5).

---

## 5. Performance

### P1 — Release artifacts are built with debug-grade emscripten flags &nbsp;·&nbsp; **Medium**

`docker/entrypoint.sh:180-199` links every shipped artifact with:

* `-sASSERTIONS=1` — emscripten disables assertions at `-O3` by default; this
  re-enables per-call runtime checking in the production binary.
* `-sDISABLE_EXCEPTION_CATCHING=0` — selects the *JavaScript-based* exception
  ABI, which instruments every `invoke_*` call site. `-fwasm-exceptions` is the
  modern, far cheaper equivalent.
* `-sFORCE_FILESYSTEM=1` with `EXPORTED_RUNTIME_METHODS=[FS,PATH,cwrap,ccall]` —
  pulls the entire Emscripten FS layer into a browser bundle to support
  `loadSidFile(path)`, which no browser caller can use.

The result is a 144 KB glue file and a 429 KB `.wasm` where a chunk of both is
unreachable in the package's primary target.

### P2 — `getAndClearSidWriteTraces()` is O(n) across the JS boundary &nbsp;·&nbsp; **Medium**

`bindings.cpp:421` builds one `emscripten::val::object()` per trace record and
performs four `set()` calls on each. One minute of a typical tune is ~75 000
records → 300 000 individual cross-boundary property writes.

### P3 — `renderCycles()` copies unconditionally

Every chunk is `.slice()`d even when the caller consumes it immediately. Correct
given [C6](#c6), but it means `renderFrames` copies each chunk twice (into the
slice, then into the output buffer).

### P4 — Render cache peaks at 2× its own budget <a id="p4"></a>

`buildCacheBuffer()` accumulates `chunks[]` and then allocates `combined` before
releasing them — 211 MiB at the 600 s default, on a code path documented as
mobile-relevant.

### P5 — Performance assertions never run in CI <a id="p5"></a>

`test/performance.test.ts:18` gates every threshold behind
`SIDFLOW_RUN_WASM_PERF_TESTS === '1'`, which is set by no script, no workflow,
and no documentation. The file's 325 lines currently produce console output and
no verdict.

---

## 6. Feature exposure

The bindings expose 16 methods. Measured against libsidplayfp v3.0.2's public
headers, the following are absent. Grouped by what a SID player would actually
reach for:

**Playback control — `sidplayfp`**

| Missing | Why it matters |
| --- | --- |
| `mute(sidNum, voice, enable)` | Per-voice soloing/muting. The single most requested feature in SID front-ends. |
| `filter(sidNum, enable)` | Bypass the SID filter — standard A/B for 6581 filter emulation. |
| `time()`, `timeMs()` | Authoritative playback position. Callers currently count samples themselves. |
| `getSidStatus(sidNum, regs[32])` | Register read-back — the basis of every SID visualiser. |
| `installedSIDs()` | How many chips the loaded tune actually instantiated. |
| `getCia1TimerA()` | Real playback speed for CIA-timed tunes. |
| `getBufSize(cycles)` | Lets a host size its buffer exactly instead of guessing. |
| `debug(enable, out)` | CPU tracing. |

**Emulation configuration — `SidConfig`**

Every field except `frequency` is hard-coded in `SidPlayerContext::configure()`:
`defaultC64Model` / `forceC64Model` (PAL, NTSC, OLD_NTSC, DREAN, PAL_M),
`defaultSidModel` / `forceSidModel` (6581 vs 8580 — audibly enormous),
`ciaModel`, `digiBoost` (pinned `true`), `samplingMethod` (pinned
`RESAMPLE_INTERPOLATE`), `powerOnDelay` (pinned `MAX`), `secondSidAddress`,
`thirdSidAddress`.

Pinning `powerOnDelay` for determinism is a defensible default, but a *default*
is not the same as a hard-code — reproducing a specific machine's power-on state
is currently impossible.

**Tune metadata — `SidTuneInfo`**

`getSidChips()`, `getSidChipBase(i)`, `getSidModel(i)`, `getCompatibility()`,
`getSongSpeed()`, `getRelocStartPage()`, `getRelocPages()`, `getFixLoad()`.
`SidInfo::sidModel(i)` and `maxsids` are likewise absent.

**Tune identity — `SidTune`**

`createMD5New()` is the HVSC `Songlengths.md5` key. Without it a browser player
cannot look up song lengths — arguably *the* missing feature for this package's
audience. It needs no external dependency: libsidplayfp bundles its own MD5
(`src/libs/hashlib/md5.hpp`) and the build already passes `--without-gcrypt`.

**Emulation tuning — `ReSIDfpBuilder`**

`filter6581Curve()`, `filter6581Range()`, `filter8580Curve()`,
`enableOld6581caps()`, `combinedWaveformsStrength()`. These are the knobs that
make a 6581 sound like *a particular* 6581.

---

## 7. Resiliency

### R1 — The SID write trace buffer is unbounded &nbsp;·&nbsp; **Medium**

`SidWriteTraceBuilder::record()` pushes into a `std::vector` with no cap. A
caller that enables tracing and never drains it grows the WASM heap until
`abort()`. At ~1 250 records/second of playback this is a matter of minutes for
a long render.

Related: `cyclePhi1` is truncated from `long long` to `uint32_t`, so it wraps
after ~4 360 s of PAL playback (~73 minutes) with no indication.

### R2 — ROM failures are terminal and unobservable

`applySystemROMs()` sets `romSupportDisabled = true` on the first failure and
never re-enables it for that context, reporting only a `console.warn`. There is
no API to ask whether custom ROMs are in effect, so a host cannot tell whether
it is hearing a correct RSID render.

### R3 — Argument validation gaps

`configure(0, …)` is accepted. `renderSeconds(NaN)` passes the `<= 0` guard,
propagates NaN through `Math.max(1, NaN)`, and returns an empty array rather
than throwing. `cacheSecondsLimit` is unbounded.

### R4 — Inconsistent post-dispose behaviour

After `dispose()`, `getChannels()` throws, `renderSeconds()` returns an empty
array, and `getTuneInfo()` returns `null`. Three different signals for one state.

### R5 — `dist/.tsbuildinfo` is committed

A `tsc --build` cache in version control. Harmless but it churns on every build
and is not in `files`.

---

## 8. Versioning: the requirement the current design cannot meet

The stated goal is that a new upstream libsidplayfp release produces a
downstream release **with the same version number**, while still allowing this
repository to ship fixes of its own. Under semver those two requirements are in
direct tension: there is no version strictly between `3.0.2` and `3.0.3`, and
`3.0.2+rev1` (build metadata) has *equal* precedence to `3.0.2`, while
`3.0.3-1` (prerelease) is excluded from ordinary `^`/`~` ranges — so a fix
published that way would never reach a user on `^3.0.0`.

A literal fourth component is not an option. npm requires exactly three numeric
parts, and rejects the alternative outright:

```
$ npm publish --dry-run          # package.json version "3.0.2.1"
npm error Invalid version: "3.0.2.1"
```

The two semver-legal near-misses are worse than they look. `3.0.2+1` is build
metadata and has *equal* precedence to `3.0.2`, so which one a range resolves to
is undefined. `3.0.2-1` is a prerelease and sorts *below* `3.0.2`, and npm
excludes prereleases from `^`/`~` ranges entirely, so a fix published that way
never reaches a user on `^3.0.2`.

The scheme adopted therefore keeps the mirror exact and lets downstream
revisions consume real patch numbers, with the pin file rather than the version
string as the authority:

* **Mirror release.** The npm version equals the pinned libsidplayfp version
  exactly, whenever that number is still free. `3.0.2` ships libsidplayfp
  `v3.0.2`. This is the automated path.
* **Downstream fix release.** Takes the next free patch number and keeps the
  same upstream pin. A fix on top of upstream `3.0.2` publishes `3.0.3`, still
  pinning `v3.0.2`. Ordinary `^3.0.2` consumers receive it.
* **Collision.** If upstream later releases `v3.0.3` and that number is taken,
  the mirror moves to the next free patch (`3.0.4`). The version then runs ahead
  of upstream by the number of downstream fixes in that patch series.
* **Re-synchronisation.** Drift is bounded by the patch series: the next
  upstream minor or major (`3.1.0`, `4.0.0`) is above any `3.0.x`, so the mirror
  becomes exact again automatically.
* **Authority.** `upstream.json`, the exported `LIBSIDPLAYFP_VERSION` /
  `UPSTREAM_VERSIONS` constants, and the release title always name the exact
  libsidplayfp and libresidfp releases inside a build. The npm version is a
  convenience, never the source of truth.

Mirroring is deliberately not switched on yet. `upstream.json` carries a
`versioning.mode`, currently `independent`: the package owns a `0.x` line while
the distribution settles, an upstream bump takes a minor and a downstream fix
takes a patch, and no claim is made about matching upstream's number. `0.x` is
npm's convention for exactly this. Switching later is a single monotonic jump —
`node scripts/upstream.mjs adopt-mirror` — because any real libsidplayfp release
is above every `0.x` version, so it burns no upstream patch number.

Both modes are implemented in `scripts/upstream.mjs` (`plan`, `update`, `bump`,
`adopt-mirror`, `verify`), enforced by the release preflight and by CI, and
documented in `README.md`. The full lifecycle is exercised end to end:

```
$ node scripts/upstream.mjs adopt-mirror --published '["0.1.0","0.2.0"]'
Adopted mirror versioning at @chrisgleissner/libsidplayfp-wasm@3.0.2
$ node scripts/upstream.mjs bump --published '["0.1.0","0.2.0","3.0.2"]'
Downstream release @chrisgleissner/libsidplayfp-wasm@3.0.3, still pinning libsidplayfp v3.0.2
$ node scripts/upstream.mjs plan --ref v3.0.3 --published '[...,"3.0.3"]'
version=3.0.4  mirrors_upstream=false
$ node scripts/upstream.mjs plan --ref v3.1.0 --published '[...,"3.0.4"]'
version=3.1.0  mirrors_upstream=true
```

---

## 9. Remediation

Applied in the accompanying branch, in severity order:

| ID | Change |
| --- | --- |
| C1 | Sample-budgeted fast-forward with a stall detector; dimensional error removed from `renderFrames` too |
| C2 | Dead cache-playback state removed; `seekSeconds()` always positions the live context; test asserts audio position, not the return value |
| C3 | Explicit `NPM_CONFIG_USERCONFIG` per publish; `NODE_AUTH_TOKEN` always defined |
| C4 | `entrypoint.sh` verifies the pinned commit for both repositories |
| C5 | New versioning scheme (§8) with `upstream.mjs plan`/`bump`, preflight enforcement, and README documentation |
| C6 | Transient-buffer contract documented in the binding, the `.d.ts`, and the README example |
| C7 | `selectSong()` failure reported through `getLastError()` and a new `hasError()`; `lastError` cleared on success |
| C8 | PSID/RSID magic validated before header patching |
| D1 | `.d.ts`, `dist/package.json`, and `dist/README.md` moved out of the heredoc into checked-in sources |
| D2 | ROM failure handling extracted to one method |
| D3 | Shared JS chunk-pump helper |
| D4 | Composite action for the shared CI/release setup |
| P1 | `-sASSERTIONS=0`, `-fwasm-exceptions`, FS layer behind a build flag |
| P2 | Packed `Uint32Array` trace export alongside the object API |
| P4 | Single-allocation cache assembly |
| P5 | Performance thresholds assert by default |
| §6 | Bindings added for mute, filter, time, register read-back, chip count/model, MD5, full `SidConfig`, full `SidTuneInfo`, and the reSIDfp filter knobs |
| R1 | Trace buffer capped with an overflow counter; `cyclePhi1` widened |
| R2 | `getRomStatus()` exposed |
| R3 | Argument validation on `configure`, `renderSeconds`, `renderFrames`, `cacheSecondsLimit` |
| R5 | `dist/.tsbuildinfo` untracked |
| C9 | One exception ABI across libresidfp, libsidplayfp, and the bindings |
| C10 | Test loads the binary matching its glue |
| C11 | Per-chip versus process-global filter scope documented; test isolated |
| M8 | Tautological assertion replaced with a real one |

### Verification of this branch

| Gate | Result |
| --- | --- |
| Full unit suite | 371 pass, 1 skip, 0 fail |
| Production TypeScript line coverage | 99.39% (657/661), gate 95% |
| Native differential parity, both engines | 58/58 fixtures within thresholds |
| — SIDLite versus native | correlation 1.0000000, error floor below −600 dBFS (bit-identical) |
| — reSIDfp versus native | correlation ≥ 0.999999, error floor −81 to −90 dBFS |
| Clean-package and Node consumer check | pass |
| Build-time artifact identity and smoke render | pass for both engines |
