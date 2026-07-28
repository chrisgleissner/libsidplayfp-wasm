#!/usr/bin/env node
/**
 * Report what upstream libsidplayfp offers that this binding does not expose.
 *
 * WHY THIS IS A REPORT AND NOT A GATE
 * -----------------------------------
 * Upstream adds methods on its own schedule. If that failed the build, the next
 * pin bump would be red for a reason that is not a defect, and the pressure
 * would be to silence the check rather than read it. So this always exits 0.
 * What it produces is visibility: when a pin moves, the new surface is named in
 * the CI log and the job summary, and the decision to bind it or not is a
 * deliberate one taken by a person.
 *
 * Not every upstream method should be bound. `debug(bool, FILE*)` takes a C
 * stdio handle that means nothing in WebAssembly; `buffers()` and `mix()` are
 * the internals of `render()`. Those live in EXPECTED_UNBOUND below with the
 * reason, so the report stays short enough to actually read — a report nobody
 * reads is the same as no report.
 *
 * Usage: node scripts/api-drift.mjs [--json] [--summary <file>]
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const UPSTREAM = path.join(PACKAGE_ROOT, ".cache/upstream/repo");
const BINDINGS = path.join(PACKAGE_ROOT, "src/bindings/bindings.cpp");

/**
 * Upstream methods this binding deliberately does not expose, and why. An entry
 * here is a decision on record; anything absent from both this list and the
 * binding shows up in the report as unreviewed.
 */
const EXPECTED_UNBOUND = {
  "sidplayfp::debug": "takes a C FILE* handle, which has no meaning in WebAssembly",
  "sidplayfp::buffers": "internal to render(); callers receive an Int16Array instead",
  "sidplayfp::mix": "internal to render()",
  "sidplayfp::initMixer": "render() manages the mixer lifecycle itself",
  "sidplayfp::sidplayfp": "constructor",
  "sidplayfp::setKernal": "covered by setSystemROMs, which sets all three together",
  "sidplayfp::setBasic": "covered by setSystemROMs",
  "sidplayfp::setChargen": "covered by setSystemROMs",
  "SidTune::SidTune": "constructor",
  "SidConfig::SidConfig": "constructor",
  "SidDatabase::SidDatabase": "constructor",
  "ReSIDfpBuilder::ReSIDfpBuilder": "constructor",
  "SidTune::load": "the binding owns tune lifetime; callers use loadSidBuffer / loadSidFile",
  "SidTune::read": "covered by loadSidBuffer",
  "SidTune::getInfo": "covered by getTuneInfo, which reports the selected song",
  "SidTune::c64Data": "raw pointer into tune memory; not representable across the boundary",
  "SidTune::placeSidTuneInC64mem": "internal to load()",
  "SidTune::setFileNameExtensions": "for filesystem loading, which the binding does not do",
  "SidTune::createMD5": "superseded upstream by createMD5New; bound as getTuneMd5",
  "SidConfig::compare": "operator support, not API",
  "ReSIDfpBuilder::create": "the player creates the builder",
  "ReSIDfpBuilder::getCredits": "reported through getEngineInfo",
  "SidInfo::getSidModel": "reported as sidModels in getEngineInfo",
  "SidTuneInfo::getSidModel": "reported as sidModels in getTuneInfo",
  "SidTuneInfo::getSidChipBase": "reported as sidChipBases in getTuneInfo",
  "SidTuneInfo::getNumberOfInfoStrings": "implied by the length of infoStrings",
  "SidTuneInfo::getNumberOfCommentStrings": "implied by the length of commentStrings",
  "SidInfo::getNumberOfCredits": "implied by the length of credits",
};

/**
 * Where each upstream method surfaces in our API when the name differs. Keeps
 * the report from claiming a gap that is only a rename.
 */
const BOUND_AS = {
  "sidplayfp::config": "getEmulationConfig / setEmulationConfig / configure",
  "sidplayfp::info": "getEngineInfo",
  "sidplayfp::error": "getLastError / hasError / clearError",
  "sidplayfp::load": "loadSidBuffer / loadSidFile",
  "sidplayfp::play": "render",
  "sidplayfp::installedSIDs": "getInstalledSids",
  "sidplayfp::filter": "setFilterEnabled",
  "sidplayfp::time": "getTimeSeconds",
  "sidplayfp::timeMs": "getTimeMs",
  "sidplayfp::setRoms": "setSystemROMs",
  "sidplayfp::getBufSize": "getBufferSize",
  "SidTune::getStatus": "checked on load; the failure reason reaches callers via getLastError",
  "SidTune::statusString": "the text getLastError returns when a tune fails to parse",
  // Upstream's SidDatabase reads the HVSC songlength file from a path. In
  // WebAssembly that means staging a ~10 MB text file into the virtual
  // filesystem before it can be opened, for a lookup that is a hash-keyed line
  // scan. `SonglengthDatabase` in src/songlengths.ts does the same job over a
  // string or stream, works the same in a browser and in Node, and adds nothing
  // to the binary. It keys on getTuneMd5(), which is bound.
  "SidDatabase::open": "implemented in TypeScript as SonglengthDatabase.parse",
  "SidDatabase::close": "not applicable: SonglengthDatabase holds no handle",
  "SidDatabase::length": "SonglengthDatabase.lengthSeconds",
  "SidDatabase::lengthMs": "SonglengthDatabase.lengthMs",
};

const HEADERS = [
  ["sidplayfp", "src/sidplayfp/sidplayfp.h"],
  ["SidInfo", "src/sidplayfp/SidInfo.h"],
  ["SidTune", "src/sidplayfp/SidTune.h"],
  ["SidTuneInfo", "src/sidplayfp/SidTuneInfo.h"],
  ["SidConfig", "src/sidplayfp/SidConfig.h"],
  ["SidDatabase", "src/utils/SidDatabase.h"],
  ["ReSIDfpBuilder", "src/builders/residfp-builder/residfp.h"],
];

