#!/usr/bin/env node
/** Verify the npm tarball in a clean Node.js consumer, without publishing it. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "libsidplayfp-wasm-package-"));
const tarballArgument = process.argv.indexOf("--tarball");
const suppliedTarball = tarballArgument >= 0 ? process.argv[tarballArgument + 1] : undefined;

if (tarballArgument >= 0 && !suppliedTarball) {
  throw new Error("Usage: check-package.mjs [--tarball /absolute/path/to/package.tgz]");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

try {
  const packed = suppliedTarball
    ? [{ filename: path.basename(suppliedTarball) }]
    : JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch]));
  const tarball = suppliedTarball ? path.resolve(suppliedTarball) : path.join(scratch, packed[0].filename);
  const packageName = "@chrisgleissner/libsidplayfp-wasm";

  const entries = run("tar", ["-tzf", tarball]).trim().split("\n");
  const forbidden = entries.filter((entry) => /(^|\/)(\.cache|src|test|scripts|docker|node_modules)(\/|$)|\.sid$/i.test(entry));
  if (forbidden.length > 0) throw new Error(`package contains development-only files: ${forbidden.join(", ")}`);
  for (const required of ["package/dist/index.js", "package/dist/libsidplayfp.wasm", "package/dist/sidlite/libsidplayfp.wasm", "package/LICENSE", "package/README.md"]) {
    if (!entries.includes(required)) throw new Error(`package is missing ${required}`);
  }

  writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: { [packageName]: `file:${tarball}` } }, null, 2),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--package-lock=false"], { cwd: scratch, stdio: "inherit" });

  const fixture = path.join(PACKAGE_ROOT, "test-tone-c4.sid");
  writeFileSync(
    path.join(scratch, "smoke.mjs"),
    `import { readFileSync } from "node:fs";\n` +
      `import { loadLibsidplayfp } from "${packageName}";\n` +
      `const wasm = await loadLibsidplayfp({ engine: "sidlite" });\n` +
      `if (wasm.getSidEngineName() !== "WasmSIDLite") throw new Error("wrong packaged engine");\n` +
      `const context = new wasm.SidPlayerContext();\n` +
      `try {\n` +
      `  if (!context.configure(48000, true)) throw new Error(context.getLastError());\n` +
      `  if (!context.loadSidBuffer(new Uint8Array(readFileSync(${JSON.stringify(fixture)})))) throw new Error(context.getLastError());\n` +
      `  const pcm = context.render(100000);\n` +
      `  if (!pcm || pcm.length === 0 || !pcm.some((sample) => sample !== 0)) throw new Error("packaged module produced no audio");\n` +
      `} finally { context.delete(); }\n`,
  );
  execFileSync("node", ["smoke.mjs"], { cwd: scratch, stdio: "inherit" });
  console.log(`package check passed: ${path.basename(tarball)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
