import { describe, expect, it } from "bun:test";

import type { LibsidplayfpWasmModule } from "../src/index.js";
import { SidAudioEngine } from "../src/player.js";

const SID = new Uint8Array(0x80);
SID[0] = 0x50; // "PSID"; the mock validates wrapper header patching, not decoding.
SID[1] = 0x53;
SID[2] = 0x49;
SID[3] = 0x44;
SID[0x0e] = 0;
SID[0x0f] = 3;

type RenderResult = Int16Array | null | "throw";
type RomResult = boolean | "throw";

interface ContextPlan {
  configure?: boolean;
  load?: boolean;
  reset?: boolean;
  render?: RenderResult[];
  roms?: RomResult[];
  deleteThrows?: boolean;
  engineName?: string;
}

class ControlledContext {
  readonly romInputs: Array<
    [Uint8Array | null, Uint8Array | null, Uint8Array | null]
  > = [];
  readonly traceEnablement: boolean[] = [];
  readonly traces = [{ sidNumber: 0, address: 4, value: 33, cyclePhi1: 10 }];
  deleted = false;
  private readonly chunks: RenderResult[];
  private readonly romResults: RomResult[];

  constructor(private readonly plan: ContextPlan) {
    this.chunks = [...(plan.render ?? [])];
    this.romResults = [...(plan.roms ?? [])];
  }

  configure(): boolean {
    return this.plan.configure ?? true;
  }

  loadSidBuffer(): boolean {
    return this.plan.load ?? true;
  }

  reset(): boolean {
    return this.plan.reset ?? true;
  }

  setSystemROMs(
    kernal: Uint8Array | null,
    basic: Uint8Array | null,
    chargen: Uint8Array | null,
  ): boolean {
    this.romInputs.push([kernal, basic, chargen]);
    const result = this.romResults.shift() ?? true;
    if (result === "throw") throw new Error("ROM injection failed");
    return result;
  }

  getChannels(): number {
    return 1;
  }

  getSampleRate(): number {
    return 10;
  }

  getTuneInfo(): Record<string, unknown> {
    return { title: "controlled" };
  }

  getLastError(): string {
    return "controlled failure";
  }

  render(): Int16Array | null {
    const result = this.chunks.shift() ?? null;
    if (result === "throw") throw new Error("render failed");
    return result;
  }

  setSidWriteTraceEnabled(enabled: boolean): void {
    this.traceEnablement.push(enabled);
  }

  getAndClearSidWriteTraces(): Array<{
    sidNumber: number;
    address: number;
    value: number;
    cyclePhi1: number;
  }> {
    return this.traces.splice(0);
  }

  delete(): void {
    this.deleted = true;
    if (this.plan.deleteThrows) throw new Error("delete failed");
  }

  isDeleted(): boolean {
    return this.deleted;
  }
}

function controlledModule(plans: ContextPlan[]): {
  module: Promise<LibsidplayfpWasmModule>;
  contexts: ControlledContext[];
} {
  const contexts: ControlledContext[] = [];
  class Context extends ControlledContext {
    constructor() {
      const plan = plans.shift();
      if (!plan) throw new Error("Unexpected SidPlayerContext creation");
      super(plan);
      contexts.push(this);
    }
  }

  return {
    module: Promise.resolve({
      SidPlayerContext: Context,
    } as unknown as LibsidplayfpWasmModule),
    contexts,
  };
}

async function muteConsole<T>(operation: () => T | Promise<T>): Promise<T> {
  const debug = console.debug;
  const warn = console.warn;
  const error = console.error;
  console.debug = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await operation();
  } finally {
    console.debug = debug;
    console.warn = warn;
    console.error = error;
  }
}

