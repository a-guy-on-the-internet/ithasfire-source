#!/usr/bin/env node
/**
 * DESIGN SYSTEM v2 — THE OFF-PALETTE COLOUR GATE ("the 4th rule")
 * ==============================================================
 *
 * The existing gates cover three shapes of colour bug:
 *   1. `eslint.config.mjs`        — bare hex / `rgba(255,255,255,…)` / bare `white` in `.ts(x)`
 *   2. `scripts/lint-css-colors.mjs` — the same three, for `.css`
 *   3. `packages/ui-email/…/check-email-colors.mjs` — off-palette hex in emails
 *
 * All three deliberately EXEMPT the `var()` fallback slot (`var(--accent, #E2481D)` is the
 * sanctioned raw-CSS pattern — the fallback is what SSR paints). That exemption is a blind spot:
 * TWO whole classes of pre-v2 drift ride straight through it, because they are neither a bare hex
 * nor `rgba(255,255,255)`:
 *
 *   A. `var(--token, wrongFallback)` where the fallback drifted from the Stub value. The anchored
 *      hex selector permits the fallback slot, so a navy `var(--accent, #35589A)` reports 0 errors.
 *   B. Pre-v2 brand values written as `rgba()` channels or as JS `??`/inline literals —
 *      `rgba(255,87,33,0.1)` (= #FF5721), `theme.accent?.val ?? "#FF5721"`,
 *      `var(--brandSecondary, #FF5721)`. Not a bare hex, not white-rgba: invisible to every gate.
 *
 * This gate closes both, for `.ts`/`.tsx`/`.css` under `apps/web/src`.
 *
 *   Check A — FALLBACK-DRIFT AUDITOR. Builds a canonical token→Stub-value map from the SAME two
 *     primitive-tier sources the doc names (`stubTheme` in packages/ui/…/tokens/colors.ts + the
 *     `:root` block of globals.css) and flags every `var(--token, fallback)` whose fallback colour
 *     ≠ the Stub value for that token.
 *   Check B — PRE-V2 DENYLIST. Flags known pre-v2 brand/neutral values in ANY form — hex OR rgba
 *     channels — anywhere OUTSIDE a `var()` fallback (those are Check A's job). Names the v2
 *     replacement in the message.
 *
 * ## Zero-dep, on purpose
 *
 * Resolves only Node built-ins. No new devDeps → no `pnpm-lock.yaml` churn (the repo rule). The
 * canon is read from disk at load, so it CANNOT drift from the real theme — if `stubTheme` changes,
 * this gate changes with it, and the self-test (which asserts against the real canon) fails loudly
 * if the parse ever breaks.
 *
 * ## Exemptions — a shrink-only ratchet (`color-fallback-allowlist.mjs`)
 *
 * Some fallbacks are DELIBERATELY not the Stub value: inverted tooltips (`background:
 * var(--foreground)` + `color: var(--background)`), fixed-dark surfaces, `display:none` dropdowns
 * whose fallback never SSR-paints. Those go in the ratchet, each with a written reason, matched by
 * (file, token, value) — never by line, so they survive edits. Same contract as
 * `eslint-hex-allowlist.mjs`: only ever shrink.
 *
 * ## Scope exclusions (baked in)
 *   - `--th-*` tokens — the entity-page namespace; those vars are set by the entity theme, not Stub.
 *   - Tokens NOT in the canon — an unknown `var(--whatever, #x)` can't be judged, so it's left
 *     alone (this is what keeps embed/entity vars from false-positiving even outside those dirs).
 *   - `.test.` / `.spec.` / `.stories.` files — fixtures/assertions legitimately name old colours.
 *
 * ## Known limitations (deliberate — documented so the next reader doesn't assume coverage)
 *
 *   - **JS `v("--token", fallback)` / `?? "#hex"` indirection is invisible to Check A**, which only
 *     parses literal `var(--token, fallback)` CSS text. A drift hidden behind a helper (e.g.
 *     `v("--accentHard", "#654321")`) only trips if the value is a Check-B denylist member. Hunt
 *     those by hand when editing such a file (see `useHydrateAudioBlocks.tsx`).
 *   - **Check-B (denylist) exemptions are keyed (file, value)**, so one ratchet entry exempts EVERY
 *     occurrence of that value in that file — same file-level granularity as `eslint-hex-allowlist`.
 *     A later, genuinely-wrong occurrence of the same pre-v2 hex in an already-ratcheted file is
 *     silently allowed. Accepted tradeoff under the shrink-only contract; keep entries tight.
 *
 * ## Maintaining this file
 *
 * ALWAYS negative-test after touching a rule — `--selftest` does exactly that against in-memory
 * fixtures: a violation must ERROR and the sanctioned patterns must NOT. A green run can mean "the
 * rule is broken", not "the code is clean". `--selftest` runs FIRST on every CI lint.
 *
 * Usage:  node scripts/lint-color-fallbacks.mjs [--selftest]
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { colorFallbackAllowlist } from "../color-fallback-allowlist.mjs";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(APP_ROOT, "..", "..");
const DOC = "docs/design/design-system-v2.md";

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".turbo", "storybook-static", "out", "build", "dist",
  "coverage", "test-results", "playwright-report",
]);

// ── Colour parsing / equality ─────────────────────────────────────────────────
//
// Everything compares as an [r,g,b,a] tuple so a hex and its rgba() twin are equal — a fallback
// written `rgba(226,72,29)` is NOT drift from a canon of `#E2481D`. Anything that doesn't parse to
// a colour (a keyword, `transparent`, a `${expr}`, a nested `var()`) returns null and is skipped.

const h2 = (s, i) => parseInt(s.slice(i, i + 2), 16);
const hx = (c) => parseInt(c + c, 16);

export function parseColor(str) {
  if (typeof str !== "string") return null;
  const s = str.trim().toLowerCase();
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    const h = m[1];
    if (h.length === 3) return [hx(h[0]), hx(h[1]), hx(h[2]), 1];
    if (h.length === 4) return [hx(h[0]), hx(h[1]), hx(h[2]), hx(h[3]) / 255];
    if (h.length === 6) return [h2(h, 0), h2(h, 2), h2(h, 4), 1];
    if (h.length === 8) return [h2(h, 0), h2(h, 2), h2(h, 4), h2(h, 6) / 255];
    return null; // 5/7-digit hex is invalid CSS
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const p = m[1].split(",").map((x) => x.trim());
    if (p.length < 3 || p.length > 4) return null;
    const r = Number.parseFloat(p[0]);
    const g = Number.parseFloat(p[1]);
    const b = Number.parseFloat(p[2]);
    const a = p.length > 3 ? Number.parseFloat(p[3]) : 1;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return [r, g, b, a];
  }
  return null;
}

function colorsEqual(a, b) {
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && Math.abs(a[3] - b[3]) < 0.005;
}

// ── Canon (token → Stub value) ────────────────────────────────────────────────
//
// Two sources, per the doc's primitive tier:
//   1. `stubTheme` in colors.ts — the Tamagui theme keys, which the injector mirrors as `--<key>`.
//   2. globals.css `:root` — the plain-CSS vars (some, like `--foreground`/`--background`, are NOT
//      theme keys and live only here).
// stubTheme wins on shared names (the doc calls colors.ts "canonical for values"); :root adds the
// CSS-only ones. A name absent from both is simply not in the canon and is left unjudged.

/**
 * Extract a named object's BRACE-DEPTH-1 string-valued props. Depth-1 ONLY is load-bearing:
 * a nested sub-bag (colors.ts has had a `color:{}` bag holding pre-v2 steel-blue) would otherwise
 * corrupt the canon and make the gate inject the very values it's meant to ban. Values are quoted
 * strings, so the rgba parens inside them never affect brace depth. First write wins.
 */
