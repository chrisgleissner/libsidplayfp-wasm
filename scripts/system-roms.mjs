#!/usr/bin/env node
/**
 * Fetch the C64 system ROMs used by the real-playback test suites.
 *
 * This mirrors SIDFlow's ROM acquisition policy: VICE is the source, every
 * file is pinned by SHA-256, and the resulting copyrighted bytes stay in the
 * local cache rather than this repository or the published npm package.
 */

import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const VICE_C64_DATA = "https://raw.githubusercontent.com/libretro/vice-libretro/master/vice/data/C64";

export const SYSTEM_ROMS = [
  {
    localName: "kernal.901227-03.bin",
    nativeName: "kernal.bin",
    remoteName: "kernal-901227-03.bin",
    bytes: 8192,
    sha256: "83c60d47047d7beab8e5b7bf6f67f80daa088b7a6a27de0d7e016f6484042721",
  },
  {
    localName: "basic.901226-01.bin",
    nativeName: "basic.bin",
    remoteName: "basic-901226-01.bin",
    bytes: 8192,
    sha256: "89878cea0a268734696de11c4bae593eaaa506465d2029d619c0e0cbccdfa62d",
  },
  {
    localName: "characters.901225-01.bin",
    nativeName: "chargen.bin",
    remoteName: "chargen-901225-01.bin",
    bytes: 4096,
    sha256: "fd0d53b8480e86163ac98998976c72cc58d5dd8eb824ed7b829774e74213b420",
  },
];

function cacheDirFromEnvironment() {
  return process.env.LIBSIDPLAYFP_WASM_ROMS_CACHE?.trim() || path.join(PACKAGE_ROOT, ".cache", "vice-c64-roms");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withLock(lockPath, operation) {
  const deadline = Date.now() + 10 * 60_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for C64 ROM cache lock: ${lockPath}`);
      await delay(250);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function fetchOne(spec, cacheDir, fetchImpl) {
  const destination = path.join(cacheDir, spec.localName);
  const temporary = `${destination}.${process.pid}.download`;
  const url = `${VICE_C64_DATA}/${spec.remoteName}`;
  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": "libsidplayfp-wasm-tests/3.0.2" } });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== spec.bytes) {
      throw new Error(`${spec.remoteName}: expected ${spec.bytes} bytes, got ${bytes.byteLength}`);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== spec.sha256) {
      throw new Error(`${spec.remoteName}: SHA-256 mismatch; expected ${spec.sha256}, got ${actual}`);
    }
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Ensure and return exact KERNAL, BASIC, and CHARGEN buffers for test-only use. */
export async function ensureSystemRoms(options = {}) {
  const cacheDir = options.cacheDir ?? cacheDirFromEnvironment();
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(cacheDir, { recursive: true });

  await withLock(path.join(cacheDir, ".download.lock"), async () => {
    for (const spec of SYSTEM_ROMS) {
      const file = path.join(cacheDir, spec.localName);
      if (!(await exists(file)) || (await digest(file)) !== spec.sha256) {
        await rm(file, { force: true });
        await fetchOne(spec, cacheDir, fetchImpl);
      }
    }
  });

  const bytesByName = new Map();
  for (const spec of SYSTEM_ROMS) bytesByName.set(spec.localName, new Uint8Array(await readFile(path.join(cacheDir, spec.localName))));
  return {
    dir: cacheDir,
    kernal: bytesByName.get("kernal.901227-03.bin"),
    basic: bytesByName.get("basic.901226-01.bin"),
    chargen: bytesByName.get("characters.901225-01.bin"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roms = await ensureSystemRoms();
  console.log(`C64 ROM cache: ${roms.dir}`);
  console.log(`KERNAL ${roms.kernal.byteLength} bytes, BASIC ${roms.basic.byteLength} bytes, CHARGEN ${roms.chargen.byteLength} bytes`);
}
