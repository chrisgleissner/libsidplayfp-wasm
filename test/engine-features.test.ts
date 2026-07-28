import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LIBRESIDFP_VERSION,
  LIBSIDPLAYFP_VERSION,
  PACKAGE_VERSION,
  SidAudioEngine,
  UPSTREAM_COMMITS,
  loadLibsidplayfp,
  type SidEngine,
} from "../src/index.js";
import { measure } from "../scripts/engine-metrics.mjs";

const ENGINES: SidEngine[] = ["residfp", "sidlite"];
const TONE = new Uint8Array(
  readFileSync(path.resolve(import.meta.dirname, "../test-tone-c4.sid")),
);

describe("upstream provenance", () => {
  it("exports the exact upstream releases the build contains", () => {
    const upstream = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../upstream.json"), "utf8"),
    );
    const packageJson = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    );

    expect(LIBSIDPLAYFP_VERSION).toBe(upstream.libsidplayfp.ref.slice(1));
    expect(LIBRESIDFP_VERSION).toBe(upstream.libresidfp.ref.slice(1));
    expect(UPSTREAM_COMMITS.libsidplayfp).toBe(upstream.libsidplayfp.commit);
    expect(UPSTREAM_COMMITS.libresidfp).toBe(upstream.libresidfp.commit);
    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });
});

describe("seeking positions the live context", () => {
  it("skips the full requested duration rather than a cycle-derived fraction", async () => {
    const engine = new SidAudioEngine({ engine: "sidlite" });
    try {
      await engine.loadSidBuffer(TONE);
      const channels = engine.getChannels();
      const sampleRate = engine.getSampleRate();

      // A cycles-per-chunk budget applied to a sample target stops roughly 15x
      // short of a 60 s seek, because libsidplayfp clamps every play() call to
      // 20 000 cycles and returns ~1 790 samples for it.
      const skipped = await engine.seekSeconds(60);
      expect(skipped).toBe(60 * sampleRate * channels);
    } finally {
      engine.dispose();
    }
  }, 60_000);

  it("moves the audio, not just the reported sample count", async () => {
    const engine = new SidAudioEngine({ engine: "sidlite" });
    try {
      await engine.loadSidBuffer(TONE);
      await engine.seekSeconds(0);
      const fromStart = await engine.renderSeconds(0.25);
      const timeAtStart = engine.getTimeMs();

      await engine.seekSeconds(5);
      const afterSeek = await engine.renderSeconds(0.25);
      const timeAfterSeek = engine.getTimeMs();

      expect(afterSeek.length).toBe(fromStart.length);
      // libsidplayfp's own clock is the independent witness: if seekSeconds
      // only reported a number without advancing the context, these would match.
      expect(timeAfterSeek).toBeGreaterThan(timeAtStart + 4_000);
    } finally {
      engine.dispose();
    }
  }, 60_000);

  it("rejects a non-finite seek position", async () => {
    const engine = new SidAudioEngine({ engine: "sidlite" });
    try {
      await engine.loadSidBuffer(TONE);
      await expect(engine.seekSeconds(Number.NaN)).rejects.toThrow("finite");
    } finally {
      engine.dispose();
    }
  });
});

describe("render cache stays within its budget", () => {
  it("refuses a cache budget that would exhaust a mobile browser", () => {
    expect(() => new SidAudioEngine({ cacheSecondsLimit: 100_000 })).toThrow(
      "cacheSecondsLimit",
    );
    expect(() => new SidAudioEngine({ cacheSecondsLimit: 0 })).toThrow(
      "cacheSecondsLimit",
    );
    expect(() => new SidAudioEngine({ cacheSecondsLimit: Number.NaN })).toThrow(
      "cacheSecondsLimit",
    );
  });

  it("caps the cache at the configured number of seconds", async () => {
    const engine = new SidAudioEngine({
      engine: "sidlite",
      sampleRate: 8_000,
      stereo: false,
      cacheSecondsLimit: 1,
    });
    try {
      await engine.loadSidBuffer(TONE);
      expect(await engine.waitForCacheReady()).toBe(true);
      const segment = engine.getCachedSegment(0, 1);
      expect(segment).not.toBeNull();
      expect(segment!.length).toBe(8_000);
      // One second past the budget is not in the cache, so it reports null
      // rather than a short or fabricated buffer.
      expect(engine.getCachedSegment(1, 1)).toBeNull();
    } finally {
      engine.dispose();
    }
  }, 60_000);
});

