import { readFile } from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(
  process.env.COVERAGE_LCOV_PATH ?? "coverage/lcov.info",
);
const minimum = Number(process.env.MIN_LINE_COVERAGE ?? "95");

if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 100) {
  throw new Error(
    "MIN_LINE_COVERAGE must be a percentage in the range (0, 100]",
  );
}

const report = await readFile(reportPath, "utf8");
let covered = 0;
let total = 0;
let sourceFile;

for (const line of report.split(/\r?\n/)) {
  if (line.startsWith("SF:")) {
    const file = line.slice(3).replaceAll("\\", "/");
    sourceFile =
      file === "src" || file.includes("/src/") || file.startsWith("src/")
        ? file
        : undefined;
    continue;
  }
  if (!sourceFile || !line.startsWith("DA:")) continue;
  const [, hits] = line.slice(3).split(",", 2);
  const count = Number(hits);
  if (!Number.isFinite(count)) {
    throw new Error(`Invalid LCOV line entry in ${sourceFile}: ${line}`);
  }
  total += 1;
  if (count > 0) covered += 1;
}

if (total === 0) {
  throw new Error(`No production src/ lines found in ${reportPath}`);
}

const percentage = (covered * 100) / total;
console.log(
  `Production line coverage: ${percentage.toFixed(2)}% (${covered}/${total}), required: ${minimum.toFixed(2)}%`,
);
if (percentage < minimum) {
  throw new Error(
    `Production line coverage ${percentage.toFixed(2)}% is below ${minimum.toFixed(2)}%`,
  );
}
