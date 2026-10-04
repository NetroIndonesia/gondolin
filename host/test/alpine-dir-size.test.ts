import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getDirSizeKb } from "../src/alpine/utils.ts";

test("getDirSizeKb uses apparent sizes rounded to ext4 blocks", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dirsize-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Highly compressible content: `du` on zfs/btrfs with compression would
  // report almost nothing for this file.
  fs.writeFileSync(path.join(dir, "zeros"), Buffer.alloc(10_000));
  fs.writeFileSync(path.join(dir, "tiny"), "x");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.symlinkSync("zeros", path.join(dir, "sub", "link"));

  // root dir + zeros (3 blocks) + tiny (1) + sub dir (1) + symlink (1)
  assert.equal(getDirSizeKb(dir), (4096 * 7) / 1024);
});

test("getDirSizeKb counts hard-linked files once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-dirsize-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "a"), Buffer.alloc(8192));
  fs.linkSync(path.join(dir, "a"), path.join(dir, "b"));

  // root dir + a (2 blocks); b is the same inode
  assert.equal(getDirSizeKb(dir), (4096 * 3) / 1024);
});
