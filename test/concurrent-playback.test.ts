import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SidAudioEngine, type SidEngine } from "../src/index.js";
import { measure } from "../scripts/engine-metrics.mjs";

const TONE = new Uint8Array(
  readFileSync(path.resolve(import.meta.dirname, "../test-tone-c4.sid")),
);
const ENGINES: SidEngine[] = ["residfp", "sidlite"];

describe("concurrent playback", () => {
  it("renders independent streams concurrently from shared engine modules", async () => {
    const jobs = Array.from({ length: 16 }, async (_, index) => {
      const engine = new SidAudioEngine({
        engine: ENGINES[index % ENGINES.length],
      });
      try {
        await engine.loadSidBuffer(TONE);
        const pcm = await engine.renderSeconds(0.2, 20_000);
        return {
          engine: await engine.getEngineName(),
          samples: pcm.length,
          acRms: measure(pcm).acRms,
        };
      } finally {
        engine.dispose();
      }
    });

    const results = await Promise.all(jobs);
    expect(results).toHaveLength(16);
    for (const result of results) {
      expect(["WasmReSIDfp", "WasmSIDLite"]).toContain(result.engine);
      expect(result.samples).toBe(17_640);
      expect(result.acRms).toBeGreaterThan(0.0001);
    }
  });
});
