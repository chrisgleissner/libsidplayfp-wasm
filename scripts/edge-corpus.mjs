#!/usr/bin/env bun
/**
 * Exercise every pathological SID selected from the complete HVSC #85 cache.
 *
 * This is intentionally a release gate rather than a fast unit test. The
 * native parity workflow runs it for both engines; this health pass makes sure
 * every selected file loads, progresses, and stays within basic signal bounds.
 */

import { loadLibsidplayfp } from "../src/index.js";
import { measure } from "./engine-metrics.mjs";
import { CHUNK_CYCLES, EDGE_FIXTURES, renderWith } from "../test/helpers/engine-fixtures.js";

const engineArgument = process.argv.find((argument) => argument.startsWith("--engine="));
const engineFromPair = process.argv.indexOf("--engine");
const engine = engineArgument
  ? engineArgument.slice("--engine=".length)
  : engineFromPair >= 0
    ? process.argv[engineFromPair + 1]
    : "all";
const renderSeconds = 0.25;

if (!["all", "residfp", "sidlite"].includes(engine)) {
  throw new Error(`--engine must be all, residfp, or sidlite; got: ${engine}`);
}

const engines = engine === "all" ? ["residfp", "sidlite"] : [engine];
let failures = 0;

for (const selectedEngine of engines) {
  const wasmModule = await loadLibsidplayfp({ engine: selectedEngine });
  const expectedBuilder = selectedEngine === "residfp" ? "WasmReSIDfp" : "WasmSIDLite";
  if (wasmModule.getSidEngineName() !== expectedBuilder) {
    throw new Error(`${selectedEngine} loader returned ${wasmModule.getSidEngineName()}, expected ${expectedBuilder}`);
  }

  let audible = 0;
  let heldFrame = 0;
  for (const [index, fixture] of EDGE_FIXTURES.entries()) {
    try {
      const pcm = renderWith(wasmModule, fixture.file, CHUNK_CYCLES, renderSeconds);
      const stats = measure(pcm);
      // A high peak is not clipping. Some unmodified, native libsidplayfp
      // renders legitimately reach 0.9848 full scale (for example Druid
      // Remix) without saturating. Treat only the two Int16 saturation values
      // as clipping, then let the native differential gate establish that the
      // WASM waveform remains faithful to upstream.
      const saturatedSamples = pcm.reduce(
        (count, sample) =>
          count + (sample === -32768 || sample === 32767 ? 1 : 0),
        0,
      );
      if (pcm.length === 0 || saturatedSamples > 0) {
        throw new Error(
          `samples=${pcm.length}, peak=${stats.peak.toFixed(4)}, saturated=${saturatedSamples}`,
        );
      }
      if (stats.acRms > 0.0001) audible++;
      else heldFrame++;
    } catch (error) {
      failures++;
      console.error(`${selectedEngine} ${fixture.name}:`, error instanceof Error ? error.message : error);
    }

    if ((index + 1) % 100 === 0 || index + 1 === EDGE_FIXTURES.length) {
      console.log(`${selectedEngine}: ${index + 1}/${EDGE_FIXTURES.length}`);
    }
  }
  console.log(`${selectedEngine}: audible=${audible}, held-frame=${heldFrame}, total=${EDGE_FIXTURES.length}`);
}

if (failures > 0) {
  throw new Error(`${failures} edge-corpus render failure(s)`);
}
