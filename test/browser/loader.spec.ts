import { expect, test } from "@playwright/test";

for (const [engine, modulePath, expectedBuilder] of [
  ["residfp", "/dist/libsidplayfp.js", "WasmReSIDfp"],
  ["sidlite", "/dist/sidlite/libsidplayfp.js", "WasmSIDLite"],
] as const) {
  test(`${engine} direct generated module renders PCM faster than realtime`, async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(
      async ({ modulePath, expectedBuilder }) => {
        const { default: factory } = await import(modulePath);
        const wasm = await factory({
          locateFile: (asset: string) =>
            new URL(asset, `http://127.0.0.1:4173${modulePath}`).href,
        });
        const context = new wasm.SidPlayerContext();
        try {
          if (!context.configure(48_000, true))
            throw new Error(context.getLastError());
          const sid = new Uint8Array(
            await (await fetch("/test-tone-c4.sid")).arrayBuffer(),
          );
          if (!context.loadSidBuffer(sid))
            throw new Error(context.getLastError());
          const started = performance.now();
          const pcm = context.render(985_248);
          return {
            builder: wasm.getSidEngineName(),
            samples: pcm?.length ?? 0,
            nonZero: pcm?.some((sample: number) => sample !== 0) ?? false,
            elapsedMs: performance.now() - started,
          };
        } finally {
          context.delete();
        }
      },
      { modulePath, expectedBuilder },
    );
    expect(result.builder).toBe(expectedBuilder);
    expect(result.samples).toBeGreaterThan(0);
    expect(result.nonZero).toBe(true);
    // One PAL C64 second must render within one browser second. This is a
    // functional headroom budget, deliberately looser than a microbenchmark.
    expect(result.elapsedMs).toBeLessThan(1_000);
  });

  test(`${engine} published wrapper renders and disposes`, async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async (engine) => {
      const { SidAudioEngine } = await import("/dist/index.js");
      const player = new SidAudioEngine({ engine });
      try {
        const sid = new Uint8Array(
          await (await fetch("/test-tone-c4.sid")).arrayBuffer(),
        );
        await player.loadSidBuffer(sid);
        const pcm = await player.renderSeconds(0.1, 20_000);
        return {
          builder: await player.getEngineName(),
          samples: pcm.length,
          nonZero: pcm.some((sample: number) => sample !== 0),
        };
      } finally {
        player.dispose();
      }
    }, engine);
    expect(result.builder).toBe(expectedBuilder);
    expect(result.samples).toBe(8_820);
    expect(result.nonZero).toBe(true);
  });

  test(`${engine} worker loads the published wrapper`, async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async (engine) => {
      const source = `
        self.onmessage = async ({ data }) => {
          try {
            const { SidAudioEngine } = await import('${location.origin}/dist/index.js');
            const player = new SidAudioEngine({ engine: data.engine });
            try {
              const sid = new Uint8Array(await (await fetch('${location.origin}/test-tone-c4.sid')).arrayBuffer());
              await player.loadSidBuffer(sid);
              const pcm = await player.renderSeconds(0.1, 20000);
              self.postMessage({ builder: await player.getEngineName(), samples: pcm.length, nonZero: pcm.some((sample) => sample !== 0) });
            } finally { player.dispose(); }
          } catch (error) {
            self.postMessage({ error: error instanceof Error ? error.message : String(error) });
          }
        };
      `;
      const url = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      try {
        return await new Promise<{
          builder?: string;
          samples?: number;
          nonZero?: boolean;
          error?: string;
        }>((resolve, reject) => {
          const worker = new Worker(url, { type: "module" });
          worker.addEventListener("message", ({ data }) => {
            worker.terminate();
            if (data.error) reject(new Error(data.error));
            else resolve(data);
          });
          worker.addEventListener("error", (event) => {
            worker.terminate();
            reject(event.error ?? new Error(event.message));
          });
          worker.postMessage({ engine });
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }, engine);
    expect(result.builder).toBe(expectedBuilder);
    expect(result.samples).toBe(8_820);
    expect(result.nonZero).toBe(true);
  });
}

test("concurrent workers render independent streams with both engines", async ({
  page,
}) => {
  await page.goto("/");
  const results = await page.evaluate(async () => {
    const workerSource = `
      self.onmessage = async ({ data }) => {
        try {
          const { SidAudioEngine } = await import('${location.origin}/dist/index.js');
          const player = new SidAudioEngine({ engine: data.engine });
          try {
            const sid = new Uint8Array(await (await fetch('${location.origin}/test-tone-c4.sid')).arrayBuffer());
            await player.loadSidBuffer(sid);
            const pcm = await player.renderSeconds(0.1, 20000);
            self.postMessage({ builder: await player.getEngineName(), samples: pcm.length, nonZero: pcm.some((sample) => sample !== 0) });
          } finally { player.dispose(); }
        } catch (error) {
          self.postMessage({ error: error instanceof Error ? error.message : String(error) });
        }
      };
    `;
    const url = URL.createObjectURL(
      new Blob([workerSource], { type: "text/javascript" }),
    );
    try {
      return await Promise.all(
        Array.from(
          { length: 8 },
          (_, index) =>
            new Promise<{
              builder?: string;
              samples?: number;
              nonZero?: boolean;
              error?: string;
            }>((resolve, reject) => {
              const worker = new Worker(url, { type: "module" });
              worker.addEventListener("message", ({ data }) => {
                worker.terminate();
                if (data.error) reject(new Error(data.error));
                else resolve(data);
              });
              worker.addEventListener("error", (event) => {
                worker.terminate();
                reject(event.error ?? new Error(event.message));
              });
              worker.postMessage({
                engine: index % 2 === 0 ? "sidlite" : "residfp",
              });
            }),
        ),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  expect(results).toHaveLength(8);
  for (const result of results) {
    expect(["WasmReSIDfp", "WasmSIDLite"]).toContain(result.builder);
    expect(result.samples).toBe(8_820);
    expect(result.nonZero).toBe(true);
  }
});
