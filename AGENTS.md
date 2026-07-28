# Agent Instructions for libsidplayfp WASM

Read this file and `README.md` before changing code, generated artifacts, tests,
or workflows. This repository is a standalone, source-compatible TypeScript and
WebAssembly distribution of libsidplayfp.

## Non-negotiable invariants

- Preserve the public loader, `SidAudioEngine`, generated module API, and both
  engine names. Existing SIDFlow environment variables remain supported as
  compatibility aliases.
- Ship **both** pure artifacts: `dist/` is reSIDfp and `dist/sidlite/` is
  SIDLite. Each must contain only its claimed builder.
- Treat valid-looking PCM as insufficient evidence. An artifact can render
  plausible audio while selecting the wrong engine and corrupting the mixer.
  Native differential parity is the authority.
- Do not commit, package, or publish HVSC files, C64 ROMs, local caches, build
  directories, or browser test results. Test-only caches live below `.cache/`.
- C64 ROMs used by tests are checksum-pinned bytes fetched from
  `libretro/vice-libretro`; package users must supply their own legal ROMs.
- All work goes through a branch and pull request. Do not push directly to
  `main`, publish from a workstation, or hand-edit release assets or goldens.

## Upstream and release policy

- `upstream.json` is the single source of truth for libsidplayfp and libresidfp
  release tags, immutable commits, and the versioning mode. Do not edit Docker
  defaults to advance a version. The build verifies that each pinned tag still
  resolves to its pinned commit and aborts if it does not.
- Never hand-edit `package.json`'s version. Every version decision belongs to
  `scripts/upstream.mjs`: `update` for an upstream bump, `bump` for a
  downstream-only fix, `adopt-mirror` to leave the 0.x line. `verify` runs in CI
  and in the release preflight, and `src/upstream-versions.ts` is generated —
  regenerate it with `bun run version:constants`.
- The two versioning modes and the drift rule are summarised for users under
  "Which libsidplayfp am I getting?" in `README.md`. The maintainer commands are:

  ```bash
  bun run version:verify        # invariants; also runs in CI and the preflight
  bun run version:bump          # downstream-only fix release
  bun run version:adopt-mirror  # leave the 0.x line, start mirroring upstream
  bun run version:constants     # regenerate src/upstream-versions.ts
  ```

- npm authentication is OIDC trusted publishing: the workflow exchanges GitHub's
  id-token for a short-lived registry credential, so in the steady state no npm
  secret exists. npm cannot create a trusted publisher for a package that does
  not exist yet, so the first release of a new package name needs a one-off
  `NPM_TOKEN` repository secret. Immediately afterwards, run

  ```bash
  npm trust github @chrisgleissner/libsidplayfp-wasm \
    --repo chrisgleissner/libsidplayfp-wasm --file release.yaml
  ```

  delete the secret, and remove the fallback branch from `release.yaml`.
- Do not stage releases through a `next` dist-tag. npm's OIDC credential
  authenticates `npm publish` and nothing else, so moving `latest` afterwards
  would require a long-lived token. The guard is the consumer smoke test run
  against the exact tarball before publishing and against the registry copy
  after; `scripts/consumer-smoke.mjs` is shared by both so they cannot diverge.
- `README.md` is written for users of the library. Release mechanics, tokens,
  and workflow internals belong here, not there.
- `.github/workflows/upstream-watch.yaml` accepts only stable upstream GitHub
  releases and opens an update PR. Merging that PR invokes the exhaustive
  release qualification workflow.
- The release workflow is the only publisher, and its stages gate one another:
  preflight (the commit's own `Verify` run must be green, and the version must
  be valid and unpublished), qualify (both engines rebuilt, full unit suite
  three times, 99% coverage gate, browser tests, clean-package check, complete
  HVSC #85 edge sweep, native parity, and a smoke test of the exact tarball),
  publish (npm via OIDC trusted publishing — no token — and GitHub Packages),
  smoke (reinstall that version from the registry and play a SID), promote (the
  git tag and the GitHub release).
- npm's OIDC credential authenticates `npm publish` and nothing else, so a
  `next` -> `latest` staging step would need a long-lived token. Do not add one:
  the guard is smoke-testing the identical bytes before publish and the registry
  copy after.
- Never hand-edit `test/fixtures/engine-goldens.json`. Regenerate it only with
  `bun run test:parity -- --update-goldens` after native parity is green.

## Development and validation

Use Bun `1.3.1` and Node `20+`. Install dependencies with:

```bash
bun install --frozen-lockfile
```

For a normal code or workflow change, run:

```bash
bun run build:wasm
bun run build
bun run test:coverage
bun run test:browser
bun run check:package
bun run test:parity
```

`build:wasm` builds both engines from the exact pins. The first real-playback
run fetches and checksum-verifies HVSC #85 and the VICE ROM cache. Reuse the
cache; do not add fixtures by downloading individual tunes from arbitrary
servers.

`test:coverage` writes LCOV and fails below 99% production TypeScript line
coverage. `test:browser` exercises Chromium, Android-sized Chromium, Firefox,
and WebKit, including concurrent module-worker playback. `test:soak` performs
the 30-minute local virtual-playback memory qualification; the scheduled weekly
workflow extends it to two hours. The soak is deliberately opt-in for normal
unit runs and must be run before approving changes to rendering, allocation,
or lifecycle behavior.

Before considering a release-related change complete, run the full test suite
three consecutive times and retain literal terminal summaries showing `0 fail`:

```bash
for run in 1 2 3; do bun run test; done
```

Then run `bun run test:edge` and `bun run test:parity:edge`. The latter is
intentionally a release-grade operation: it compares every selected HVSC edge
case through both WASM engines against native builds at the same pins.

## Implementation guidance

- Use `apply_patch` for source edits and keep TypeScript strict. Every `catch`
  must log its error or rethrow it.
- Maintain cache integrity checks, atomic downloads, and locks. A cache hit must
  verify its digest before it is trusted.
- Keep `scripts/build-native-reference.sh` and `docker/entrypoint.sh` behavior
  aligned with `src/bindings/bindings.cpp`; they are the formal comparison
  control and production build respectively.
- `src/bindings/libsidplayfp.d.ts` and `src/bindings/ARTIFACT.md` are the
  artifact's public type surface and README. Update them in the same change as
  `bindings.cpp`; `docker/entrypoint.sh` copies them verbatim.
- The exception ABI must be identical for libresidfp, libsidplayfp, and the
  bindings. Compiling upstream with no exception flags is not neutral: its
  internal try/catch blocks are then compiled not to catch, and errors it is
  designed to report through a status escape to JavaScript instead.
- For browser changes, test both artifact locations with Playwright. Browser
  asset resolution is part of the public contract.
- Update `README.md` when changing installation, assets, ROM handling, engine
  selection, validation, source pins, or release behavior.
