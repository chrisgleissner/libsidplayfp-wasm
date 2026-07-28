import { test } from "@playwright/test";

/**
 * What the render path costs on a slow phone, and whether it stays that way.
 *
 * Desktop Node measurements flatter this code twice over: the CPU is an order of
 * magnitude faster than a low-end handset, and the heap is large enough that the
 * collector barely runs, so per-call allocation never has to be paid for. Both
 * are corrected here — CPU throttling through CDP, and a 64 MB V8 heap set by
 * the runner config.
 *
 * The deciding number is not the mean. It is the worst call against the audio
 * quantum: a 20 ms buffer that takes 25 ms to fill is a dropout the listener
 * hears, however good the average looked.
 */

const QUANTUM_SECONDS = 0.02;
const QUANTUM_MS = QUANTUM_SECONDS * 1000;
const PAL_CLOCK = 985_248;

type Stats = {
    mean: number;
    p95: number;
    p99: number;
    max: number;
};

const ENGINES = [
    ["sidlite", "/dist/sidlite/libsidplayfp.js"],
    ["residfp", "/dist/libsidplayfp.js"],
] as const;

async function measure(
    page: import("@playwright/test").Page,
    modulePath: string,
    calls: number,
): Promise<Stats> {
    return page.evaluate(
        async ({ modulePath, calls, quantum, clock }) => {
            const { default: factory } = await import(modulePath);
            const wasm = await factory({
                locateFile: (asset: string) =>
                    new URL(asset, `http://127.0.0.1:4173${modulePath}`).href,
            });
            const context = new wasm.SidPlayerContext();
            const sid = new Uint8Array(await (await fetch("/test-tone-c4.sid")).arrayBuffer());
            context.configure(44_100, true);
            context.loadSidBuffer(sid);

            const cyclesPerQuantum = Math.round(clock * quantum);
            for (let i = 0; i < 20; i++) context.render(cyclesPerQuantum);

            const latencies: number[] = [];
            for (let i = 0; i < calls; i++) {
                const started = performance.now();
                // The transient WASM view must be copied out, which is the
                // allocation every consumer makes once per audio callback.
                const view = context.render(cyclesPerQuantum);
                const copy = view === null ? new Int16Array(0) : view.slice();
                if (copy.length > 0 && copy[0] === 0x7fff) throw new Error("unreachable");
                latencies.push(performance.now() - started);
            }
            context.delete();

            latencies.sort((a, b) => a - b);
            const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!;
            return {
                mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
                p95: at(0.95),
                p99: at(0.99),
                max: latencies[latencies.length - 1]!,
            };
        },
        { modulePath, calls, quantum: QUANTUM_SECONDS, clock: PAL_CLOCK },
    );
}

for (const [engine, modulePath] of ENGINES) {
    for (const rate of [1, 4, 6, 10, 20]) {
        test(`${engine} at ${rate}x CPU throttling`, async ({ page }) => {
            const client = await page.context().newCDPSession(page);
            await page.goto("/");
            await client.send("Emulation.setCPUThrottlingRate", { rate });

            const s = await measure(page, modulePath, 300);
            const verdict =
                s.max > QUANTUM_MS
                    ? `DROPOUT (${(s.max / QUANTUM_MS).toFixed(1)}x over)`
                    : `${(100 - (s.max / QUANTUM_MS) * 100).toFixed(0)}% headroom`;
            console.log(
                `  ${engine.padEnd(8)} ${String(rate).padStart(2)}x  mean=${s.mean.toFixed(2).padStart(6)}  ` +
                    `p95=${s.p95.toFixed(2).padStart(6)}  p99=${s.p99.toFixed(2).padStart(6)}  ` +
                    `max=${s.max.toFixed(2).padStart(7)}ms  of ${QUANTUM_MS}ms  ${verdict}`,
            );
        });
    }
}

/**
 * 2000 seconds of audio, streamed a quantum at a time, on a throttled CPU with a
 * phone-sized heap. A short soak cannot see a slow leak or a collector that
 * gradually falls behind; this is 100,000 render-buffer allocations.
 */
test("sidlite over 2000s of streamed audio on a throttled CPU", async ({ page }) => {
    test.setTimeout(1_800_000);
    const client = await page.context().newCDPSession(page);
    await page.goto("/");
    await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    const rounds = await page.evaluate(
        async ({ quantum, clock }) => {
            const { default: factory } = await import("/dist/sidlite/libsidplayfp.js");
            const wasm = await factory({
                locateFile: (asset: string) =>
                    new URL(asset, "http://127.0.0.1:4173/dist/sidlite/libsidplayfp.js").href,
            });
            const context = new wasm.SidPlayerContext();
            const sid = new Uint8Array(await (await fetch("/test-tone-c4.sid")).arrayBuffer());
            context.configure(44_100, true);
            context.loadSidBuffer(sid);

            const cyclesPerQuantum = Math.round(clock * quantum);
            const heap = () =>
                (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
                    ?.usedJSHeapSize ?? 0;
            const gc = (globalThis as unknown as { gc?: () => void }).gc;

            for (let i = 0; i < 100; i++) context.render(cyclesPerQuantum);
            gc?.();
            const baseline = heap();

            const out: { audioSeconds: number; ms: number; retainedMb: number; worstMs: number }[] = [];
            // 10 rounds x 10,000 calls x 20ms = 2000 seconds of audio.
            for (let round = 0; round < 10; round++) {
                let worst = 0;
                const started = performance.now();
                for (let i = 0; i < 10_000; i++) {
                    const t = performance.now();
                    const view = context.render(cyclesPerQuantum);
                    const copy = view === null ? new Int16Array(0) : view.slice();
                    if (copy.length > 0 && copy[0] === 0x7fff) throw new Error("unreachable");
                    const took = performance.now() - t;
                    if (took > worst) worst = took;
                }
                const ms = performance.now() - started;
                gc?.();
                out.push({
                    audioSeconds: (round + 1) * 10_000 * quantum,
                    ms,
                    retainedMb: (heap() - baseline) / 1048576,
                    worstMs: worst,
                });
            }
            context.delete();
            return out;
        },
        { quantum: QUANTUM_SECONDS, clock: PAL_CLOCK },
    );

    for (const r of rounds) {
        console.log(
            `  audio=${String(r.audioSeconds).padStart(4)}s  ` +
                `wall=${(r.ms / 1000).toFixed(1).padStart(5)}s  ` +
                `throughput=${(200 / (r.ms / 1000)).toFixed(1).padStart(5)}x realtime  ` +
                `retained=${r.retainedMb.toFixed(2).padStart(6)}MB  worstCall=${r.worstMs.toFixed(2)}ms`,
        );
    }
});
