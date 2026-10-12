import type { XorShift32 } from "../rng.ts";

export type FuzzTarget = {
  name: string;
  description: string;
  /** initial seed corpus */
  seeds: Buffer[];
  /** default max input len */
  defaultMaxLen: number;

  /**
   * Run a single fuzz iteration.
   *
   * Return true if the input is "interesting" and should be added to the corpus.
   * May be async so targets can fuzz promise-returning parsers; the CLI awaits it.
   */
  runOne: (input: Buffer, rng: XorShift32) => boolean | Promise<boolean>;
};
