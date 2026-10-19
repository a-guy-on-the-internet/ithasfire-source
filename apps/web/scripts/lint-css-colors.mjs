#!/usr/bin/env node
/**
 * DESIGN SYSTEM v2 — THE CSS COLOR GATE
 * =====================================
 *
 * `docs/design/design-system-v2.md` says: **no raw hex in components.** `eslint.config.mjs`
 * enforces that for `.ts`/`.tsx`. Nothing enforced it for `.css` — every `globals.css` colour bug
 * to date (the `select { color-scheme: dark }` panel, the white glyph on `#EFE7D6` paper, the
 * invisible focus ring) was found by hand. ~5.2k lines of CSS were the migration's single biggest
 * blind spot. This closes it.
 *
 * ## Why a bespoke scanner and not stylelint
 *
 * 1. **Zero dependencies.** `stylelint` is not installed, and `postcss` is only present
 *    transitively (undeclared — it resolves via `.npmrc` `nodeLinker=hoisted`). Adding either
 *    floats unrelated `pnpm-lock.yaml` churn, which this repo deliberately avoids.
 * 2. **The interesting rule is custom anyway.** "Hex is legal *only* inside a `var()` fallback"
 *    is not a built-in stylelint rule — it would need a custom plugin regardless. Given that, the
 *    dependency buys us only a CSS parser, and the parsing we need is small and testable.
 *
 * ## The rules — deliberately at PARITY with eslint.config.mjs
 *
 * | # | Rule | Mirrors |
 * |---|------|---------|
 * | 1 | Bare hex outside a `var()` fallback | `HEX_SELECTOR` |
 * | 2 | `rgba(255,255,255,…)` anywhere | `WHITE_SELECTOR` |
 * | 3 | The bare `white` keyword anywhere | `WHITE_KEYWORD_SELECTOR` |
 *
 * Rule 1 exempts `var(--accent, #E2481D)` because the fallback is the SANCTIONED pattern for
 * raw-CSS contexts — it is what SSR paints before the injector hydrates. Rules 2 and 3 do NOT
 * exempt the fallback slot, and that asymmetry is intentional: it mirrors the eslint selectors
 * (`HEX_SELECTOR` is `^…$`-anchored, so a fallback never matches; `WHITE_SELECTOR` is unanchored,
 * so it matches anywhere). It is also correct on the merits — a fallback must be the *Stub* value,
 * and Stub has no bare `white` (its paper is `#FDFAF3`, its background `#F6F0E4`). A `white`
 * fallback is always either a bug or an Ember leftover.
 *
 * ## Exemptions — annotations, not path lists
 *
 * The eslint gate exempts by FILE PATH (`eslint-hex-allowlist.mjs`). That does not work here:
 * `globals.css` alone holds both principled permanents (the embed forced-light block) and real
 * debt, so a file-level exemption would blind the gate to the single most important stylesheet.
 * Exemptions are therefore per-site annotations:
 *
 *   /* ds-color-ok: <reason> *\/          — PERMANENT. Same line, or the line above.
 *   /* ds-color-ok-start: <reason> *\/    — PERMANENT, until…
 *   /* ds-color-ok-end *\/                — …here. For contiguous blocks (see globals.css).
 *   /* ds-color-debt: <reason> *\/        — DEBT. Same shape, but counted and reported.
 *
 * A reason is REQUIRED — an annotation with an empty reason is itself an error. This is the same
 * bar as adding to `eslint-white-permanents.mjs` (which also demands a written reason and shows
 * up in review), but the reason lives where the next reader actually needs it.
 *
 * Two traps this shape sidesteps for free:
 *   - No path globs ⇒ the `[slug]` glob-metacharacter trap (`escapeGlob`) cannot bite. That trap
 *     silently no-op'd the whole eslint allowlist once and produced 219 phantom errors.
 *   - Annotations are extracted from comments BEFORE comments are blanked, so prose *about* the
 *     anti-pattern never trips the rules — matching eslint, where comments are not `Literal`s.
 *
 * ## `ds-color-ok` vs `ds-color-debt`
 *
 * Same distinction the eslint gate draws between `eslint-white-permanents.mjs` (principled) and
 * `eslint-hex-allowlist.mjs` (a shrinking ratchet). `ok` = correct and staying. `debt` = known
 * wrong, not yet fixed. The debt count is printed on every run and must only ever go DOWN.
 *
 * ## The primitive tier
 *
 * Per the doc, raw values live in exactly two places: `packages/ui/…/tokens/colors.ts` and the
 * `:root` block of `globals.css`. So declarations inside a `:root` block are exempt — that is the
 * primitive tier by definition. Custom-property definitions OUTSIDE `:root` are NOT auto-exempt
 * (they are theme-branch overrides and deserve a stated reason).
 *
 * ## Maintaining this file
 *
 * ALWAYS negative-test after touching a rule: inject a violation, confirm it ERRORS, revert.
 * A green lint can mean "the rule is broken", not "the code is clean". `--selftest` does exactly
 * this against in-memory fixtures; run it.
 *
 * Usage:  node scripts/lint-css-colors.mjs [--selftest]
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Build output / vendored CSS — never authored by us. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "storybook-static",
  "out",
  "build",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
]);

// ── Rules ────────────────────────────────────────────────────────────────────

const DOC = "docs/design/design-system-v2.md";

const RULES = [
  {
    id: "raw-hex",
    // Not inside a var() fallback — the fallback slot is masked out before this runs.
    re: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
    maskVarFallbacks: true,
    message: (m) =>
      `Raw hex color \`${m}\`. Design System v2 forbids raw hex in components — use \`var(--token, #stubFallback)\` (the fallback is what SSR paints, so it must be the STUB value). See ${DOC}. If this is genuinely correct (a fixed-dark surface, a forced-light embed, a theme-branch literal), annotate the site: /* ds-color-ok: <reason> */`,
  },
  {
    id: "raw-white-rgba",
    // `i` — CSS functions/keywords are case-insensitive, so `RGBA(255,255,255,.5)` paints white
    // just the same. (eslint's selector is case-sensitive here; this is a deliberate improvement
    // on parity, not a break from it.)
    re: /rgba\(\s*255\s*,\s*255\s*,\s*255/gi,
    maskVarFallbacks: false,
    message: () =>
      `Raw white \`rgba(255,255,255,…)\`. This was the retired Ember dark theme's chrome and is invisible on the Stub cream default. Use an ink tint (\`rgba(33,28,22,α)\`) or \`color-mix(in srgb, var(--onStructure, #FDFAF3) X%, transparent)\` for light-on-dark chrome. See ${DOC}. Only annotate /* ds-color-ok: <reason> */ if the surface is dark in EVERY theme.`,
  },
  {
    id: "raw-white-keyword",
    // Value-token `white`, incl. inside a var() fallback — a white fallback is never a Stub value.
    // `i` keeps parity with eslint's `/^(?:white|WHITE)$/` (CSS keywords are case-insensitive) and
    // additionally covers `White`. The lookbehind/lookahead keep `whitesmoke`/`antiquewhite` and
    // the `white-space` property name out.
    re: /(?<=^|[\s:,(])white(?=$|[\s;,)!])/gi,
    maskVarFallbacks: false,
    message: () =>
      `The bare \`white\` keyword. On an accent fill use \`var(--onBrandSecondary, #FFFFFF)\`; on an ink/structure fill use \`var(--onStructure, #FDFAF3)\`; on a light surface it is invisible — use \`var(--foreground, #211C16)\`. NOTE: inside a \`var()\` fallback this is still wrong — the fallback must be the STUB value, and Stub has no bare white (paper is #FDFAF3, background #F6F0E4). See ${DOC}.`,
  },
];

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Blank out `/* … *\/` comments, preserving every byte offset and newline so line numbers and
 * column offsets stay exact. Returns the blanked source plus the comments found (for annotations).
 */