describe.each(ENGINES)("libsidplayfp feature surface: %s", (engine) => {
  it("reports tune identity, chip layout, and playback clock", async () => {
    const player = new SidAudioEngine({ engine });
    try {
      await player.loadSidBuffer(TONE);

      // The HVSC Songlengths.md5 key, which needs libsidplayfp's bundled MD5.
      expect(player.getTuneMd5()).toMatch(/^[0-9a-f]{32}$/);
      expect(player.getInstalledSids()).toBeGreaterThanOrEqual(1);
      expect(player.hasTune()).toBe(true);
      expect(player.isStereo()).toBe(true);

      const info = player.getTuneInfo();
      expect(info).not.toBeNull();
      expect(info!.sidChipBases.length).toBe(info!.sidChips);
      expect(info!.sidModels.length).toBe(info!.sidChips);
      expect(["UNKNOWN", "PAL", "NTSC", "ANY"]).toContain(info!.clock);
      expect(["C64", "PSID", "R64", "BASIC"]).toContain(info!.compatibility);

      const engineInfo = player.getEngineInfo();
      expect(engineInfo!.builder).toBe(
        engine === "residfp" ? "WasmReSIDfp" : "WasmSIDLite",
      );
      expect(engineInfo!.installedSids).toBe(player.getInstalledSids());

      const before = player.getTimeMs();
      await player.renderSeconds(0.5);
      expect(player.getTimeMs()).toBeGreaterThan(before);
      expect(player.getCia1TimerA()).toBeGreaterThan(0);
    } finally {
      player.dispose();
    }
  }, 60_000);

  it("reads back SID registers for a visualiser", async () => {
    const player = new SidAudioEngine({ engine });
    try {
      await player.loadSidBuffer(TONE);
      await player.renderSeconds(0.2);

      const registers = player.getSidStatus(0);
      expect(registers).not.toBeNull();
      expect(registers!.length).toBe(32);
      // A tone tune has written a frequency and a waveform by now.
      expect(registers!.some((value) => value !== 0)).toBe(true);

      // Out-of-range chips are refused, not silently clamped to chip 0.
      expect(player.getSidStatus(7)).toBeNull();
    } finally {
      player.dispose();
    }
  }, 60_000);

  it("mutes voices and bypasses the filter", async () => {
    const player = new SidAudioEngine({ engine });
    try {
      await player.loadSidBuffer(TONE);
      const audible = measure(await player.renderSeconds(0.5, 20_000));
      expect(audible.acRms).toBeGreaterThan(0.0001);

      await player.seekSeconds(0);
      for (const voice of [0, 1, 2]) player.mute(0, voice, true);
      const silenced = measure(await player.renderSeconds(0.5, 20_000));
      expect(silenced.acRms).toBeLessThan(audible.acRms);

      player.setFilterEnabled(0, false);

      expect(() => player.mute(0, 3, true)).toThrow("voice");
      expect(() => player.mute(9, 0, true)).toThrow("out of range");
    } finally {
      player.dispose();
    }
  }, 60_000);

  it("applies SidConfig and reports the resolved configuration", async () => {
    const player = new SidAudioEngine({ engine });
    try {
      await player.loadSidBuffer(TONE);

      await player.setEmulationConfig({
        c64Model: "NTSC",
        forceC64Model: true,
        sidModel: "MOS6581",
        forceSidModel: true,
        digiBoost: false,
        samplingMethod: "INTERPOLATE",
        powerOnDelay: 1_234,
      });

      const resolved = player.getEmulationConfig();
      expect(resolved.c64Model).toBe("NTSC");
      expect(resolved.forceC64Model).toBe(true);
      expect(resolved.sidModel).toBe("MOS6581");
      expect(resolved.digiBoost).toBe(false);
      expect(resolved.samplingMethod).toBe("INTERPOLATE");
      expect(resolved.powerOnDelay).toBe(1_234);

      // A forced model change must still render, not just be recorded.
      expect(measure(await player.renderSeconds(0.5, 20_000)).acRms).toBeGreaterThan(
        0.0001,
      );

      await expect(
        player.setEmulationConfig({ c64Model: "AMIGA" as never }),
      ).rejects.toThrow("unknown c64Model");
      await expect(
        player.setEmulationConfig({ frequency: 1 }),
      ).rejects.toThrow("frequency");
      await expect(
        player.setEmulationConfig({ secondSidAddress: 0x1_0000 }),
      ).rejects.toThrow("16-bit address");
    } finally {
      player.dispose();
    }
  }, 60_000);

  it("exposes reSIDfp filter tuning only on the engine that has it", async () => {
    // filter6581Range and old6581Caps mutate reSIDfp's FilterModelConfig6581
    // singleton, so they reach every player sharing a WASM module. An
    // uncacheable load gives this test its own module instance and keeps the
    // change out of every other test's engine.
    const player = new SidAudioEngine({
      module: loadLibsidplayfp({ engine, locateFile: undefined }),
    });
    try {
      await player.loadSidBuffer(TONE);
      expect(player.supportsFilterConfig()).toBe(engine === "residfp");

      if (engine === "residfp") {
        player.setFilterConfig({
          filter6581Curve: 0.6,
          filter6581Range: 0.4,
          filter8580Curve: 0.7,
          old6581Caps: true,
          combinedWaveforms: "STRONG",
        });
        expect(
          measure(await player.renderSeconds(0.3, 20_000)).acRms,
        ).toBeGreaterThan(0.0001);
        expect(() => player.setFilterConfig({ filter6581Curve: 5 })).toThrow(
          "0.0..1.0",
        );
        expect(() =>
          player.setFilterConfig({ combinedWaveforms: "LOUD" as never }),
        ).toThrow("unknown combinedWaveforms");
      } else {
        expect(() => player.setFilterConfig({ filter6581Curve: 0.5 })).toThrow(
          "SIDLite",
        );
      }
    } finally {
      player.dispose();
    }
  }, 60_000);

  it("reports whether custom ROMs are actually in effect", async () => {
    const player = new SidAudioEngine({ engine });
    try {
      expect(player.getRomStatus()).toEqual({
        requested: false,
        active: false,
        kernal: false,
        basic: false,
        chargen: false,
      });

      await player.setSystemROMs(new Uint8Array(8_192), null, null);
      expect(player.getRomStatus()).toEqual({
        requested: true,
        active: true,
        kernal: true,
        basic: false,
        chargen: false,
      });
    } finally {
      player.dispose();
    }
  }, 60_000);

  it("throws a clear error for engine calls before a tune is loaded", async () => {
    const player = new SidAudioEngine({ engine });
    try {
      expect(() => player.getEmulationConfig()).toThrow("not initialized");
      expect(() => player.getTimeMs()).toThrow("not initialized");
      expect(player.getEngineInfo()).toBeNull();
      expect(player.getSidStatus(0)).toBeNull();
      expect(player.getTuneMd5()).toBeNull();
      expect(player.getInstalledSids()).toBe(0);
      expect(player.hasTune()).toBe(false);
    } finally {
      player.dispose();
    }
  }, 60_000);
});

