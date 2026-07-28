import { readFileSync } from "node:fs";

import { ensureHvsc85Fixtures } from "../../scripts/hvsc-fixtures.mjs";

const fixtures = await ensureHvsc85Fixtures();

const primary = fixtures.representative.find(
  (fixture: { header: { format: string; chips: number; playAddress: number } }) =>
    fixture.header.format === "PSID" && fixture.header.chips === 1 && fixture.header.playAddress !== 0,
) ?? fixtures.representative[0];

if (!primary) {
  throw new Error("HVSC 85 fixture cache did not provide a representative SID");
}

export const primarySidPath = primary.absolutePath;
export const primarySidRelativePath = primary.relativePath;

export function readPrimarySid(): Uint8Array {
  return new Uint8Array(readFileSync(primarySidPath));
}