function stripComments(src) {
  let out = "";
  const comments = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    // Strings first — a `/*` inside a quoted value (`content: "/*"`) is DATA, not a comment.
    // Without this, indexOf("*/") finds no terminator and blanks the entire rest of the file,
    // silently disabling every rule below that line. `valueRegions` skips strings the same way;
    // the two passes must agree on what a string is.
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      out += src[i];
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i];
          i += 1;
        }
        if (src[i] === "\n") line += 1;
        out += src[i];
        i += 1;
      }
      if (i < src.length) {
        out += src[i];
        i += 1;
      }
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      const text = src.slice(i, stop);
      const startLine = line;
      // Is the comment ALONE on its line? Both halves matter, and they must be checked
      // independently — see parseAnnotations. `ownLine` = nothing but whitespace before the `/*`;
      // `endsLine` = nothing but whitespace after the `*/`. A comment can start its line and still
      // be followed by a declaration (`/* … */ color: #fff;`), which is NOT "alone on its line".
      let k = i - 1;
      let ownLine = true;
      while (k >= 0 && src[k] !== "\n") {
        if (src[k] !== " " && src[k] !== "\t") {
          ownLine = false;
          break;
        }
        k -= 1;
      }
      let f = stop;
      let endsLine = true;
      while (f < src.length && src[f] !== "\n") {
        if (src[f] !== " " && src[f] !== "\t" && src[f] !== "\r") {
          endsLine = false;
          break;
        }
        f += 1;
      }
      // Preserve newlines so line numbers downstream stay correct.
      for (const ch of text) {
        out += ch === "\n" ? "\n" : " ";
        if (ch === "\n") line += 1;
      }
      comments.push({ text, line: startLine, endLine: line, ownLine, endsLine });
      i = stop;
      continue;
    }
    if (src[i] === "\n") line += 1;
    out += src[i];
    i += 1;
  }
  return { code: out, comments };
}

