#!/usr/bin/env node
/**
 * Guard: a test suite that runs in NO workflow is not coverage.
 *
 * ## Why this exists
 *
 * Three times now a package's tests have been green locally and executed by
 * nothing: `@th/types` (161 tests / 18 files — money, safe-external-url, the
 * SEO builders, passkey-name), `@th/errors`, and `@th/ui-native` (the RN
 * palette and tone-family guards that two apps render from). Each was found by
 * hand, months apart, and each time the fix was to add one CI step — which
 * closes that instance and nothing else. The next package added to the
 * monorepo starts the clock again.
 *
 * The failure is silent by construction. Nothing about an unrun suite is red;
 * it looks exactly like a suite that passes. That is the whole class of bug
 * CLAUDE.md's "Gates That Look Real And Are Not" table catalogues, and this
 * script mechanises the three entries in it that a machine can check.
 *
 * ## "Some workflow" is not the bar
 *
 * `ci.yml` triggers on `pull_request` + `workflow_dispatch` only, and this repo
 * commits straight to main — so a suite wired up there and nowhere else runs
 * approximately never. That is not hypothetical: `@th/ui-native` was added to
 * `ci.yml` alone, in a commit whose message said it closed exactly this gap,
 * and it stayed unrun. An earlier draft of THIS script accepted it, because it
 * asked "does any workflow run this" — the same question, with the same wrong
 * answer.
 *
 * So coverage means a workflow that triggers on a push to main. Those are
 * discovered from each workflow's `on:` block rather than named here, so
 * changing a workflow's triggers moves the bar automatically instead of
 * quietly invalidating a hardcoded filename.
 *
 * ## What it checks
 *
 *  1. Every workspace package with test files is run by a main-push workflow.
 *  2. Every `pnpm -F <name>` in a workflow resolves to a real package. A typo'd
 *     filter prints "No projects matched the filters" and exits 0 — a
 *     permanently-green step that looks like a gate.
 *  3. Every package a workflow runs `vitest` against actually HAS test files.
 *     `vitest --run` exits non-zero when it matches nothing, so a step added
 *     for an empty package fails CI on arrival.
 *
 * Checks 2 and 3 are the two directions of the same mistake, and they are here
 * together on purpose: fixing a missing suite by adding a step with a typo in
 * it converts an invisible failure into an invisible pass.
 *
 * ## What it deliberately does not check
 *
 * Whether the tests are any good, or whether the step's flags survive. `pnpm
 * run <script> -- <flags>` silently drops everything after `--`, which is a
 * real trap in this repo (deploy-dev's web step passes `--retry=1` that has
 * never applied) — but "these flags reached the tool" is not decidable from
 * the YAML alone.
 *
 * Usage: node scripts/ci/check-ci-test-coverage.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = join(REPO, ".github", "workflows");

/**
 * Directories whose specs are NOT vitest, so their presence must not imply a
 * missing vitest step. Playwright and Appium suites are driven by their own
 * runners against a live stack and are wired up separately.
 */
const NON_VITEST_DIRS = new Set(["e2e", "e2e-appium", "node_modules", "dist", "build", ".next", ".expo", "coverage"]);

/**
 * Packages allowed to have no CI test step, each with the reason. An entry
 * here is a recorded decision; an absent entry is a bug. Keep it empty unless
 * there is a real reason — "we'll wire it up later" is what produced the three
 * cases above.
 */
const ALLOWED_WITHOUT_CI = new Map([
  // (currently none — every package with tests is wired up)
]);

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/;

// ── Workspace packages ──────────────────────────────────────────────────────

function workspaceGlobs() {
  const raw = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of raw.split("\n")) {
    if (/^packages:/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const m = line.match(/^\s+-\s+['"]?([^'"\s#]+)['"]?/);
      if (m) globs.push(m[1]);
      else if (line.trim() && !line.startsWith(" ")) break;
    }
  }
  return globs;
}

