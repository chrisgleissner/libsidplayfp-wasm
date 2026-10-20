import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const hostOwner = `${process.getuid?.()}:${process.getgid?.()}`;

// A fake `docker` that answers `docker info` with the SecurityOptions given in
// FAKE_SECURITY_OPTIONS and appends every other invocation to FAKE_DOCKER_LOG.
const FAKE_DOCKER = `#!/usr/bin/env bash
if [[ "$1" == "info" ]]; then
    [[ -n "\${FAKE_INFO_FAILS:-}" ]] && exit 1
    echo "\${FAKE_SECURITY_OPTIONS}"
    exit 0
fi
echo "$*" >> "\${FAKE_DOCKER_LOG}"
`;

let workDir: string;
let binDir: string;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "container-owner-"));
  binDir = path.join(workDir, "bin");
  mkdirSync(binDir);
  writeFileSync(path.join(binDir, "docker"), FAKE_DOCKER);
  chmodSync(path.join(binDir, "docker"), 0o755);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(script: string, env: Record<string, string>) {
  const log = path.join(workDir, "docker.log");
  writeFileSync(log, "");
  const result = spawnSync("bash", [path.join(root, script)], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: log,
      LIBSIDPLAYFP_WASM_DIST_DIR: path.join(workDir, "dist"),
      ...env,
    },
  });
  return { ...result, dockerCalls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

const ROOTFUL = '["name=seccomp,profile=builtin","name=cgroupns"]';
const ROOTLESS = '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]';

describe("container-owner.sh", () => {
  it("uses the invoking user's IDs on a rootful daemon", () => {
    const result = run("scripts/container-owner.sh", { FAKE_SECURITY_OPTIONS: ROOTFUL });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(hostOwner);
  });

  it("uses container root on a rootless daemon, where root maps to the invoking user", () => {
    const result = run("scripts/container-owner.sh", { FAKE_SECURITY_OPTIONS: ROOTLESS });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0:0");
  });

  it("falls back to the invoking user's IDs and says so when docker info fails", () => {
    const result = run("scripts/container-owner.sh", { FAKE_INFO_FAILS: "1" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(hostOwner);
    expect(result.stderr).toContain("assuming a rootful daemon");
  });
});

describe("build.sh ownership step", () => {
  const chownCall = (calls: string[]) => calls.find((call) => call.includes("--entrypoint chown"));

  it("chowns dist/ to the invoking user's IDs on a rootful daemon", () => {
    const result = run("scripts/build.sh", { FAKE_SECURITY_OPTIONS: ROOTFUL });
    expect(result.status).toBe(0);
    expect(chownCall(result.dockerCalls)).toEndWith(`-R ${hostOwner} /dist`);
  });

  it("chowns dist/ to 0:0 on a rootless daemon", () => {
    const result = run("scripts/build.sh", { FAKE_SECURITY_OPTIONS: ROOTLESS });
    expect(result.status).toBe(0);
    expect(chownCall(result.dockerCalls)).toEndWith("-R 0:0 /dist");
  });
});