/**
 * Walk CSS and yield the *declaration value* regions — the text between a `:` and its `;`/`}`,
 * at brace depth ≥ 1. Selectors are therefore never scanned, so `.white-box {` and `#fff { }`
 * (an ID selector) can't produce false positives, while multi-line values (a wrapped
 * `box-shadow:` list) are still fully covered — a line-based regex would miss those.
 *
 * Also reports whether each region sits inside a `:root` block (the primitive tier).
 */
function valueRegions(code) {
  const regions = [];
  const selectorStack = [];
  let depth = 0;
  let selBuf = "";
  let inValue = false;
  let valueStart = 0;
  let i = 0;

  const flush = (end) => {
    if (!inValue) return;
    regions.push({
      start: valueStart,
      end,
      text: code.slice(valueStart, end),
      // Exact-match `:root` only. A `:root` nested in an at-rule, `:root, .foo {}` and `:root:has(…)`
      // therefore do NOT count as the primitive tier. That fails SAFE — a false positive you resolve
      // with an annotation, never a silent miss — and doesn't occur today (globals.css's only
      // `:root` is top-level). Noted so the next person doesn't debug it cold.
      inRoot: selectorStack.some((s) => s === ":root"),
    });
    inValue = false;
  };

  while (i < code.length) {
    const ch = code[i];

    // Skip strings wholesale — url("data:…;base64,…") and content:"…" must not be
    // mistaken for structure. (Data-URI SVGs encode `#` as `%23`, so they carry no hex anyway.)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === "{") {
      flush(i);
      selectorStack.push(selBuf.trim());
      selBuf = "";
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      flush(i);
      selectorStack.pop();
      selBuf = "";
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ";") {
      flush(i);
      selBuf = "";
      i += 1;
      continue;
    }
    if (ch === ":" && depth > 0 && !inValue) {
      inValue = true;
      valueStart = i + 1;
      i += 1;
      continue;
    }
    if (!inValue) selBuf += ch;
    i += 1;
  }
  flush(code.length);
  return regions;
}

/**
 * Mask the FALLBACK slot of every `var()` — everything after the first top-level comma, up to the
 * matching close paren — replacing it with spaces so offsets survive. This is what makes
 * `var(--accent, #E2481D)` legal while `color: #E2481D` is not.
 *
 * Nested `var(--a, var(--b, #fff))` masks in one go: the whole outer fallback is a fallback.
 */
