import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SidAudioEngine } from "../src/index.js";

const TUNE = new Uint8Array(
  readFileSync(path.join(import.meta.dirname, "fixtures/test-tone-c4.sid")),
);

/**
 * libsidplayfp cannot skip: a seek emulates every cycle up to the target, so its
 * cost is linear in the distance. An unbounded seek therefore has no failure
 * mode — a caller who passes milliseconds where seconds were wanted gets no
 * error and no result, just a render that runs for hours. On a main thread that
 * is a frozen tab, which is worse than an exception.
 */
describe("seek bounds", () => {
  it("refuses a seek far beyond any real tune rather than rendering for hours", async () => {
    const engine = new SidAudioEngine({ engine: "sidlite" });
    try {
      await engine.loadSidBuffer(TUNE, 0);

      await expect(engine.seekSeconds(99_999)).rejects.toThrow(RangeError);
      // The number a caller most plausibly gets wrong: milliseconds for seconds.
      await expect(engine.seekSeconds(60_000)).rejects.toThrow(/at most 3600 seconds/);
    } finally {
      await engine.dispose();
    }
  });

  it("still allows a seek at the limit", async () => {
    const engine = new SidAudioEngine({ engine: "sidlite" });
    try {
      await engine.loadSidBuffer(TUNE, 0);

      // Accepted, and bounded by where the tune actually ends.
      expect(await engine.seekSeconds(3600)).toBeGreaterThanOrEqual(0);
    } finally {
      await engine.dispose();
    }
  }, 120_000);
});