function expandGlob(glob) {
  // Only the shapes pnpm-workspace.yaml actually uses: a literal path, or one
  // trailing `*` segment. Anything richer should fail loudly, not silently
  // resolve to nothing and report a clean run.
  if (!glob.includes("*")) return [join(REPO, glob)];
  const [head, ...rest] = glob.split("/*");
  if (rest.length !== 1 || rest[0] !== "") {
    throw new Error(`Unsupported workspace glob "${glob}" — teach this script the new shape rather than letting it match nothing.`);
  }
  const base = join(REPO, head);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((d) => join(base, d))
    .filter((d) => statSync(d).isDirectory());
}

function findPackages() {
  const out = [];
  for (const glob of workspaceGlobs()) {
    for (const dir of expandGlob(glob)) {
      const pkgJson = join(dir, "package.json");
      if (!existsSync(pkgJson)) continue;
      const name = JSON.parse(readFileSync(pkgJson, "utf8")).name;
      if (name) out.push({ name, dir });
    }
  }
  return out;
}

function countTestFiles(dir) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (NON_VITEST_DIRS.has(e.name)) continue;
        walk(join(d, e.name), depth + 1);
      } else if (TEST_FILE.test(e.name)) {
        n++;
      }
    }
  };
  walk(dir, 0);
  return n;
}

// ── Workflow steps ──────────────────────────────────────────────────────────

/**
 * Every `run:` body in every workflow, as raw text. Deliberately regex over
 * the file rather than a YAML parse: a `run:` block's content is what the
 * shell sees, and this only ever asks "does this text invoke that package",
 * which survives any block-scalar style.
 */
function workflowRunText() {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  return files.map((f) => ({ file: f, text: readFileSync(join(WORKFLOW_DIR, f), "utf8") }));
}

/** Strip comment lines so a package named only in prose never counts as covered. */
function withoutComments(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/**
 * Does this workflow run on a push to the main BRANCH?
 *
 * Two slices, both load-bearing:
 *
 *  - `on:` down to the next top-level key. The word "push" appears throughout
 *    these files (docker push, git push), so a whole-file grep would call every
 *    workflow a main-push gate and quietly neuter this script.
 *  - `push:` down to the next key at its own indent. `mobile-release.yml` and
 *    `scanner-release.yml` push on TAGS (`mobile-v*`, `scanner-v*`), never on a
 *    branch. Counting those would let a suite be "gated" by a workflow that
 *    only runs at release time — the same never-runs bug in a new costume.
 *
 * Hand-sliced rather than YAML-parsed to keep this guard dependency-free; the
 * surface is two nested keys, and `assertTriggerParsing` below pins the result
 * for every workflow in the repo so a parsing regression is a failing check
 * rather than a silently permissive one.
 */
function onBlockOf(text) {
  const body = withoutComments(text);
  const onStart = body.search(/^on:/m);
  if (onStart === -1) return null;
  const afterOn = body.slice(onStart + 3);
  const onEnd = afterOn.search(/^\S/m);
  return onEnd === -1 ? afterOn : afterOn.slice(0, onEnd);
}

/**
 * Which fork-reachable PR triggers does this workflow declare?
 *
 * Scoped to the `on:` block and matched as a KEY (`^\s+pull_request:`), not as
 * a word. `ci.yml` says "NO `pull_request` trigger, DELIBERATELY" in prose and
 * several workflows read `github.event.pull_request.*` in expressions; a
 * whole-file grep would flag both and the guard would be deleted as noisy
 * within a week.
 */
function forkPrTriggers(text) {
  const onBlock = onBlockOf(text);
  if (!onBlock) return [];
  const hits = [...onBlock.matchAll(/^\s+(pull_request_target|pull_request):/gm)].map((m) => m[1]);
  return [...new Set(hits)];
}

function runsOnMainPush(text) {
  const onBlock = onBlockOf(text);
  if (onBlock === null) return false;

  const pushMatch = onBlock.match(/^(\s+)push:\s*$/m);
  if (!pushMatch) return false;
  const indent = pushMatch[1];
  const afterPush = onBlock.slice(pushMatch.index + pushMatch[0].length);
  const pushEnd = afterPush.search(new RegExp(`^${indent}\\S`, "m"));
  const pushBlock = pushEnd === -1 ? afterPush : afterPush.slice(0, pushEnd);

  const branches = pushBlock.match(/branches:\s*(\[[^\]]*\]|(?:\s*\n\s+-\s+\S+)+)/);
  if (branches) return /\bmain\b/.test(branches[1]);
  // No `branches:` filter means every branch, which includes main — unless the
  // trigger is tag-scoped, in which case it never fires for a branch push.
  return !/tags:/.test(pushBlock);
}

