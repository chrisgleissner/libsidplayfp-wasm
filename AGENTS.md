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
  id-token for a short-lived registry credential, so no npm secret exists. The
  package's trusted publisher is `chrisgleissner/libsidplayfp-wasm` +
  `release.yaml`, with no environment. Changing the workflow *filename* breaks
  publishing until the trusted publisher is updated to match.

### Bootstrapping a new package on npm

  Only relevant if this package is ever renamed, or when setting up a sibling
  project. It cost several hours to work out, so it is written down.

  1. **A token cannot publish from CI** when the npm account is set to
     `two-factor auth: auth-and-writes` (check with `npm profile get`). Every
     write is challenged interactively, and the one exemption — the Classic
     "Automation" token — has been retired; npm now offers only Granular tokens
     and is [restricting 2FA
     bypass](https://gh.io/npm-gat-bypass2fa-deprecation). A CI publish attempt
     fails with `EOTP`. Do not waste time on token types.
  2. **Trusted publishing requires the package to already exist**, so a brand
     new name is a chicken-and-egg. Break it by publishing a minimal placeholder
     `0.0.1` by hand, which is the one operation that legitimately needs a human
     and a browser. Delete that version once the first real release is out;
     npm allows unpublishing a version within 72 hours when it is not the only
     one.
  3. **Configure the trusted publisher in the npm web UI**, at
     `https://www.npmjs.com/package/<name>/access`, not with `npm trust github`.
     The API requires an `allowed_actions` field that the CLI does not send
     (`lib/commands/trust/github.js:optionsToBody` emits only `type` and
     `claims`), so the CLI fails with an undiagnosable `400 Bad Request`. Tick
     **publish** only — the release runs no other privileged npm command.
  4. **Leave the environment name empty** unless the workflow declares a
     matching `environment:`. An environment in the claim that the workflow does
     not set makes every publish fail.
  5. **Expect registry lag on a brand new package.** Immediately after the first
     publish, the read path 404s while `npm access list packages` already shows
     the package. Errors during that window mean "not propagated yet", not
     "failed" — re-check state before retrying a destructive command.
  6. Confirm success by the publisher badge on
     `https://www.npmjs.com/settings/<user>/packages`: it reads **GitHub
     Actions** once trusted publishing works, and your username before that.
  7. Finally set *Publishing access* to **require 2FA and disallow tokens**, so
     the token path is impossible rather than merely unused.

- **Do not merge to `main` while a release is qualifying.** The release preflight
  waits for the `Verify` run of the exact commit it is releasing, and `Verify`
  uses `cancel-in-progress` per branch — so a merge cancels the run the release
  depends on, and the release fails with `Verify concluded 'cancelled'`. A
  release also pins itself to `main`'s HEAD at dispatch time, so a merge landing
  between the check and the dispatch silently changes what gets released. Let the
  release finish first.
- Do not stage releases through a `next` dist-tag. npm's OIDC credential
  authenticates `npm publish` and nothing else, so moving `latest` afterwards
  would require a long-lived token. The guard is the consumer smoke test run
  against the exact tarball before publishing and against the registry copy
  after; `scripts/consumer-smoke.mjs` is shared by both so they cannot diverge.
- `README.md` is written for users of the library. Release mechanics, tokens,
  and workflow internals belong here, not there.
- `.github/workflows/upstream-watch.yaml` accepts only stable upstream GitHub
  releases and opens an update PR. That PR touches `upstream.json`, which is one
  of the paths that triggers `.github/workflows/exhaustive.yaml`, so the full
  HVSC sweep runs on it before it merges.
- The release workflow is the only publisher, and its stages gate one another:
  preflight (the commit's own `Verify` run must be green, and the version must
  be valid and unpublished), qualify (both engines rebuilt, then the exact
  tarball packed and smoke-tested), publish (npm via OIDC trusted publishing,
  with no stored credential), smoke (reinstall that version from the registry
  and play a SID), promote (the git tag and the GitHub release). GitHub Packages
  is not a target: it requires scoped names, and this package is deliberately
  unscoped.
- **`qualify` deliberately does not re-run the unit suite, the browsers or
  native parity.** `Verify` ran all of them on the identical commit and
  preflight refuses to proceed unless that run was green, so repeating them
  spent four minutes of every release re-answering a settled question about
  bytes that had not moved. What `qualify` keeps is the part `Verify` cannot
  do — proving the artifact itself. If you add a check here, first ask whether
  it belongs in `Verify` instead.
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

`test:coverage` writes LCOV and fails below 100% production TypeScript line
coverage. `test:browser` exercises Chromium, Android-sized Chromium, Firefox,
and WebKit, including concurrent module-worker playback. `test:soak` performs
the 30-minute local virtual-playback memory qualification; the scheduled weekly
workflow extends it to two hours. The soak is deliberately opt-in for normal
unit runs and must be run before approving changes to rendering, allocation,
or lifecycle behavior.

Before considering a release-related change complete, run the full test suite
and retain the literal terminal summary showing `0 fail`:

```bash
bun run test
```

`bun run test:edge` and `bun run test:parity:edge` sweep every selected HVSC
edge case through both WASM engines, the latter against native builds at the
same pins. They take roughly an hour together and are **not** part of a release.
Run them — or let `.github/workflows/exhaustive.yaml` run them — when the
engine's own bytes change: an upstream pin, a toolchain flag, a binding. For a
change to TypeScript they cannot tell you anything the curated corpus does not.

## Definition of done

No change is complete until all four of these have been done and the result
stated. They are cheap next to the cost of the drift they prevent.

**1. Deduplication.** Search for what you just wrote before you finish. If the
same logic, constant, error message, or documentation now exists in two places,
collapse it or say why it cannot be collapsed. Duplicated code here has a track
record of diverging in exactly one copy: ROM failure handling differed in
whether it reset a flag, and the pre- and post-publish smoke tests checked
different things until they were made one file. Ask specifically:

- Does a helper already do this? `scripts/`, `test/helpers/`, `src/player.ts`.
- Did I add a second render loop, a second env read, a second version rule, a
  second way to describe the same fact?
- If two places must state the same value, does one derive it from the other?

**2. Consistency.** The same fact must read the same way everywhere it appears:

- `bindings.cpp` and `src/bindings/libsidplayfp.d.ts` — a binding with no
  declaration, or the reverse, fails `test/binding-surface.test.ts`.
- Coverage thresholds in `scripts/check-coverage.mjs`, `.codecov.yml`,
  `README.md`, `AGENTS.md`, and the workflow step names.
- Version rules in `scripts/upstream.mjs` and the README table.
- Build flags in `docker/entrypoint.sh` and what the README claims about
  runtime support.

**3. Documentation.** Update the docs in the same change, not afterwards:

- `README.md` for anything a *user* sees: API, engines, browser support,
  versioning, what is verified. It is written for users; keep release
  mechanics, tokens, and tooling out of it.
- `AGENTS.md` for anything a *contributor* must know.
- `THIRD-PARTY-NOTICES.md` and `MODIFICATIONS.md` for anything that changes what
  is compiled into the binaries or how upstream is patched. See "Licensing".
- The `.d.ts` for any binding change, including scope caveats — some reSIDfp
  settings are process-global and the type surface has to say so.

**4. Workflows.** Validate any change to `.github/` with `actionlint`, which is
what CI runs. `yaml.safe_load` is not sufficient: it accepts a workflow GitHub
rejects, and an unparseable workflow shows up as a failed run with no jobs and
no useful error. The specific trap is a blank line inside a quoted multi-line
shell argument — the continuation lands at column 0 and silently terminates the
surrounding block scalar. Build multi-line text with a heredoc and pass it by
file.

**5. Claims.** Every factual statement in the docs must be checkable, and you
must have checked it. State what is actually tested, not what sounds thorough:
name the browsers the config really runs, the number of tunes really swept, the
duration really rendered. If you cannot verify a claim, remove it.

## Licensing

The published package distributes GPL object code, so licensing is part of the
build rather than a one-off.

- The package is GPL-2.0-or-later. libsidplayfp, libresidfp, and SIDLite are all
  GPL-2.0-**or-later**; the binaries additionally contain MIT code (`hashlib`,
  musl, the Emscripten runtime) and Apache-2.0-with-LLVM-exception runtime
  libraries.
- Any change to what is compiled into the binaries must update
  `THIRD-PARTY-NOTICES.md`. Any change to how upstream is patched must update
  `MODIFICATIONS.md` *and* the in-file notice the patch script inserts, which
  exists to satisfy GPL-2.0 section 2(a).
- `docker/entrypoint.sh` copies `LICENSE`, `THIRD-PARTY-NOTICES.md`,
  `MODIFICATIONS.md`, and a generated `UPSTREAM.json` beside every `.wasm`, so
  an artifact taken out of the package on its own is still compliant.
- `scripts/complete-source.mjs` builds the complete corresponding source, and
  `bun run build` puts it at `dist/complete-source.tar.gz` so it ships *inside*
  the npm package. That is what satisfies GPL-2.0 section 3(a), and it is why no
  written offer is needed. Do not remove it. The release additionally attaches a
  version-named copy as a release asset.
- `scripts/check-package.mjs` fails the build if any of those files are missing,
  if the recorded upstream commits do not match `upstream.json`, or if a ROM,
  SID, or corpus file appears in the tarball. Extend it rather than working
  around it.
- Never claim or imply official upstream status.

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
