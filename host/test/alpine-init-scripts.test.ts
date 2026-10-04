import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOTFS_INIT_SCRIPT } from "../src/alpine/init-scripts.ts";

test("rootfs init uses current uv system certificates environment variable", () => {
  assert.match(ROOTFS_INIT_SCRIPT, /export UV_SYSTEM_CERTS=true/);
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /UV_NATIVE_TLS/);
});

test("rootfs init creates standard /dev symlinks idempotently", (t) => {
  const start = ROOTFS_INIT_SCRIPT.indexOf("for dev_link in");
  const end = ROOTFS_INIT_SCRIPT.indexOf("done\n", start) + "done\n".length;
  assert.ok(start >= 0 && end > start);

  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dev-"));
  t.after(() => fs.rmSync(devDir, { recursive: true, force: true }));
  // pre-existing entries must be left alone
  fs.writeFileSync(path.join(devDir, "stdout"), "");

  const snippet = ROOTFS_INIT_SCRIPT.slice(start, end).replaceAll(
    '"/dev/',
    `"${devDir}/`,
  );
  execFileSync("sh", ["-euc", `log() { :; }\n${snippet}`]);

  assert.equal(fs.readlinkSync(path.join(devDir, "fd")), "/proc/self/fd");
  assert.equal(fs.readlinkSync(path.join(devDir, "stdin")), "/proc/self/fd/0");
  assert.equal(fs.readlinkSync(path.join(devDir, "stderr")), "/proc/self/fd/2");
  assert.ok(!fs.lstatSync(path.join(devDir, "stdout")).isSymbolicLink());

  // running again is a no-op
  execFileSync("sh", ["-euc", `log() { :; }\n${snippet}`]);
});
