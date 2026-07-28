#!/usr/bin/env node
/**
 * Install the package from the npm registry and play a SID with it.
 *
 * Everything else in the pipeline tests a local build. This tests the artifact a
 * user actually receives: it downloads the published version into an empty
 * directory, imports it by package name, and requires real audio out of both
 * engines and both public entry points.
 *
 * Run in CI immediately after publishing and before the `latest` dist-tag moves,
 * so a version that fails here is never the one `npm install` resolves to.
 *
 * Usage:
 *   node scripts/published-smoke.mjs --package @scope/name --version 1.2.3
 *                                    [--registry https://registry.npmjs.org]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    `import { readFileSync } from "node:fs";
import {
  LIBSIDPLAYFP_VERSION,
  PACKAGE_VERSION,
  SidAudioEngine,
  loadLibsidplayfp,
} from ${JSON.stringify(packageName)};

const tune = new Uint8Array(readFileSync("tune.sid"));
const expectedVersion = ${JSON.stringify(version)};

if (PACKAGE_VERSION !== expectedVersion) {
  throw new Error(\`published PACKAGE_VERSION is \${PACKAGE_VERSION}, expected \${expectedVersion}\`);
}
if (!/^\\d+\\.\\d+\\.\\d+$/.test(LIBSIDPLAYFP_VERSION)) {
  throw new Error(\`published LIBSIDPLAYFP_VERSION is not a release: \${LIBSIDPLAYFP_VERSION}\`);
}
console.log(\`package \${PACKAGE_VERSION} contains libsidplayfp \${LIBSIDPLAYFP_VERSION}\`);

function rms(pcm) {
  let sum = 0;
  for (const sample of pcm) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

for (const [engine, builder] of [["sidlite", "WasmSIDLite"], ["residfp", "WasmReSIDfp"]]) {
  // Path 1: the generated module, driven directly.
  const wasm = await loadLibsidplayfp({ engine });
  if (wasm.getSidEngineName() !== builder) {
    throw new Error(\`\${engine} resolved to \${wasm.getSidEngineName()}, expected \${builder}\`);
  }
  const context = new wasm.SidPlayerContext();
  try {
    if (!context.configure(48_000, true)) throw new Error(context.getLastError());
    if (!context.loadSidBuffer(tune)) throw new Error(context.getLastError());
    const chunk = context.render(100_000);
    if (!chunk || chunk.length === 0) throw new Error(\`\${engine} module produced no samples\`);
    const info = context.getEngineInfo();
    if (!info || typeof info.name !== "string") throw new Error(\`\${engine} reported no engine info\`);
  } finally {
    context.delete();
  }

  // Path 2: the SidAudioEngine wrapper, which is what most callers use.
  const player = new SidAudioEngine({ engine, sampleRate: 44_100, stereo: true });
  try {
    await player.loadSidBuffer(tune);
    const pcm = await player.renderSeconds(1, 20_000);
    if (pcm.length !== 88_200) {
      throw new Error(\`\${engine} wrapper produced \${pcm.length} samples, expected 88200\`);
    }
    const level = rms(pcm);
    if (!(level > 0.001)) throw new Error(\`\${engine} wrapper rendered silence (rms \${level})\`);
    console.log(\`\${engine}: \${pcm.length} samples, rms \${level.toFixed(4)}\`);
  } finally {
    player.dispose();
  }
}

console.log("published package smoke test: ok");
`,
  );

  execFileSync("node", ["smoke.mjs"], { cwd: scratch, stdio: "inherit" });
  console.log(`published smoke test passed: ${packageName}@${version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