function maskVarFallbacks(text) {
  // `split("")` (UTF-16 code units), NOT `[...text]` (code points) — every index here must live in
  // ONE space. Mixing them (spreading into code points while matching with a code-unit offset)
  // desyncs by +1 per astral char, which walked the paren scanner into the *next* function and
  // silently masked its arguments — an emoji in a `url()` could exempt a later raw hex.
  // `toLowerCase()` can also change length (İ → 2 units), so detection compares chars directly
  // rather than lowercasing the string.
  const chars = text.split("");
  // CSS function names are case-insensitive: `VAR(--accent, #E2481D)` is a real var() whose
  // fallback must be masked like any other (the mirror of the rgba→RGBA gap).
  const at = (k, c) => chars[k] === c || chars[k] === c.toUpperCase();
  let i = 0;
  while (i < chars.length) {
    if (at(i, "v") && at(i + 1, "a") && at(i + 2, "r") && chars[i + 3] === "(") {
      let depth = 0;
      let commaAt = -1;
      let j = i + 3; // at '('
      for (; j < chars.length; j++) {
        const c = chars[j];
        if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        } else if (c === "," && depth === 1 && commaAt === -1) commaAt = j;
      }
      if (commaAt !== -1 && j < chars.length) {
        for (let k = commaAt; k < j; k++) if (chars[k] !== "\n") chars[k] = " ";
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

// ── Annotations ──────────────────────────────────────────────────────────────

/**
 * Anchored to the comment's LEADING token, deliberately. Unanchored, this matched `ds-color-ok:`
 * anywhere in a comment — so prose *explaining the convention* silently armed a real exemption:
 *
 *   /* To exempt a literal, write ds-color-ok: your reason here *\/
 *   .a { color: #fff; }        ← 0 errors. The doc comment granted the exemption.
 *
 * The header promises the inverse (prose about the ANTI-PATTERN never trips the rules); this is the
 * mirror hazard, and it matters more now that the handoff actively teaches people to write these
 * markers. An annotation must be the comment's whole point, not a mention inside one.
 */
const ANNOT_RE = /^\/\*\s*ds-color-(ok-start|ok-end|ok|debt)\s*(?::\s*([^*]*))?/;

function parseAnnotations(comments, file, errors) {
  /** line -> {kind, reason} for single-line forms */
  const single = new Map();
  /** array of {from, to, kind, reason} for region forms */
  const regions = [];
  let open = null;

  for (const { text, line, endLine, ownLine, endsLine } of comments) {
    const m = ANNOT_RE.exec(text);
    if (!m) continue;
    const kind = m[1];
    const reason = (m[2] ?? "").trim();

    if (kind === "ok-end") {
      if (!open) {
        errors.push({ file, line, id: "annotation", message: "`ds-color-ok-end` without a matching `ds-color-ok-start`." });
        continue;
      }
      regions.push({ from: open.endLine, to: line, kind: "ok", reason: open.reason });
      open = null;
      continue;
    }

    // A reason is mandatory for every other form — "it's easier" is not a reason, and an
    // un-reasoned exemption is exactly the rot this gate exists to prevent.
    if (!reason) {
      errors.push({
        file,
        line,
        id: "annotation",
        message: `\`ds-color-${kind}\` requires a reason: /* ds-color-${kind}: why this literal is correct */`,
      });
      continue;
    }

    if (kind === "ok-start") {
      if (open) {
        errors.push({ file, line, id: "annotation", message: "Nested `ds-color-ok-start` — close the previous one first." });
        continue;
      }
      open = { line, endLine, reason };
      continue;
    }
    // An annotation covers every line the comment itself OCCUPIES — which for the trailing form
    // (`color: #fff; /* ds-color-ok: … */`) is the declaration's own line, even if the reason
    // wraps onto further lines.
    //
    // CONTRACT: exemption is LINE-granular, like eslint's own `eslint-disable-line`. So a comment
    // with code on both sides of it exempts both, and two declarations sharing one line share one
    // annotation. That's accepted, not a leak — but it means one declaration per line if you want
    // one reason per literal.
    for (let l = line; l <= endLine; l++) single.set(l, { kind, reason });
    // …and, ONLY when the comment sits alone on its line, the declaration beneath it.
    //
    // This guard is load-bearing, and it needs BOTH halves. Reaching to endLine+1 hands a free,
    // reason-less exemption to whatever declaration comes next — a gate that silently stops
    // matching is worse than no gate, because green then reads as "the code is clean". Both of
    // these leaked past earlier versions and are now pinned by fixtures:
    //
    //   TRAILING (needs !ownLine)          LEADING (needs !endsLine)
    //   .scrim {                            .scrim {
    //     color: #fff; /* ds-color-ok: … */   /* ds-color-ok: … */ color: #fff;
    //     background: #0F1B33;  ← leaked       background: #0F1B33;  ← leaked
    //   }                                   }
    //
    // `ownLine` alone is only half the spec: a comment can START its line and still be followed by
    // a declaration on it, which is not "alone on its line". Either way the annotation still
    // covers the line it occupies via the loop above, so no legitimate form loses its exemption.
    if (ownLine && endsLine) single.set(endLine + 1, { kind, reason });
  }

  if (open) {
    errors.push({ file, line: open.line, id: "annotation", message: "`ds-color-ok-start` was never closed with `ds-color-ok-end`." });
  }
  return { single, regions };
}

function annotationFor(line, { single, regions }) {
  const hit = single.get(line);
  if (hit) return hit;
  for (const r of regions) if (line > r.from && line < r.to) return r;
  return null;
}

// ── Checking ─────────────────────────────────────────────────────────────────

const lineOf = (code, index) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === "\n") line += 1;
  return line;
};

export function checkCss(src, file) {
  const errors = [];
  const debts = [];
  const { code, comments } = stripComments(src);
  const annots = parseAnnotations(comments, file, errors);

  for (const region of valueRegions(code)) {
    // The primitive tier. Raw values are supposed to live here.
    if (region.inRoot) continue;

    for (const rule of RULES) {
      const haystack = rule.maskVarFallbacks ? maskVarFallbacks(region.text) : region.text;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(haystack)) !== null) {
        const line = lineOf(code, region.start + m.index);
        const annot = annotationFor(line, annots);
        if (annot?.kind === "ok") continue;
        if (annot?.kind === "debt") {
          debts.push({ file, line, id: rule.id, reason: annot.reason });
          continue;
        }
        errors.push({ file, line, id: rule.id, message: rule.message(m[0]) });
      }
    }
  }
  return { errors, debts };
}

