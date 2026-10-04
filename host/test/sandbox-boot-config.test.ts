import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_CMDLINE_BINDS_MAX_BYTES,
  buildSandboxfsAppend,
  buildSandboxfsMountsResult,
  normalizeSandboxFsConfig,
} from "../src/sandbox/server-boot-config.ts";

const BASE = "console=ttyAMA0 initramfs_async=1";

function legacyBinds(append: string): string[] | null {
  const arg = append.split(" ").find((a) => a.startsWith("sandboxfs.bind="));
  return arg ? arg.slice("sandboxfs.bind=".length).split(",") : null;
}

test("sandboxfs append includes binds when they fit", () => {
  const config = normalizeSandboxFsConfig({
    type: "boot",
    fuseMount: "/data",
    fuseBinds: ["/workspace", "/etc/gondolin/mitm"],
  });
  assert.equal(
    buildSandboxfsAppend(BASE, config),
    `${BASE} sandboxfs.mount=/data sandboxfs.bind=/etc/gondolin/mitm,/workspace`,
  );
});

test("sandboxfs append never exceeds the cmdline budget", () => {
  const userBinds = Array.from(
    { length: 40 },
    (_, i) => `/home/user/projects/some-long-project-name-${i}/vendor/deps`,
  );
  const config = normalizeSandboxFsConfig({
    type: "boot",
    fuseMount: "/data",
    fuseBinds: [...userBinds, "/etc/gondolin/mitm", "/etc/gondolin/listeners"],
  });

  const append = buildSandboxfsAppend(BASE, config);
  assert.ok(Buffer.byteLength(append) <= LEGACY_CMDLINE_BINDS_MAX_BYTES);

  // gondolin's own mounts are needed by init and must not be dropped
  const binds = legacyBinds(append);
  assert.ok(binds);
  assert.ok(binds.includes("/etc/gondolin/mitm"));
  assert.ok(binds.includes("/etc/gondolin/listeners"));
  assert.ok(binds.length < config.fuseBinds.length);
  assert.deepEqual(binds, [...binds].sort());

  // the rpc result still has the complete list
  assert.deepEqual(buildSandboxfsMountsResult(config), {
    mount: "/data",
    binds: config.fuseBinds,
  });
});

test("sandboxfs append skips binds that cannot be encoded on the cmdline", () => {
  const config = normalizeSandboxFsConfig({
    type: "boot",
    fuseMount: "/data",
    fuseBinds: ["/with space", "/with,comma", "/plain"],
  });
  assert.deepEqual(legacyBinds(buildSandboxfsAppend(BASE, config)), ["/plain"]);
  assert.deepEqual(buildSandboxfsMountsResult(config).binds, [
    "/plain",
    "/with space",
    "/with,comma",
  ]);
});

test("sandboxfs config rejects newlines in bind paths", () => {
  assert.throws(
    () =>
      normalizeSandboxFsConfig({
        type: "boot",
        fuseMount: "/data",
        fuseBinds: ["/foo\nbar"],
      }),
    /newlines/,
  );
});
