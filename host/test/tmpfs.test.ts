import assert from "node:assert/strict";
import test from "node:test";

import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";
import {
  DEFAULT_GUEST_TMPFS,
  buildTmpfsAppend,
  normalizeGuestTmpfs,
} from "../src/sandbox/tmpfs.ts";

test("tmpfs append encodes mounts sorted by path", () => {
  assert.equal(
    buildTmpfsAppend({
      "/var/tmp/": { size: "25%" },
      "/tmp": { size: 1048576, mode: "1777" },
    }),
    "gondolin.tmpfs=/tmp:size=1048576:mode=1777,/var/tmp:size=25%",
  );
});

test("tmpfs append disables all mounts for an empty map", () => {
  assert.equal(buildTmpfsAppend({}), "gondolin.tmpfs=none");
});

test("tmpfs append for the default set", () => {
  assert.equal(
    buildTmpfsAppend({ ...DEFAULT_GUEST_TMPFS }),
    "gondolin.tmpfs=/root:mode=0700,/tmp,/var/cache,/var/log,/var/tmp",
  );
});

test("tmpfs rejects invalid paths and options", () => {
  for (const bad of [
    "relative",
    "/",
    "/with space",
    "/with,comma",
    "/with:colon",
    "/glob*",
    "/proc",
    "/dev/shm",
    "/run",
  ]) {
    assert.throws(() => normalizeGuestTmpfs({ [bad]: {} }), Error, bad);
  }
  assert.throws(() => normalizeGuestTmpfs({ "/tmp": { size: "1x" } }));
  assert.throws(() => normalizeGuestTmpfs({ "/tmp": { size: "0" } }));
  assert.throws(() => normalizeGuestTmpfs({ "/tmp": { size: -1 } }));
  assert.throws(() => normalizeGuestTmpfs({ "/tmp": { mode: "rwx" } }));
  assert.throws(() => normalizeGuestTmpfs({ "/tmp": {}, "/tmp/": {} }));
});

test("sandbox server options validate tmpfs eagerly", () => {
  const imagePath = {
    kernelPath: "/nonexistent/vmlinuz",
    initrdPath: "/nonexistent/initramfs.cpio.lz4",
    rootfsPath: "/nonexistent/rootfs.ext4",
  };
  assert.deepEqual(
    resolveSandboxServerOptions({ imagePath, tmpfs: { "/tmp/": {} } }).tmpfs,
    { "/tmp": {} },
  );
  assert.equal(resolveSandboxServerOptions({ imagePath }).tmpfs, undefined);
  assert.throws(() =>
    resolveSandboxServerOptions({ imagePath, tmpfs: { "/proc": {} } }),
  );
});
