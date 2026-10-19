#!/usr/bin/env node
/**
 * Guard: docs links and `docs/` paths must resolve.
 *
 * Checks (all over TRACKED files only):
 *  a. Relative links in tracked markdown resolve to a file or directory.
 *  b. Every `docs/...` path mentioned in any tracked text file exists.
 *  c. Every docs/*.md and docs/runbooks/*.md is linked from docs/README.md.
 *  d. Every file under docs/records/ has a date-prefixed basename.
 *
 * Usage: node scripts/docs-check.mjs [--quiet | --self-test]
 *   --quiet      print errors and the summary only, not warnings.
 *   --self-test  run this script against fixture repos in a temp dir and
 *                assert that each planted break turns the gate red.
 * Exit 1 when any error is found, else 0. Runs on the repo that holds cwd.
 *
 * Resolution: a target exists only when it is a tracked file that is on disk,
 * or a directory holding one. So an untracked or gitignored file, a wrong-case
 * name (passes on macOS, 404s on Linux) and a tracked file deleted in the
 * working tree all count as missing. Skip-worktree (sparse) files are
 * dropped. A link or mention that resolves outside the repo is a finding.
 *
 * Matcher choices:
 *  - (a) checks inline links `[x](path)` / `![x](path)` only. NOT checked:
 *    reference-style definitions (`[x]: path`), HTML `href=` / `src=`,
 *    autolinks. Skips URL schemes (`https:`, `vscode:`, `file:` ...), `//`
 *    URLs, pure #anchors, links in fenced code and inline code spans. A
 *    root-absolute `/x` resolves from the repo root. Only the file part is
 *    checked, never the anchor.
 *    apps/web/content/help/** is out of scope (links are site routes).
 *  - (b) counts a mention when `docs/` is not preceded by a path character
 *    (`[A-Za-z0-9_./-]`), or is preceded by `./` that is itself not part of a
 *    path. So `apps/web/docs/x` and `../docs/x` never match; `@docs/x`,
 *    `**docs/x**`, `|docs/x|` and `./docs/x` do. The path ends at whitespace,
 *    quotes, brackets, `<>|*\$,;?#`; then trailing punctuation and a `:12`,
 *    `:12-30` or `:12:5` suffix are dropped, and the path is normalized. A
 *    path cut at a placeholder (`<date>`, a lone `*`, `{a,b}`, `$VAR`, `YYYY`,
 *    `...`; not `**` or `</tag>`) is checked as a prefix of a tracked path. An
 *    extensionless or line-wrapped (`-` at the end) path counts when it is the
 *    stem of a tracked file. Paths under GENERATED_DOCS_DIRS pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

// A missing docs/README.md row or an undated record name is an error.
const INDEX_AND_RECORD_NAMES_ARE_ERRORS = true;

// Runtime output dirs (gitignored); a mention of a path inside one passes.
const GENERATED_DOCS_DIRS = ["docs/curation/"];

// Records and specs are never rewritten, and an applied migration is
// checksummed by Prisma, so a stale path inside them warns.
const isFrozenHistorical = (file) =>
  file.startsWith("docs/records/") ||
  file.startsWith("docs/specs/") ||
  file.startsWith("packages/db/prisma/migrations/");

const git = (args, { cwd, env, okStatus = [] } = {}) => {
  const r = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw r.error;
  if (r.status === 0 || okStatus.includes(r.status)) return r;
  throw new Error(`git ${args.join(" ")} exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
};

// Yields { line, target } for each inline link outside code.
function* markdownLinks(text) {
  let fence = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    if (fence) {
      const c = raw.match(/^\s*(`+|~+)\s*$/);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      continue;
    }
    const o = raw.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (o && !(o[1][0] === "`" && o[2].includes("`"))) {
      fence = { ch: o[1][0], len: o[1].length, line: i + 1 };
      continue;
    }
    const t = raw.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
    for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
      yield { line: i + 1, target: m[1] };
    }
  }
  if (fence) yield { line: fence.line, unclosedFence: true };
}

const escapesRepo = (p) => p === ".." || p.startsWith("../");

// Repo-relative path of a link (`/x` is repo-root relative), or null when it
// is a URL or a pure anchor. An escaping path comes back as `../...`.
const linkPath = (fromFile, target) => {
  if (/^(?:[a-z][a-z0-9+.-]*:(?!\d)|#|\/\/)/i.test(target)) return null;
  let t = target.split("#")[0].split("?")[0];
  if (!t) return null;
  try {
    t = decodeURI(t);
  } catch {
    /* keep raw */
  }
  const joined = t.startsWith("/") ? t.slice(1) : posix.join(posix.dirname(fromFile), t);
  return posix.normalize(joined || ".").replace(/\/+$/, "");
};

