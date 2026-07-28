#!/usr/bin/env node
/**
 * Upstream pins and the package version derived from them.
 *
 * `upstream.json` is the authority for which libsidplayfp and libresidfp
 * releases a build contains, and for which of the two versioning modes described
 * in README.md ("Versioning") is in force.
 *
 * independent (`versioning.mode: "independent"`)
 *   The package owns its own semver. An upstream bump takes a minor release, a
 *   downstream fix takes a patch. Nothing is claimed about matching upstream's
 *   number. This is the shakedown mode.
 *
 * mirror (`versioning.mode: "mirror"`)
 *   A release that only advances upstream takes the pinned libsidplayfp version
 *   verbatim, whenever that number is still free. A downstream-only fix takes
 *   the next free patch and keeps the pin. When a mirror's natural number has
 *   already been consumed by a downstream fix, the mirror moves up to the next
 *   free patch; that gap closes again at the next upstream minor or major,
 *   because those are above any drift within a patch series.
 *
 * Every rule is one function here so the workflows never re-derive a version by
 * hand.
 *
 * Commands:
 *   get <library>.<field>                     print one pinned value
 *   status --ref vX.Y.Z --commit <sha>        is this candidate an update?
 *   plan --ref vX.Y.Z [--published <json>]    version an upstream bump would take
 *   update --ref vX.Y.Z --commit <sha> [--published <json>]
 *                                             move the pin and the version
 *   bump [--published <json>]                 downstream-only patch release
 *   adopt-mirror [--published <json>]         switch to mirror mode
 *   emit-constants                            regenerate src/upstream-versions.ts
 *   verify                                    assert the repository is self-consistent
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const UPSTREAM_PATH = path.join(PACKAGE_ROOT, "upstream.json");
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");
const CONSTANTS_PATH = path.join(PACKAGE_ROOT, "src", "upstream-versions.ts");
const STABLE_REF = /^v?(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

function parseStableVersion(ref) {
  const match = STABLE_REF.exec(ref);
  if (!match) throw new Error(`Expected a stable vMAJOR.MINOR.PATCH upstream tag, got: ${ref}`);
  return match.slice(1).map(Number);
}

function formatVersion([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * The first version at or above `candidate` that is strictly greater than
 * `current` and not already published.
 *
 * Only the patch component moves. A mirror whose number is free is therefore
 * returned unchanged, which is the common case and the one that makes our
 * version identical to upstream's.
 */
function nextFreeVersion(candidate, current, published) {
  const taken = new Set(published);
  let parts = parseStableVersion(candidate);
  for (;;) {
    const version = formatVersion(parts);
    if (compareVersions(version, current) > 0 && !taken.has(version)) return version;
    parts = [parts[0], parts[1], parts[2] + 1];
  }
}

const VERSIONING_MODES = new Set(["independent", "mirror"]);

async function readMetadata() {
  const metadata = JSON.parse(await readFile(UPSTREAM_PATH, "utf8"));
  if (metadata?.schemaVersion !== 1) throw new Error(`${UPSTREAM_PATH} has an unsupported schema`);
  const mode = metadata.versioning?.mode;
  if (!VERSIONING_MODES.has(mode)) {
    throw new Error(`upstream.json versioning.mode must be one of ${[...VERSIONING_MODES].join(", ")}`);
  }
  parseStableVersion(metadata.libsidplayfp?.ref ?? "");
  if (!STABLE_REF.test(metadata.libresidfp?.ref ?? "")) throw new Error("libresidfp ref must be a release tag");
  if (!SHA.test(metadata.libsidplayfp?.commit ?? "") || !SHA.test(metadata.libresidfp?.commit ?? "")) {
    throw new Error("upstream metadata must pin full immutable commits");
  }
  return metadata;
}

