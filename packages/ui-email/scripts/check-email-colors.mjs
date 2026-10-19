#!/usr/bin/env node
/**
 * DESIGN SYSTEM v2 — THE EMAIL COLOUR GATE
 * ========================================
 *
 * `@th/ui-email` renders transactional emails. Mail clients strip CSS custom properties, so unlike
 * the web (`apps/web/scripts/lint-css-colors.mjs`, which bans bare hex and pushes everything through
 * `var(--token)`), email colours are NECESSARILY inline literal hex. So this gate can't ban all hex —
 * it bans OFF-PALETTE hex: every colour must come from `tokens.colors.*`
 * (`packages/ui-email/src/theme/tokens.ts`), the single source of the v2 email palette.
 *
 * The one exception is **white / black** — `#FFFFFF` (text on the accent/ink fills) and `#000000`
 * are universal on-colour values with no brand identity, used inline. Everything else — an accent,
 * an ink, a status colour, a surface — must be a token, or the palette silently forks again (which
 * is exactly how the whole package drifted onto the pre-v2 steel-blue/orange brand before the
 * 2026-07-17 migration).
 *
 * ## Scope
 *
 * `packages/ui-email/src/**` EXCEPT:
 *   - `theme/tokens.ts` — the palette DEFINITION (the literals live here by definition).
 *   - `preview/**` — a dev-only preview gallery, not a shipped email; its chrome is its own concern.
 *   - tests / `*.samples.*` — fixtures.
 *
 * ## Maintaining
 *
 * ALWAYS negative-test after touching the rule (`--selftest` does this against fixtures: a violation
 * must ERROR, a token/white use must not). A green run can mean "the rule is broken", not "the code
 * is clean". Runs first on every `pnpm lint` (chained into the package's `lint` script), so it gates
 * CI. Zero-dep on purpose — no new devDeps, no lockfile churn.
 *
 * Usage:  node scripts/check-email-colors.mjs [--selftest]
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PKG_ROOT, "src");

/** White/black — the only inline colour literals allowed outside tokens.ts. */
const ALLOWED = new Set(["#fff", "#ffff", "#ffffff", "#ffffffff", "#000", "#0000", "#000000", "#000000ff"]);

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** Blank `//…` and `/* … *\/` comments, preserving offsets/newlines, so prose hex ("was #FF5721")
 *  and strings are handled honestly. Strings are NOT stripped — a hex in a string IS a colour. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

export function checkSource(src, file) {
  const errors = [];
  const code = stripComments(src);
  let m;
  HEX.lastIndex = 0;
  while ((m = HEX.exec(code)) !== null) {
    const hex = m[0].toLowerCase();
    if (ALLOWED.has(hex)) continue;
    const line = code.slice(0, m.index).split("\n").length;
    errors.push({
      file,
      line,
      hex: m[0],
      message: `Off-palette hex \`${m[0]}\` in an email template. Email colours come from \`tokens.colors.*\` (packages/ui-email/src/theme/tokens.ts) — the v2 palette. Only #FFFFFF / #000000 may be inline. If you need a new colour, add it to tokens.ts (and keep it AA on white).`,
    });
  }
  return errors;
}

// ── Walk + report ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "preview", "__tests__", "scripts"]);
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec|samples)\./.test(e)) yield full;
  }
}

const EXCLUDE_FILES = new Set([join(SRC, "theme", "tokens.ts")]);

function main() {
  const all = [];
  let scanned = 0;
  for (const file of walk(SRC)) {
    if (EXCLUDE_FILES.has(file)) continue;
    scanned++;
    all.push(...checkSource(readFileSync(file, "utf8"), relative(PKG_ROOT, file)));
  }
  for (const e of all) console.error(`\n${e.file}:${e.line}\n  error  ${e.message}`);
  const summary = `${scanned} email files scanned · ${all.length} off-palette colours`;
  if (all.length) {
    console.error(`\n✖ email colour gate: ${summary}\n`);
    process.exit(1);
  }
  console.log(`✔ email colour gate: ${summary}`);
}

// ── Self-test ────────────────────────────────────────────────────────────────

const FIXTURES = [
  ["off-palette accent errors", `const s = { color: "#FF5721" };`, 1],
  ["off-palette ink errors", `const s = { color: "#181818" };`, 1],
  ["cool grey errors", `background: "#F8FAFC"`, 1],
  ["sky blue errors", `border: "1px solid #0EA5E9"`, 1],
  ["white is allowed", `const s = { color: "#FFFFFF" };`, 0],
  ["short white is allowed", `const s = { color: "#fff" };`, 0],
  ["black is allowed", `boxShadow: "0 1px 2px #000"`, 0],
  ["token reference is fine (no hex)", `color: tokens.colors.brandAccent`, 0],
  ["hex in a // comment is prose, not code", `// was steel-blue #35589A\ncolor: tokens.colors.brand`, 0],
  ["hex in a block comment is prose", `/* white on #FF5721 is 3.16:1 */\ncolor: "#FFFFFF"`, 0],
  ["template-literal hex still caught", "const c = `${x}#B93312`;", 1],
  ["8-digit hex (with alpha) caught", `color: "#FF5721CC"`, 1],
  ["multiple offenders counted", `a: "#111111", b: "#0EA5E9"`, 2],
];

function selftest() {
  let failed = 0;
  for (const [name, src, expected] of FIXTURES) {
    const got = checkSource(src, "fixture.ts").length;
    if (got !== expected) {
      failed++;
      console.error(`  ✖ ${name}: expected ${expected} error(s), got ${got}`);
    }
  }
  if (failed) {
    console.error(`\n✖ email colour gate self-test: ${failed}/${FIXTURES.length} failed\n`);
    process.exit(1);
  }
  console.log(`✔ email colour gate self-test: ${FIXTURES.length} fixtures passed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
