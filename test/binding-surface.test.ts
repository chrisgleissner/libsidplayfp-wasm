import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadLibsidplayfp, type SidEngine } from "../src/index.js";

/**
 * Keep the three descriptions of the module's public surface in agreement:
 * `bindings.cpp` (what is registered), `libsidplayfp.d.ts` (what callers are
 * told), and the artifact itself (what is actually there).
 *
 * The type surface is a hand-written file, so nothing but a test stops it
 * drifting from the bindings it describes.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const BINDINGS = readFileSync(
  path.join(ROOT, "src/bindings/bindings.cpp"),
  "utf8",
);
const DECLARATIONS = readFileSync(
  path.join(ROOT, "src/libsidplayfp.d.ts"),
  "utf8",
);

/** Methods registered with embind, in registration order. */
const registered = [
  ...BINDINGS.matchAll(/\.function\("([A-Za-z0-9_]+)"/g),
].map((match) => match[1]!);

/** Methods declared on the exported class, bounded to the class body itself. */
const classStart = DECLARATIONS.indexOf("export class SidPlayerContext");
const classBody = DECLARATIONS.slice(
  classStart,
  // The class is the last brace-at-column-0 block before the module interface.
  classStart + DECLARATIONS.slice(classStart).indexOf("\n}\n"),
);
const declared = new Set(
  [...classBody.matchAll(/^ {2}([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]!),
);

// Synthesised by embind on every bound class rather than registered by name.
const EMBIND_PROVIDED = new Set(["constructor", "delete", "isDeleted"]);

describe("public binding surface", () => {
  it("registers at least one method", () => {
    expect(registered.length).toBeGreaterThan(20);
  });

  it("declares every registered method in the shipped type surface", () => {
    const missing = registered.filter((name) => !declared.has(name));
    expect(
      missing,
      `bindings.cpp registers these but src/libsidplayfp.d.ts does not declare them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("declares nothing the bindings do not provide", () => {
    const registeredSet = new Set(registered);
    const extra = [...declared].filter(
      (name) => !registeredSet.has(name) && !EMBIND_PROVIDED.has(name),
    );
    expect(
      extra,
      `src/libsidplayfp.d.ts declares these but bindings.cpp does not register them: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("ships the same type surface beside both engine artifacts", () => {
    for (const artifact of ["dist", "dist/sidlite"]) {
      expect(
        readFileSync(path.join(ROOT, artifact, "libsidplayfp.d.ts"), "utf8"),
        `${artifact}/libsidplayfp.d.ts differs from src/libsidplayfp.d.ts`,
      ).toBe(DECLARATIONS);
    }
  });

  it("names the artifact's package.json after the real package version", () => {
    const { version } = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    const meta = JSON.parse(
      readFileSync(path.join(ROOT, "dist/package.json"), "utf8"),
    );

    expect(meta.version, "dist/package.json is stale").toBe(version);
  });

  /**
   * The licence, the notices and the change record govern the whole package and
   * sit at its root and beside the primary artifact. Repeating them inside
   * `dist/sidlite/` added six files that said nothing new — the second engine is
   * the same code built against a different emulation, in the same package,
   * under the same licence.
   */
  it("keeps the nested engine to what is needed to load it", () => {
    const nested = readdirSync(path.join(ROOT, "dist/sidlite")).sort();

    expect(nested).toEqual([
      "libsidplayfp.d.ts",
      "libsidplayfp.js",
      "libsidplayfp.wasm",
    ]);
  });
});

describe.each<SidEngine>(["residfp", "sidlite"])(
  "loaded %s artifact",
  (engine) => {
    it("exposes every registered method at runtime", async () => {
      const wasm = await loadLibsidplayfp({ engine });
      const context = new wasm.SidPlayerContext();
      try {
        const missing = registered.filter(
          (name) =>
            typeof (context as unknown as Record<string, unknown>)[name] !==
            "function",
        );
        expect(
          missing,
          `${engine} artifact is missing: ${missing.join(", ")}`,
        ).toEqual([]);
        // embind supplies these; a caller that forgets delete() leaks the C++ object.
        expect(typeof context.delete).toBe("function");
        expect(typeof context.isDeleted).toBe("function");
      } finally {
        context.delete();
      }
    });
  },
);

/**
 * Rendering is a pure function of (tune, configuration).
 *
 * Chunk-size invariance is the property that the mixer holding freed chip
 * buffers destroys: the contents of the freed region depend on allocator
 * activity, so the same tune rendered in different chunk sizes produces
 * different audio. Asserting it directly is cheaper and more specific than
 * inferring it from a spectral comparison.
 */
describe.each<SidEngine>(["residfp", "sidlite"])("determinism: %s", (engine) => {
  async function render(chunkCycles: number): Promise<Int16Array> {
    const wasm = await loadLibsidplayfp({ engine, locateFile: undefined });
    const context = new wasm.SidPlayerContext();
    try {
      expect(context.configure(44_100, true)).toBe(true);
      expect(
        context.loadSidBuffer(
          new Uint8Array(readFileSync(path.join(ROOT, "test", "fixtures", "test-tone-c4.sid"))),
        ),
      ).toBe(true);

      const want = 44_100 * 2; // one second, stereo
      const out = new Int16Array(want);
      let have = 0;
      let empty = 0;
      while (have < want) {
        const chunk = context.render(chunkCycles);
        if (!chunk || chunk.length === 0) {
          if (++empty > 64) break;
          continue;
        }
        empty = 0;
        const take = Math.min(chunk.length, want - have);
        out.set(chunk.subarray(0, take), have);
        have += take;
      }
      return out.subarray(0, have);
    } finally {
      context.delete();
    }
  }

  it("renders identical audio on repeat and at any chunk size", async () => {
    const first = await render(100_000);
    expect(first.length).toBe(88_200);

    const repeat = await render(100_000);
    expect(Array.from(repeat)).toEqual(Array.from(first));

    const smallChunks = await render(5_000);
    expect(smallChunks.length).toBe(first.length);
    expect(Array.from(smallChunks)).toEqual(Array.from(first));
  }, 120_000);
});
