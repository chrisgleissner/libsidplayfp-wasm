import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SidAudioEngine } from "../src/player.js";
import { ensureHvsc85Fixtures } from "../scripts/hvsc-fixtures.mjs";
import { ensureSystemRoms } from "../scripts/system-roms.mjs";

const fixtures = await ensureHvsc85Fixtures();
const roms = await ensureSystemRoms();
const bytes = new Uint8Array(readFileSync(path.join(
  fixtures.c64MusicRoot, "MUSICIANS/A/Andy/Justincase_part_6.sid",
)));
expect(createHash("sha256").update(bytes).digest("hex")).toBe(
  "c71f6df2c987f591dc82f61d8e69180c05229c7cce4bdc04c1c6474eecd5d68c",
);

describe("SIDLite capacity with raster-sensitive Justincase part 6", () => {
  for (const sampleRate of [8000, 48000]) {
    it(`retains complete stable PCM for the raster-sensitive input at ${sampleRate} Hz`, async () => {
      const render = async (pull: number): Promise<Int16Array> => {
        const engine = new SidAudioEngine({ engine: "sidlite", sampleRate, stereo: true });
        try {
          await engine.setSystemROMs(roms.kernal, roms.basic, roms.chargen);
          await engine.loadSidBuffer(bytes, 0);
          await engine.setEmulationConfig({ powerOnDelay: 5000 });
          return await engine.renderSeconds(2, pull);
        } finally {
          engine.dispose();
        }
      };
      for (const pull of [256, 100000]) {
        const reference = await render(pull);
        expect(reference.length).toBe(sampleRate * 2 * 2);
        expect(await render(pull)).toEqual(reference);
      }
    }, 60000);
  }
});
