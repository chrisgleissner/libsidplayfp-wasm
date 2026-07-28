import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  loadLibsidplayfp,
  SidAudioEngine,
  type SidEngine,
} from "../src/index.js";
import { measure } from "../scripts/engine-metrics.mjs";
import { ensureSystemRoms } from "../scripts/system-roms.mjs";
import { FIXTURE_CASES } from "./helpers/engine-fixtures.js";

const ENGINES: Array<{ engine: SidEngine; builder: string }> = [
  { engine: "residfp", builder: "WasmReSIDfp" },
  { engine: "sidlite", builder: "WasmSIDLite" },
];
const TONE = new Uint8Array(
  readFileSync(path.resolve(import.meta.dirname, "../test-tone-c4.sid")),
);
const ROMS = await ensureSystemRoms();

describe.each(ENGINES)(
  "public API contract: $engine",
  ({ engine, builder }) => {
    it("rejects malformed SID input and reports invalid ROM sizes", async () => {
      const wasm = await loadLibsidplayfp({ engine, locateFile: undefined });
      expect(wasm.getSidEngineName()).toBe(builder);
      const context = new wasm.SidPlayerContext();
      try {
        expect(context.configure(44_100, true)).toBe(true);
        expect(
          context.setSystemROMs(
            new Uint8Array(1),
            new Uint8Array(1),
            new Uint8Array(1),
          ),
        ).toBe(false);
        expect(context.getLastError()).toContain("8192");
        expect(() => context.loadSidBuffer(new Uint8Array(128))).toThrow();
      } finally {
        context.delete();
      }

      const engineWrapper = new SidAudioEngine({ engine });
      try {
        await expect(
          engineWrapper.loadSidBuffer(new Uint8Array(128)),
        ).rejects.toThrow();
        expect(await engineWrapper.renderSeconds(0.01)).toEqual(
          new Int16Array(0),
        );
        await expect(engineWrapper.selectSong(0)).rejects.toThrow("Load a SID");
      } finally {
        engineWrapper.dispose();
      }
    });

    it("preserves ArrayBufferView boundaries, tracing, frame counts, and disposal", async () => {
      const padded = new Uint8Array(TONE.length + 8);
      padded.set(TONE, 4);
      const engineWrapper = new SidAudioEngine({
        engine,
        sampleRate: 48_000,
        stereo: true,
      });
      try {
        engineWrapper.setSidWriteTraceEnabled(true);
        await engineWrapper.loadSidBuffer(
          padded.subarray(4, padded.length - 4),
        );
        const progress: number[] = [];
        const pcm = await engineWrapper.renderFrames(
          1_024,
          5_000,
          (samplesWritten) => progress.push(samplesWritten),
        );
        expect(pcm.length).toBe(2_048);
        expect(pcm.some((sample) => sample !== 0)).toBe(true);
        expect(progress.at(-1)).toBe(pcm.length);
        expect(
          progress.every(
            (value, index) => index === 0 || value > progress[index - 1]!,
          ),
        ).toBe(true);
        expect(
          engineWrapper.getAndClearSidWriteTraces().length,
        ).toBeGreaterThan(0);
        expect(engineWrapper.getAndClearSidWriteTraces()).toEqual([]);
        engineWrapper.reset();
        expect((await engineWrapper.renderSeconds(0.02)).length).toBe(1_920);
      } finally {
        engineWrapper.dispose();
      }

      expect(() => engineWrapper.getChannels()).toThrow("not initialized");
      expect(await engineWrapper.renderSeconds(0.02)).toEqual(
        new Int16Array(0),
      );
    });

    describe.each(FIXTURE_CASES)("$name", ({ file, header }) => {
      it("plays through the wrapper with VICE ROMs and survives song reselection", async () => {
        const engineWrapper = new SidAudioEngine({
          engine,
          sampleRate: 44_100,
          stereo: true,
        });
        try {
          await engineWrapper.setSystemROMs(
            ROMS.kernal,
            ROMS.basic,
            ROMS.chargen,
          );
          await engineWrapper.loadSidBuffer(new Uint8Array(readFileSync(file)));
          // Several legitimate RSID and multi-SID programs initialise through
          // interrupt-driven C64 code and can begin with one held frame. A full
          // two-second window proves that playback progresses, rather than
          // mistaking that deterministic startup state for silence.
          const first = await engineWrapper.renderSeconds(2, 20_000);
          const stats = measure(first);
          expect(first.length).toBe(176_400);
          expect(stats.acRms).toBeGreaterThan(0.0001);
          expect(stats.peak).toBeLessThan(0.9);
          expect(engineWrapper.getTuneInfo()).not.toBeNull();

          const selected = await engineWrapper.selectSong(
            Number.MAX_SAFE_INTEGER,
          );
          expect(selected).toBeGreaterThanOrEqual(0);
          expect(selected).toBeLessThan(header.songs);
          const second = await engineWrapper.renderSeconds(0.5, 20_000);
          expect(second.length).toBe(44_100);
          expect(measure(second).acRms).toBeGreaterThan(0.0001);
        } finally {
          engineWrapper.dispose();
        }
      }, 60_000);
    });
  },
);