async function readPackageJson() {
  return JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Versions already on the registry.
 *
 * Supplied by the caller — `npm view <pkg> versions --json` in CI — because this
 * script must stay offline and deterministic. An absent list means "nothing is
 * published", which is correct for a first release and safe otherwise: the
 * `> current` rule alone still guarantees a strictly increasing version.
 */
function readPublished() {
  const raw = readOption("--published");
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `--published is not JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  // `npm view <missing> --json` prints an error object on stdout and exits 1,
  // which for a package that has never been published means exactly "nothing".
  // Any other error is a registry problem the caller must not mistake for an
  // empty registry, because that would let an already-published version through.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.error) {
    if (parsed.error.code === "E404") return [];
    throw new Error(`registry lookup failed: ${parsed.error.summary ?? parsed.error.code}`);
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((entry) => typeof entry === "string" && STABLE_REF.test(entry));
}

async function get(field) {
  const [library, key] = field.split(".");
  const metadata = await readMetadata();
  const value = metadata[library]?.[key];
  if (typeof value !== "string") throw new Error(`Unknown upstream field: ${field}`);
  process.stdout.write(`${value}\n`);
}

async function status() {
  const candidateRef = readOption("--ref");
  const candidateCommit = readOption("--commit");
  if (!candidateRef || !candidateCommit) throw new Error("Usage: upstream.mjs status --ref vX.Y.Z --commit <40-hex-sha>");
  parseStableVersion(candidateRef);
  if (!SHA.test(candidateCommit)) throw new Error(`Expected an immutable 40-character commit, got: ${candidateCommit}`);

  const metadata = await readMetadata();
  const comparison = compareVersions(candidateRef, metadata.libsidplayfp.ref);
  if (comparison === 0 && candidateCommit !== metadata.libsidplayfp.commit) {
    throw new Error(
      `Refusing mutable upstream tag ${candidateRef}: pinned ${metadata.libsidplayfp.commit}, received ${candidateCommit}`,
    );
  }
  const update = comparison > 0;
  process.stdout.write(`update=${update}\n`);
  process.stdout.write(`current_ref=${metadata.libsidplayfp.ref}\n`);
  process.stdout.write(`candidate_ref=${candidateRef}\n`);
  if (comparison < 0) process.stdout.write("reason=candidate_is_older\n");
  else if (comparison === 0) process.stdout.write("reason=already_pinned\n");
  else process.stdout.write("reason=new_stable_release\n");

  if (update) {
    const packageJson = await readPackageJson();
    const version = versionForUpstream(
      metadata.versioning.mode,
      candidateRef,
      packageJson.version,
      readPublished(),
    );
    process.stdout.write(`mode=${metadata.versioning.mode}\n`);
    process.stdout.write(`version=${version}\n`);
    process.stdout.write(`mirrors_upstream=${version === candidateRef.slice(1)}\n`);
  }
}

/**
 * The version an upstream bump to `ref` would take under the current mode.
 *
 * In mirror mode that is upstream's own number whenever it is free. In
 * independent mode an upstream engine change is a minor release, which is the
 * strongest signal 0.x semver offers.
 */
function versionForUpstream(mode, ref, current, published) {
  if (mode === "mirror") {
    return nextFreeVersion(ref.slice(1), current, published);
  }
  const [major, minor] = parseStableVersion(current);
  return nextFreeVersion(formatVersion([major, minor + 1, 0]), current, published);
}

async function plan() {
  const ref = readOption("--ref");
  if (!ref) throw new Error("Usage: upstream.mjs plan --ref vX.Y.Z [--published <json-array>]");
  parseStableVersion(ref);
  const metadata = await readMetadata();
  const packageJson = await readPackageJson();
  const version = versionForUpstream(
    metadata.versioning.mode,
    ref,
    packageJson.version,
    readPublished(),
  );
  process.stdout.write(`mode=${metadata.versioning.mode}\n`);
  process.stdout.write(`version=${version}\n`);
  process.stdout.write(`mirrors_upstream=${version === ref.slice(1)}\n`);
}

async function update() {
  const ref = readOption("--ref");
  const commit = readOption("--commit");
  if (!ref || !commit) throw new Error("Usage: upstream.mjs update --ref vX.Y.Z --commit <40-hex-sha>");
  parseStableVersion(ref);
  if (!SHA.test(commit)) throw new Error(`Expected an immutable 40-character commit, got: ${commit}`);

  const metadata = await readMetadata();
  if (compareVersions(ref, metadata.libsidplayfp.ref) < 0) {
    throw new Error(`Refusing to move upstream backwards from ${metadata.libsidplayfp.ref} to ${ref}`);
  }
  metadata.libsidplayfp.ref = ref;
  metadata.libsidplayfp.commit = commit;

  const packageJson = await readPackageJson();
  packageJson.version = versionForUpstream(
    metadata.versioning.mode,
    ref,
    packageJson.version,
    readPublished(),
  );
  await writeFile(UPSTREAM_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeConstants(metadata, packageJson.version);
  const mirrors =
    packageJson.version === ref.slice(1)
      ? "mirrors upstream"
      : `${metadata.versioning.mode} of upstream ${ref.slice(1)}`;
  process.stdout.write(
    `Pinned libsidplayfp ${ref} (${commit}) and set ${packageJson.name}@${packageJson.version} (${mirrors})\n`,
  );
}

/** Downstream-only release: keep the pin, take the next free patch. */
async function bump() {
  const metadata = await readMetadata();
  const packageJson = await readPackageJson();
  const [major, minor, patch] = parseStableVersion(packageJson.version);
  packageJson.version = nextFreeVersion(
    formatVersion([major, minor, patch + 1]),
    packageJson.version,
    readPublished(),
  );
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeConstants(metadata, packageJson.version);
  process.stdout.write(
    `Downstream release ${packageJson.name}@${packageJson.version}, still pinning libsidplayfp ${metadata.libsidplayfp.ref}\n`,
  );
  process.stdout.write(`version=${packageJson.version}\n`);
}

/**
 * Leave the shakedown 0.x line and start mirroring upstream.
 *
 * A one-way switch, taken once the package is trusted enough for its version to
 * be a claim about upstream rather than about itself. The jump is monotonic:
 * any real libsidplayfp release is above every 0.x version.
 */
async function adoptMirror() {
  const metadata = await readMetadata();
  const packageJson = await readPackageJson();
  if (metadata.versioning.mode === "mirror") {
    throw new Error("versioning.mode is already mirror");
  }

  const upstream = metadata.libsidplayfp.ref.slice(1);
  const version = nextFreeVersion(upstream, packageJson.version, readPublished());
  if (version !== upstream) {
    throw new Error(
      `cannot adopt mirror mode: ${upstream} is not available (would have to use ${version}). ` +
        "Publish the mirror from a state where upstream's own number is still free.",
    );
  }

  metadata.versioning.mode = "mirror";
  packageJson.version = version;
  await writeFile(UPSTREAM_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeConstants(metadata, version);
  process.stdout.write(`Adopted mirror versioning at ${packageJson.name}@${version}\n`);
}

function renderConstants(metadata, version) {
  return `// Generated by scripts/upstream.mjs. Do not edit by hand.
//
// The npm version and the upstream release it contains are not always the same
// number — see "Versioning" in README.md. These constants are the authority for
// what a build actually contains.

/** libsidplayfp release this build was compiled from, without the leading "v". */
export const LIBSIDPLAYFP_VERSION = ${JSON.stringify(metadata.libsidplayfp.ref.slice(1))};

/** libresidfp release this build was compiled from, without the leading "v". */
export const LIBRESIDFP_VERSION = ${JSON.stringify(metadata.libresidfp.ref.slice(1))};

/** Immutable upstream commits, exactly as pinned in upstream.json. */
export const UPSTREAM_COMMITS = {
  libsidplayfp: ${JSON.stringify(metadata.libsidplayfp.commit)},
  libresidfp: ${JSON.stringify(metadata.libresidfp.commit)},
} as const;

/** Version of this npm package. */
export const PACKAGE_VERSION = ${JSON.stringify(version)};
`;
}

async function writeConstants(metadata, version) {
  await writeFile(CONSTANTS_PATH, renderConstants(metadata, version));
}

async function emitConstants() {
  const metadata = await readMetadata();
  const packageJson = await readPackageJson();
  await writeConstants(metadata, packageJson.version);
  process.stdout.write(`Wrote ${path.relative(PACKAGE_ROOT, CONSTANTS_PATH)}\n`);
}

/**
 * Assert the repository is self-consistent before anything is published.
 *
 * Deliberately not `packageVersion === upstreamRef`: that equality is what makes
 * a downstream-only fix impossible. These are the invariants that hold in both
 * versioning modes.
 */
async function verify() {
  const metadata = await readMetadata();
  const packageJson = await readPackageJson();
  const problems = [];

  const version = packageJson.version;
  try {
    parseStableVersion(version);
  } catch {
    problems.push(`package.json version ${version} is not a stable MAJOR.MINOR.PATCH release`);
  }

  const upstream = metadata.libsidplayfp.ref.slice(1);
  const mode = metadata.versioning.mode;
  if (problems.length === 0 && mode === "mirror" && compareVersions(version, upstream) < 0) {
    problems.push(
      `package version ${version} is below the pinned libsidplayfp ${upstream}; ` +
        "in mirror mode a release must be at least the upstream version",
    );
  }

  const expected = renderConstants(metadata, version);
  let actual = "";
  try {
    actual = await readFile(CONSTANTS_PATH, "utf8");
  } catch {
    problems.push(`${path.relative(PACKAGE_ROOT, CONSTANTS_PATH)} is missing`);
  }
  if (actual && actual !== expected) {
    problems.push(
      `${path.relative(PACKAGE_ROOT, CONSTANTS_PATH)} is stale; run: node scripts/upstream.mjs emit-constants`,
    );
  }

  const published = readPublished();
  if (published.includes(version)) {
    problems.push(`${version} is already published; releases are immutable`);
  }

  if (problems.length > 0) {
    throw new Error(`Upstream/version invariants failed:\n  - ${problems.join("\n  - ")}`);
  }

  process.stdout.write(
    `mode=${mode} version=${version} upstream=${upstream} mirrors_upstream=${version === upstream}\n`,
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "get") return await get(process.argv[3] ?? "");
  if (command === "status") return await status();
  if (command === "plan") return await plan();
  if (command === "update") return await update();
  if (command === "bump") return await bump();
  if (command === "adopt-mirror") return await adoptMirror();
  if (command === "emit-constants") return await emitConstants();
  if (command === "verify") return await verify();
  throw new Error("Usage: upstream.mjs <get|status|plan|update|bump|emit-constants|verify> ...");
}

main().catch((error) => {
  console.error("Upstream metadata error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

export {
  compareVersions,
  nextFreeVersion,
  parseStableVersion,
  renderConstants,
  versionForUpstream,
};
