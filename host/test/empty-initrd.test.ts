import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEmptyInitrd,
  resolveUsableKrunInitrd,
} from "../src/utils/empty-initrd.ts";

test("createEmptyInitrd is a non-empty newc archive with only a trailer", (t) => {
  const initrd = createEmptyInitrd();
  assert.equal(initrd.length, 512);
  assert.equal(initrd.subarray(0, 6).toString("latin1"), "070701");
  assert.equal(initrd.subarray(110, 120).toString("latin1"), "TRAILER!!!");

  let listing: string;
  try {
    listing = execFileSync("cpio", ["-it"], {
      input: initrd,
      encoding: "utf8",
    });
  } catch {
    t.skip("cpio not available");
    return;
  }
  assert.equal(listing.trim(), "");
});

test("resolveUsableKrunInitrd replaces 0-byte initrds", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-initrd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const good = path.join(dir, "good");
  fs.writeFileSync(good, "x");
  assert.equal(resolveUsableKrunInitrd(good), good);

  const empty = path.join(dir, "empty");
  fs.writeFileSync(empty, "");
  const replaced = resolveUsableKrunInitrd(empty);
  assert.notEqual(replaced, empty);
  assert.ok(fs.readFileSync(replaced).equals(createEmptyInitrd()));
});
