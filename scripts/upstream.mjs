#!/usr/bin/env node
/** Maintain the single source of truth for reproducible upstream release pins. */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const UPSTREAM_PATH = path.join(PACKAGE_ROOT, "upstream.json");
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");
const STABLE_REF = /^v?(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

function parseStableVersion(ref) {
  const match = STABLE_REF.exec(ref);
  if (!match) throw new Error(`Expected a stable vMAJOR.MINOR.PATCH upstream tag, got: ${ref}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function readMetadata() {
  const metadata = JSON.parse(await readFile(UPSTREAM_PATH, "utf8"));
  if (metadata?.schemaVersion !== 1) throw new Error(`${UPSTREAM_PATH} has an unsupported schema`);
  parseStableVersion(metadata.libsidplayfp?.ref ?? "");
  if (!STABLE_REF.test(metadata.libresidfp?.ref ?? "")) throw new Error("libresidfp ref must be a release tag");
  if (!SHA.test(metadata.libsidplayfp?.commit ?? "") || !SHA.test(metadata.libresidfp?.commit ?? "")) {
    throw new Error("upstream metadata must pin full immutable commits");
  }
  return metadata;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
  packageJson.version = ref.slice(1);
  await writeFile(UPSTREAM_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  process.stdout.write(`Pinned libsidplayfp ${ref} (${commit}) and package ${packageJson.name}@${packageJson.version}\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === "get") return await get(process.argv[3] ?? "");
  if (command === "status") return await status();
  if (command === "update") return await update();
  throw new Error("Usage: upstream.mjs <get|status|update> ...");
}

main().catch((error) => {
  console.error("Upstream metadata error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