// ── Walk + report ────────────────────────────────────────────────────────────

function* cssFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* cssFiles(full);
    else if (entry.endsWith(".css")) yield full;
  }
}

function main() {
  const allErrors = [];
  const allDebts = [];
  let scanned = 0;

  for (const file of cssFiles(APP_ROOT)) {
    scanned += 1;
    const rel = relative(APP_ROOT, file);
    const { errors, debts } = checkCss(readFileSync(file, "utf8"), rel);
    allErrors.push(...errors);
    allDebts.push(...debts);
  }

  for (const e of allErrors) {
    console.error(`\n${e.file}:${e.line}\n  error  [${e.id}]  ${e.message}`);
  }

  const summary = `${scanned} CSS files scanned · ${allDebts.length} annotated debt · ${allErrors.length} errors`;
  if (allErrors.length) {
    console.error(`\n✖ design-system CSS colour gate: ${summary}\n`);
    process.exit(1);
  }
  console.log(`✔ design-system CSS colour gate: ${summary}`);
}

// ── Self-test ────────────────────────────────────────────────────────────────
//
// The gate's own regression suite. A colour gate that silently stops matching is WORSE than no
// gate — it reads as "the code is clean". These fixtures assert both directions: violations ERROR,
// and the sanctioned patterns do NOT.

