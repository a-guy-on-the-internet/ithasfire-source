#!/usr/bin/env tsx
/**
 * Help-centre drift check.
 *
 * Walks `apps/web/content/help/**\/*.md`, reads each article's `specs:`
 * frontmatter, and compares the last-commit timestamp of each referenced spec
 * against the article's own last-commit timestamp. Reports articles whose
 * linked spec has been touched more recently than the article.
 *
 * Uses `git log -1 --format=%ct` rather than filesystem mtimes because
 * fs mtimes get reset on checkout, which produces false negatives.
 *
 * Exit codes:
 *   0 — every article is up to date (or has no `specs:` to check)
 *   1 — at least one article may be stale; review suggested
 *   2 — configuration error (missing spec file referenced by an article)
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";

// ─── Paths ───────────────────────────────────────────────────────────────────

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const HELP_ROOT = join(REPO_ROOT, "apps", "web", "content", "help");
const SPECS_ROOT = join(REPO_ROOT, "docs", "specs");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

/** Last-commit timestamp (ms). Falls back to fs mtime if the file is untracked. */
function lastChangedMs(path: string): number {
  const proc = spawnSync("git", ["log", "-1", "--format=%ct", "--", path], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const out = proc.stdout?.trim();
  if (out && /^\d+$/.test(out)) {
    return parseInt(out, 10) * 1000;
  }
  // Uncommitted or untracked — use fs mtime as a soft fallback
  return statSync(path).mtimeMs;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ─── Check ───────────────────────────────────────────────────────────────────

interface Issue {
  article: string;
  spec: string;
  articleAt: number;
  specAt: number;
  kind: "drift" | "missing";
}

const issues: Issue[] = [];
let articlesChecked = 0;

if (!existsSync(HELP_ROOT)) {
  console.error(`help root not found: ${HELP_ROOT}`);
  process.exit(2);
}

for (const articlePath of walkMarkdown(HELP_ROOT)) {
  const raw = readFileSync(articlePath, "utf8");
  const { data } = matter(raw) as { data: { specs?: unknown } };
  const specs = Array.isArray(data.specs) ? (data.specs as string[]) : [];
  if (specs.length === 0) continue;

  articlesChecked += 1;
  const articleAt = lastChangedMs(articlePath);

  for (const ref of specs) {
    // Specs ship as .spec.md or .spec.yaml — accept either.
    const candidates = [
      join(SPECS_ROOT, `${ref}.spec.md`),
      join(SPECS_ROOT, `${ref}.spec.yaml`),
    ];
    const specPath = candidates.find(existsSync) ?? candidates[0]!;
    if (!existsSync(specPath)) {
      issues.push({
        article: relative(REPO_ROOT, articlePath),
        spec: relative(REPO_ROOT, specPath),
        articleAt,
        specAt: 0,
        kind: "missing",
      });
      continue;
    }

    const specAt = lastChangedMs(specPath);
    if (specAt > articleAt) {
      issues.push({
        article: relative(REPO_ROOT, articlePath),
        spec: relative(REPO_ROOT, specPath),
        articleAt,
        specAt,
        kind: "drift",
      });
    }
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (issues.length === 0) {
  console.log(
    `✓ ${articlesChecked} help article(s) with spec links — all up to date.`,
  );
  process.exit(0);
}

const drift = issues.filter((i) => i.kind === "drift");
const missing = issues.filter((i) => i.kind === "missing");

if (missing.length > 0) {
  console.log(
    `\n✗ ${missing.length} spec reference(s) point to files that do not exist:`,
  );
  for (const m of missing) {
    console.log(`  ${m.article}`);
    console.log(`    → ${m.spec}  (missing)`);
  }
}

if (drift.length > 0) {
  console.log(
    `\n⚠ ${drift.length} article(s) may need review — spec modified since article:`,
  );
  for (const d of drift) {
    console.log(`  ${d.article}  (last touched ${formatDate(d.articleAt)})`);
    console.log(`    → ${d.spec}  (last touched ${formatDate(d.specAt)})`);
  }
}

console.log(
  `\nChecked ${articlesChecked} article(s) with spec links. See ` +
    `.claude/skills/help-center-authoring/SKILL.md for the drift-sweep workflow.`,
);

// Exit 2 on missing specs (a real config bug), 1 on drift, 0 on clean
process.exit(missing.length > 0 ? 2 : 1);
