import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { VM } from "../src/vm/core.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

test("QEMU idle resume restores guest wall clock before exec", {
  timeout: 120_000,
}, async (t) => {
  if (shouldSkipVmTests()) {
    t.skip("hardware virtualization unavailable");
    return;
  }

  const vm = await VM.create({
    sandbox: { vmm: "qemu", console: "none", qemuIdlePauseMs: 1000 },
  });
  try {
    const before = await vm.exec(["/bin/date", "+%s"]);
    assert.equal(before.exitCode, 0);

    await delay(5000);

    const after = await vm.exec(["/bin/date", "+%s"]);
    assert.equal(after.exitCode, 0);
    const guestSeconds = Number(after.stdout.trim());
    assert.ok(Number.isFinite(guestSeconds));
    assert.ok(
      Math.abs(guestSeconds - Date.now() / 1000) < 3,
      `guest clock still behind after idle resume: ${guestSeconds}`,
    );
  } finally {
    await vm.close();
  }
});
