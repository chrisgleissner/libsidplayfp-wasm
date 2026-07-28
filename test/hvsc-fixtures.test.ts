import { describe, expect, it } from "bun:test";

import { parseSidHeader, selectEdgeCorpus, selectRepresentativeCorpus } from "../scripts/hvsc-fixtures.mjs";

function header(overrides: Record<string, unknown> = {}) {
  return {
    format: "PSID",
    version: 4,
    songs: 1,
    initAddress: 0x1000,
    playAddress: 0x1003,
    chips: 1,
    isRsidBasic: false,
    ...overrides,
  };
}

describe("HVSC #85 fixture selection", () => {
  it("parses only structurally valid PSID and RSID headers", () => {
    const bytes = new Uint8Array(0x7c);
    bytes.set(new TextEncoder().encode("PSID"));
    bytes.set([0, 4], 0x04);
    bytes.set([0, 0x7c], 0x06);
    bytes.set([0x10, 0], 0x0a);
    bytes.set([0x10, 3], 0x0c);
    bytes.set([0, 2], 0x0e);
    bytes.set([0, 1], 0x10);
    bytes[0x7a] = 0x42;

    expect(parseSidHeader(bytes)).toEqual({
      format: "PSID",
      version: 4,
      songs: 2,
      initAddress: 0x1000,
      playAddress: 0x1003,
      chips: 2,
      isRsidBasic: false,
    });
    expect(parseSidHeader(new Uint8Array(0x75))).toBeNull();
    bytes.set(new TextEncoder().encode("NOPE"));
    expect(parseSidHeader(bytes)).toBeNull();
  });

  it("takes the complete deterministic union of every edge-case class", () => {
    const entries = [
      { relativePath: "one.sid", header: header() },
      { relativePath: "two.sid", header: header({ chips: 2 }) },
      { relativePath: "three.sid", header: header({ chips: 3 }) },
      { relativePath: "basic.sid", header: header({ format: "RSID", isRsidBasic: true }) },
      { relativePath: "many.sid", header: header({ songs: 32 }) },
      { relativePath: "zero.sid", header: header({ playAddress: 0 }) },
    ];
    const selected = selectEdgeCorpus(entries);
    expect(selected.map((entry: { relativePath: string }) => entry.relativePath)).toEqual([
      "basic.sid",
      "many.sid",
      "three.sid",
      "two.sid",
      "zero.sid",
    ]);
    expect(selectRepresentativeCorpus(entries, 3).map((entry: { relativePath: string }) => entry.relativePath)).toEqual([
      "basic.sid",
      "two.sid",
      "zero.sid",
    ]);
  });
});