export function extractObjectStringProps(rawSrc, objName) {
  // Strip comments FIRST. `stubTheme` carries paragraphs of `//` prose full of backticks,
  // parens, and apostrophes (`Stub's`, `it's`, `` `lightTheme` ``) — an unstripped scan mistakes a
  // stray backtick for a template string and swallows real declarations (this dropped every key
  // from `brandSecondary` down, so the canon shipped WITHOUT the accent it exists to police).
  const src = stripComments(rawSrc, { slashSlash: true });
  const decl = new RegExp(`(?:export\\s+)?const\\s+${objName}\\s*=\\s*\\{`).exec(src);
  if (!decl) throw new Error(`canon: could not find \`const ${objName} = {\` in colors.ts`);
  let i = decl.index + decl[0].length; // just past the opening brace
  let depth = 1;
  const out = new Map();
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // skip a string wholesale (also skips any `{`/`}` inside it)
      const q = ch;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") { depth -= 1; i += 1; continue; }
    if (depth === 1) {
      // key: "value" — only at the object's own level
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*(["'])((?:\\.|(?!\2).)*)\2/.exec(src.slice(i));
      if (m) {
        if (!out.has(m[1])) out.set(m[1], m[3]);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** Extract color-valued `--name: value;` from the top-level `:root { … }` block of a CSS string. */
export function extractRootVars(rawCss) {
  const css = stripComments(rawCss, { slashSlash: false }); // CSS comments can hold braces/quotes
  const start = /:root\s*\{/.exec(css);
  if (!start) return new Map();
  let i = start.index + start[0].length;
  let depth = 1;
  const out = new Map();
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "}") { depth -= 1; i += 1; continue; }
    if (depth === 1 && ch === "-" && css[i + 1] === "-") {
      const m = /^--([\w-]+)\s*:\s*([^;}]+)/.exec(css.slice(i));
      if (m) {
        const val = m[2].trim();
        if (!out.has(m[1]) && parseColor(val)) out.set(m[1], val);
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

function buildCanon() {
  const colorsPath = join(REPO_ROOT, "packages/ui/src/ui/tamagui/tokens/colors.ts");
  const globalsPath = join(APP_ROOT, "src/app/globals.css");
  const stub = extractObjectStringProps(readFileSync(colorsPath, "utf8"), "stubTheme");
  const root = extractRootVars(readFileSync(globalsPath, "utf8"));
  const canon = new Map();
  for (const [k, v] of root) if (parseColor(v)) canon.set(k, v); // CSS-only vars first
  for (const [k, v] of stub) if (parseColor(v)) canon.set(k, v); // theme keys win
  if (!canon.has("accent") || !canon.has("color") || !canon.has("structure")) {
    throw new Error("canon: parsed too few tokens — the stubTheme/`:root` parse likely broke");
  }
  return canon;
}

// The canon is a module-level singleton so the self-test exercises the REAL parse, not a mock.
const CANON = buildCanon();

// ── Pre-v2 denylist (Check B) ─────────────────────────────────────────────────
//
// Each value matches its hex (with optional 2-digit alpha) OR its rgb/rgba channel triple. The
// `#` anchor stops a substring match inside a longer hex; the rgba arm ignores the alpha channel.
const rgbaArm = (r, g, b) => `rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\b`;
const hexArm = (hex) => `${hex}(?:[0-9a-f]{2})?\\b`;
// `hex` is the CANONICAL identity of the value (both the hex and rgba spellings report it), so the
// finding key is stable for the allowlist and dedup — the raw match text is quoted in the message.
const deny = (hex, [r, g, b], replacement) => ({
  hex: hex.toUpperCase(),
  re: new RegExp(`${hexArm(hex)}|${rgbaArm(r, g, b)}`, "gi"),
  replacement,
});

const DENYLIST = [
  deny("#ff5721", [255, 87, 33], "pre-v2 Ember orange → v2 accent: `var(--accent, #E2481D)` / `$accent` (or `$brandSecondaryHover` behind small text)"),
  deny("#ff5a21", [255, 90, 33], "pre-v2 orange variant → v2 accent: `var(--accent, #E2481D)` / `$accent`"),
  deny("#35589a", [53, 88, 154], "pre-v2 steel-blue → v2 structure ink on Stub: `var(--structure, #211C16)` / `$structure` (for the raw brand hex import `palette.brandPrimary`)"),
  deny("#181818", [24, 24, 24], "pre-v2 near-black ink → v2 ink: `var(--color, #211C16)` / `$color`"),
  deny("#707070", [112, 112, 112], "pre-v2 muted grey → v2 muted ink: `var(--colorMuted, #5C544A)` / `$colorMuted`"),
  deny("#d4d4d4", [212, 212, 212], "pre-v2 border grey → v2 soft border: `var(--borderColorSoft, rgba(33,28,22,0.3))`"),
  deny("#f8fafc", [248, 250, 252], "pre-v2 cool-grey surface → v2 warm surface: `var(--surface, #FDFAF3)`"),
];

// ── Comment stripping (offset-preserving, string-aware) ───────────────────────
//
// Blank `/* … */` (both langs) and `//…` (TS only) so prose hex ("was #FF5721") never trips a rule.
// STRINGS ARE PRESERVED — a hex in `color: "#FF5721"` IS a colour (matching the email gate). Being
// string-aware is what stops a `//` inside `"https://…"` or a CSS `url(//cdn)` from being read as a
// comment and blanking the rest of the line/file.
function stripComments(src, { slashSlash }) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      out += ch;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < src.length) { out += src[i]; i += 1; }
        out += src[i];
        i += 1;
      }
      if (i < src.length) { out += src[i]; i += 1; }
      continue;
    }
    if (slashSlash && ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ── var() fallback handling ───────────────────────────────────────────────────

/** Yield every `var(--token, fallback)` with a fallback slot: {token, fallback, index}. */
function* varFallbacks(text) {
  for (let i = 0; i < text.length; i++) {
    if (
      (text[i] === "v" || text[i] === "V") &&
      /a/i.test(text[i + 1] || "") &&
      /r/i.test(text[i + 2] || "") &&
      text[i + 3] === "("
    ) {
      let depth = 0;
      let commaAt = -1;
      let j = i + 3;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === "(") depth += 1;
        else if (c === ")") { depth -= 1; if (depth === 0) break; }
        else if (c === "," && depth === 1 && commaAt === -1) commaAt = j;
      }
      if (commaAt !== -1 && j < text.length) {
        const token = text.slice(i + 4, commaAt).trim().replace(/^--/, "");
        const fallback = text.slice(commaAt + 1, j).trim();
        yield { token, fallback, index: i };
        // Do NOT jump `i` past the close paren. A nested fallback
        // `var(--a, var(--accent, #35589A))` yields the OUTER fallback first
        // (a `var()` expr → parseColor null → skipped), and skipping ahead
        // would leave the INNER `var(--accent, #35589A)` drift unscanned while
        // maskVarFallbacks blanks it from Check B too — a silent miss. Letting
        // the loop advance by 1 re-enters the inner var() and flags it.
      }
    }
  }
}

/** Replace every var() fallback slot with spaces (offset-preserving) so Check B skips it. */
function maskVarFallbacks(text) {
  const chars = text.split("");
  for (const { index } of varFallbacks(text)) {
    // re-scan this one var() to find its fallback span (varFallbacks already validated it)
    let depth = 0;
    let commaAt = -1;
    let j = index + 3;
    for (; j < chars.length; j++) {
      const c = chars[j];
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) break; }
      else if (c === "," && depth === 1 && commaAt === -1) commaAt = j;
    }
    if (commaAt !== -1 && j < chars.length) {
      for (let k = commaAt; k < j; k++) if (chars[k] !== "\n") chars[k] = " ";
    }
  }
  return chars.join("");
}

// ── Allowlist ─────────────────────────────────────────────────────────────────

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, "");
function isAllowlisted(file, token, value) {
  const pc = parseColor(value);
  return colorFallbackAllowlist.some(
    (e) =>
      e.file === file &&
      e.token === token &&
      (norm(e.value) === norm(value) || colorsEqual(parseColor(e.value), pc)),
  );
}