/**
 * Method names declared in a header, ignoring comments and preprocessor lines.
 * Deliberately loose: over-reporting a name is a moment's reading, while missing
 * one defeats the purpose.
 */
function declaredMethods(source) {
  const names = new Set();
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("#")) continue;
    if (line.startsWith("typedef") || line.startsWith("enum") || line.startsWith("class")) continue;
    const match = /(?:^|[\s*&])([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(line);
    if (!match) continue;
    const name = match[1];
    // Control flow and casts read like calls; none of them are declarations.
    if (["if", "for", "while", "switch", "return", "sizeof", "static_cast", "delete"].includes(name)) continue;
    if (!line.includes(";") && !line.includes("{")) continue;
    names.add(name);
  }
  return names;
}

/**
 * What this binding exposes, which is two different things: methods registered
 * on the context, and the fields it sets on the objects those methods return.
 * Most of upstream's accessors reach callers the second way — `SidTuneInfo::songs()`
 * is `songs` on the object from `getTuneInfo()`, not a method of its own — so a
 * check that only counted `.function()` would report nearly the whole of
 * SidTuneInfo as missing and be ignored within a week.
 */
function boundNames() {
  const source = readFileSync(BINDINGS, "utf8");
  return new Set([
    ...[...source.matchAll(/\.function\("([a-zA-Z0-9_]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/\.set\("([a-zA-Z0-9_]+)"/g)].map((match) => match[1]),
    // Config options are read by key, not registered, so they appear as
    // hasKey("filter8580Curve") rather than as a method or a field.
    ...[...source.matchAll(/hasKey\(\s*\w+\s*,\s*"([a-zA-Z0-9_]+)"/g)].map((match) => match[1]),
  ]);
}

/**
 * Upstream's spelling versus ours. These are the same capability under a
 * different name — `SidInfo::basicDesc()` is `basic` on getEngineInfo() — so
 * reporting them as gaps would be false and would train the reader to skim.
 */
const RENAMED = new Map(Object.entries({
  basicDesc: "basic",
  chargenDesc: "chargen",
  kernalDesc: "kernal",
  driverAddr: "driverAddress",
  speedString: "speed",
  formatString: "format",
  numberOfSIDs: "sidChips",
  initAddr: "initAddress",
  loadAddr: "loadAddress",
  playAddr: "playAddress",
  sidChipBase: "sidChipBases",
  infoString: "infoStrings",
  commentString: "commentStrings",
  numberOfInfoStrings: "infoStrings",
  numberOfCommentStrings: "commentStrings",
  numberOfCredits: "credits",
  createMD5New: "getTuneMd5",
  enableOld6581caps: "old6581Caps",
  combinedWaveformsStrength: "combinedWaveforms",
}));

const bound = boundNames();
const boundLower = new Set([...bound].map((name) => name.toLowerCase()));
const report = [];

for (const [klass, relative] of HEADERS) {
  const file = path.join(UPSTREAM, relative);
  if (!existsSync(file)) {
    report.push({ klass, status: "header-missing", detail: relative, methods: [] });
    continue;
  }
  const unexposed = [];
  for (const method of declaredMethods(readFileSync(file, "utf8"))) {
    const key = `${klass}::${method}`;
    if (EXPECTED_UNBOUND[key]) continue;
    if (BOUND_AS[key]) continue;
    if (bound.has(method)) continue;
    // getFoo() upstream vs foo in our surface, and vice versa.
    const stripped = method.replace(/^(get|set|is|has)/, "").toLowerCase();
    const bare = method.replace(/^(get|set|is|has)/, "");
    const renamed = RENAMED.get(method) ?? RENAMED.get(bare[0]?.toLowerCase() + bare.slice(1));
    if (renamed && bound.has(renamed)) continue;
    if (boundLower.has(method.toLowerCase())) continue;
    if ([...boundLower].some((name) => name.replace(/^(get|set|is|has)/, "") === stripped)) continue;
    unexposed.push(method);
  }
  if (unexposed.length > 0) report.push({ klass, status: "unexposed", methods: unexposed.sort() });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ bound: [...bound].sort(), report }, null, 2));
} else {
  console.log(`libsidplayfp API drift — ${bound.size} methods bound\n`);
  if (report.length === 0) {
    console.log("No upstream surface is unaccounted for.");
  } else {
    for (const entry of report) {
      if (entry.status === "header-missing") {
        console.log(`  ${entry.klass}: header not found at ${entry.detail} (upstream may have moved it)`);
        continue;
      }
      console.log(`  ${entry.klass}: ${entry.methods.length} not exposed and not listed as deliberate`);
      console.log(`    ${entry.methods.join(", ")}`);
    }
    console.log(
      "\nThis is a report, not a failure. Bind what belongs in a WebAssembly\n" +
        "binding, and record the rest in EXPECTED_UNBOUND with the reason.",
    );
  }
}

const summaryIndex = process.argv.indexOf("--summary");
const summaryPath = summaryIndex >= 0 ? process.argv[summaryIndex + 1] : process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const lines = [`### libsidplayfp API drift\n`, `${bound.size} methods bound.\n`];
  if (report.length === 0) {
    lines.push("No upstream surface is unaccounted for.\n");
  } else {
    for (const entry of report) {
      lines.push(
        entry.status === "header-missing"
          ? `- **${entry.klass}**: header not found at \`${entry.detail}\`\n`
          : `- **${entry.klass}**: \`${entry.methods.join("`, `")}\`\n`,
      );
    }
  }
  appendFileSync(summaryPath, lines.join(""));
}

// Always zero. See the note at the top.
process.exit(0);
