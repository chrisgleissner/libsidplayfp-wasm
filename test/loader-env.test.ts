import { afterEach, describe, expect, it } from "bun:test";

import {
  DEFAULT_SID_ENGINE,
  loadLibsidplayfp,
  resolveSidEngine,
  type SidEngine,
} from "../src/index.js";

/**
 * The loader reads its environment on demand and keys its memoised default
 * module on the engine *and* the path override, so every branch here is
 * reachable against the real module rather than a cache-busted copy of it.
 */

const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe("environment without a process object", () => {
  it("reports no engine and no path override", () => {
    const globals = globalThis as Record<string, unknown>;
    const realProcess = globals.process;
    const realEnv = process.env;

    // Browsers and workers have no `process` at all; a runtime that exposes one
    // without an `env` object is the other shape the guard covers.
    try {
      (process as { env?: unknown }).env = undefined;
      expect(resolveSidEngine()).toBe(DEFAULT_SID_ENGINE);
    } finally {
      (process as { env?: unknown }).env = realEnv;
    }

    try {
      delete globals.process;
      expect(resolveSidEngine()).toBe(DEFAULT_SID_ENGINE);
    } finally {
      globals.process = realProcess;
    }
  });
});

describe("LIBSIDPLAYFP_WASM_PATH", () => {
  it("routes the binary through the override and evicts a failed default load", async () => {
    process.env.LIBSIDPLAYFP_WASM_PATH = "/nonexistent/libsidplayfp.wasm";

    // A path that cannot load proves the override was consulted. The second
    // attempt proves the rejected promise was dropped from the cache: were it
    // retained, this would settle from the cached rejection without the loader
    // ever running again.
    await expect(loadLibsidplayfp({})).rejects.toThrow();
    await expect(loadLibsidplayfp({})).rejects.toThrow();

    // With the override cleared, the same instance resolves the artifact beside
    // its JavaScript again.
    delete process.env.LIBSIDPLAYFP_WASM_PATH;
    expect((await loadLibsidplayfp({})).getSidEngineName()).toBe("WasmSIDLite");
  }, 60_000);

  it("accepts the SIDFLOW_ alias and ignores a whitespace-only value", async () => {
    process.env.SIDFLOW_LIBSIDPLAYFP_WASM_PATH = "/nonexistent/libsidplayfp.wasm";
    await expect(loadLibsidplayfp({})).rejects.toThrow();

    delete process.env.SIDFLOW_LIBSIDPLAYFP_WASM_PATH;
    process.env.LIBSIDPLAYFP_WASM_PATH = "   ";
    expect((await loadLibsidplayfp({})).getSidEngineName()).toBe("WasmSIDLite");
  }, 60_000);

  it("does not override a caller's own locateFile", async () => {
    process.env.LIBSIDPLAYFP_WASM_PATH = "/nonexistent/libsidplayfp.wasm";

    const wasm = await loadLibsidplayfp({
      locateFile: (asset: string) =>
        new URL(asset, new URL("../dist/sidlite/", import.meta.url)).href,
    });
    expect(wasm.getSidEngineName()).toBe("WasmSIDLite");
  }, 60_000);
});

describe("LIBSIDPLAYFP_WASM_ENGINE", () => {
  it("selects an engine, trims it, and falls back when unrecognised", async () => {
    for (const [value, expected] of [
      ["residfp", "residfp"],
      ["  ReSIDfp  ", "residfp"],
      ["sidlite", "sidlite"],
      ["banana", DEFAULT_SID_ENGINE],
      ["", DEFAULT_SID_ENGINE],
    ] as const) {
      process.env.LIBSIDPLAYFP_WASM_ENGINE = value;
      expect(resolveSidEngine(), `for ${JSON.stringify(value)}`).toBe(
        expected as SidEngine,
      );
    }
  });

  it("accepts the SIDFLOW_SID_ENGINE alias, and prefers the current name", async () => {
    process.env.SIDFLOW_SID_ENGINE = "residfp";
    expect(resolveSidEngine()).toBe("residfp");

    process.env.LIBSIDPLAYFP_WASM_ENGINE = "sidlite";
    expect(resolveSidEngine()).toBe("sidlite");
  });

  it("lets an explicit argument beat the environment", async () => {
    process.env.LIBSIDPLAYFP_WASM_ENGINE = "residfp";
    expect(resolveSidEngine("sidlite")).toBe("sidlite");
  });

  it("loads the engine the environment names", async () => {
    process.env.LIBSIDPLAYFP_WASM_ENGINE = "residfp";
    expect((await loadLibsidplayfp({})).getSidEngineName()).toBe("WasmReSIDfp");
  }, 60_000);
});

describe("default-module memoisation", () => {
  it("caches a bare load and an engine-only load, but not one with other options", async () => {
    const [bare, again] = await Promise.all([
      loadLibsidplayfp(),
      loadLibsidplayfp({}),
    ]);
    expect(bare).toBe(again);
    expect(await loadLibsidplayfp({ engine: "sidlite" })).toBe(bare);

    // Any further option makes the load bespoke, so it must not be served from
    // or written to the shared cache.
    const bespoke = await loadLibsidplayfp({
      engine: "sidlite",
      locateFile: undefined,
    });
    expect(bespoke).not.toBe(bare);
  }, 60_000);
});
