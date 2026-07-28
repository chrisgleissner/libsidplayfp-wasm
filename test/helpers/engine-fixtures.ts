/**
 * Fixture set and render loop shared by the engine gate and the native
 * comparison, so both drive the engine identically. Any divergence here would
 * make the CI gate and the formal analysis measure different things.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { CHANNELS, SAMPLE_RATE } from "../../scripts/engine-metrics.mjs";
import { ensureHvsc85Fixtures } from "../../scripts/hvsc-fixtures.mjs";
import { ensureSystemRoms } from "../../scripts/system-roms.mjs";
import type { LibsidplayfpWasmModule } from "../../src/index.js";

export const RENDER_SECONDS = 2;

/**
 * The host default. `Player::play()` clamps to MAX_CYCLES (20 000) internally,
 * so this is "as much as the engine will give per call".
 */
export const CHUNK_CYCLES = 100000;

/**
 * A fast, deterministic selection from the cached real HVSC corpus. The release
 * gate additionally traverses the complete edge corpus. Keeping the test helper
 * sourced from the same manifest means local, CI, and release runs cannot drift
 * onto a different tune population.
 */
const cachedFixtures = await ensureHvsc85Fixtures();
const systemRoms = await ensureSystemRoms();

type CachedFixture = (typeof cachedFixtures.representative)[number];
export type EngineFixture = { name: string; file: string };
export type EngineFixtureCase = EngineFixture & {
  header: CachedFixture["header"];
};

// This tune is retained in EDGE_FIXTURES and compared against native SIDLite,
// where it likewise holds a DC frame. It is not an audible-playback exemplar.
// The fast health gate instead uses playable representatives for every API path.
const FAST_PLAYBACK_EXCLUSIONS = new Set(["DEMOS/UNKNOWN/Lemon_Remix_II.sid"]);

function fixedStride<T>(entries: readonly T[], count: number): T[] {
  if (entries.length <= count) return [...entries];
  const stride = entries.length / count;
  return Array.from(
    { length: count },
    (_, index) => entries[Math.floor((index + 0.5) * stride)]!,
  );
}

function toEngineFixtures(entries: readonly CachedFixture[]): EngineFixture[] {
  return entries.map((entry) => ({
    name: entry.relativePath,
    file: entry.absolutePath,
  }));
}

function buildFastFixtures(): EngineFixture[] {
  const selected = new Map<string, CachedFixture>();
  const add = (entries: readonly CachedFixture[]): void => {
    for (const entry of entries) selected.set(entry.relativePath, entry);
  };

  // The general set uses SIDFlow's fixed-stride method. The supplements ensure
  // the fast gate covers each non-ROM-dependent multi-SID execution path.
  add(
    fixedStride(
      cachedFixtures.representative.filter(
        (entry) => entry.header.format === "PSID",
      ),
      16,
    ),
  );
  add(
    fixedStride(
      cachedFixtures.edge.filter(
        (entry) => entry.header.format === "PSID" && entry.header.chips === 2,
      ),
      4,
    ),
  );
  add(
    fixedStride(
      cachedFixtures.edge.filter(
        (entry) => entry.header.format === "PSID" && entry.header.chips >= 3,
      ),
      4,
    ),
  );
  add(
    fixedStride(
      cachedFixtures.edge.filter(
        (entry) =>
          entry.header.format === "PSID" &&
          entry.header.playAddress === 0 &&
          !FAST_PLAYBACK_EXCLUSIONS.has(entry.relativePath),
      ),
      4,
    ),
  );
  add(
    fixedStride(
      cachedFixtures.edge.filter(
        (entry) => entry.header.format === "PSID" && entry.header.songs >= 32,
      ),
      4,
    ),
  );

  return [...selected.values()]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((entry) => ({ name: entry.relativePath, file: entry.absolutePath }));
}

export const FIXTURES = buildFastFixtures();

/** Representative public-API scenarios, selected from real HVSC metadata. */
const fastFixturePaths = new Set(FIXTURES.map((fixture) => fixture.name));
export const FIXTURE_CASES: EngineFixtureCase[] = [
  {
    label: "single-SID PSID",
    matches: (entry: CachedFixture) =>
      entry.header.format === "PSID" &&
      entry.header.chips === 1 &&
      entry.header.playAddress !== 0,
  },
  {
    label: "dual-SID PSID",
    matches: (entry: CachedFixture) =>
      entry.header.format === "PSID" && entry.header.chips === 2,
  },
  {
    label: "triple-SID PSID",
    matches: (entry: CachedFixture) =>
      entry.header.format === "PSID" && entry.header.chips >= 3,
  },
  {
    label: "zero-play-address PSID",
    matches: (entry: CachedFixture) =>
      entry.header.format === "PSID" && entry.header.playAddress === 0,
  },
  {
    label: "high-subsong PSID",
    matches: (entry: CachedFixture) =>
      entry.header.format === "PSID" && entry.header.songs >= 32,
  },
].map(({ label, matches }) => {
  const fixture = cachedFixtures.edge.find(
    (entry) => fastFixturePaths.has(entry.relativePath) && matches(entry),
  );
  if (!fixture)
    throw new Error(`The audible fast fixture set has no ${label} scenario`);
  return {
    name: `${label}: ${fixture.relativePath}`,
    file: fixture.absolutePath,
    header: fixture.header,
  };
});

/** Every pathological case selected from the complete HVSC #85 cache. */
export const EDGE_FIXTURES = toEngineFixtures(cachedFixtures.edge);

/**
 * Render a tune the way a host does: configure, load, select the song, then pull
 * fixed-size chunks.
 *
 * The test cache supplies the same pinned VICE ROM set that SIDFlow uses. This
 * is required for tunes whose playback is interrupt-driven or BASIC-backed:
 * without it libsidplayfp can return a plausible constant frame instead of a
 * progressing song.
 */
export function renderWith(
  wasmModule: Pick<LibsidplayfpWasmModule, "SidPlayerContext">,
  file: string,
  chunkCycles: number = CHUNK_CYCLES,
  seconds: number = RENDER_SECONDS,
): Int16Array {
  const context = new wasmModule.SidPlayerContext();
  try {
    if (!context.configure(SAMPLE_RATE, CHANNELS === 2)) {
      throw new Error(`configure failed: ${context.getLastError()}`);
    }
    if (
      !context.setSystemROMs(
        systemRoms.kernal,
        systemRoms.basic,
        systemRoms.chargen,
      )
    ) {
      throw new Error(`setSystemROMs failed: ${context.getLastError()}`);
    }
    if (!context.loadSidBuffer(new Uint8Array(readFileSync(file)))) {
      throw new Error(`loadSidBuffer failed: ${context.getLastError()}`);
    }
    context.selectSong(0);

    const wanted = seconds * SAMPLE_RATE * CHANNELS;
    const out = new Int16Array(wanted);
    let have = 0;
    let empties = 0;

    while (have < wanted) {
      const chunk = context.render(chunkCycles);
      if (!chunk || chunk.length === 0) {
        if (++empties > 64) break;
        continue;
      }
      empties = 0;
      const take = Math.min(chunk.length, wanted - have);
      out.set(chunk.subarray(0, take), have);
      have += take;
    }

    return out.subarray(0, have);
  } finally {
    // embind objects are not garbage collected: without delete() the C++
    // SidPlayerContext lives on, keeping its SID emulations locked in the shared
    // module and shifting the allocation pattern seen by later renders.
    context.delete();
  }
}
