import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SidAudioEngine, loadLibsidplayfp, type SidEngine } from "../src/index.js";

/**
 * Guards against libsidplayfp itself regressing.
 *
 * The other correctness checks in this repository are all *relative*: native
 * parity compares this WebAssembly build against a native build of the same
 * pinned commit, and the golden fixtures compare a build against its own
 * recorded output. Both are exactly right for catching a mistake in the
 * binding — and both are blind to upstream. If a future libsidplayfp broke the
 * oscillator, the native build would break identically, parity would still pass,
 * and re-recording the goldens would bless the regression.
 *
 * So this asserts something absolute, derived from the hardware's own
 * definition rather than from any previous run: the SID's oscillator frequency
 * is `register * clock / 2^24`, so a tune that writes a frequency register must
 * produce audio at that pitch. Nothing about that can be satisfied by comparing
 * upstream to itself.
 */

const TUNE = new Uint8Array(
    readFileSync(path.join(import.meta.dirname, "fixtures/test-tone-c4.sid")),
);

/** The C64's PAL system clock. `getTuneInfo().clock` reports which one applies. */
const PAL_CLOCK_HZ = 985248;
const NTSC_CLOCK_HZ = 1022727;

/**
 * Fundamental frequency by normalised autocorrelation, searched across the whole
 * musical range rather than around an expected answer.
 *
 * Searching near a target cannot fail informatively: constrained to ±15% of
 * 261 Hz it will report something near 261 Hz for almost any input, including
 * one that has drifted. The global maximum is taken with no octave heuristic —
 * "prefer a shorter lag that is nearly as good" reads as a reasonable guard
 * against octave errors and in fact selects a false peak here, reporting 277 Hz
 * for a signal that is 259 Hz.
 */
function fundamentalHz(pcm: Int16Array, sampleRate: number, channels: number): number {
    const frames = Math.floor(pcm.length / channels);
    const signal = new Float64Array(frames);
    for (let i = 0; i < frames; i++) signal[i] = pcm[i * channels]!;

    let mean = 0;
    for (let i = 0; i < frames; i++) mean += signal[i]!;
    mean /= frames;
    for (let i = 0; i < frames; i++) signal[i] -= mean;

    let energy = 0;
    for (let i = 0; i < frames; i++) energy += signal[i]! * signal[i]!;
    if (energy === 0) return 0;

    const minLag = Math.max(2, Math.floor(sampleRate / 2000));
    const maxLag = Math.min(frames - 1, Math.ceil(sampleRate / 60));

    let bestLag = minLag;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
        let sum = 0;
        const limit = frames - lag;
        for (let i = 0; i < limit; i++) sum += signal[i]! * signal[i + lag]!;
        const score = sum / energy;
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
        }
    }
    return sampleRate / bestLag;
}

/** The voice-1 frequency register the tune writes, via the SID write trace. */
async function voiceOneFrequencyRegister(engine: SidEngine): Promise<number> {
    const module = await loadLibsidplayfp({ engine });
    const context = new module.SidPlayerContext();
    try {
        context.configure(44100, true);
        context.loadSidBuffer(TUNE);
        context.setSidWriteTraceEnabled(true);
        context.render(200_000);

        let low: number | undefined;
        let high: number | undefined;
        for (const write of context.getAndClearSidWriteTraces()) {
            if (write.sidNumber !== 0) continue;
            if (write.address === 0 && low === undefined) low = write.value;
            if (write.address === 1 && high === undefined) high = write.value;
        }
        if (low === undefined || high === undefined) {
            throw new Error("the fixture wrote no voice-1 frequency register");
        }
        return (high << 8) | low;
    } finally {
        context.delete();
    }
}

describe.each<SidEngine>(["residfp", "sidlite"])("upstream degradation: %s", (engine) => {
    it("renders the pitch the frequency register asks for", async () => {
        const register = await voiceOneFrequencyRegister(engine);
        const player = new SidAudioEngine({ engine });
        try {
            await player.loadSidBuffer(TUNE, 0);
            const clock = player.getTuneInfo()!.clock === "ntsc" ? NTSC_CLOCK_HZ : PAL_CLOCK_HZ;
            // The SID's oscillator: a 24-bit phase accumulator advanced by the
            // register once per clock cycle.
            const expected = (register * clock) / 2 ** 24;

            const pcm = await player.renderSeconds(2);
            const measured = fundamentalHz(pcm, player.getSampleRate(), player.getChannels());

            // 1% covers the autocorrelation's lag quantisation at this pitch —
            // one sample of period is already 0.6% — while a regression of even
            // a semitone is 6% and would fail loudly.
            expect(Math.abs(measured - expected) / expected).toBeLessThan(0.01);
        } finally {
            await player.dispose();
        }
    }, 60_000);

    it("keeps the tone audible, unclipped and centred", async () => {
        const player = new SidAudioEngine({ engine });
        try {
            await player.loadSidBuffer(TUNE, 0);
            const pcm = await player.renderSeconds(2);

            let peak = 0;
            let sumSquares = 0;
            let sum = 0;
            for (const sample of pcm) {
                const magnitude = Math.abs(sample);
                if (magnitude > peak) peak = magnitude;
                sumSquares += sample * sample;
                sum += sample;
            }
            const rms = Math.sqrt(sumSquares / pcm.length) / 32768;
            const dc = sum / pcm.length / 32768;

            // Audible, with headroom, and not riding an offset. A tune reduced to
            // silence, driven into the rails, or pushed off centre are the three
            // ways an emulation regression shows up before anything else.
            expect(rms).toBeGreaterThan(0.01);
            expect(peak / 32768).toBeLessThan(0.95);
            expect(Math.abs(dc)).toBeLessThan(0.05);
        } finally {
            await player.dispose();
        }
    }, 60_000);
});
