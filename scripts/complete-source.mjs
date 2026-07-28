#!/usr/bin/env node
/**
 * Assemble the complete corresponding source for the distributed WASM binaries.
 *
 * The `.wasm` files are object code covered by the GNU General Public License,
 * so recipients are entitled to the source they were built from. This produces a
 * single archive containing all of it, which the release workflow attaches to
 * the same GitHub release as the binaries — so the source is offered from the
 * same place as the object code.
 *
 * Contents:
 *   libsidplayfp/   upstream at the exact pinned commit
 *   libresidfp/     upstream at the exact pinned commit
 *   libsidplayfp-wasm/
 *                   the bindings, the patch scripts that modify upstream, the
 *                   Docker build, and the build scripts
 *   README.md       what this is and how to rebuild from it
 *
 * Upstream's own test suites are included, and deliberately. GPL-2.0 section 3
 * asks for "all the source code for all modules it contains, plus any associated
 * interface definition files, plus the scripts used to control compilation" — a
 * test suite is none of those, so the licence alone would not require it. What
 * requires it is upstream's build: `libsidplayfp/configure.ac` and
 * `libresidfp/configure.ac` both name `tests/Makefile` in AC_CONFIG_FILES, so a
 * tree without those directories fails at `configure` and the archive would no
 * longer rebuild the binaries — which is the property section 3 actually cares
 * about. They cost 384 KB of a 5.4 MB tree; `libsidplayfp/src` is 3.8 MB of it.
 *
 * Our own tests are not included, for the complementary reason: nothing in the
 * build refers to them, so their absence cannot stop anyone rebuilding.
 *
 * With no --out it writes `dist/complete-source.tar.gz`, which ships inside the
 * npm package so the source accompanies the object code (GPL-2.0 section 3(a)).
 * The release workflow additionally emits a version-named copy as a release
 * asset. Regeneration is skipped when the existing archive matches the current
 * pins; pass --force to rebuild anyway.
 *
 * Usage: node scripts/complete-source.mjs [--out <dir>] [--force]
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const outDir = path.resolve(
  outIndex >= 0 ? process.argv[outIndex + 1] : path.join(PACKAGE_ROOT, "dist"),
);

const upstream = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "upstream.json"), "utf8"));
const { version, name } = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
}

/**
 * Check out one dependency at its pinned commit, without its git history.
 *
 * The commit, not the tag, is what identifies the source: tags are mutable, so a
 * source archive built from a tag would not be verifiably the source of the
 * binary.
 */
function exportUpstream(library, destination) {
  const { repository, ref, commit } = upstream[library];
  const scratch = mkdtempSync(path.join(tmpdir(), `libsidplayfp-wasm-src-${library}-`));
  try {
    console.log(`fetching ${library} ${ref} (${commit})`);
    run("git", ["init", "--quiet", scratch]);
    run("git", ["-C", scratch, "remote", "add", "origin", repository]);
    run("git", ["-C", scratch, "fetch", "--quiet", "--depth", "1", "--recurse-submodules", "origin", commit]);
    run("git", ["-C", scratch, "checkout", "--quiet", commit]);
    run("git", ["-C", scratch, "submodule", "--quiet", "update", "--init", "--recursive", "--depth", "1"]);

    const resolved = run("git", ["-C", scratch, "rev-parse", "HEAD"]).trim();
    if (resolved !== commit) {
      throw new Error(`${library} resolved to ${resolved}, expected ${commit}`);
    }

    rmSync(path.join(scratch, ".git"), { recursive: true, force: true });
    cpSync(scratch, destination, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const stageName = `libsidplayfp-wasm-${version}-complete-source`;
const archiveName = outIndex >= 0 ? `${stageName}.tar.gz` : "complete-source.tar.gz";
const archivePath = path.join(outDir, archiveName);
const stampPath = `${archivePath}.stamp`;

// Regenerating means fetching both upstreams, so skip it when the existing
// archive was built from the same pins and version.
const stamp = JSON.stringify({
  version,
  libsidplayfp: upstream.libsidplayfp.commit,
  libresidfp: upstream.libresidfp.commit,
});
if (!process.argv.includes("--force")) {
  try {
    if (readFileSync(stampPath, "utf8") === stamp && readFileSync(archivePath).length > 0) {
      console.log(`complete corresponding source is current: ${archivePath}`);
      process.exit(0);
    }
  } catch {
    // No usable archive yet; build one.
  }
}

mkdirSync(outDir, { recursive: true });
const stage = path.join(outDir, stageName);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

exportUpstream("libsidplayfp", path.join(stage, "libsidplayfp"));
exportUpstream("libresidfp", path.join(stage, "libresidfp"));

// Everything of ours that goes into producing the binaries.
const ours = path.join(stage, "libsidplayfp-wasm");
mkdirSync(ours, { recursive: true });
for (const entry of [
  "src",
  "scripts",
  "docker",
  "package.json",
  "upstream.json",
  "tsconfig.json",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "MODIFICATIONS.md",
  "README.md",
]) {
  cpSync(path.join(PACKAGE_ROOT, entry), path.join(ours, entry), { recursive: true });
}

writeFileSync(
  path.join(stage, "README.md"),
  `# Complete corresponding source for ${name} ${version}

This archive is the complete corresponding source, in the sense of section 3 of
the GNU General Public License version 2, for the WebAssembly binaries
distributed in ${name}@${version}.

## Contents

| Directory | What it is |
| --- | --- |
| \`libsidplayfp/\` | ${upstream.libsidplayfp.repository} at \`${upstream.libsidplayfp.commit}\` (${upstream.libsidplayfp.ref}) |
| \`libresidfp/\` | ${upstream.libresidfp.repository} at \`${upstream.libresidfp.commit}\` (${upstream.libresidfp.ref}) |
| \`libsidplayfp-wasm/\` | The bindings, the scripts that modify upstream, and the build |

Both upstream trees are pristine, at the exact commits the binaries were built
from. The modifications this project applies are **not** baked into them: they
are applied at build time by \`libsidplayfp-wasm/scripts/apply-thread-guards.py\`
and \`libsidplayfp-wasm/scripts/apply-sid-write-hook.py\`, and are described in
\`libsidplayfp-wasm/MODIFICATIONS.md\`.

## Rebuilding

With Docker available:

\`\`\`bash
cd libsidplayfp-wasm
bash scripts/build-all-wasm.sh
\`\`\`

That fetches the same pinned commits, applies the modifications, and links both
engines. \`docker/entrypoint.sh\` is the authoritative build; it records the exact
compiler flags used.

## Licensing

libsidplayfp, libresidfp, and SIDLite are GPL-2.0-or-later. See
\`libsidplayfp-wasm/THIRD-PARTY-NOTICES.md\` for every component compiled into
the binaries and its licence, and \`libsidplayfp-wasm/LICENSE\` for the GPL text.
`,
);

run("tar", ["-czf", archivePath, "-C", outDir, stageName]);
rmSync(stage, { recursive: true, force: true });
writeFileSync(stampPath, stamp);
console.log(`complete corresponding source: ${archivePath}`);
