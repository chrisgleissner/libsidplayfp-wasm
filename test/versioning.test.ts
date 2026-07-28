import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The versioning rules decide what gets published, so they are exercised through
 * the CLI the workflows actually call rather than through internals.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "upstream.mjs");

function currentVersion(): string {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

function run(args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      out: failure.stdout ?? "",
      err: failure.stderr ?? "",
    };
  }
}

describe("registry lookup", () => {
  it("reads a version list", () => {
    const { code, out } = run(["verify", "--published", '["0.0.1"]']);
    expect(code).toBe(0);
    expect(out).toContain("version=");
  });

  it("treats npm's E404 object as an empty registry", () => {
    // `npm view <missing> --json` prints this on stdout and exits 1. For a
    // package that has never been published it means exactly "nothing".
    const notFound = JSON.stringify({
      error: { code: "E404", summary: "Not Found", detail: "..." },
    });
    const { code, out } = run(["verify", "--published", notFound]);
    expect(code).toBe(0);
    expect(out).toContain("version=");
  });

  it("refuses to read any other registry error as an empty registry", () => {
    // Treating a 500 as "nothing is published" would let a release overwrite an
    // existing version number.
    const serverError = JSON.stringify({
      error: { code: "E500", summary: "registry is down" },
    });
    const { code, err } = run(["verify", "--published", serverError]);
    expect(code).not.toBe(0);
    expect(err).toContain("registry lookup failed");
  });

  it("refuses input that is not JSON", () => {
    const { code, err } = run(["verify", "--published", "{oops"]);
    expect(code).not.toBe(0);
    expect(err).toContain("not JSON");
  });

  it("refuses to republish a version already on the registry", () => {
    const { code, err } = run(["verify", "--published", JSON.stringify([currentVersion()])]);
    expect(code).not.toBe(0);
    expect(err).toContain("already published");
  });
});

describe("version planning", () => {
  it("takes a minor for an upstream bump while the 0.x line is independent", () => {
    // Derived, not hard-coded: a literal would go red the first time the
    // package version moves, which is exactly when this rule matters most.
    const [major, minor] = currentVersion().split(".").map(Number);
    const { code, out } = run(["plan", "--ref", "v3.0.3"]);
    expect(code).toBe(0);
    expect(out).toContain("mode=independent");
    expect(out).toContain(`version=${major}.${minor + 1}.0`);
    expect(out).toContain("mirrors_upstream=false");
  });

  it("refuses a ref that is not a stable release tag", () => {
    for (const ref of ["v3.0.3-rc1", "main", "3.0"]) {
      const { code, err } = run(["plan", "--ref", ref]);
      expect(code, `${ref} should be refused`).not.toBe(0);
      expect(err).toContain("stable");
    }
  });

  it("keeps the generated constants in step with the pin", () => {
    const { code, out } = run(["verify"]);
    expect(code).toBe(0);
    expect(out).toContain("upstream=");
  });
});
