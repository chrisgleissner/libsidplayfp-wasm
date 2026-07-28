import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureSystemRoms, SYSTEM_ROMS } from "../scripts/system-roms.mjs";

const temporaryDirectories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "libsidplayfp-wasm-roms-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("VICE system ROM cache", () => {
  it("pins the exact ROM set libsidplayfp requires", () => {
    expect(SYSTEM_ROMS.map((spec) => [spec.localName, spec.bytes])).toEqual([
      ["kernal.901227-03.bin", 8192],
      ["basic.901226-01.bin", 8192],
      ["characters.901225-01.bin", 4096],
    ]);
    for (const spec of SYSTEM_ROMS)
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("repairs a corrupt cached file only after digest verification", async () => {
    const canonical = await ensureSystemRoms();
    const directory = await scratch();
    const corrupted = SYSTEM_ROMS[0]!;

    const remoteBytes = new Map(
      await Promise.all(
        SYSTEM_ROMS.map(
          async (spec) =>
            [
              spec.remoteName,
              await readFile(path.join(canonical.dir, spec.localName)),
            ] as const,
        ),
      ),
    );
    await Promise.all(
      SYSTEM_ROMS.map(async (spec) => {
        await writeFile(
          path.join(directory, spec.localName),
          remoteBytes.get(spec.remoteName)!,
        );
      }),
    );
    await writeFile(
      path.join(directory, corrupted.localName),
      new Uint8Array(corrupted.bytes).fill(0xff),
    );
    const requests: string[] = [];
    const restored = await ensureSystemRoms({
      cacheDir: directory,
      fetchImpl: async (url: string) => {
        const remoteName = url.split("/").pop()!;
        requests.push(remoteName);
        const bytes = remoteBytes.get(remoteName);
        return new Response(bytes, { status: bytes ? 200 : 404 });
      },
    });

    expect(requests).toEqual([corrupted.remoteName]);
    expect(
      new Uint8Array(
        await readFile(path.join(restored.dir, corrupted.localName)),
      ),
    ).toEqual(new Uint8Array(remoteBytes.get(corrupted.remoteName)!));
  });

  it("shares one locked download across concurrent initializers", async () => {
    const canonical = await ensureSystemRoms();
    const directory = await scratch();
    const remoteBytes = new Map(
      await Promise.all(
        SYSTEM_ROMS.map(
          async (spec) =>
            [
              spec.remoteName,
              await readFile(path.join(canonical.dir, spec.localName)),
            ] as const,
        ),
      ),
    );
    const requests = new Map<string, number>();
    const fetchImpl = async (url: string) => {
      const remoteName = url.split("/").pop()!;
      requests.set(remoteName, (requests.get(remoteName) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(remoteBytes.get(remoteName), { status: 200 });
    };

    const initialized = await Promise.all(
      Array.from({ length: 4 }, () =>
        ensureSystemRoms({ cacheDir: directory, fetchImpl }),
      ),
    );
    expect(
      initialized.every(
        (roms) =>
          roms.kernal.byteLength === 8192 && roms.basic.byteLength === 8192,
      ),
    ).toBe(true);
    expect([...requests.entries()].sort()).toEqual(
      SYSTEM_ROMS.map((spec) => [spec.remoteName, 1]).sort(),
    );
  });
});