// ── Checking ──────────────────────────────────────────────────────────────────

const lineOf = (code, index) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === "\n") line += 1;
  return line;
};

const isCss = (file) => file.endsWith(".css");

export function checkText(src, file) {
  const errors = [];
  const debts = [];
  const code = stripComments(src, { slashSlash: !isCss(file) });

  const record = (line, id, token, value, message) => {
    if (isAllowlisted(file, token, value)) debts.push({ file, line, id, token, value });
    else errors.push({ file, line, id, token, value, message });
  };

  // Check A — fallback drift
  for (const { token, fallback, index } of varFallbacks(code)) {
    if (token.startsWith("th-")) continue; // entity-page namespace
    if (!CANON.has(token)) continue; // unknown token — can't judge (embed/entity/scoped vars)
    const got = parseColor(fallback);
    if (!got) continue; // nested var(), keyword, ${expr} — not a plain colour literal
    const want = parseColor(CANON.get(token));
    if (colorsEqual(got, want)) continue;
    record(
      lineOf(code, index),
      "fallback-drift",
      token,
      fallback,
      `\`var(--${token}, ${fallback})\` — the fallback drifted from the Stub value \`${CANON.get(token)}\`. The fallback is what SSR paints before the theme injector hydrates, so it MUST be the Stub value for this token. Fix it to \`var(--${token}, ${CANON.get(token)})\`. See ${DOC}. If this surface is deliberately not-Stub (inverted tooltip, fixed-dark chrome), add a reason'd entry to color-fallback-allowlist.mjs.`,
    );
  }

  // Check B — pre-v2 denylist, outside var() fallbacks (those are Check A's)
  const masked = maskVarFallbacks(code);
  for (const rule of DENYLIST) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(masked)) !== null) {
      record(
        lineOf(code, m.index),
        "pre-v2-color",
        "denylist",
        rule.hex,
        `Pre-v2 colour \`${m[0]}\` (${rule.hex}). ${rule.replacement}. See ${DOC}. If this is a genuinely fixed literal (canvas/MapLibre paint, third-party brand, data palette), add a reason'd entry to color-fallback-allowlist.mjs.`,
      );
    }
  }

  return { errors, debts };
}

