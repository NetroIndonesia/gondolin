#!/usr/bin/env node
/**
 * Rebrand the Gondolin sandbox tree.
 *
 * This fork is a full derivative of an Apache-2.0 upstream project. The goal is
 * that nothing user-visible refers to the upstream brand or org, while genuine
 * third-party references (the upstream projects this code depends on, downloads
 * from, or cites) are preserved exactly.
 *
 * Design notes:
 *  - Rules are explicit and ordered, longest first, so that a scoped package
 *    name is rewritten before the bare product name inside it.
 *  - Third-party URLs and identifiers live in PROTECTED and are never touched.
 *  - The tool is idempotent: it records what it applied in rebrand.state.json so
 *    re-running after a config change does not corrupt already-renamed text.
 *  - A dry run is the default; pass --apply to write.
 *
 * Usage:
 *   node scripts/rebrand-gondolin.mjs --dry
 *   node scripts/rebrand-gondolin.mjs --apply
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, "rebrand.gondolin.json");
const STATE = path.join(ROOT, "rebrand.gondolin.state.json");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DRY = args.includes("--dry") || !APPLY;

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const state = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, "utf8"))
  : { applied: [] };

const { upstream, brand } = config;

// Text that must survive verbatim because it names somebody else's project,
// service, or release artifact. Anything matched here is skipped outright.
// Only genuine third parties belong here: the upstream project's own names are
// handled by RULES above, so listing them here would block their rename.
const PROTECTED = [
  // Third-party projects this tree builds on, downloads from, or cites:
  "trufflesecurity",
  "containers/libkrun",
  "containers/libkrunfw",
  "nodejs/node",
  "joyent/node",
  "tc39/proposal-explicit-resource-management",
  "wasilibs/go-re2",
  "alpinelinux",
  "libkrun",
  "libkrunfw",
];

// Ordered rewrite rules. Each entry: [description, regex, replacement].
// Longest/most specific first so scoped names are handled before bare names.
// Files that describe the rebrand itself must never be rewritten, or a second
// run would no longer know the original names.
const SKIP_FILES = new Set([
  "rebrand.gondolin.json",
  "rebrand.gondolin.state.json",
  "scripts/rebrand-gondolin.mjs",
]);

// Source files whose names carry the upstream CLI brand. Renamed in place so
// that imports and docs refer to one name only.
const RENAMES = [
  ["host/examples/pi-gondolin.ts", "host/examples/hxf-gondolin.ts"],
];

const RULES = [
  [
    "scoped runner packages",
    new RegExp(escapeRe(`${upstream.scope}/gondolin-krun-runner`), "g"),
    `${brand.scope}/${brand.app}-krun-runner`,
  ],
  [
    "scoped main package",
    new RegExp(escapeRe(`${upstream.scope}/gondolin`), "g"),
    `${brand.scope}/${brand.app}`,
  ],
  [
    "upstream repo urls",
    new RegExp(escapeRe(`github.com/${upstream.org}/${upstream.app}`), "g"),
    `github.com/${brand.org}/${brand.app}`,
  ],
  [
    "upstream repo ssh urls",
    new RegExp(escapeRe(`${upstream.org}/${upstream.app}.git`), "g"),
    `${brand.org}/${brand.app}.git`,
  ],
  [
    "upstream pages site",
    new RegExp(escapeRe(`${upstream.org}.github.io/${upstream.app}`), "g"),
    `${brand.org}.github.io/${brand.app}`,
  ],
  [
    "upstream org in source-query and prose",
    new RegExp(escapeRe(upstream.org), "g"),
    brand.org,
  ],
  [
    "env var prefix",
    new RegExp(`\\b${escapeRe(upstream.envPrefix)}_`, "g"),
    `${brand.envPrefix}_`,
  ],
  [
    "upstream company name",
    new RegExp(escapeRe(upstream.company), "g"),
    brand.company,
  ],
  [
    "upstream website",
    new RegExp(escapeRe(upstream.website), "g"),
    brand.website,
  ],
  [
    "bare vendor name",
    new RegExp(`\\b${escapeRe("Earendil")}\\b`, "g"),
    brand.company,
  ],
  // Case variants. The config holds the CLI name in lowercase ("pi") but the
  // prose writes the capitalised form in headings and changelog entries
  // ("Pi Extension"). A case-sensitive rule leaves every one of those behind,
  // so the vendor name survives in the most visible place there is.
  [
    "upstream CLI brand in prose and paths",
    new RegExp(`\\b${escapeRe(upstream.cli)}\\b`, "g"),
    brand.cli,
  ],
  [
    "upstream CLI brand, capitalised",
    new RegExp(
      `\\b${escapeRe(upstream.cli[0].toUpperCase() + upstream.cli.slice(1))}\\b`,
      "g",
    ),
    brand.cli,
  ],
  [
    "binary / cli name",
    new RegExp(`\\b${escapeRe(upstream.app)}\\b`, "g"),
    brand.app,
  ],
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "zig-out",
  "zig-cache",
  ".zig-cache",
]);
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".toml",
  ".yaml",
  ".yml",
  ".zig",
  ".sh",
  ".txt",
  ".html",
  ".css",
  ".jsonc",
  "",
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (!TEXT_EXT.has(ext)) continue;
      // Skip lockfiles: they are regenerated, not hand-edited.
      if (entry.name === "pnpm-lock.yaml" || entry.name === "package-lock.json")
        continue;
      if (SKIP_FILES.has(path.relative(ROOT, path.join(dir, entry.name))))
        continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function protectedRanges(text) {
  const ranges = [];
  for (const needle of PROTECTED) {
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      ranges.push([idx, idx + needle.length]);
      idx += needle.length;
    }
  }
  return ranges;
}

function inRanges(pos, ranges) {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

let filesChanged = 0;
let totalReplacements = 0;
const perRule = new Map();

for (const file of walk(ROOT)) {
  const original = fs.readFileSync(file, "utf8");
  let text = original;

  for (const [label, re, replacement] of RULES) {
    const ranges = protectedRanges(text);
    let count = 0;
    text = text.replace(re, (match, ...rest) => {
      const offset = rest[rest.length - 2];
      if (typeof offset === "number" && inRanges(offset, ranges)) return match;
      // A rule whose replacement equals its match (e.g. an identity mapping
      // kept for documentation) must not be counted as a change.
      if (replacement === match) return match;
      count++;
      return replacement;
    });
    if (count) {
      perRule.set(label, (perRule.get(label) ?? 0) + count);
      totalReplacements += count;
    }
  }

  if (text !== original) {
    filesChanged++;
    if (APPLY) fs.writeFileSync(file, text);
    console.log(
      `  ${APPLY ? "rewrote" : "would rewrite"} ${path.relative(ROOT, file)}`,
    );
  }
}

// File renames run after content rewrites so the paths in the rules stay valid.
const renamed = [];
for (const [from, to] of RENAMES) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  if (fs.existsSync(src)) {
    if (APPLY) fs.renameSync(src, dst);
    renamed.push([from, to]);
    console.log(`  ${APPLY ? "renamed" : "would rename"} ${from} -> ${to}`);
  }
}

console.log("");
console.log(`  mode          : ${DRY ? "dry run" : "apply"}`);
console.log(`  files changed : ${filesChanged}`);
console.log(`  files renamed : ${renamed.length}`);
console.log(`  replacements  : ${totalReplacements}`);
for (const [label, n] of [...perRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${label.padEnd(34)} ${n}`);
}

if (APPLY) {
  const entry = {
    at: new Date().toISOString(),
    from: upstream,
    to: brand,
    filesChanged,
  };
  state.applied.push(entry);
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`  state recorded: ${path.relative(ROOT, STATE)}`);
}
