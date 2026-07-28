/**
 * Native-validated non-degradation gate for both shipped engines.
 *
 * A broken artifact can load and return plausible PCM while using the wrong
 * builder and corrupting mixer buffers. Goldens are deliberately generated
 * only by scripts/native-parity.mjs after each WASM engine has passed against
 * a native libsidplayfp build at the same pinned upstream refs.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLibsidplayfp, type SidEngine } from "../src/index.js";
import { BANDS, CHANNELS, correlation, differenceDbfs, measure, SAMPLE_RATE } from "../scripts/engine-metrics.mjs";
import { CHUNK_CYCLES, FIXTURES, RENDER_SECONDS, renderWith } from "./helpers/engine-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");

type Golden = {
  dc: number;
  rms: number;
  peak: number;
  bandsDb: number[];
  envelope: number[];
};

type GoldenDocument = {
  libsidplayfpRef: string;
  libresidfpRef: string;
  sampleRate: number;
  channels: number;
  renderSeconds: number;
  chunkCycles: number;
  engines: Record<SidEngine, Record<string, Golden>>;
};

const goldens = JSON.parse(readFileSync(path.join(HERE, "fixtures/engine-goldens.json"), "utf8")) as GoldenDocument;

const ENGINES: Array<{ engine: SidEngine; builder: string; artifact: string }> = [
  { engine: "residfp", builder: "WasmReSIDfp", artifact: "dist/libsidplayfp.wasm" },
  { engine: "sidlite", builder: "WasmSIDLite", artifact: "dist/sidlite/libsidplayfp.wasm" },
];

const TOLERANCE = {
  dc: 0.01,
  rmsDb: 0.5,
  peak: 0.05,
  bandDb: 1.5,
  envelopeCorrelation: 0.999,
};

const STABILITY = {
  correlation: 0.9999,
  errorRmsDbfs: -60,
};

const RENDER_TEST_TIMEOUT_MS = 60_000;
const wasmModules = new Map<SidEngine, Awaited<ReturnType<typeof loadLibsidplayfp>>>();

beforeAll(async () => {
  for (const { engine, builder } of ENGINES) {
    const wasmModule = await loadLibsidplayfp({ engine });
    expect(wasmModule.getSidEngineName(), `loader returned the wrong artifact for ${engine}`).toBe(builder);
    wasmModules.set(engine, wasmModule);
  }
});

function render(engine: SidEngine, file: string): Int16Array {
  const wasmModule = wasmModules.get(engine);
  if (!wasmModule) throw new Error(`WASM module not loaded for ${engine}`);
  return renderWith(wasmModule, file, CHUNK_CYCLES, RENDER_SECONDS);
}

describe.each(ENGINES)("engine identity: $engine", ({ engine, builder, artifact }) => {
  it("contains exactly its requested builder", () => {
    const symbols = readFileSync(path.join(PACKAGE_ROOT, artifact)).toString("latin1");
    const otherBuilder = ENGINES.find((candidate) => candidate.engine !== engine)?.builder;
    expect(symbols.includes(builder), `${artifact} does not contain ${builder}`).toBe(true);
    expect(symbols.includes(otherBuilder!), `${artifact} contains ${otherBuilder}; it is not a pure ${engine} build`).toBe(false);
  });
});

describe.each(ENGINES)("engine non-degradation: $engine", ({ engine }) => {
  describe.each(FIXTURES)("$name", ({ name, file }) => {
    it("renders a progressing audio stream", () => {
      const stats = measure(render(engine, file));
      expect(stats.frames, `${engine}/${name}: engine stopped producing samples early`).toBeGreaterThan(SAMPLE_RATE);
      expect(stats.acRms, `${engine}/${name}: held a DC frame instead of advancing`).toBeGreaterThan(0.0001);
    }, RENDER_TEST_TIMEOUT_MS);

    it("is stable across repeated renders", () => {
      const a = render(engine, file);
      const b = render(engine, file);
      const corr = correlation(a, b);
      const diff = differenceDbfs(a, b);
      expect(
        corr,
        `${engine}/${name}: two identical renders correlate only ${corr.toFixed(6)}`,
      ).toBeGreaterThan(STABILITY.correlation);
      expect(
        diff.rmsDbfs,
        `${engine}/${name}: run-to-run difference is ${diff.rmsDbfs.toFixed(1)} dBFS`,
      ).toBeLessThan(STABILITY.errorRmsDbfs);
    }, RENDER_TEST_TIMEOUT_MS);

    it("matches the native-validated golden within tolerance", () => {
      const golden = goldens.engines[engine]?.[name];
      expect(golden, `no ${engine} golden for ${name}; run scripts/native-parity.mjs --update-goldens`).toBeDefined();
      if (!golden) return;

      const stats = measure(render(engine, file));
      const hint =
        "\nIf this is an intended engine change, re-validate natively and regenerate:\n" +
        "    bun run scripts/native-parity.mjs --update-goldens\n" +
        "Do NOT hand-edit test/fixtures/engine-goldens.json to silence this.";

      expect(Math.abs(stats.dc - golden.dc), `${engine}/${name}: DC moved ${golden.dc} -> ${stats.dc}${hint}`).toBeLessThan(
        TOLERANCE.dc,
      );
      const rmsDb = 20 * Math.log10((stats.rms + 1e-30) / (golden.rms + 1e-30));
      expect(Math.abs(rmsDb), `${engine}/${name}: level moved ${rmsDb.toFixed(2)} dB${hint}`).toBeLessThan(TOLERANCE.rmsDb);
      expect(Math.abs(stats.peak - golden.peak), `${engine}/${name}: peak moved${hint}`).toBeLessThan(TOLERANCE.peak);

      stats.bandsDb.forEach((db, index) => {
        const [lo, hi] = BANDS[index]!;
        const delta = db - golden.bandsDb[index]!;
        expect(Math.abs(delta), `${engine}/${name}: ${lo}-${hi} Hz moved ${delta.toFixed(2)} dB${hint}`).toBeLessThan(
          TOLERANCE.bandDb,
        );
      });

      expect(
        correlation(stats.envelope, golden.envelope),
        `${engine}/${name}: loudness envelope no longer follows the golden${hint}`,
      ).toBeGreaterThan(TOLERANCE.envelopeCorrelation);
    }, RENDER_TEST_TIMEOUT_MS);
  });
});

describe("golden provenance", () => {
  it("matches the pinned upstream refs and the current fixture set", () => {
    const upstream = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "upstream.json"), "utf8")) as {
      libsidplayfp: { ref: string };
      libresidfp: { ref: string };
    };
    const hint = "\nRe-validate natively and regenerate with:\n    bun run scripts/native-parity.mjs --update-goldens";

    expect(goldens.libsidplayfpRef, `libsidplayfp ref drifted${hint}`).toBe(upstream.libsidplayfp.ref);
    expect(goldens.libresidfpRef, `libresidfp ref drifted${hint}`).toBe(upstream.libresidfp.ref);
    expect(goldens.renderSeconds).toBe(RENDER_SECONDS);
    expect(goldens.chunkCycles).toBe(CHUNK_CYCLES);
    expect(goldens.sampleRate).toBe(SAMPLE_RATE);
    expect(goldens.channels).toBe(CHANNELS);

    for (const { engine } of ENGINES) {
      expect(
        Object.keys(goldens.engines[engine]).sort(),
        `goldens cover a different ${engine} fixture set than the tests render`,
      ).toEqual(FIXTURES.map((fixture) => fixture.name).sort());
    }
  });
});
