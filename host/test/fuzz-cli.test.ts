import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { targets } from "../fuzz/targets/index.ts";

const cliPath = path.resolve(import.meta.dirname, "..", "fuzz", "cli.ts");

// Snapshot of the real registry (stub swaps below rewrite index.ts on disk,
// but this import is already cached, so the count stays authoritative).
const registryCount = Object.keys(targets).length;

function runFuzz(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
}

test("fuzz cli: --all --iters runs every target and exits 0", () => {
  const result = runFuzz(["--all", "--iters", "200", "--seed", "1"]);
  assert.equal(result.status, 0, result.stderr);

  // One "Done." line per registered target plus the --all summary.
  const doneLines = result.stderr
    .split("\n")
    .filter((l) => l.startsWith("Done. target="));
  assert.equal(doneLines.length, registryCount, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(`Done\\. all=${registryCount} iters=200 seed=1`),
  );
});

test("fuzz cli: --all without --iters refuses to run", () => {
  const result = runFuzz(["--all"]);
  assert.notEqual(result.status, 0, "expected non-zero exit");
  assert.match(result.stderr, /--all requires a positive --iters/);
});

test("fuzz cli: a crashing target fails the run with an artifact", () => {
  // Stub registry: replace targets/index.ts with a single crashing target
  // so the CLI's crash path (artifact + exit 1) is exercised end-to-end.
  const fuzzDir = path.resolve(import.meta.dirname, "..", "fuzz");
  const indexPath = path.join(fuzzDir, "targets", "index.ts");
  const original = fs.readFileSync(indexPath, "utf8");

  try {
    fs.writeFileSync(
      indexPath,
      [
        'import type { FuzzTarget } from "./types.ts";',
        "",
        "const crashTarget: FuzzTarget = {",
        '  name: "crash-probe",',
        "  defaultMaxLen: 16,",
        "  seeds: [Buffer.from([1, 2, 3])],",
        "  runOne: () => {",
        '    throw new Error("crash-probe: boom");',
        "  },",
        "};",
        "",
        "export const targets: Record<string, FuzzTarget> = {",
        "  [crashTarget.name]: crashTarget,",
        "};",
        "",
      ].join("\n"),
    );

    const result = runFuzz(["--all", "--iters", "10", "--seed", "1"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FUZZ CRASH in target 'crash-probe'/);
    assert.match(result.stderr, /artifact: /);

    // The artifact file must exist on disk for later repro.
    const artifactMatch = result.stderr.match(/artifact: (\S+)/);
    assert.ok(artifactMatch, result.stderr);
    assert.ok(fs.existsSync(artifactMatch[1]!), artifactMatch[1]);
  } finally {
    fs.writeFileSync(indexPath, original);
    // Remove probe artifacts so the repo stays clean.
    const artifactDir = path.join(fuzzDir, "artifacts", "crash-probe");
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("fuzz cli: --repro replays a saved input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-repro-"));
  const file = path.join(dir, "input.bin");
  fs.writeFileSync(file, Buffer.from([0x01, 0x02, 0x03]));
  try {
    const result = runFuzz(["dns", "--repro", file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /repro OK/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fuzz cli: http-conversion and mounts are registered with seeds", () => {
  const httpTarget = targets["http-conversion"];
  assert.ok(httpTarget, "http-conversion missing from the registry");
  assert.ok(
    httpTarget.seeds.length >= 8,
    "http-conversion needs seeds for requests and responses",
  );
  const mountsTarget = targets.mounts;
  assert.ok(mountsTarget, "mounts missing from the registry");
  assert.ok(
    mountsTarget.seeds.length >= 7,
    "mounts needs valid, invalid and duplicate path seeds",
  );
});

test("fuzz cli: http-conversion survives bounded runs on two seeds", () => {
  for (const seed of ["1", "2"]) {
    const result = runFuzz([
      "http-conversion",
      "--iters",
      "1000",
      "--seed",
      seed,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Done\. target=http-conversion/);
  }
});

test("fuzz cli: mounts survives a bounded run", () => {
  const result = runFuzz(["mounts", "--iters", "1000", "--seed", "1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Done\. target=mounts/);
});

test("fuzz cli: an async crashing target fails the run with an artifact", () => {
  // Same stub approach as the sync crash test, but the rejection happens on a
  // later tick: if the CLI forgot to await runOne the process would die with an
  // unhandled rejection and never print FUZZ CRASH here.
  const fuzzDir = path.resolve(import.meta.dirname, "..", "fuzz");
  const indexPath = path.join(fuzzDir, "targets", "index.ts");
  const original = fs.readFileSync(indexPath, "utf8");

  try {
    fs.writeFileSync(
      indexPath,
      [
        'import type { FuzzTarget } from "./types.ts";',
        "",
        "const asyncCrash: FuzzTarget = {",
        '  name: "async-crash-probe",',
        "  defaultMaxLen: 16,",
        "  seeds: [Buffer.from([1, 2, 3])],",
        "  runOne: async () => {",
        "    await Promise.resolve();",
        '    throw new Error("async-crash-probe: boom");',
        "  },",
        "};",
        "",
        "export const targets: Record<string, FuzzTarget> = {",
        "  [asyncCrash.name]: asyncCrash,",
        "};",
        "",
      ].join("\n"),
    );

    const result = runFuzz(["--all", "--iters", "5", "--seed", "1"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FUZZ CRASH in target 'async-crash-probe'/);
    const artifactMatch = result.stderr.match(/artifact: (\S+)/);
    assert.ok(artifactMatch, result.stderr);
    assert.ok(fs.existsSync(artifactMatch[1]!), artifactMatch[1]);
  } finally {
    fs.writeFileSync(indexPath, original);
    const artifactDir = path.join(fuzzDir, "artifacts", "async-crash-probe");
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});
