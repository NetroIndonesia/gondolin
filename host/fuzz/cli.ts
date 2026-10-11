import fs from "node:fs";
import path from "node:path";

import { XorShift32 } from "./rng.ts";
import { mutateBuffer } from "./mutate.ts";
import { targets } from "./targets/index.ts";
import type { FuzzTarget } from "./targets/types.ts";

function getArgv(): string[] {
  const argv = process.argv.slice(2);
  // Some package managers forward an extra "--".
  if (argv[0] === "--") return argv.slice(1);
  return argv;
}

function parseArg(argv: string[], flag: string): string | null {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] ?? "";
}

function usage() {
  const names = Object.keys(targets).sort().join(", ");
  process.stderr.write(
    `usage: pnpm run fuzz -- <target|--all> [--iters N] [--seed N] [--max-len N] [--repro FILE]\n\n` +
      `By default the fuzzer runs forever (like libFuzzer). Use --iters to run a bounded number of iterations.\n` +
      `--all runs every target sequentially and requires --iters (CI smoke run).\n\n` +
      `Available targets: ${names}\n`,
  );
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function writeArtifact(target: string, data: Buffer): string {
  const dir = path.join(import.meta.dirname, "artifacts", target);
  ensureDir(dir);
  const name = `${Date.now()}-${process.pid}.bin`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

/**
 * Run one fuzz target. `iters === null` runs forever (libFuzzer-style);
 * a positive value is a bounded run suitable for CI smoke.
 * Returns the final corpus size.
 */
function runBounded(
  target: FuzzTarget,
  iters: number | null,
  seed: number,
  maxLen: number,
): number {
  const rng = new XorShift32(seed);
  const corpus: Buffer[] = target.seeds.map((s) => Buffer.from(s));
  const maxCorpus = 1024;

  for (let i = 0; iters === null || iters === 0 || i < iters; i++) {
    const base = corpus[rng.int(0, corpus.length - 1)]!;
    const input = mutateBuffer(base, rng, { maxLen });

    try {
      const interesting = target.runOne(input, rng);
      if (interesting && corpus.length < maxCorpus) {
        // Keep a copy to avoid later mutation aliasing.
        corpus.push(Buffer.from(input));
      }
    } catch (err: any) {
      const artifact = writeArtifact(target.name, input);
      process.stderr.write(
        `\nFUZZ CRASH in target '${target.name}' at iter=${i} seed=${seed}\n`,
      );
      process.stderr.write(`artifact: ${artifact}\n`);
      process.stderr.write(`error: ${String(err?.stack ?? err)}\n`);
      process.exitCode = 1;
      return corpus.length;
    }

    if ((i + 1) % 5000 === 0) {
      if (iters === null || iters === 0) {
        process.stderr.write(
          `target=${target.name} iter=${i + 1} corpus=${corpus.length} maxLen=${maxLen}\r`,
        );
      } else {
        process.stderr.write(
          `target=${target.name} iter=${i + 1}/${iters} corpus=${corpus.length} maxLen=${maxLen}\r`,
        );
      }
    }
  }

  // Only reachable for bounded runs.
  process.stderr.write(
    `\nDone. target=${target.name} iters=${String(iters)} corpus=${corpus.length}\n`,
  );
  return corpus.length;
}

async function main() {
  const argv = getArgv();

  const targetName = argv[0];
  if (!targetName || targetName === "-h" || targetName === "--help") {
    usage();
    process.exit(targetName ? 0 : 2);
  }

  const runAll = targetName === "--all";
  const target = runAll ? null : targets[targetName];
  if (!runAll && !target) {
    process.stderr.write(`unknown target: ${targetName}\n`);
    usage();
    process.exit(2);
  }

  const itersArg = parseArg(argv, "--iters");
  if (itersArg === "") throw new Error("--iters requires a value");
  const iters = itersArg === null ? null : Number.parseInt(itersArg, 10);
  const seed = Number.parseInt(parseArg(argv, "--seed") ?? "1", 10);
  const maxLenArg = parseArg(argv, "--max-len");
  const maxLen =
    maxLenArg === null
      ? null
      : Number.parseInt(maxLenArg, maxLenArg.startsWith("0x") ? 16 : 10);
  const reproFile = parseArg(argv, "--repro");

  if (iters !== null) {
    if (!Number.isFinite(iters)) throw new Error("--iters must be a number");
    if (iters < 0) throw new Error("--iters must be >= 0");
  }
  if (runAll && (iters === null || iters === 0)) {
    throw new Error("--all requires a positive --iters (bounded run only)");
  }
  if (!Number.isFinite(seed)) throw new Error("--seed must be finite");
  if (maxLen !== null && (!Number.isFinite(maxLen) || maxLen <= 0)) {
    throw new Error("--max-len must be > 0");
  }

  const rng = new XorShift32(seed);

  if (reproFile) {
    const input = fs.readFileSync(reproFile);
    if (runAll) {
      for (const t of Object.values(targets)) {
        t.runOne(input, new XorShift32(seed));
      }
      process.stderr.write(`repro OK (all targets): ${reproFile}\n`);
    } else {
      target!.runOne(input, rng);
      process.stderr.write(`repro OK: ${reproFile}\n`);
    }
    return;
  }

  if (runAll) {
    let crashed = false;
    for (const t of Object.values(targets)) {
      runBounded(t, iters as number, seed, maxLen ?? t.defaultMaxLen);
      if (process.exitCode) {
        crashed = true;
        break;
      }
    }
    if (!crashed) {
      process.stderr.write(
        `Done. all=${Object.keys(targets).length} iters=${iters} seed=${seed}\n`,
      );
    }
    return;
  }

  runBounded(target!, iters, seed, maxLen ?? target!.defaultMaxLen);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