function check() {
  const quiet = process.argv.includes("--quiet");
  const REPO = git(["rev-parse", "--show-toplevel"]).stdout.trim();

  // A tracked file deleted in the working tree is neither a source nor a
  // target: a peer's uncommitted deletion is a real break in this view.
  // Skip-worktree (sparse checkout, tag S) entries are dropped quietly.
  const sparse = new Set();
  const listed = new Set();
  for (const row of git(["-C", REPO, "ls-files", "-t", "-z"]).stdout.split("\0").filter(Boolean)) {
    const path = row.slice(2);
    if (row[0] === "S") sparse.add(path);
    else listed.add(path);
  }
  const tracked = [...listed]
    .filter((f) => !sparse.has(f) && existsSync(join(REPO, f)))
    .sort();
  const trackedSet = new Set(tracked);
  const dirs = new Set();
  for (const f of tracked) {
    for (let d = posix.dirname(f); d !== "."; d = posix.dirname(d)) {
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  }
  const exists = (p) => p === "" || p === "." || trackedSet.has(p) || dirs.has(p);
  const hasTrackedPrefix = (prefix) => {
    let lo = 0;
    let hi = tracked.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tracked[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo < tracked.length && tracked[lo].startsWith(prefix);
  };

  // findings[check] = [{ severity, source, line, target }]
  const findings = { setup: [], links: [], mentions: [], index: [], records: [] };
  const add = (check, severity, source, line, target) =>
    findings[check].push({ severity, source, line, target });
  const severityFor = (source) => (isFrozenHistorical(source) ? "warning" : "error");
  const stats = { markdown: 0, grepRows: 0, mentions: 0, generated: 0, indexCandidates: 0 };

  // (a) relative markdown links
  const LINK_SCOPES = ["docs/", "apps/", "packages/", "infra/"];
  const inLinkScope = (f) =>
    f.endsWith(".md") &&
    !f.startsWith("apps/web/content/help/") &&
    (!f.includes("/") || LINK_SCOPES.some((s) => f.startsWith(s)));

  for (const file of tracked.filter(inLinkScope)) {
    stats.markdown++;
    for (const l of markdownLinks(readFileSync(join(REPO, file), "utf8"))) {
      if (l.unclosedFence) {
        add("links", "warning", file, l.line, "code fence never closes; links after it are unchecked");
        continue;
      }
      const resolved = linkPath(file, l.target);
      if (resolved === null || exists(resolved)) continue;
      const shown = escapesRepo(resolved) ? `${l.target} (escapes repo)` : l.target;
      add("links", severityFor(file), file, l.line, shown);
    }
  }

  // (b) docs/ path mentions in any tracked text file
  const grepOut = git(
    [
      "-C", REPO, "grep", "-z", "-n", "-I", "-F", "--no-color", "--no-column",
      "--no-recurse-submodules", "-e", "docs/",
      "--", ".", ":!pnpm-lock.yaml", ":!**/*.lock", ":!scripts/docs-check.mjs",
    ],
    // exit 1 = no matches; anything else must not pass as "no mentions".
    { okStatus: [1] },
  ).stdout;
  const MENTION =
    /(?:(?<![A-Za-z0-9_./-])|(?<=(?<![A-Za-z0-9_./-])\.\/))docs\/[^\s"'`()[\]{}<>|*\\$,;?#‘’“”]*/g;
  // What follows the path: `<name>`, a lone `*`, `{a,b}`, `$VAR`. Not `</`
  // (a closing tag) and not `**` (bold).
  const PLACEHOLDER_STOP = /^(?:<[A-Za-z_-]+>|\*(?!\*)|[{$])/;
  const PLACEHOLDER_TOKEN = /YYYY|\.\.\.|…/;
  const trimTail = (p) => p.replace(/[.,;:!?)\]}'"`]+$/, "");
  const isGenerated = (p) => GENERATED_DOCS_DIRS.some((d) => `${p.replace(/\/$/, "")}/`.startsWith(d));
  const mentionResolves = (p, cut) => {
    if (p.endsWith("/")) return exists(p.slice(0, -1));
    if (exists(p)) return true;
    if (/\.[A-Za-z0-9]+$/.test(p.slice(p.lastIndexOf("/") + 1))) return false;
    // A cut placeholder or a comment wrapped mid-name (`.../gated-event-`)
    // leaves a prefix; prose drops the extension (`docs/engineering-standards`).
    if (cut || p.endsWith("-")) return hasTrackedPrefix(p);
    return hasTrackedPrefix(`${p}.`) || hasTrackedPrefix(`${p}/`);
  };
  const unparseable = (pos, why) => {
    throw new Error(`git grep row ${why} at byte ${pos}: ${JSON.stringify(grepOut.slice(pos, pos + 200))}`);
  };
  const unresolved = [];
  for (let pos = 0; pos < grepOut.length; ) {
    const a = grepOut.indexOf("\0", pos);
    const b = a < 0 ? -1 : grepOut.indexOf("\0", a + 1);
    const end = b < 0 ? -1 : grepOut.indexOf("\n", b + 1);
    if (end < 0) unparseable(pos, "is not path\\0line\\0text");
    const source = grepOut.slice(pos, a);
    const lineNo = grepOut.slice(a + 1, b);
    const text = grepOut.slice(b + 1, end).replace(/\r$/, "");
    if (!/^\d+$/.test(lineNo)) unparseable(pos, "has no line number");
    pos = end + 1;
    if (sparse.has(source)) continue;
    if (!trackedSet.has(source)) unparseable(a - source.length, "names an untracked path");
    stats.grepRows++;
    for (const hit of text.matchAll(MENTION)) {
      let p = hit[0];
      let cut = PLACEHOLDER_STOP.test(text.slice(hit.index + p.length));
      const token = p.search(PLACEHOLDER_TOKEN);
      if (token >= 0) {
        p = p.slice(0, token);
        cut = true;
      }
      p = trimTail(trimTail(p).replace(/:\d+(?:[-:]\d+)?$/, ""));
      if (p === "docs" || p === "docs/") continue;
      p = posix.normalize(p);
      stats.mentions++;
      if (escapesRepo(p.replace(/\/$/, ""))) {
        add("mentions", severityFor(source), source, Number(lineNo), `${p} (escapes repo)`);
        continue;
      }
      if (mentionResolves(p, cut)) continue;
      if (isGenerated(p)) {
        stats.generated++;
        continue;
      }
      add("mentions", severityFor(source), source, Number(lineNo), p);
    }
  }
  if (stats.grepRows === 0 && tracked.some((f) => f.startsWith("docs/"))) {
    add("setup", "error", REPO, 0, "docs/ exists but git grep returned no rows; scanned nothing");
  }

  // (c) index rows
  const indexSeverity = INDEX_AND_RECORD_NAMES_ARE_ERRORS ? "error" : "warning";
  const linked = new Set();
  if (trackedSet.has("docs/README.md")) {
    const readme = readFileSync(join(REPO, "docs/README.md"), "utf8").replace(
      /<!--[\s\S]*?-->/g,
      (c) => c.replace(/[^\n]/g, ""),
    );
    for (const l of markdownLinks(readme)) {
      const resolved = l.target && linkPath("docs/README.md", l.target);
      if (resolved) linked.add(resolved);
    }
  } else {
    add("setup", "error", "docs/README.md", 0, "not tracked; nothing to index against");
  }
  for (const f of tracked) {
    if (!/^docs\/(runbooks\/)?[^/]+\.md$/.test(f) || f === "docs/README.md") continue;
    stats.indexCandidates++;
    if (!linked.has(f)) add("index", indexSeverity, f, 0, "no row in docs/README.md");
  }
  if (stats.markdown === 0) add("setup", "error", REPO, 0, "no tracked markdown in scope; scanned nothing");

  // (d) dated record names
  for (const f of tracked) {
    if (!f.startsWith("docs/records/")) continue;
    if (!/^\d{4}-\d{2}-\d{2}-.+/.test(posix.basename(f))) {
      add("records", indexSeverity, f, 0, "basename needs a YYYY-MM-DD- prefix");
    }
  }

  // report
  const titles = {
    setup: "setup",
    links: "(a) relative markdown links",
    mentions: "(b) docs/ path mentions",
    index: "(c) docs/README.md index rows",
    records: "(d) dated record names",
  };
  const counts = [];
  let errors = 0;
  for (const [check, list] of Object.entries(findings)) {
    const e = list.filter((f) => f.severity === "error").length;
    const w = list.length - e;
    errors += e;
    if (check !== "setup") counts.push(`${check}: ${e} error, ${w} warning`);
    const shown = list.filter((f) => f.severity === "error" || !quiet);
    if (!shown.length) continue;
    console.log(`\n${titles[check]}`);
    for (const f of shown) {
      const where = f.line ? `${f.source}:${f.line}` : f.source;
      console.log(`  ${f.severity === "error" ? "ERROR" : "warn "} ${where} → ${f.target}`);
    }
  }
  console.log(
    `\nscanned ${REPO}: ${stats.markdown} markdown files, ${stats.grepRows} grep rows, ` +
      `${stats.mentions} docs/ mentions (${stats.generated} in generated dirs), ${stats.indexCandidates} index candidates`,
  );
  console.log(`docs:check ${errors ? "FAILED" : "ok"} | ${counts.join(" | ")}`);
  process.exitCode = errors ? 1 : 0;
}

function selfTest() {
  const script = fileURLToPath(import.meta.url);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const base = {
    "docs/README.md": "# Docs\n\n| [Hot paths](hot-paths.md) | x |\n| [X](x.md) | x |\n",
    "docs/hot-paths.md": "# Hot paths\n",
    "docs/x.md": "# X\n",
    "CLAUDE.md": "Read docs/hot-paths.md first.\n",
  };
  const cases = [
    { name: "clean fixture", files: {}, exit: 0 },
    {
      name: "broken relative link in a living doc",
      files: { "docs/x.md": "# X\n\n[gone](missing.md)\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:3 → missing.md"],
    },
    {
      name: "broken link in docs/specs/ only warns",
      files: { "docs/specs/s.md": "[gone](missing.md)\n" },
      exit: 0,
      expect: ["warn  docs/specs/s.md:1 → missing.md"],
    },
    {
      name: "./docs/ mention in a skill",
      files: { ".claude/skills/x/SKILL.md": "Read ./docs/missing.md first.\n" },
      exit: 1,
      expect: ["ERROR .claude/skills/x/SKILL.md:1 → docs/missing.md"],
    },
    {
      name: "@docs/ import mention",
      files: { "CLAUDE.md": "@docs/missing.md\n" },
      exit: 1,
      expect: ["ERROR CLAUDE.md:1 → docs/missing.md"],
    },
    {
      name: "**docs/**, <code>, |table| and \\n mentions",
      files: {
        "notes.txt":
          "**docs/gone1.md**\n<code>docs/gone2.md</code>\n|docs/gone3.md|\n\"see docs/gone4.md\\n\"\n",
      },
      exit: 1,
      expect: ["→ docs/gone1.md", "→ docs/gone2.md", "→ docs/gone3.md", "→ docs/gone4.md"],
    },
    {
      name: "CRLF workflow mention",
      files: { ".github/workflows/x.yml": "on: push\r\n# see docs/missing.md\r\n" },
      exit: 1,
      expect: ["ERROR .github/workflows/x.yml:2 → docs/missing.md"],
    },
    {
      name: "path with a colon and non-ASCII",
      files: { "notes/a:b é.txt": "see docs/missing.md\n" },
      exit: 1,
      expect: ["ERROR notes/a:b é.txt:1 → docs/missing.md"],
    },
    {
      name: "link after a mismatched fence",
      files: {
        "docs/x.md": "# X\n\n````text\n```text\n[in](inside-missing.md)\n````\n\n[after](after-missing.md)\n",
      },
      exit: 1,
      expect: ["ERROR docs/x.md:8 → after-missing.md"],
      reject: ["inside-missing.md"],
    },
    {
      name: "inline ```ts``` span does not open a fence",
      files: { "docs/x.md": "```ts``` is inline\n\n[gone](missing.md)\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:3 → missing.md"],
    },
    {
      name: "wrong-case link",
      files: { "docs/x.md": "[hp](Hot-Paths.md)\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:1 → Hot-Paths.md"],
    },
    {
      name: "untracked target",
      files: { "docs/x.md": "[new](new.md)\n" },
      untracked: { "docs/new.md": "# New\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:1 → new.md"],
    },
    {
      name: "tracked target deleted on disk",
      files: { "docs/x.md": "[old](old.md)\n", "docs/old.md": "# Old\n" },
      deleteAfterAdd: ["docs/old.md"],
      exit: 1,
      expect: ["ERROR docs/x.md:1 → old.md"],
    },
    {
      name: "generated dir: its mention passes, a link to it and other misses fail",
      files: {
        ".gitignore": "docs/curation/\n",
        "notes.txt": "writes docs/curation/run.json\nsee docs/gone.md\nwrites docs/out/run.json\n",
        "docs/x.md": "[run](curation/run.json)\n",
      },
      untracked: { "docs/curation/run.json": "{}\n", "docs/out/run.json": "{}\n" },
      exit: 1,
      expect: [
        "ERROR docs/x.md:1 → curation/run.json",
        "ERROR notes.txt:2 → docs/gone.md",
        "ERROR notes.txt:3 → docs/out/run.json",
        "2 in generated dirs",
      ],
      reject: ["notes.txt:1", ".gitignore"],
    },
    {
      name: "link escaping the repo",
      files: { "docs/x.md": "[std](../../CLAUDE.md)\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:1 → ../../CLAUDE.md (escapes repo)"],
    },
    {
      name: "root-absolute link resolves from the repo root",
      files: { "docs/x.md": "[ok](/docs/hot-paths.md)\n[gone](/docs/gone.md)\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:2 → /docs/gone.md"],
      reject: ["/docs/hot-paths.md"],
    },
    {
      name: "link title forms and space before )",
      files: { "docs/x.md": "[a](gone1.md \"t\" )\n[b](gone2.md (title))\n[c](hot-paths.md )\n" },
      exit: 1,
      expect: ["ERROR docs/x.md:1 → gone1.md", "ERROR docs/x.md:2 → gone2.md"],
      reject: ["→ hot-paths.md"],
    },
    {
      name: "missing mention in a frozen source only warns",
      files: { "docs/specs/s.spec.yaml": "see docs/missing.md\n" },
      exit: 0,
      expect: ["warn  docs/specs/s.spec.yaml:1 → docs/missing.md"],
    },
    {
      name: "undated record name is an error",
      files: { "docs/records/notes.md": "# Notes\n" },
      exit: 1,
      expect: ["ERROR docs/records/notes.md → basename needs a YYYY-MM-DD- prefix"],
    },
    {
      name: "extensionless stem",
      files: { "notes.txt": "see docs/hot-paths and docs/gone\n" },
      exit: 1,
      expect: ["ERROR notes.txt:1 → docs/gone"],
      reject: ["→ docs/hot-paths"],
    },
    {
      name: "bold and </code> are not placeholders",
      files: {
        "docs/runbooks/stripe-connect.md": "# S\n",
        "notes.txt":
          "**docs/runbooks/stripe**\n<code>docs/runbooks/stripe</code>\ndocs/runbooks/<name>.md docs/runbooks/*.md\n",
      },
      exit: 1,
      expect: [
        "ERROR notes.txt:1 → docs/runbooks/stripe",
        "ERROR notes.txt:2 → docs/runbooks/stripe",
        "ERROR docs/runbooks/stripe-connect.md → no row in docs/README.md",
      ],
      reject: ["notes.txt:3"],
    },
    {
      name: "mentions are normalized; escaping one is a finding",
      files: { "notes.txt": "docs/../CLAUDE.md\ndocs/../../outside.md\n" },
      exit: 1,
      expect: ["ERROR notes.txt:2 → ../outside.md (escapes repo)"],
      reject: ["notes.txt:1"],
    },
    {
      name: "tracked source deleted on disk",
      files: { "notes.txt": "see docs/missing.md\n" },
      deleteAfterAdd: ["notes.txt"],
      exit: 0,
    },
    {
      name: "sparse checkout drops skip-worktree files quietly",
      files: { "other/a.txt": "see docs/missing.md\n" },
      prepare: (run) => {
        run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        run(["sparse-checkout", "set", "--no-cone", "/docs/", "/CLAUDE.md"]);
      },
      exit: 0,
    },
    { name: "unknown argument exits 2", files: {}, args: ["--qiet"], exit: 2, expect: ["unknown argument --qiet"] },
    {
      name: "docs/ tracked but no grep rows",
      base: { "docs/README.md": base["docs/README.md"], "docs/hot-paths.md": "# H\n", "docs/x.md": "# X\n" },
      files: {},
      exit: 1,
      expect: ["git grep returned no rows"],
    },
    {
      name: "docs/x.md:12, with a line suffix",
      files: { "notes.txt": "see docs/x.md:12, and docs/x.md:3-9.\n" },
      exit: 0,
    },
    {
      name: "../docs/ from a nested file is not root docs/",
      files: { "packages/p/src/a.ts": "// see ../docs/only-here.md\n" },
      exit: 0,
    },
    {
      name: "placeholder cut checks the directory",
      files: { "notes.txt": "docs/records/<date>-x.md and docs/plans/<name>.md\n", "docs/records/2026-01-01-a.md": "a\n" },
      exit: 1,
      expect: ["→ docs/plans/"],
      reject: ["→ docs/records/"],
    },
    {
      name: "README link inside an HTML comment is not an index row",
      files: { "docs/README.md": "# Docs\n\n[Hot paths](hot-paths.md)\n<!-- [X](x.md) -->\n" },
      exit: 1,
      expect: ["ERROR docs/x.md → no row in docs/README.md"],
    },
    { name: "no docs/README.md tracked", base: {}, files: { "a.md": "# A\n" }, exit: 1, expect: ["ERROR docs/README.md"] },
    { name: "empty repo", base: {}, files: {}, exit: 1, expect: ["ERROR docs/README.md"] },
  ];

  let failed = 0;
  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), "docs-check-"));
    try {
      const write = (files) => {
        for (const [p, body] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, p)), { recursive: true });
          writeFileSync(join(dir, p), body);
        }
      };
      git(["init", "-q"], { cwd: dir, env });
      const files = { ...(c.base ?? base), ...c.files };
      write(files);
      if (Object.keys(files).length) git(["add", "-f", "--", ...Object.keys(files)], { cwd: dir, env });
      write(c.untracked ?? {});
      for (const p of c.deleteAfterAdd ?? []) unlinkSync(join(dir, p));
      c.prepare?.((a) => git(a, { cwd: dir, env }));
      const r = spawnSync(process.execPath, [script, ...(c.args ?? [])], { cwd: dir, env, encoding: "utf8" });
      const out = `${r.stdout}${r.stderr}`;
      const problems = [];
      if (r.status !== c.exit) problems.push(`exit ${r.status}, expected ${c.exit}`);
      if (c.exit === 0 && !out.includes("docs:check ok")) problems.push(`no "docs:check ok"`);
      for (const s of c.expect ?? []) if (!out.includes(s)) problems.push(`missing ${JSON.stringify(s)}`);
      for (const s of c.reject ?? []) if (out.includes(s)) problems.push(`unexpected ${JSON.stringify(s)}`);
      if (problems.length) {
        failed++;
        console.log(`FAIL ${c.name}: ${problems.join("; ")}\n${out.replace(/^/gm, "    ")}`);
      } else {
        console.log(`PASS ${c.name}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`\nself-test ${failed ? "FAILED" : "ok"}: ${cases.length - failed}/${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--quiet" && a !== "--self-test");
if (unknown.length) {
  console.error(`docs:check: unknown argument ${unknown.join(" ")}; usage: [--quiet | --self-test]`);
  process.exitCode = 2;
} else if (args.includes("--self-test")) selfTest();
else check();
