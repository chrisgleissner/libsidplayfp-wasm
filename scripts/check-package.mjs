#!/usr/bin/env node
/** Verify the npm tarball in a clean Node.js consumer, without publishing it. */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderConsumerSmoke } from "./consumer-smoke.mjs";

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

  // Development-only material, and anything whose copyright is not ours to
  // redistribute: C64 ROM images, SID tunes, and the HVSC cache.
  const forbidden = entries.filter((entry) =>
    /(^|\/)(\.cache|src|test|scripts|docker|node_modules)(\/|$)/i.test(entry) ||
    /\.(sid|mus|str|prg|p00|d64|t64|rom|bin|7z)$/i.test(entry) ||
    /(^|\/)(kernal|basic|chargen)([._-]|$)/i.test(entry) ||
    /(^|\/)\.tsbuildinfo$/i.test(entry),
  );
  if (forbidden.length > 0) {
    throw new Error(`package contains files it must not distribute: ${forbidden.join(", ")}`);
  }

  // Licensing and attribution. The GPL text, the notices for the third-party
  // code compiled into the binaries, and the record of what was changed in
  // upstream must travel with the object code — beside every .wasm, so an
  // artifact copied out on its own is still compliant.
  const required = [
    "package/dist/index.js",
    "package/dist/libsidplayfp.wasm",
    "package/dist/sidlite/libsidplayfp.wasm",
    "package/LICENSE",
    "package/README.md",
    "package/THIRD-PARTY-NOTICES.md",
    "package/MODIFICATIONS.md",
    "package/dist/LICENSE",
    "package/dist/THIRD-PARTY-NOTICES.md",
    "package/dist/MODIFICATIONS.md",
    "package/dist/UPSTREAM.json",
    "package/dist/complete-source.tar.gz",
    "package/dist/sidlite/LICENSE",
    "package/dist/sidlite/THIRD-PARTY-NOTICES.md",
    "package/dist/sidlite/MODIFICATIONS.md",
    "package/dist/sidlite/UPSTREAM.json",
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`package is missing ${entry}`);
  }

  writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: { [packageName]: `file:${tarball}` } }, null, 2),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--package-lock=false"], { cwd: scratch, stdio: "inherit" });

  // A licence file that does not contain the licence, or notices that omit a
  // component actually compiled into the binaries, would satisfy the file-list
  // check above while failing the obligation it exists for.
  const installed = path.join(scratch, "node_modules", packageName);
  const licenceText = readFileSync(path.join(installed, "LICENSE"), "utf8");
  for (const phrase of ["GNU GENERAL PUBLIC LICENSE", "Version 2, June 1991"]) {
    if (!licenceText.includes(phrase)) throw new Error(`LICENSE does not contain ${phrase}`);
  }
  const notices = readFileSync(path.join(installed, "THIRD-PARTY-NOTICES.md"), "utf8");
  for (const component of [
    "libsidplayfp",
    "libresidfp",
    "SIDLite",
    "hashlib",     // MIT, linked in via SidTune::createMD5New
    "Emscripten",
    "musl",
    "LLVM",
    "Complete corresponding source",
    "not endorsed by or affiliated with",
  ]) {
    if (!notices.includes(component)) {
      throw new Error(`THIRD-PARTY-NOTICES.md does not mention ${component}`);
    }
  }

  // The GPL entitles recipients to the source for the binaries, and this package
  // satisfies that by shipping it. Verify the archive actually contains the
  // upstream sources and the build, not just that a file with the right name is
  // present.
  const sourceEntries = run("tar", [
    "-tzf",
    path.join(installed, "dist", "complete-source.tar.gz"),
  ]).split("\n");
  for (const expected of [
    /\/libsidplayfp\/COPYING$/,
    /\/libresidfp\/COPYING$/,
    /\/libsidplayfp\/src\/sidplayfp\/sidplayfp\.cpp$/,
    /\/libresidfp\/src\/SID\.cpp$/,
    /\/libsidplayfp-wasm\/src\/bindings\/bindings\.cpp$/,
    /\/libsidplayfp-wasm\/scripts\/apply-sid-write-hook\.py$/,
    /\/libsidplayfp-wasm\/scripts\/apply-thread-guards\.py$/,
    /\/libsidplayfp-wasm\/docker\/entrypoint\.sh$/,
  ]) {
    if (!sourceEntries.some((entry) => expected.test(entry))) {
      throw new Error(`complete-source.tar.gz is missing ${expected}`);
    }
  }

  // The upstream commits recorded beside each artifact are what identifies the
  // corresponding source, so they must match the pins the build actually used.
  const pins = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "upstream.json"), "utf8"));
  for (const artifact of ["dist", "dist/sidlite"]) {
    const stamped = JSON.parse(
      readFileSync(path.join(installed, artifact, "UPSTREAM.json"), "utf8"),
    );
    for (const library of ["libsidplayfp", "libresidfp"]) {
      if (stamped[library]?.commit !== pins[library].commit) {
        throw new Error(
          `${artifact}/UPSTREAM.json records ${library} ${stamped[library]?.commit}, ` +
            `but upstream.json pins ${pins[library].commit}`,
        );
      }
    }
  }

  // The same smoke test the released package is put through after publishing,
  // so the bytes we verify and the bytes users get are held to one standard.
  copyFileSync(
    path.join(PACKAGE_ROOT, "test", "fixtures", "test-tone-c4.sid"),
    path.join(scratch, "tune.sid"),
  );
  writeFileSync(
    path.join(scratch, "smoke.mjs"),
    renderConsumerSmoke({
      packageName,
      expectedVersion: JSON.parse(
        readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
      ).version,
      tunePath: "tune.sid",
    }),
  );
  execFileSync("node", ["smoke.mjs"], { cwd: scratch, stdio: "inherit" });
  console.log(`package check passed: ${path.basename(tarball)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
