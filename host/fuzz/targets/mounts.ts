import type { VirtualProvider } from "../../src/vfs/node/index.ts";
import {
  getRelativePath,
  isUnderMountPoint,
  listMountPaths,
  normalizeMountMap,
  normalizeMountPath,
} from "../../src/vfs/mounts.ts";
import type { XorShift32 } from "../rng.ts";
import type { FuzzTarget } from "./types.ts";

/** validation errors thrown by normalizeMountPath (all start with "mount path") */
function tryNormalize(raw: string): string | null {
  try {
    return normalizeMountPath(raw);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("mount path")) {
      return null;
    }
    throw err;
  }
}

function invariant(cond: boolean, message: string): void {
  if (!cond) throw new Error(`mounts: ${message}`);
}

const provider = { open: () => undefined } as unknown as VirtualProvider;

function decodePair(input: Buffer): [string, string] {
  const cut = (input[0] ?? 0) % Math.max(1, input.length - 1);
  const first = input.subarray(1, 1 + cut).toString("latin1");
  const second = input.subarray(1 + cut).toString("latin1");
  return [first, second];
}

function encodePair(first: string, second: string): Buffer {
  return Buffer.concat([
    Buffer.from([first.length]),
    Buffer.from(first, "ascii"),
    Buffer.from(second, "ascii"),
  ]);
}

function checkPath(raw: string): string | null {
  const shouldThrow =
    raw.length === 0 || !raw.startsWith("/") || raw.includes("\0");
  const normalized = tryNormalize(raw);
  if (shouldThrow) {
    invariant(
      normalized === null,
      `accepted invalid path ${JSON.stringify(raw)}`,
    );
    return null;
  }
  invariant(normalized !== null, `rejected valid path ${JSON.stringify(raw)}`);
  const n = normalized!;
  invariant(
    n.startsWith("/"),
    `normalized path lost leading slash: ${JSON.stringify(n)}`,
  );
  invariant(
    !n.endsWith("/") || n === "/",
    `normalized path kept trailing slash: ${JSON.stringify(n)}`,
  );
  invariant(!n.includes("\0"), "normalized path kept a null byte");
  invariant(
    tryNormalize(n) === n,
    `normalization is not idempotent: ${JSON.stringify(n)} -> ${JSON.stringify(tryNormalize(n))}`,
  );
  return n;
}

function checkRouting(path: string, mount: string): void {
  const rel = getRelativePath(path, mount);
  const under = isUnderMountPoint(path, mount);
  // Spec, restated independently: a path is under a mount when it equals the
  // mount or starts with "<mount>/" (root mounts swallow every absolute path).
  const shouldBeUnder =
    mount === "/"
      ? path.startsWith("/")
      : path === mount || path.startsWith(`${mount}/`);
  invariant(
    under === shouldBeUnder,
    `prefix boundary disagrees: path=${JSON.stringify(path)} mount=${JSON.stringify(mount)} under=${under}`,
  );
  if (!under) return;
  invariant(
    rel === "/" || rel.startsWith("/"),
    `under a mount but relative path lacks a boundary: path=${JSON.stringify(path)} mount=${JSON.stringify(mount)} rel=${JSON.stringify(rel)}`,
  );
  invariant(
    mount === "/"
      ? rel === path
      : path === mount
        ? rel === "/"
        : path === mount + rel,
    `relative path does not reconstruct the input: ${JSON.stringify(mount)} + ${JSON.stringify(rel)} != ${JSON.stringify(path)}`,
  );
}

function checkMountMap(keyA: string, keyB: string): boolean {
  // keyB always carries a trailing slash so it normalizes back to keyA when
  // the two raw keys denote the same mount point.
  const distinct = keyA !== keyB;
  const normA = tryNormalize(keyA);
  const normB = tryNormalize(keyB);
  const mounts = distinct
    ? { [keyA]: provider, [keyB]: provider }
    : { [keyA]: provider };

  try {
    normalizeMountMap(mounts);
  } catch (err) {
    if (!(err instanceof Error)) {
      throw new Error(`mounts: unexpected throw type: ${String(err)}`);
    }
    if (normA === null || normB === null) {
      invariant(
        err.message.startsWith("mount path"),
        `expected a path validation error, got: ${err.message}`,
      );
      return false;
    }
    if (distinct && normA === normB) {
      invariant(
        err.message.startsWith("duplicate mount path"),
        `expected duplicate detection, got: ${err.message}`,
      );
      return true;
    }
    throw err;
  }

  invariant(
    normA !== null && normB !== null,
    `normalizeMountMap accepted invalid paths ${JSON.stringify(keyA)} / ${JSON.stringify(keyB)}`,
  );
  if (distinct) {
    invariant(
      normA !== normB,
      `duplicate mount ${JSON.stringify(normA)} accepted`,
    );
  }
  const listed = listMountPaths(mounts);
  const expected = Array.from(new Set([normA, normB])).sort();
  invariant(
    JSON.stringify(listed) === JSON.stringify(expected),
    `listMountPaths mismatch: ${JSON.stringify(listed)} vs ${JSON.stringify(expected)}`,
  );
  return true;
}

export const mountsTarget: FuzzTarget = {
  name: "mounts",
  description: "vfs: mount path normalization + prefix routing",
  defaultMaxLen: 512,
  seeds: [
    encodePair("/data", "/mnt"),
    encodePair("/foo", "/foobar"),
    // reverse direction: path is the longer string, so a mount matcher that
    // drops the "/" boundary immediately claims "/foobar" lives under "/foo"
    encodePair("/foobar", "/foo"),
    encodePair("/data2x", "/data"),
    encodePair("/data", "/data/"),
    encodePair("/", "/tmp/cache"),
    encodePair("data", "/mnt"),
    encodePair("/with\0nul", "/mnt"),
    encodePair("/a/b/c", "/a/b"),
  ],
  runOne(input: Buffer, _rng: XorShift32): boolean {
    const [rawPath, rawMount] = decodePair(input);

    const path = checkPath(rawPath);
    const mount = checkPath(rawMount);
    let interesting = false;
    if (path !== null && mount !== null) {
      checkRouting(path, mount);
      interesting = true;
    }

    // normalizeMountMap sees the raw keys (plus a trailing-slash twin of the
    // second one) so duplicate detection is exercised across spellings.
    if (checkMountMap(rawPath, `${rawMount}/`)) interesting = true;
    return interesting;
  },
};
