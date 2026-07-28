#!/usr/bin/env node
/**
 * Install the package from the npm registry and play a SID with it.
 *
 * Everything else in the pipeline tests a local build. This tests the artifact a
 * user actually receives: it downloads the published version into an empty
 * directory, imports it by package name, and requires real audio out of both
 * engines and both public entry points.
 *
 * The body is `scripts/consumer-smoke.mjs`, shared with the pre-publish check in
 * `check-package.mjs`, so the bytes that are verified and the bytes that are
 * served are held to the same standard. Failing here blocks the git tag and the
 * GitHub release.
 *
 * Usage:
 *   node scripts/published-smoke.mjs --package @scope/name --version 1.2.3
 *                                    [--registry https://registry.npmjs.org]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderConsumerSmoke } from "./consumer-smoke.mjs";

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value && fallback === undefined) {
    throw new Error(`Missing required --${name}`);
  }
  return value ?? fallback;
}

const packageName = readOption("package");
const version = readOption("version");
const registry = readOption("registry", "https://registry.npmjs.org");
const packageRoot = path.resolve(import.meta.dirname, "..");
const fixture = path.join(packageRoot, "test-tone-c4.sid");

const scratch = mkdtempSync(path.join(tmpdir(), "libsidplayfp-wasm-published-"));

try {
  writeFileSync(
    path.join(scratch, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );

  console.log(`Installing ${packageName}@${version} from ${registry}`);
  execFileSync(
    "npm",
    [
      "install",
      `${packageName}@${version}`,
      "--registry",
      registry,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: scratch, stdio: "inherit" },
  );

  writeFileSync(path.join(scratch, "tune.sid"), readFileSync(fixture));

  writeFileSync(
    path.join(scratch, "smoke.mjs"),
    renderConsumerSmoke({
      packageName,
      expectedVersion: version,
      tunePath: "tune.sid",
    }),
  );

  execFileSync("node", ["smoke.mjs"], { cwd: scratch, stdio: "inherit" });
  console.log(`published smoke test passed: ${packageName}@${version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
