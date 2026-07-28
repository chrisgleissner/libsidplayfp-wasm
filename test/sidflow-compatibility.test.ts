import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SidAudioEngine,
  type SidEngine,
  type SidWriteTrace,
} from "../src/index.js";
import { FIXTURE_CASES } from "./helpers/engine-fixtures.js";
import { ensureSystemRoms } from "../scripts/system-roms.mjs";

const RENDER_CYCLES_PER_CHUNK = 20_000;
const TARGET_SECONDS = 0.5;
const MAX_SILENT_ITERATIONS = 32;
const HVSC_SUBSET = FIXTURE_CASES.slice(0, 4);
const ROMS = await ensureSystemRoms();

type TraceTuple = [number, number, number, number];

function traceToTuple(trace: SidWriteTrace): TraceTuple {
  return [trace.sidNumber, trace.address, trace.value, trace.cyclePhi1];
}

function removeDcOffset(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
): void {
  const cornerHz = 5;
  const coefficient = 1 - (2 * Math.PI * cornerHz) / sampleRate;
  for (let channel = 0; channel < channels; channel += 1) {
    let previousInput = 0;
    let previousOutput = 0;
    let first = true;
    for (let index = channel; index < samples.length; index += channels) {
      const input = samples[index]!;
      if (first) {
        previousInput = input;
        previousOutput = 0;
        first = false;
      }
      const output = input - previousInput + coefficient * previousOutput;
      previousInput = input;
      previousOutput = output;
      samples[index] = Math.max(-32_768, Math.min(32_767, Math.round(output)));
    }
  }
}

function encodePcmToWav(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
): Buffer {
  const dataSize = samples.byteLength;
  const buffer = Buffer.allocUnsafe(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(
    buffer,
    44,
  );
  return buffer;
}

async function renderLikeSidflow(
  engine: SidAudioEngine,
  sidFile: string,
  drainEveryChunk: boolean,
): Promise<{ pcm: Int16Array; traces: TraceTuple[] }> {
  // This ordering and chunking intentionally mirror SIDFlow's
  // renderWavWithEngine(): tracing starts before load and drains on every
  // render chunk, so trace capture has no unbounded in-memory side channel.
  engine.setSidWriteTraceEnabled(true);
  await engine.setSystemROMs(ROMS.kernal, ROMS.basic, ROMS.chargen);
  await engine.loadSidBuffer(new Uint8Array(await readFile(sidFile)));

  const sampleRate = engine.getSampleRate();
  const channels = engine.getChannels();
  const maxSamples = Math.floor(sampleRate * channels * TARGET_SECONDS);
  let pcm = new Int16Array(Math.min(maxSamples, sampleRate * channels));
  let collected = 0;
  let silentIterations = 0;
  const traces: TraceTuple[] = [];

  while (collected < maxSamples) {
    const chunk = engine.renderCycles(RENDER_CYCLES_PER_CHUNK);
    if (drainEveryChunk) {
      traces.push(...engine.getAndClearSidWriteTraces().map(traceToTuple));
    }
    if (chunk === null) break;
    if (chunk.length === 0) {
      if (++silentIterations >= MAX_SILENT_ITERATIONS) break;
      continue;
    }
    silentIterations = 0;
    const take = Math.min(chunk.length, maxSamples - collected);
    if (collected + take > pcm.length) {
      const expanded = new Int16Array(
        Math.min(maxSamples, (collected + take) * 2),
      );
      expanded.set(pcm.subarray(0, collected));
      pcm = expanded;
    }
    pcm.set(chunk.subarray(0, take), collected);
    collected += take;
  }

  // Unconditional: the streamed mode needs this for the tail left after its
  // last in-loop drain, and the complete mode needs it for everything. Only the
  // drain *inside* the loop depends on drainEveryChunk.
  traces.push(...engine.getAndClearSidWriteTraces().map(traceToTuple));
  return { pcm: pcm.subarray(0, collected), traces };
}

describe.each(["sidlite", "residfp"] as const)(
  "SIDFlow render contract: %s",
  (engine: SidEngine) => {
    it.each(HVSC_SUBSET)(
      "renders $name as WAV while preserving every SID register write",
      async ({ name, file }) => {
        const streamed = new SidAudioEngine({ engine });
        const complete = new SidAudioEngine({ engine });
        const outputDir = await mkdtemp(
          path.join(tmpdir(), "libsidplayfp-wasm-wav-"),
        );
        try {
          const streamedResult = await renderLikeSidflow(streamed, file, true);
          const completeResult = await renderLikeSidflow(complete, file, false);
          expect(streamedResult.pcm.length).toBeGreaterThan(0);
          expect(streamedResult.traces.length).toBeGreaterThan(0);
          expect(streamedResult.traces).toEqual(completeResult.traces);

          for (const [
            sidNumber,
            address,
            value,
            cyclePhi1,
          ] of streamedResult.traces) {
            expect(sidNumber).toBeGreaterThanOrEqual(0);
            expect(address).toBeGreaterThanOrEqual(0);
            expect(address).toBeLessThanOrEqual(0x1f);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(0xff);
            expect(cyclePhi1).toBeGreaterThanOrEqual(0);
          }

          const pcmForWav = streamedResult.pcm.slice();
          removeDcOffset(
            pcmForWav,
            streamed.getSampleRate(),
            streamed.getChannels(),
          );
          const wavPath = path.join(
            outputDir,
            `${engine}-${path.basename(file)}.wav`,
          );
          const tracePath = `${wavPath}.trace.jsonl`;
          await writeFile(
            wavPath,
            encodePcmToWav(
              pcmForWav,
              streamed.getSampleRate(),
              streamed.getChannels(),
            ),
          );
          await writeFile(
            tracePath,
            [
              JSON.stringify({
                kind: "header",
                v: 1,
                format: "sid-trace-jsonl",
                clock: "PAL",
              }),
              JSON.stringify({ kind: "batch", records: streamedResult.traces }),
              JSON.stringify({
                kind: "footer",
                eventCount: streamedResult.traces.length,
                batchCount: 1,
              }),
            ].join("\n") + "\n",
          );

          const wav = await readFile(wavPath);
          const traceLines = (await readFile(tracePath, "utf8"))
            .trim()
            .split("\n")
            .map(JSON.parse);
          expect(wav.subarray(0, 4).toString()).toBe("RIFF");
          expect(wav.subarray(8, 12).toString()).toBe("WAVE");
          expect(wav.readUInt32LE(40)).toBe(pcmForWav.byteLength);
          expect(wav.length).toBe(44 + pcmForWav.byteLength);
          expect(traceLines[0]).toMatchObject({
            kind: "header",
            format: "sid-trace-jsonl",
          });
          expect(traceLines.at(-1)).toMatchObject({
            kind: "footer",
            eventCount: streamedResult.traces.length,
          });
        } finally {
          streamed.dispose();
          complete.dispose();
          await rm(outputDir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