describe("SidAudioEngine lifecycle and cache boundaries", () => {
  it("builds a bounded cache only when explicitly requested and seeks within it", async () => {
    const controlled = controlledModule([
      {},
      {
        render: [new Int16Array([1, 2, 3, 4]), new Int16Array([5, 6, 7, 8])],
      },
      {},
      { render: [new Int16Array([9, 10, 11]), null] },
    ]);
    const engine = new SidAudioEngine({
      module: controlled.module,
      sampleRate: 10,
      stereo: false,
      cacheSecondsLimit: 0.6,
    });

    await engine.loadSidBuffer(SID);
    expect(controlled.contexts).toHaveLength(1);
    expect(await engine.waitForCacheReady()).toBe(true);
    expect(controlled.contexts).toHaveLength(2);
    expect(engine.getCachedSegment(0.2, 0.3)).toEqual(
      new Int16Array([3, 4, 5]),
    );
    expect(engine.getCachedSegment(-1, 0.1)).toBeNull();
    expect(engine.getCachedSegment(0.5, 0.2)).toBeNull();
    expect(await engine.seekSeconds(0.4)).toBe(4);
    expect(await engine.seekSeconds(0)).toBe(0);
    expect(await engine.seekSeconds(0.8, 1)).toBe(3);
    engine.dispose();
  });

  it("recovers from controlled renderer, ROM, and disposal failures", async () => {
    const controlled = controlledModule([
      {
        roms: [false, "throw"],
        render: ["throw", new Int16Array(0), new Int16Array([7])],
        deleteThrows: true,
      },
      {},
      { render: ["throw"] },
    ]);
    const engine = new SidAudioEngine({
      module: controlled.module,
      sampleRate: 10,
      stereo: false,
    });

    await muteConsole(async () => {
      await engine.setSystemROMs(
        new Uint8Array(8_192),
        new Uint8Array(8_192),
        new Uint8Array(4_096),
      );
      await engine.loadSidBuffer(SID);
      expect(engine.renderCycles()).toBeNull();
      expect(
        await engine.renderFrames(1, 1, undefined, { loop: true }),
      ).toEqual(new Int16Array([7]));
      await engine.setSystemROMs(
        new Uint8Array(8_192),
        new Uint8Array(8_192),
        new Uint8Array(4_096),
      );
      expect(await engine.seekSeconds(0.1, 1)).toBe(0);
      engine.dispose();
    });
  });

  it("keeps a valid prior context when a replacement cannot configure or load", async () => {
    const controlled = controlledModule([
      { render: [new Int16Array([1, 2])] },
      { configure: false },
      { load: false },
      { reset: false },
    ]);
    const engine = new SidAudioEngine({
      module: controlled.module,
      sampleRate: 10,
      stereo: false,
    });

    await engine.loadSidBuffer(SID);
    await expect(engine.loadSidBuffer(SID)).rejects.toThrow(
      "Failed to configure SID player",
    );
    expect(engine.renderCycles()).toEqual(new Int16Array([1, 2]));
    await expect(engine.loadSidBuffer(SID)).rejects.toThrow(
      "controlled failure",
    );
    await expect(engine.loadSidBuffer(SID)).rejects.toThrow(
      "controlled failure",
    );
    expect(engine.getTuneInfo()).toEqual({ title: "controlled" });
    expect(engine.getSampleRate()).toBe(10);
    expect(engine.getChannels()).toBe(1);
    engine.dispose();
  });

  it("handles cache-promise failures, unavailable state, and custom module metadata", async () => {
    const controlled = controlledModule([{}]);
    const engine = new SidAudioEngine({
      module: controlled.module,
      sampleRate: 10,
      stereo: false,
    });
    const rejected = Promise.reject(new Error("cache failed"));
    rejected.catch(() => undefined);
    Reflect.set(engine, "cachePromise", rejected);

    await muteConsole(async () => {
      expect(await engine.waitForCacheReady()).toBe(false);
    });
    expect(engine.getEngine()).toBeNull();
    expect(await engine.getEngineName()).toBe("unknown");
    expect(engine.getCachedSegment(0, 1)).toBeNull();
    expect(await engine.renderFrames(1)).toEqual(new Int16Array(0));
    expect(await engine.renderSeconds(0.1)).toEqual(new Int16Array(0));
    await expect(engine.renderSeconds(0)).rejects.toThrow(
      "Duration must be greater than zero",
    );
    await expect(engine.renderFrames(0)).rejects.toThrow(
      "Frame count must be greater than zero",
    );
    engine.dispose();
  });
});