describe("SID write tracing", () => {
  it("packs traces without one JS object per record and counts drops", async () => {
    const wasm = await loadLibsidplayfp({ engine: "sidlite" });
    const context = new wasm.SidPlayerContext();
    try {
      expect(context.configure(44_100, true)).toBe(true);
      context.setSidWriteTraceEnabled(true);
      expect(context.loadSidBuffer(TONE)).toBe(true);
      context.render(100_000);

      const packed = context.getAndClearSidWriteTracesPacked();
      expect(packed).toBeInstanceOf(Float64Array);
      expect(packed.length % 4).toBe(0);
      expect(packed.length).toBeGreaterThan(0);
      for (let index = 0; index < packed.length; index += 4) {
        expect(packed[index]).toBe(0); // single-SID tune
        expect(packed[index + 1]).toBeLessThan(32); // register address
        expect(packed[index + 2]).toBeLessThan(256); // byte value
        expect(packed[index + 3]).toBeGreaterThanOrEqual(0); // PHI1 cycle
      }
      // Draining clears, so a second call on an unrendered context is empty.
      expect(context.getAndClearSidWriteTracesPacked().length).toBe(0);
      expect(context.getDroppedSidWriteTraceCount()).toBe(0);
    } finally {
      context.delete();
    }
  }, 60_000);
});

describe("sample-rate validation", () => {
  it("refuses a rate no C64 audio path could use", async () => {
    const wasm = await loadLibsidplayfp({ engine: "sidlite" });
    const context = new wasm.SidPlayerContext();
    try {
      expect(context.configure(0, true)).toBe(false);
      expect(context.getLastError()).toContain("sample rate");
      expect(context.configure(1_000_000, true)).toBe(false);
      expect(context.configure(44_100, true)).toBe(true);
      expect(context.hasError()).toBe(false);
    } finally {
      context.delete();
    }
  });

  it("surfaces the engine's rejection through the wrapper", async () => {
    const engine = new SidAudioEngine({ engine: "sidlite", sampleRate: 10 });
    try {
      await expect(engine.loadSidBuffer(TONE)).rejects.toThrow(
        "Failed to configure SID player",
      );
    } finally {
      engine.dispose();
    }
  });
});
