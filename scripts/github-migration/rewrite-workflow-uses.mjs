#!/usr/bin/env node
/**
 * Cutover-only: rewrite Forgejo's full-URL `uses:` form to GitHub's short form.
 *
 *   uses: https://github.com/actions/checkout@v4   ->   uses: actions/checkout@v4
 *
 * WHY THIS IS A SCRIPT AND NOT A COMMITTED EDIT
 * --------------------------------------------
 * Forgejo resolves a bare `actions/checkout@v4` against its own
 * DEFAULT_ACTIONS_URL (code.forgejo.org), NOT github.com — which is why every
 * `uses:` in this repo carries the full URL. Applying this rewrite while
 * Forgejo is still the CI host breaks every workflow immediately. Run it as
 * part of the GitHub cutover, in the same commit that stops using Forgejo, and
 * not before.
 *
 * `--reverse` restores the Forgejo form, so a failed cutover is one command
 * away from being undone.
 *
 * Usage:
 *   node scripts/github-migration/rewrite-workflow-uses.mjs --dry-run
 *   node scripts/github-migration/rewrite-workflow-uses.mjs
 *   node scripts/github-migration/rewrite-workflow-uses.mjs --reverse
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const reverse = args.has("--reverse");

// Only rewrite the `uses:` KEY. A bare URL elsewhere (a comment, a curl target,
// a docs link) must be left alone — several workflows cite github.com URLs in
// prose, and this repo's comments are load-bearing.
const TO_SHORT = /(\buses:\s*)https:\/\/github\.com\/([^\s@]+@[^\s]+)/g;
const TO_FULL = /(\buses:\s*)(?!https:\/\/)([A-Za-z0-9._-]+\/[^\s@]+@[^\s]+)/g;

let filesChanged = 0;
let linesChanged = 0;

for (const name of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
  const path = join(DIR, name);
  const before = readFileSync(path, "utf8");
  let after;
  let n = 0;

  if (reverse) {
    after = before.replace(TO_FULL, (_m, key, spec) => {
      n += 1;
      return `${key}https://github.com/${spec}`;
    });
  } else {
    after = before.replace(TO_SHORT, (_m, key, spec) => {
      n += 1;
      return `${key}${spec}`;
    });
  }

  if (n > 0) {
    filesChanged += 1;
    linesChanged += n;
    console.log(`${dryRun ? "would rewrite" : "rewrote"} ${n
      .toString()
      .padStart(3)}  ${path}`);
    if (!dryRun) writeFileSync(path, after);
  }
}

console.log(
  `\n${dryRun ? "DRY RUN — " : ""}${linesChanged} \`uses:\` lines across ${filesChanged} files` +
    ` (${reverse ? "GitHub -> Forgejo" : "Forgejo -> GitHub"})`,
);

if (linesChanged === 0) console.log("Nothing to do — already in the target form.");
