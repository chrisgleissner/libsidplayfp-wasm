#!/usr/bin/env node
/**
 * Materialise the real-SID test corpus once, then select it deterministically.
 *
 * HVSC's Update #85 archive contains only the delta from #84. The complete #85
 * archive is the result of applying that update and is therefore the only
 * archive capable of reproducing SIDFlow's full edge-case selection. It is not
 * committed or published in this package.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");

export const HVSC_85_ARCHIVE_URL = "https://hvsc.brona.dk/HVSC/HVSC_85-all-of-them.7z";
export const HVSC_85_ARCHIVE_SHA256 = "f770339229446df1b8e037938fb70f3f4c953cb4a6eeef7ce357f05ca2c73225";
export const HVSC_85_FILE_COUNT = 61_157;
export const EDGE_SAMPLE_SIZE = 400;

function cacheDirFromEnvironment() {
  return process.env.LIBSIDPLAYFP_WASM_HVSC_CACHE?.trim() || path.join(PACKAGE_ROOT, ".cache", "hvsc-85");
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

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
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
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the HVSC cache lock at ${lockPath}`);
      }
      await delay(250);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      await handle.close();
      await rm(lockPath, { force: true });
    } catch (error) {
      console.error(`Failed to remove the HVSC cache lock ${lockPath}:`, error);
      throw error;
    }
  }
}

async function downloadArchive(destination, fetchImpl) {
  const response = await fetchImpl(HVSC_85_ARCHIVE_URL, {
    headers: { "User-Agent": "libsidplayfp-wasm-test-fixtures/3.0.2" },
  });
  if (!response.ok) {
    throw new Error(`HVSC download failed: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function extractArchive(archivePath, cacheDir) {
  const stagingDir = path.join(cacheDir, `.extract-${process.pid}`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    await execFileAsync("7z", ["x", "-y", archivePath, `-o${stagingDir}`], { maxBuffer: 1024 * 1024 });
    const extractedRoot = path.join(stagingDir, "C64Music");
    if (!(await exists(extractedRoot))) {
      throw new Error(`HVSC archive did not contain C64Music: ${archivePath}`);
    }
    await rename(extractedRoot, path.join(cacheDir, "C64Music"));
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function readWord(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** Parse only the stable fields needed for corpus selection. */
export function parseSidHeader(bytes) {
  if (bytes.length < 0x76) return null;
  const magic = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
  if (magic !== "PSID" && magic !== "RSID") return null;

  const version = readWord(bytes, 0x04);
  if (version < 1 || version > 4) return null;
  const requiredLength = version >= 2 ? 0x7c : 0x76;
  if (bytes.length < requiredLength) return null;

  const dataOffset = readWord(bytes, 0x06);
  const songs = readWord(bytes, 0x0e);
  const startSong = readWord(bytes, 0x10);
  if (dataOffset < 0x76 || dataOffset > bytes.length || songs < 1 || songs > 256 || startSong < 1 || startSong > songs) {
    return null;
  }

  const flags = version >= 2 ? readWord(bytes, 0x76) : 0;
  const secondSid = version >= 3 ? bytes[0x7a] : 0;
  const thirdSid = version >= 4 ? bytes[0x7b] : 0;

  return {
    format: magic,
    version,
    songs,
    initAddress: readWord(bytes, 0x0a),
    playAddress: readWord(bytes, 0x0c),
    chips: 1 + Number(secondSid !== 0) + Number(thirdSid !== 0),
    isRsidBasic: magic === "RSID" && (flags & 0x02) !== 0,
  };
}

async function walkSidFiles(directory, root = directory, result = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkSidFiles(absolutePath, root, result);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sid")) {
      result.push({ absolutePath, relativePath: path.relative(root, absolutePath).split(path.sep).join("/") });
    }
  }
  return result;
}

function evenlySelect(entries, count) {
  if (entries.length <= count) return [...entries];
  const stride = entries.length / count;
  return Array.from({ length: count }, (_, index) => entries[Math.floor((index + 0.5) * stride)]);
}

function addUnique(target, entries) {
  for (const entry of entries) target.set(entry.relativePath, entry);
}

/**
 * The pathological selection mirrors SIDFlow's WASM verification sweep. Its
 * union is intentionally auditable instead of hand-curated: every multi-SID,
 * RSID+BASIC, and high-subsong file; then fixed-stride samples of the much
 * larger RSID and zero-play-address populations.
 */