/**
 * The trigger classification this script's verdict rests on, pinned per file.
 * If a workflow's `on:` block changes shape, this fails loudly instead of
 * letting the coverage check pass on a misread.
 */
const EXPECTED_MAIN_PUSH = {
  "ci.yml": false, // pull_request + workflow_dispatch
  "deploy-dev.yml": true, // push: branches: [main] — the real gate
  "deploy-prod.yml": false, // workflow_dispatch
  "infra-validation.yml": true, // push: branches: [main], paths: infra/**
  "mobile-release.yml": false, // push: tags: mobile-v*
  "scanner-release.yml": false, // push: tags: scanner-v*
  // Dispatch-only, and it runs on a SELF-HOSTED runner (a VM on a personal
  // Mac). Pinned here so that if anyone ever gives it a push trigger, this
  // guard says so out loud rather than letting repo code start executing on
  // someone's laptop on every commit.
  "runner-smoke.yml": false, // workflow_dispatch only
};

const PKG = "[@a-zA-Z0-9/._-]+";
const filterRe = new RegExp(`pnpm\\s+-F\\s+(${PKG})`, "g");
const vitestRe = (name) =>
  new RegExp(`pnpm\\s+-F\\s+${name.replace(/[/@.\\-]/g, "\\$&")}\\s+(exec\\s+vitest|run\\s+test)`);

// ── Run the checks ──────────────────────────────────────────────────────────

const packages = findPackages();
const byName = new Map(packages.map((p) => [p.name, p]));
const workflows = workflowRunText().map((w) => ({
  ...w,
  code: withoutComments(w.text),
  mainPush: runsOnMainPush(w.text),
}));

const errors = [];

for (const [file, expected] of Object.entries(EXPECTED_MAIN_PUSH)) {
  const w = workflows.find((x) => x.file === file);
  if (!w) {
    errors.push(`EXPECTED_MAIN_PUSH names ${file}, which no longer exists — update the table.`);
  } else if (w.mainPush !== expected) {
    errors.push(
      `Trigger classification for ${file} changed: this script now reads it as ` +
        `${w.mainPush ? "" : "NOT "}running on a push to main, but the pinned expectation is ` +
        `${expected ? "" : "NOT "}main-push.\n` +
        `      Either the workflow's triggers changed (update EXPECTED_MAIN_PUSH) or the parsing broke.`,
    );
  }
}

