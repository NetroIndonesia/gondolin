import assert from "node:assert/strict";
import test from "node:test";

import { SandboxServerOps } from "../src/sandbox/server-ops.ts";

type SentMessage = { t: string; id: number; p: { eof?: boolean } };

/**
 * Minimal stand-in for `SandboxServer` that runs the real file-op methods and
 * emulates a guest which processes one file request at a time (like
 * sandboxd's `handleFileWrite`).
 */
function createFakeServer() {
  const sent: SentMessage[] = [];
  const server = Object.create(SandboxServerOps.prototype) as Record<
    string,
    any
  >;
  Object.assign(server, {
    inflight: new Map(),
    startedExecs: new Map(),
    execQueue: [],
    fileOps: new Map(),
    activeFileOpId: null,
    nextFileOpId: 1,
    start: async () => {},
    assertGuestPath: () => {},
    pumpExecQueue: () => {},
    scheduleControllerIdlePause: () => {},
    sendControlMessage: async (message: SentMessage) => {
      sent.push(message);
      // yield so concurrent callers get a chance to interleave
      await new Promise((resolve) => setImmediate(resolve));
      const done =
        (message.t === "file_write_data" && message.p.eof) ||
        message.t === "file_delete_request";
      if (done) {
        setImmediate(() => server.resolveFileOperation(message.id));
      }
    },
  });
  return { server, sent };
}

test("concurrent guest file writes are serialized", async () => {
  const { server, sent } = createFakeServer();

  const payload = Buffer.alloc(200 * 1024, 0x61);
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) =>
      server.writeGuestFile(`/tmp/f${i}`, payload),
    ),
    server.deleteGuestFile("/tmp/gone"),
  ]);

  // Every request's frames must be contiguous: once a request starts, no
  // other request id may appear until its terminating frame.
  let active: number | null = null;
  const seen = new Set<number>();
  for (const message of sent) {
    if (active === null) {
      assert.ok(
        message.t === "file_write_request" ||
          message.t === "file_delete_request",
        `unexpected ${message.t} with no active request`,
      );
      assert.ok(!seen.has(message.id), "request id reused while unresolved");
      seen.add(message.id);
      active = message.id;
    } else {
      assert.equal(
        message.id,
        active,
        "frames of different requests interleaved",
      );
    }
    if (
      (message.t === "file_write_data" && message.p.eof) ||
      message.t === "file_delete_request"
    ) {
      active = null;
    }
  }
  assert.equal(seen.size, 9);
  assert.equal(server.activeFileOpId, null);
  assert.equal(server.fileOps.size, 0);
});
