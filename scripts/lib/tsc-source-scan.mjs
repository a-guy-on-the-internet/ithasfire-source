// Newest-source-mtime scanning, shared by scripts/tsc-daemon.mjs (which records
// a watermark when a compile cycle STARTS) and scripts/tsc-status.mjs (which
// compares that watermark against the tree as it is NOW).
//
// Both sides must agree on what counts as "a source file", or staleness is
// either over- or under-reported. That is the only reason this lives in its own
// module.
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".expo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
  "playwright-report",
  "test-results",
  "ios",
  "android",
]);

const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
// A tsconfig edit changes the program as surely as a source edit does.
const CONFIG_FILE = /^tsconfig.*\.json$/;

function isSource(name) {
  return SOURCE_FILE.test(name) || CONFIG_FILE.test(name);
}

/**
 * Walk `roots` (repo-root-relative) and return every source file with its mtime.
 * Paths come back repo-root-relative and POSIX-separated so they line up with
 * `git status --porcelain` output.
 */
export function scanSources(repoRoot, roots) {
  const files = [];
  const seen = new Set();

  const walk = (abs) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // a directory that vanished mid-walk is not an error here
    }
    for (const entry of entries) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
        walk(child);
        continue;
      }
      if (!entry.isFile() || !isSource(entry.name)) continue;
      const rel = path.relative(repoRoot, child).split(path.sep).join("/");
      if (seen.has(rel)) continue;
      let stat;
      try {
        stat = fs.statSync(child);
      } catch {
        continue;
      }
      seen.add(rel);
      files.push({ path: rel, mtimeMs: stat.mtimeMs });
    }
  };

  for (const root of roots) {
    const abs = path.resolve(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs);
  }

  let newest = null;
  for (const file of files) {
    if (!newest || file.mtimeMs > newest.mtimeMs) newest = file;
  }
  return { files, newest, count: files.length };
}

/**
 * The watermark record the daemon stores, derived from a scan.
 *
 * CLAMPED to the cycle's wall clock. The newest mtime alone is not safe: an
 * rsync/tar restore, a skewed bind-mount clock or a stray `touch` can put a
 * source file in the FUTURE, which would drag the watermark past real time and
 * make every later edit compare as "not newer" — a permanent confident green on
 * a tree nobody is re-checking. Clamping makes that file report itself
 * perpetually stale instead: noisy, but stale is the direction we are willing
 * to be wrong in.
 */
export function watermarkFrom(scan, cycleStartMs = Date.now()) {
  const newestMtimeMs = scan.newest ? scan.newest.mtimeMs : 0;
  const mtimeMs = Math.min(newestMtimeMs, cycleStartMs);
  return {
    mtimeMs,
    iso: mtimeMs ? new Date(mtimeMs).toISOString() : null,
    file: scan.newest ? scan.newest.path : null,
    fileCount: scan.count,
    // Recorded so `tsc:status` can explain why a file looks eternally stale.
    clampedFrom: newestMtimeMs > cycleStartMs ? newestMtimeMs : null,
  };
}

/** Files that changed after a watermark — the staleness evidence. */
export function newerThan(scan, watermarkMtimeMs) {
  return scan.files
    .filter((f) => f.mtimeMs > watermarkMtimeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Memoize scans within one process so six targets sharing `packages` pay once. */
export function createScanCache(repoRoot, ttlMs = 0) {
  const cache = new Map();
  return (roots) => {
    const key = [...roots].sort().join("|");
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at <= ttlMs) return hit.scan;
    const scan = scanSources(repoRoot, roots);
    cache.set(key, { at: now, scan });
    return scan;
  };
}