const FIXTURES = [
  // [name, css, expectedErrorIds]
  ["bare hex errors", `.a { color: #E2481D; }`, ["raw-hex"]],
  ["short hex errors", `.a { color: #fff; }`, ["raw-hex"]],
  ["8-digit hex errors", `.a { color: #E2481DCC; }`, ["raw-hex"]],
  ["var() fallback is legal", `.a { color: var(--accent, #E2481D); }`, []],
  ["nested var() fallback is legal", `.a { color: var(--a, var(--b, #E2481D)); }`, []],
  ["uppercase VAR() fallback is legal too (CSS fn names are case-insensitive)", `.a { color: VAR(--accent, #E2481D); }`, []],
  // An astral char earlier in the value used to desync the var()-scanner's index space, walking it
  // into the NEXT function and masking that function's args — silently exempting a real hex.
  [
    "an astral char before a var() does not let a later hex escape masking",
    `.a { background: url("🔥.svg") var(--bg, red) linear-gradient(color-mix(in srgb, #FF0000 50%, transparent), transparent); }`,
    ["raw-hex"],
  ],
  ["an astral char does not break a legitimate var() fallback either", `.a { background: url("🔥.svg") var(--accent, #E2481D); }`, []],
  // Prose that MENTIONS an annotation must not BE one — otherwise a comment documenting the
  // convention silently exempts whatever follows it.
  ["prose mentioning ds-color-ok does not arm an exemption", `/* To exempt a literal, write ds-color-ok: your reason here */\n.a { color: #fff; }`, ["raw-hex"]],
  ["a real annotation still works after that anchor change", `/* ds-color-ok: fixed-dark scrim */\n.a { color: #fff; }`, []],
  ["hex outside a var() but beside one", `.a { border: 1px solid #333; color: var(--a, #fff); }`, ["raw-hex"]],
  [":root is the primitive tier", `:root { --accent: #E2481D; }`, []],
  ["custom prop outside :root is NOT exempt", `.t_stub { --accent: #E2481D; }`, ["raw-hex"]],
  ["rgba white errors", `.a { color: rgba(255, 255, 255, 0.5); }`, ["raw-white-rgba"]],
  ["rgba white errors inside a var() fallback", `.a { color: var(--x, rgba(255,255,255,.5)); }`, ["raw-white-rgba"]],
  ["white keyword errors", `.a { color: white; }`, ["raw-white-keyword"]],
  ["white keyword errors inside a var() fallback", `.a { color: var(--th-color-bg, white); }`, ["raw-white-keyword"]],
  ["white in a selector is not a value", `.white-box { padding: 0; }`, []],
  ["ink tint is legal", `.a { color: rgba(33, 28, 22, 0.3); }`, []],
  ["comments are not code", `/* never write #FF0000 or white here */\n.a { padding: 0; }`, []],
  ["multi-line value is still scanned", `.a {\n  box-shadow:\n    0 1px 2px #000,\n    0 2px 4px rgba(255,255,255,.2);\n}`, ["raw-hex", "raw-white-rgba"]],
  ["data-URI SVG is not a hex (encodes %23)", `.a { background-image: url("data:image/svg+xml,%3Csvg stroke='%235C544A'%3E"); }`, []],
  ["ds-color-ok exempts its own line", `.a { color: #fff; /* ds-color-ok: fixed-dark scrim */ }`, []],
  ["ds-color-ok exempts the line below", `/* ds-color-ok: fixed-dark scrim */\n.a { color: #fff; }`, []],
  // Regression (BLOCKING, found in review): a TRAILING annotation must cover its own declaration
  // and STOP. Extending it to the next line handed a free, reason-less exemption to whatever came
  // after — the exact "green lint means the rule is broken" failure this gate exists to prevent.
  // The suite previously asserted the +1 worked but never that it stopped.
  [
    "a trailing ds-color-ok does NOT leak onto the next line",
    `.a {\n  color: #ffffff; /* ds-color-ok: light-on-dark photo scrim */\n  background: #0F1B33;\n}`,
    ["raw-hex"],
  ],
  [
    "a trailing ds-color-ok with a wrapped reason still covers its own line, and stops",
    `.a {\n  color: #ffffff; /* ds-color-ok: a reason long\n     enough that it wraps */\n  background: #0F1B33;\n}`,
    ["raw-hex"],
  ],
  // Round 2: `ownLine` alone was only half the guard — a comment can START its line and still be
  // followed by a declaration on it, which re-opened the identical leak from the leading side.
  [
    "a leading ds-color-ok followed by code does NOT leak onto the next line",
    `.a {\n  /* ds-color-ok: fixed-dark scrim */ color: #ffffff;\n  background: #0F1B33;\n}`,
    ["raw-hex"],
  ],
  [
    "…and it still covers the declaration it leads on its own line",
    `.a {\n  /* ds-color-ok: fixed-dark scrim */ color: #ffffff;\n}`,
    [],
  ],
  // Pins the `line..endLine` span (as opposed to start-line-only): a WRAPPED leading comment must
  // still cover the declaration sitting on its final line. Mutation-tested — the single-line
  // leading fixture above can't catch this, because there line === endLine.
  [
    "a wrapped leading ds-color-ok covers the declaration on its last line",
    `.a {\n  /* ds-color-ok: a reason long\n     enough to wrap */ color: #ffffff;\n}`,
    [],
  ],
  ["ds-color-debt cannot be leaked onto the next line either", `.a {\n  color: #fff; /* ds-color-debt: known */\n  background: #0F1B33;\n}`, ["raw-hex"]],
  // The region form's exemption must STOP too. Without these, changing `<` to `<=` in
  // annotationFor — or `from: open.endLine` to `open.line` — passes the whole suite.
  ["a violation AFTER ds-color-ok-end is not exempt", `/* ds-color-ok-start: x */\n.a { color: #fff; }\n/* ds-color-ok-end */\n.b { color: #0F1B33; }`, ["raw-hex"]],
  ["a violation BEFORE ds-color-ok-start is not exempt", `.b { color: #0F1B33; }\n/* ds-color-ok-start: x */\n.a { color: #fff; }\n/* ds-color-ok-end */`, ["raw-hex"]],
  ["a violation ON the ds-color-ok-end line is not exempt", `/* ds-color-ok-start: x */\n.a { color: #fff; }\n.b { color: #0F1B33; } /* ds-color-ok-end */`, ["raw-hex"]],
  // Pins the region's START anchor to the ok-start comment's END line. With `from: open.line`
  // instead, a declaration sharing the comment's last line would fall INSIDE the region and be
  // silently exempted. Mutation-tested: this fixture is the only thing that catches that swap.
  [
    "a wrapped ds-color-ok-start does not exempt code on its own last line",
    `.a {\n  /* ds-color-ok-start: a reason long\n     enough to wrap */ color: #0F1B33;\n  background: #fff;\n}\n/* ds-color-ok-end */`,
    ["raw-hex"],
  ],
  ["uppercase WHITE errors (CSS keywords are case-insensitive)", `.a { color: WHITE; }`, ["raw-white-keyword"]],
  ["mixed-case White errors", `.a { color: White; }`, ["raw-white-keyword"]],
  ["uppercase RGBA white errors", `.a { color: RGBA(255,255,255,0.5); }`, ["raw-white-rgba"]],
  ["whitesmoke is not the white keyword", `.a { color: whitesmoke; }`, []],
  ["the white-space property name is not a value", `.a { white-space: nowrap; }`, []],
  // A `/*` inside a quoted value is DATA. Mishandling it blanked the rest of the file and
  // silently disabled every rule below — a file-wide false negative.
  ["a /* inside a string does not blank the rest of the file", `.a::before { content: "/*"; }\n.b { color: #FF0000; }`, ["raw-hex"]],
  ["ds-color-ok without a reason is an error", `/* ds-color-ok */\n.a { color: #fff; }`, ["annotation", "raw-hex"]],
  // Regression: annotations anchor to the line the comment ENDS on. Anchoring to the START line
  // meant any reason long enough to wrap silently stopped covering its own declaration.
  ["a wrapped ds-color-ok reason still covers the line below", `/* ds-color-ok: a reason long\n   enough that it wraps */\n.a { color: #fff; }`, []],
  ["a wrapped ok-start reason still covers the region", `/* ds-color-ok-start: a reason long\n   enough that it wraps */\n.a { color: #fff; }\n/* ds-color-ok-end */`, []],
  ["ds-color-debt is counted, not an error", `/* ds-color-debt: entity CTA fallback, see handoff */\n.a { color: #fff; }`, []],
  ["ok-start/ok-end covers a region", `/* ds-color-ok-start: forced-light embed */\n.a { color: #fff; }\n.b { color: #000; }\n/* ds-color-ok-end */`, []],
  ["unclosed ok-start is an error", `/* ds-color-ok-start: x */\n.a { padding: 0; }`, ["annotation"]],
];

function selftest() {
  let failed = 0;
  for (const [name, css, expected] of FIXTURES) {
    const { errors, debts } = checkCss(css, "fixture.css");
    const got = errors.map((e) => e.id).sort();
    const want = [...expected].sort();
    const ok = got.length === want.length && got.every((v, i) => v === want[i]);
    if (!ok) {
      failed += 1;
      console.error(`  ✖ ${name}\n      expected [${want}] but got [${got}]`);
    }
    if (name.includes("debt") && debts.length !== 1) {
      failed += 1;
      console.error(`  ✖ ${name}\n      expected 1 counted debt, got ${debts.length}`);
    }
  }
  if (failed) {
    console.error(`\n✖ CSS colour gate self-test: ${failed}/${FIXTURES.length} failed\n`);
    process.exit(1);
  }
  console.log(`✔ CSS colour gate self-test: ${FIXTURES.length} fixtures passed`);
}

// Only act when run as a CLI. `checkCss` is exported, and without this guard importing it (from a
// vitest suite, say) would walk all of apps/web and could `process.exit(1)` as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv.includes("--selftest")) selftest();
  else main();
}
