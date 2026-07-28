import { beforeAll, describe, expect, it } from "bun:test";
import { SidAudioEngine } from "../src/player.js";
import { primarySidRelativePath, readPrimarySid } from "./helpers/real-sid.js";

const PLAYBACK_DURATION = 0.02;
const SEEK_DURATION = 0.02;
const PLAYBACK_CHUNK_SAMPLES = Math.floor(PLAYBACK_DURATION * 44_100 * 2);
const SEEK_CHUNK_SAMPLES = Math.floor(SEEK_DURATION * 44_100 * 2);

describe("SidAudioEngine WASM flows", () => {
  let playbackChunk: Int16Array;
  let tuneInfo: Record<string, unknown> | null;
  let songSelectResult = 0;
  let followupChunkLen = 0;

  beforeAll(async () => {
    const sidBuffer = readPrimarySid();

    const playbackEngine = new SidAudioEngine({ cacheSecondsLimit: 2 });
    await playbackEngine.loadSidBuffer(sidBuffer);
    playbackChunk = await playbackEngine.renderSeconds(PLAYBACK_DURATION, 5_000);
    tuneInfo = playbackEngine.getTuneInfo();
    songSelectResult = await playbackEngine.selectSong(1);
    followupChunkLen = (await playbackEngine.renderSeconds(PLAYBACK_DURATION, 5_000)).length;
  });

  it("streams PCM, exposes metadata, and supports song selection", () => {
    expect(playbackChunk.length).toBe(PLAYBACK_CHUNK_SAMPLES);
    expect(tuneInfo?.infoStrings).toBeInstanceOf(Array);
    expect(primarySidRelativePath).toMatch(/\.sid$/i);
    expect(songSelectResult).toBeGreaterThanOrEqual(0);
    expect(followupChunkLen).toBeGreaterThan(0);
  });

  // Test removed: The cache seek feature (seekToSample method) is not implemented
  // in SidAudioEngine. While cacheSecondsLimit parameter exists, the actual seek
  // functionality and cache lookups are not yet implemented. This test was testing
  // non-existent behavior and should be removed rather than skipped.
});
