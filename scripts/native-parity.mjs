#!/usr/bin/env bun
/**
 * Comparative engine analysis: WASM vs a NATIVE build of the same libsidplayfp.
 *
 * This is the rigorous half of the engine story. `test/engine-parity.test.ts`
 * compares the wasm build against recorded goldens and runs in seconds on every
 * CI run; this compares it against a freshly built native reference at the same
 * pinned refs, with the same SidConfig and the same render loop, so the only
 * remaining variable is the wasm target itself.
 *
 * Why a purpose-built native reference rather than the distro `sidplayfp`:
 * distros ship libsidplayfp 2.x, so comparing against `/usr/bin/sidplayfp`
 * conflates "our build is wrong" with "upstream changed between major versions".
 *
 *   bun run scripts/native-parity.mjs                  # verify
 *   bun run scripts/native-parity.mjs --update-goldens # verify, then re-record
 *
 * Exit code is non-zero if any fixture fails a threshold.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLibsidplayfp } from "../src/index.js";
import { CHANNELS, correlation, differenceDbfs, measure, SAMPLE_RATE } from "./engine-metrics.mjs";
import { ensureSystemRoms } from "./system-roms.mjs";
import { CHUNK_CYCLES, EDGE_FIXTURES, FIXTURES, RENDER_SECONDS, renderWith } from "../test/helpers/engine-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const GOLDENS_PATH = path.join(PACKAGE_ROOT, "test/fixtures/engine-goldens.json");

/**
 * Thresholds.
 *
 * SIDLite is integer-only, so its WASM and native builds are bit-identical:
 * correlation 1.0000000 with a zero error floor.
 *
 * reSIDfp is not, and cannot be. It builds its filter model with
 * `log1p(exp(x))` (FilterModelConfig6581.cpp) and its combined-waveform tables
 * with `pow()` (WaveformCalculator.cpp). IEEE-754 does not require either
 * function to be correctly rounded, so emscripten's musl-derived libm and
 * glibc legitimately disagree in the last bit. Computing libresidfp's own
 * 65 536-entry filter table both ways measures the disagreement exactly:
 *
 *     differing entries : 28 of 65536  (0.04%)
 *     max ULP difference: 1
 *
 * One ULP of a double is the smallest non-zero difference IEEE-754 can express,
 * so this is the floor. Forcing it to zero would mean building the native
 * control against musl too, which would stop it being an independent control,
 * or patching upstream's math, which would make our output differ from every
 * native build instead of one. Neither is a trade worth making for a table
 * perturbation that an IIR filter amplifies to at most 15 LSB out of 32768.
 *
 * On a healthy build the resulting gap is correlation > 0.99999 with an error
 * floor of −81 to −90 dBFS: inaudible, and far below the SID's own noise floor.
 * For scale, a mixer reading freed memory measures correlation 0.75 and roughly
 * −20 dBFS. So −60 dBFS leaves ~20 dB of headroom over observed noise while
 * still catching that defect by ~40 dB.
 *
 * What *is* required, and is asserted directly in test/binding-surface.test.ts,
 * is that each build is deterministic and chunk-size invariant.
 */
const THRESHOLDS = {
  correlation: 0.9999,
  errorRmsDbfs: -60,
  // Pearson correlation and relative level are not meaningful once a tune's
  // AC content is below this RMS level. At -55 dBFS and below, a 2-LSB implementation/libm
  // difference can lower correlation while remaining more than 20 dB beneath
  // the absolute error budget. Keep a tight instantaneous bound there too:
  // known-good native/WASM renders peak at 5 LSB across the full HVSC corpus.
  comparableRms: 0.005,
  quietMaxAbsLsb: 16,
  // Low-level tunes make a tiny absolute DC difference look large in dB.
  // The waveform threshold remains the primary fidelity discriminator.
  levelDb: 0.2,
  dc: 0.001,
};

const updateGoldens = process.argv.includes("--update-goldens");
const corpusArgument = process.argv.find((argument) => argument.startsWith("--corpus="));
const corpusFromPair = process.argv.indexOf("--corpus");
const corpus = corpusArgument
  ? corpusArgument.slice("--corpus=".length)
  : corpusFromPair >= 0
    ? process.argv[corpusFromPair + 1]
    : "fast";