// ── Walk + report ─────────────────────────────────────────────────────────────

const SKIP_FILE = /\.(test|spec|stories)\.[jt]sx?$/;
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|css)$/.test(entry) && !SKIP_FILE.test(entry)) yield full;
  }
}

function main() {
  const allErrors = [];
  const allDebts = [];
  let scanned = 0;

  for (const file of sourceFiles(join(APP_ROOT, "src"))) {
    const rel = relative(APP_ROOT, file);
    scanned += 1;
    const { errors, debts } = checkText(readFileSync(file, "utf8"), rel);
    allErrors.push(...errors);
    allDebts.push(...debts);
  }

  for (const e of allErrors) {
    console.error(`\n${e.file}:${e.line}\n  error  [${e.id}]  ${e.message}`);
  }

  const summary = `${scanned} files scanned · ${allDebts.length} ratcheted · ${allErrors.length} errors`;
  if (allErrors.length) {
    console.error(`\n✖ design-system off-palette colour gate: ${summary}\n`);
    process.exit(1);
  }
  console.log(`✔ design-system off-palette colour gate: ${summary}`);
}

// ── Self-test ─────────────────────────────────────────────────────────────────
//
// A colour gate that silently stops matching reads as "the code is clean" — the worst failure mode.
// These fixtures assert BOTH directions: violations ERROR, sanctioned patterns do NOT. They run
// against the REAL canon (loaded above), so a broken parse fails here too.

