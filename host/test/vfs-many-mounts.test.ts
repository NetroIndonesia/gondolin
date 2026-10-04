import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "../src/vfs/node/index.ts";
import {
  closeVm,
  scheduleForceExit,
  shouldSkipVmTests,
  withVm,
} from "./helpers/vm-fixture.ts";

const skipVmTests = shouldSkipVmTests();
const timeoutMs = Number(process.env.WS_TIMEOUT ?? 60000);

// Enough mounts that the bind list would not fit on the kernel cmdline
const mountPaths = Array.from(
  { length: 40 },
  (_, i) => `/workspace/some-rather-long-project-directory-name-${i}/deps`,
);
mountPaths.push("/with space/and,comma");

const mounts: Record<string, MemoryProvider> = {};
for (const mountPath of mountPaths) {
  mounts[mountPath] = new MemoryProvider();
}

const vmKey = "vfs-many-mounts";
const vmOptions = {
  sandbox: { console: "none" as const },
  vfs: { mounts },
};

test.after(async () => {
  await closeVm(vmKey);
  scheduleForceExit();
});

test("many vfs mounts do not truncate the kernel cmdline or drop the mitm ca", {
  skip: skipVmTests,
  timeout: timeoutMs,
}, async () => {
  await withVm(vmKey, vmOptions, async (vm) => {
    for (const [mountPath, provider] of Object.entries(mounts)) {
      const handle = await provider.open("/marker", "w+");
      await handle.writeFile(mountPath);
      await handle.close();
    }

    await vm.start();

    const cmdline = await vm.exec(["/bin/sh", "-c", "cat /proc/cmdline"]);
    assert.equal(cmdline.exitCode, 0, cmdline.stderr);
    assert.ok(
      Buffer.byteLength(cmdline.stdout.trim()) < 2047,
      `cmdline looks truncated (${cmdline.stdout.length} bytes)`,
    );

    // init must have found the MITM CA (bound from /etc/gondolin/mitm)
    const env = await vm.exec(["/bin/sh", "-c", 'echo "$SSL_CERT_FILE"']);
    assert.equal(env.exitCode, 0, env.stderr);
    assert.equal(env.stdout.trim(), "/run/gondolin/ca-certificates.crt");

    // init itself (not the host fallback) bound every mount
    const binds = await vm.exec(["/bin/cat", "/run/sandboxfs.binds"]);
    assert.equal(binds.exitCode, 0, binds.stderr);
    const bindList = binds.stdout.split("\n").filter(Boolean);
    for (const mountPath of mountPaths) {
      assert.ok(bindList.includes(mountPath), `missing bind ${mountPath}`);
    }
    assert.ok(bindList.includes("/etc/gondolin/mitm"));

    for (const mountPath of mountPaths) {
      const read = await vm.exec(["/bin/cat", `${mountPath}/marker`]);
      assert.equal(read.exitCode, 0, read.stderr);
      assert.equal(read.stdout, mountPath);
    }
  });
});