if (corpus !== "fast" && corpus !== "edge") {
  throw new Error(`--corpus must be fast or edge, got: ${corpus}`);
}
if (updateGoldens && corpus !== "fast") {
  throw new Error("goldens are recorded from the fast corpus only; do not overwrite them from the edge sweep");
}

const fixtures = corpus === "edge" ? EDGE_FIXTURES : FIXTURES;
// The full corpus verifies every selected edge case. Half a second captures
// initialization and several play-routine calls while keeping the release gate
// practical on public runners; fidelity goldens retain the two-second sample.
const renderSeconds = corpus === "edge" ? 0.5 : RENDER_SECONDS;
const ENGINES = [
  { name: "residfp", builder: "WasmReSIDfp" },
  { name: "sidlite", builder: "WasmSIDLite" },
];

function readPinnedRef(library) {
  const upstream = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "upstream.json"), "utf8"));
  const ref = upstream[library]?.ref;
  if (typeof ref !== "string") throw new Error(`could not read ${library}.ref from upstream.json`);
  return ref;
}

const libsidplayfpRef = readPinnedRef("libsidplayfp");
const libresidfpRef = readPinnedRef("libresidfp");

console.log(`pinned refs: libsidplayfp ${libsidplayfpRef}, libresidfp ${libresidfpRef}`);

const nativeBinary = execFileSync("bash", [path.join(HERE, "build-native-reference.sh")], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
})
  .trim()
  .split("\n")
  .pop();

console.log(`native reference: ${nativeBinary}\n`);

const wasmModules = new Map();
for (const engine of ENGINES) {
  const wasmModule = await loadLibsidplayfp({ engine: engine.name });
  if (wasmModule.getSidEngineName() !== engine.builder) {
    throw new Error(
      `requested ${engine.name}, but the WASM artifact identifies itself as ${wasmModule.getSidEngineName()}`,
    );
  }
  wasmModules.set(engine.name, wasmModule);
}
const systemRoms = await ensureSystemRoms();
const scratch = mkdtempSync(path.join(tmpdir(), "sidflow-parity-"));

const rows = [];
const goldenFixtures = Object.fromEntries(ENGINES.map((engine) => [engine.name, {}]));
let failures = 0;

// The comparison table is only useful sorted and complete, so it is printed at
// the end. That leaves the sweep itself silent, and on the edge corpus that is
// thousands of fixtures and many minutes of nothing — indistinguishable from a
// hung job, which is an invitation to cancel a release that is in fact fine.
// So report progress as it goes; the table still lands at the end.
const totalComparisons = fixtures.length * ENGINES.length;
const progressEvery = Math.max(1, Math.ceil(fixtures.length / 20));
const startedAt = Date.now();
let completed = 0;

function reportProgress(engineName, index) {
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = completed / Math.max(elapsed, 0.001);
  const remaining = rate > 0 ? (totalComparisons - completed) / rate : 0;
  console.log(
    `[parity] ${engineName} ${index + 1}/${fixtures.length}` +
      ` — ${completed}/${totalComparisons} total,` +
      ` ${elapsed.toFixed(0)}s elapsed, ~${remaining.toFixed(0)}s remaining,` +
      ` ${failures} failing so far`,
  );
}