const TS = "fixture.ts";
const CSS = "fixture.css";
const FIXTURES = [
  // [name, file, src, expectedErrorIds]
  // Check A — fallback drift
  ["stub fallback is legal", TS, `const c = "var(--accent, #E2481D)";`, []],
  ["stub fallback as rgba twin is legal", TS, `const c = "var(--accent, rgba(226,72,29,1))";`, []],
  ["drifted accent fallback errors", TS, `const c = "var(--accent, #35589A)";`, ["fallback-drift"]],
  ["drifted accentHard fallback errors (steel-blue flash)", TS, `const c = "var(--accentHard, #35589A)";`, ["fallback-drift"]],
  ["unknown token is not judged", TS, `const c = "var(--totally-made-up, #123456)";`, []],
  ["--th-* entity token is skipped", TS, `const c = "var(--th-color-surface-muted, #1b294a)";`, []],
  ["no-fallback var() is skipped", TS, `const c = "var(--accent)";`, []],
  ["nested var() fallback (correct inner) is clean", TS, `const c = "var(--a, var(--accent, #E2481D))";`, []],
  ["nested var() fallback DRIFT on the inner token is still flagged", TS, `const c = "var(--a, var(--accent, #35589A))";`, ["fallback-drift"]],
  ["expr fallback is skipped", TS, "const c = `var(--accent, ${x})`;", []],
  ["css fallback drift errors", CSS, `.a { color: var(--foreground, #fff); }`, ["fallback-drift"]],
  ["css stub fallback is legal", CSS, `.a { color: var(--foreground, #211C16); }`, []],
  ["3-digit hex equals 6-digit canon", CSS, `.a { color: var(--structurePress, #000); }`, []],

  // Check B — denylist, any form
  ["bare pre-v2 orange hex errors", TS, `const c = "#FF5721";`, ["pre-v2-color"]],
  ["pre-v2 orange as rgba errors", TS, `const c = "rgba(255, 87, 33, 0.1)";`, ["pre-v2-color"]],
  ["pre-v2 orange with alpha-hex errors", TS, `const c = "#FF5721CC";`, ["pre-v2-color"]],
  ["JS ?? fallback to pre-v2 orange errors", TS, `const c = theme.accent?.val ?? "#FF5721";`, ["pre-v2-color"]],
  ["pre-v2 steel-blue hex errors", TS, `const c = "#35589A";`, ["pre-v2-color"]],
  ["pre-v2 steel-blue as rgba errors", TS, `const c = "rgba(53,88,154,0.2)";`, ["pre-v2-color"]],
  ["template-literal pre-v2 hex still caught", TS, "const c = `border:1px solid #FF5721`;", ["pre-v2-color"]],
  ["denylist ignores the var() fallback slot (Check A owns it)", TS, `const c = "var(--brandSecondary, #FF5721)";`, ["fallback-drift"]],
  ["a longer hex is not a substring match", TS, `const c = "#AAFF5721";`, []],
  ["v2 accent is NOT denylisted", TS, `const c = "#E2481D";`, []],

  // Comments / strings
  ["hex in a // comment is prose", TS, `// was #FF5721 before\nconst c = tokens.accent;`, []],
  ["hex in a block comment is prose", TS, `/* #FF5721 → #E2481D */\nconst c = tokens.accent;`, []],
  ["a // inside a string is not a comment", TS, `const u = "https://x#FF5721";`, ["pre-v2-color"]],
  ["a url(//cdn) in css is not a comment", CSS, `.a { background: url(//cdn/x.png); color: #FF5721; }`, ["pre-v2-color"]],
  ["css /* */ comment prose is not code", CSS, `/* never use #FF5721 */\n.a { padding: 0; }`, []],
];

function selftest() {
  let failed = 0;
  for (const [name, file, src, expected] of FIXTURES) {
    const { errors } = checkText(src, file);
    const got = errors.map((e) => e.id).sort();
    const want = [...expected].sort();
    const ok = got.length === want.length && got.every((v, i) => v === want[i]);
    if (!ok) {
      failed += 1;
      console.error(`  ✖ ${name}\n      [${file}] expected [${want}] but got [${got}]`);
    }
  }
  if (failed) {
    console.error(`\n✖ off-palette colour gate self-test: ${failed}/${FIXTURES.length} failed\n`);
    process.exit(1);
  }
  console.log(`✔ off-palette colour gate self-test: ${FIXTURES.length} fixtures passed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
