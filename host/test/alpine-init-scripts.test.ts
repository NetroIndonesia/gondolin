import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOTFS_INIT_SCRIPT } from "../src/alpine/init-scripts.ts";
import { DEFAULT_GUEST_TMPFS, buildTmpfsAppend } from "../src/sandbox/tmpfs.ts";

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

function runSandboxfsBindSnippet(
  t: test.TestContext,
  options: { bindsFile?: string; cmdlineBinds?: string },
): string[] {
  const start = ROOTFS_INIT_SCRIPT.indexOf(
    'if [ ! -f "${sandboxfs_binds_file}" ]',
  );
  const endMarker = 'done < "${sandboxfs_binds_file}"\n    fi\n';
  const end = ROOTFS_INIT_SCRIPT.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start >= 0 && end > start);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-binds-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bindsFile = path.join(dir, "binds");
  if (options.bindsFile !== undefined) {
    fs.writeFileSync(bindsFile, options.bindsFile);
  }

  const output = execFileSync(
    "sh",
    [
      "-euc",
      [
        "log() { :; }",
        "mkdir() { :; }",
        'log_cmd() { printf "%s|%s\\n" "$3" "$4"; }',
        'sandboxfs_mount="/data"',
        'sandboxfs_binds="$1"',
        'sandboxfs_binds_file="$2"',
        ROOTFS_INIT_SCRIPT.slice(start, end),
      ].join("\n"),
      "sh",
      options.cmdlineBinds ?? "",
      bindsFile,
    ],
    { encoding: "utf8" },
  );
  return output.split("\n").filter((line) => line.length > 0);
}

test("rootfs init binds sandboxfs mounts from the binds file", (t) => {
  // the cmdline list is ignored when sandboxfs wrote the file
  const binds = runSandboxfsBindSnippet(t, {
    bindsFile: "/etc/gondolin/mitm\n/with space\n/with,comma\n",
    cmdlineBinds: "/stale",
  });
  assert.deepEqual(binds, [
    "/data/etc/gondolin/mitm|/etc/gondolin/mitm",
    "/data/with space|/with space",
    "/data/with,comma|/with,comma",
  ]);
});

test("rootfs init falls back to cmdline sandboxfs binds", (t) => {
  const binds = runSandboxfsBindSnippet(t, {
    cmdlineBinds: "/etc/gondolin/mitm,/workspace",
  });
  assert.deepEqual(binds, [
    "/data/etc/gondolin/mitm|/etc/gondolin/mitm",
    "/data/workspace|/workspace",
  ]);
});

test("rootfs init passes the binds file to sandboxfs", () => {
  assert.match(
    ROOTFS_INIT_SCRIPT,
    /\/usr\/bin\/sandboxfs .*--binds-file "\$\{sandboxfs_binds_file\}"/,
  );
});

function runTmpfsSnippet(cmdlineTmpfs?: string): string[] {
  const defaultMatch = ROOTFS_INIT_SCRIPT.match(/^gondolin_tmpfs="([^"]*)"$/m);
  assert.ok(defaultMatch);
  const start = ROOTFS_INIT_SCRIPT.indexOf("mount_tmpfs_entry() {");
  const end = ROOTFS_INIT_SCRIPT.indexOf("\nexport HOME=/root", start);
  assert.ok(start >= 0 && end > start);

  const output = execFileSync(
    "sh",
    [
      "-euc",
      [
        "log() { :; }",
        "mkdir() { :; }",
        'mount() { printf "%s\\n" "$*"; }',
        `gondolin_tmpfs="${defaultMatch[1]}"`,
        'if [ "$#" -gt 0 ]; then gondolin_tmpfs="$1"; fi',
        ROOTFS_INIT_SCRIPT.slice(start, end),
      ].join("\n"),
      "sh",
      ...(cmdlineTmpfs === undefined ? [] : [cmdlineTmpfs]),
    ],
    { encoding: "utf8" },
  );
  return output.split("\n").filter((line) => line.length > 0);
}

test("rootfs init mounts the built-in tmpfs set by default", () => {
  assert.deepEqual(runTmpfsSnippet(), [
    "-t tmpfs -o mode=0700 tmpfs /root",
    "-t tmpfs tmpfs /tmp",
    "-t tmpfs tmpfs /var/cache",
    "-t tmpfs tmpfs /var/log",
    "-t tmpfs tmpfs /var/tmp",
  ]);
});

test("rootfs init built-in tmpfs set matches DEFAULT_GUEST_TMPFS", () => {
  assert.match(
    ROOTFS_INIT_SCRIPT,
    new RegExp(
      `^gondolin_tmpfs="${buildTmpfsAppend({ ...DEFAULT_GUEST_TMPFS }).slice("gondolin.tmpfs=".length)}"$`,
      "m",
    ),
  );
});

test("rootfs init mounts tmpfs entries from the cmdline", () => {
  assert.deepEqual(runTmpfsSnippet("/tmp:size=256m:mode=1777,/scratch"), [
    "-t tmpfs -o size=256m,mode=1777 tmpfs /tmp",
    "-t tmpfs tmpfs /scratch",
  ]);
  assert.deepEqual(runTmpfsSnippet("none"), []);
});

test("rootfs init does not hardcode application env vars", () => {
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /XDG_(CACHE|CONFIG|DATA)_HOME/);
  assert.doesNotMatch(ROOTFS_INIT_SCRIPT, /UV_CACHE_DIR/);
});