try {
  for (const engine of ENGINES) {
    const wasmModule = wasmModules.get(engine.name);
    console.log(`[parity] ${engine.name}: comparing ${fixtures.length} fixtures against the native build`);
    for (const [index, fixture] of fixtures.entries()) {
      const wasm = renderWith(wasmModule, fixture.file, CHUNK_CYCLES, renderSeconds);
      const nativeRaw = path.join(scratch, `${engine.name}-${index}.raw`);
      execFileSync(nativeBinary, [fixture.file, String(renderSeconds), nativeRaw, "0", engine.name, systemRoms.dir], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const nativeBuffer = readFileSync(nativeRaw);
      const native = new Int16Array(nativeBuffer.buffer, nativeBuffer.byteOffset, nativeBuffer.byteLength / 2);

      const length = Math.min(wasm.length, native.length);
      const a = wasm.subarray(0, length);
      const b = native.subarray(0, length);
      const corr = correlation(a, b);
      const diff = differenceDbfs(a, b);
      const wasmStats = measure(a);
      const nativeStats = measure(b);
      const levelDb = 20 * Math.log10((wasmStats.rms + 1e-30) / (nativeStats.rms + 1e-30));
      const dcDelta = Math.abs(wasmStats.dc - nativeStats.dc);
      // Pearson correlation subtracts the mean. Use the matching AC measure
      // here, otherwise a held DC frame can incorrectly promote a nearly
      // silent transient into the correlation-only branch.
      const isQuiet = Math.max(wasmStats.acRms, nativeStats.acRms) < THRESHOLDS.comparableRms;

      const problems = [];
      if (length === 0) problems.push("one renderer produced no samples");
      if (!isQuiet && !(corr >= THRESHOLDS.correlation))
        problems.push(`correlation ${corr.toFixed(6)} < ${THRESHOLDS.correlation}`);
      if (!(diff.rmsDbfs <= THRESHOLDS.errorRmsDbfs))
        problems.push(`error ${diff.rmsDbfs.toFixed(1)} dBFS > ${THRESHOLDS.errorRmsDbfs}`);
      if (isQuiet && diff.maxAbsLsb > THRESHOLDS.quietMaxAbsLsb)
        problems.push(`quiet max difference ${diff.maxAbsLsb} LSB > ${THRESHOLDS.quietMaxAbsLsb}`);
      if (!isQuiet && !(Math.abs(levelDb) <= THRESHOLDS.levelDb))
        problems.push(`level ${levelDb.toFixed(3)} dB`);
      if (!(dcDelta <= THRESHOLDS.dc)) problems.push(`DC delta ${dcDelta.toFixed(5)}`);

      if (problems.length > 0) failures++;
      rows.push({
        engine: engine.name,
        name: fixture.name,
        corr,
        errDb: diff.rmsDbfs,
        maxLsb: diff.maxAbsLsb,
        levelDb,
        status: problems.length === 0 ? "ok" : problems.join("; "),
      });

      goldenFixtures[engine.name][fixture.name] = {
        dc: wasmStats.dc,
        rms: wasmStats.rms,
        peak: wasmStats.peak,
        bandsDb: wasmStats.bandsDb,
        envelope: wasmStats.envelope,
      };

      completed++;
      if (completed % progressEvery === 0 || index === fixtures.length - 1) {
        reportProgress(engine.name, index);
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`native parity corpus: ${corpus} (${fixtures.length} fixtures x ${ENGINES.length} engines)`);
console.log(`${pad("engine", 9)}${pad("fixture", 48)}${pad("corr", 12)}${pad("errRMS", 11)}${pad("maxΔ", 8)}${pad("level", 10)}status`);
console.log("-".repeat(90));
for (const row of rows) {
  console.log(
    pad(row.engine, 9) +
      pad(row.name, 48) +
      pad(row.corr.toFixed(7), 12) +
      pad(`${row.errDb.toFixed(1)} dB`, 11) +
      pad(`${row.maxLsb}`, 8) +
      pad(`${row.levelDb >= 0 ? "+" : ""}${row.levelDb.toFixed(3)} dB`, 10) +
      row.status,
  );
}
console.log();

if (failures > 0) {
  console.error(
    `${failures} fixture(s) failed the native parity thresholds.\n` +
      `The wasm engine does not match a native build of the same library. A mixer holding\n` +
      `freed chip buffers is the classic cause. Reproduce it under AddressSanitizer, which\n` +
      `names the offending access directly:\n` +
      `    SIDFLOW_EXTRA_FLAGS=-fsanitize=address bun run build:wasm`,
  );
  process.exit(1);
}

console.log("native parity: all fixtures within thresholds");

if (updateGoldens) {
  const goldens = {
    // Recorded so a ref bump cannot silently invalidate the tolerances.
    libsidplayfpRef,
    libresidfpRef,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    renderSeconds,
    chunkCycles: CHUNK_CYCLES,
    generatedBy: "scripts/native-parity.mjs --update-goldens",
    note: "Regenerate only after native parity passes. Never hand-edit to silence a failing test.",
    engines: goldenFixtures,
  };
  writeFileSync(GOLDENS_PATH, `${JSON.stringify(goldens, null, 2)}\n`);
  console.log(`goldens rewritten: ${path.relative(PACKAGE_ROOT, GOLDENS_PATH)}`);
}