export function selectEdgeCorpus(entries) {
  const selected = new Map();
  addUnique(selected, entries.filter((entry) => entry.header.chips >= 2));
  addUnique(selected, entries.filter((entry) => entry.header.isRsidBasic));
  addUnique(selected, entries.filter((entry) => entry.header.songs >= 32));
  addUnique(selected, evenlySelect(entries.filter((entry) => entry.header.format === "RSID"), EDGE_SAMPLE_SIZE));
  addUnique(selected, evenlySelect(entries.filter((entry) => entry.header.playAddress === 0), EDGE_SAMPLE_SIZE));
  return [...selected.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** Same fixed-stride representative sampling that SIDFlow uses for comparison. */
export function selectRepresentativeCorpus(entries, count = 48) {
  return evenlySelect(entries, count).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function countTraits(entries) {
  return {
    files: entries.length,
    rsid: entries.filter((entry) => entry.header.format === "RSID").length,
    rsidBasic: entries.filter((entry) => entry.header.isRsidBasic).length,
    twoSid: entries.filter((entry) => entry.header.chips === 2).length,
    threeOrMoreSid: entries.filter((entry) => entry.header.chips >= 3).length,
    highSubsong: entries.filter((entry) => entry.header.songs >= 32).length,
    zeroPlayAddress: entries.filter((entry) => entry.header.playAddress === 0).length,
  };
}

async function buildManifest(c64MusicRoot, manifestPath) {
  const files = await walkSidFiles(c64MusicRoot);
  const parsed = [];
  for (const file of files) {
    const header = parseSidHeader(await readFile(file.absolutePath));
    if (header) parsed.push({ ...file, header });
  }

  if (parsed.length !== HVSC_85_FILE_COUNT) {
    throw new Error(`Expected ${HVSC_85_FILE_COUNT} valid HVSC 85 SID files, found ${parsed.length}`);
  }

  const edge = selectEdgeCorpus(parsed);
  const representative = selectRepresentativeCorpus(parsed);
  const manifest = {
    hvscVersion: 85,
    archiveSha256: HVSC_85_ARCHIVE_SHA256,
    source: HVSC_85_ARCHIVE_URL,
    corpus: countTraits(parsed),
    edge: edge.map((entry) => ({ relativePath: entry.relativePath, header: entry.header })),
    representative: representative.map((entry) => ({ relativePath: entry.relativePath, header: entry.header })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function readOrBuildManifest(c64MusicRoot, cacheDir) {
  const manifestPath = path.join(cacheDir, "corpus-manifest.json");
  if (await exists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest?.hvscVersion === 85 && manifest?.archiveSha256 === HVSC_85_ARCHIVE_SHA256) return manifest;
  }
  return await buildManifest(c64MusicRoot, manifestPath);
}

export async function ensureHvsc85Fixtures(options = {}) {
  const cacheDir = options.cacheDir ?? cacheDirFromEnvironment();
  const fetchImpl = options.fetchImpl ?? fetch;
  const archivePath = path.join(cacheDir, "HVSC_85-all-of-them.7z");
  const c64MusicRoot = path.join(cacheDir, "C64Music");
  await mkdir(cacheDir, { recursive: true });

  const manifest = await withLock(path.join(cacheDir, ".download.lock"), async () => {
    if (!(await exists(c64MusicRoot))) {
      const archiveIsValid = (await exists(archivePath)) && (await sha256(archivePath)) === HVSC_85_ARCHIVE_SHA256;
      if (!archiveIsValid) {
        await rm(archivePath, { force: true });
        const temporaryArchive = `${archivePath}.${process.pid}.download`;
        try {
          await downloadArchive(temporaryArchive, fetchImpl);
          const digest = await sha256(temporaryArchive);
          if (digest !== HVSC_85_ARCHIVE_SHA256) {
            throw new Error(`HVSC archive SHA-256 mismatch: expected ${HVSC_85_ARCHIVE_SHA256}, got ${digest}`);
          }
          await rename(temporaryArchive, archivePath);
        } finally {
          await rm(temporaryArchive, { force: true });
        }
      }
      await extractArchive(archivePath, cacheDir);
    }
    return await readOrBuildManifest(c64MusicRoot, cacheDir);
  });

  const hydrate = (entry) => ({ ...entry, absolutePath: path.join(c64MusicRoot, ...entry.relativePath.split("/")) });
  return {
    cacheDir,
    archivePath,
    c64MusicRoot,
    manifest,
    edge: manifest.edge.map(hydrate),
    representative: manifest.representative.map(hydrate),
  };
}

async function main() {
  const command = process.argv[2] ?? "ensure";
  if (command !== "ensure" && command !== "show") {
    throw new Error(`Usage: hvsc-fixtures.mjs [ensure|show]`);
  }
  const fixtures = await ensureHvsc85Fixtures();
  console.log(`HVSC 85 cache: ${fixtures.cacheDir}`);
  console.log(`SID files: ${fixtures.manifest.corpus.files}; edge corpus: ${fixtures.edge.length}; representative: ${fixtures.representative.length}`);
  console.log(`traits: ${JSON.stringify(fixtures.manifest.corpus)}`);
  if (command === "show") console.log(JSON.stringify(fixtures.manifest, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("HVSC fixture setup failed:", error);
    process.exitCode = 1;
  });
}
