import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import loadLibsidplayfp, { type SidEngine } from "../src/index.js";

const RUN_SOAK = process.env.LIBSIDPLAYFP_WASM_SOAK === "1";
const VIRTUAL_SECONDS = Number(
  process.env.LIBSIDPLAYFP_WASM_SOAK_SECONDS ?? 30 * 60,
);
const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const TONE = new Uint8Array(
  readFileSync(path.resolve(import.meta.dirname, "fixtures/test-tone-c4.sid")),
);

type HeapExport = { HEAPU8?: Uint8Array };

if (!Number.isInteger(VIRTUAL_SECONDS) || VIRTUAL_SECONDS <= 0) {
  throw new Error("LIBSIDPLAYFP_WASM_SOAK_SECONDS must be a positive integer");
}

async function soakEngine(engine: SidEngine): Promise<void> {
  const wasm = (await loadLibsidplayfp({ engine })) as Awaited<
    ReturnType<typeof loadLibsidplayfp>
  > &
    HeapExport;
  const context = new wasm.SidPlayerContext();
  try {
    expect(context.configure(SAMPLE_RATE, true)).toBe(true);
    expect(context.loadSidBuffer(TONE)).toBe(true);

    // Warm-up allocations before taking the baseline. The test then simulates
    // thirty minutes of continuous playback without retaining rendered PCM.
    for (let index = 0; index < 20; index += 1) context.render(100_000);
    const baseline = wasm.HEAPU8?.buffer.byteLength;
    const samplesTarget = VIRTUAL_SECONDS * SAMPLE_RATE * CHANNELS;
    const samplesPerCheckpoint = Math.floor(samplesTarget / 6);
    const heapSamples: number[] = [];
    let rendered = 0;
    let nextCheckpoint = samplesPerCheckpoint;
    let emptyReads = 0;

    while (rendered < samplesTarget) {
      const chunk = context.render(100_000);
      if (!chunk || chunk.length === 0) {
        if (++emptyReads > 128) {
          throw new Error(
            `${engine} stopped before the thirty-minute soak completed`,
          );
        }
        continue;
      }
      emptyReads = 0;
      rendered += chunk.length;
      if (rendered >= nextCheckpoint) {
        const heapBytes = wasm.HEAPU8?.buffer.byteLength;
        if (heapBytes !== undefined) heapSamples.push(heapBytes);
        nextCheckpoint += samplesPerCheckpoint;
      }
    }

    expect(rendered).toBeGreaterThanOrEqual(samplesTarget);
    if (baseline !== undefined) {
      expect(heapSamples).not.toHaveLength(0);
      // Any change after warm-up is a retained WASM allocation. A stable
      // linear heap over all six equal-duration windows catches slow leaks that
      // conventional short rendering tests cannot see.
      expect(heapSamples.every((size) => size === baseline)).toBe(true);
    }
  } finally {
    context.delete();
  }
}

const soak = RUN_SOAK ? test : test.skip;

// This is an explicit operational gate, run locally with `bun run test:soak`
// and by the weekly GitHub Actions workflow. It is skipped in normal unit runs
// because it deliberately performs thirty minutes of virtual playback.
soak(
  "renders the configured virtual soak duration per engine without WASM heap growth",
  { timeout: 1_800_000 },
  async () => {
    await soakEngine("sidlite");
    await soakEngine("residfp");
  },
);