// 0 — no workflow may be reachable from a fork's pull request.
//
// `a-guy-on-the-internet/ithasfire-source` is a PUBLIC mirror of this repo and
// carries copies of these same workflows, so anyone can fork it and open a PR.
// Meanwhile the gate jobs in deploy-dev.yml run on a SELF-HOSTED runner — a VM
// on a personal Mac — whenever the CI_GATE_RUNNER variable is set.
//
// Those two facts are only safe together while no workflow declares a
// `pull_request` trigger. That invariant has been living in a runbook paragraph
// and in a comment in ci.yml whose premise ("This repository is PUBLIC") is
// already stale, which is precisely how it gets re-added by someone acting in
// good faith. Enforce it where it cannot drift.
//
// `pull_request_target` is the worse half: it runs against the BASE repo with
// secrets available, so it is dangerous even without a self-hosted runner.
for (const w of workflows) {
  const triggers = forkPrTriggers(w.text);
  if (triggers.length > 0) {
    errors.push(
      `${w.file} declares ${triggers.join(" + ")}, which a fork can trigger.\n` +
        `      This repo is mirrored publicly and its gate jobs run on a self-hosted runner, so a\n` +
        `      fork PR would execute attacker-controlled code on a personal machine.\n` +
        `      If you genuinely need PR CI, run it on ubuntu-latest and keep it out of deploy-dev.yml.`,
    );
  }
}

const mainPushWorkflows = workflows.filter((w) => w.mainPush);
if (mainPushWorkflows.length === 0) {
  // Without one, every check below would pass vacuously — the exact shape of
  // failure this script exists to prevent, so it fails instead of reporting a
  // clean run.
  errors.push(
    "No workflow triggers on a push to main, so there is no gate to measure coverage against.\n" +
      "      Either that is a mistake, or this script needs to learn the new arrangement.",
  );
}

// 1 — a package with tests that the main-push gate does not run.
for (const pkg of packages) {
  const testFiles = countTestFiles(pkg.dir);
  if (testFiles === 0) continue;
  const gated = mainPushWorkflows.filter((w) => vitestRe(pkg.name).test(w.code)).map((w) => w.file);
  if (gated.length === 0) {
    if (ALLOWED_WITHOUT_CI.has(pkg.name)) continue;
    const elsewhere = workflows.filter((w) => vitestRe(pkg.name).test(w.code)).map((w) => w.file);
    const note = elsewhere.length
      ? `It IS run by ${elsewhere.join(", ")} — but none of those trigger on a push to main, so in practice it never runs.`
      : "No workflow runs it at all.";
    errors.push(
      `${pkg.name} has ${testFiles} test file(s) in ${relative(REPO, pkg.dir)} that the main-push gate does not run.\n` +
        `      ${note}\n` +
        `      Add it to quality_gate in .github/workflows/deploy-dev.yml:  pnpm -F ${pkg.name} exec vitest --run\n` +
        `      (or record the exemption in ALLOWED_WITHOUT_CI with a reason)`,
    );
  }
}

// 2 — a filter that names nothing. Exits 0 in CI, so it can only be caught here.
for (const w of workflows) {
  const seen = new Set();
  for (const m of w.code.matchAll(filterRe)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (!byName.has(name)) {
      errors.push(
        `${w.file} runs \`pnpm -F ${name}\`, which matches no workspace package.\n` +
          `      pnpm prints "No projects matched the filters" and exits 0, so this step is permanently green.`,
      );
    }
  }
}

// 3 — vitest pointed at a package with nothing to run (non-zero on zero matches).
for (const w of workflows) {
  for (const pkg of packages) {
    if (!vitestRe(pkg.name).test(w.code)) continue;
    if (countTestFiles(pkg.dir) === 0) {
      errors.push(
        `${w.file} runs vitest for ${pkg.name}, which has no test files.\n` +
          `      \`vitest --run\` exits non-zero when it matches nothing, so this step fails on arrival.`,
      );
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (errors.length > 0) {
  console.error("CI test coverage is not what it looks like:\n");
  for (const e of errors) console.error(`  - ${e}\n`);
  process.exit(1);
}

const withTests = packages.filter((p) => countTestFiles(p.dir) > 0);
console.log(
  `CI test coverage OK — ${withTests.length}/${packages.length} workspace packages have tests, ` +
    `all of them gated by a main-push workflow (${mainPushWorkflows.map((w) => w.file).join(", ")}), ` +
    `and every \`pnpm -F\` filter resolves.`,
);
