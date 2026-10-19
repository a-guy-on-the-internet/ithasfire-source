import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { BUTTON_VARIANT_STYLES } from "../components/forms/Button";

// ─────────────────────────────────────────────────────────────────────────────
// Call-site guard for the "the label never followed the button" bug class.
//
// `contrast-pairs.test.ts` proves the Button ATOM's ladder is legible at every
// rung. It reads BUTTON_VARIANT_STYLES, so it is structurally blind to what
// callers actually render — and that blindness WAS the bug: the atom was
// perfectly legible while every live instance was not.
//
// The mechanism (Text.tsx): `resolvedColor = color ?? toneColorMap[tone]`, and
// with the default tone="default" that is `$color`, which is ALWAYS applied to
// the Paragraph. A `<Text>` child therefore paints its own colour and never
// sees the Button's `hoverStyle.color` / `pressStyle.color`, which only ever
// land on the FRAME. Any variant whose label colour is not `$color` at some
// rung is silently wrong at that rung.
//
// Measured on /forgot-password (Stub, the shipped default) before the fix:
// "Back to sign in" hovered at 2.85:1 and pressed at 2.09:1 — the `<Text>` kept
// ink `#211C16` while the fill went to `#B93312` / `#98240B`.
//
// The escape hatches are `tone="inherit"` (→ css `color: inherit`, so the label
// tracks the frame through all three rungs) or an explicit `color` the caller
// has reasoned about.
//
// NOTE this guard deliberately derives its rule FROM the atom rather than
// hardcoding a variant list: if someone later gives `ghost` a hover colour, or
// adds a variant, the call-site rule widens automatically instead of going
// quietly out of date.
//
// It also reads THROUGH dynamic `variant={...}` expressions (see
// `classifyVariant`). Reading only string literals is what let this guard
// certify a clean repo while six dynamic-variant call sites — including
// AdminTableParts' FilterChips at 2.85:1 — sat in its blind spot.
// ─────────────────────────────────────────────────────────────────────────────

type Rungs = {
  color?: string;
  hoverStyle?: { color?: string };
  pressStyle?: { color?: string };
};

/** Label colours a variant paints across rest / hover / press. */
const rungColors = (v: Rungs): string[] =>
  [v.color, v.hoverStyle?.color, v.pressStyle?.color].filter(
    (c): c is string => typeof c === "string",
  );

/**
 * A default-tone `<Text>` renders `$color`. So a variant is only safe for a
 * bare `<Text>` child if EVERY rung is `$color` — otherwise the label is wrong
 * at whichever rung differs.
 */
const VARIANTS_REQUIRING_INHERIT = Object.entries(BUTTON_VARIANT_STYLES)
  .filter(([, style]) => rungColors(style as Rungs).some((c) => c !== "$color"))
  .map(([name]) => name);

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const SCAN_ROOTS = [
  join(REPO_ROOT, "apps", "web", "src"),
  join(REPO_ROOT, "packages", "ui", "src"),
];

// Test files build deliberate fixtures (Button.theme.test.tsx renders a bare
// <Text> child precisely to assert how nested labels are handled), so they are
// not call sites. Stories ARE call sites and stay in scope.
const IGNORED =
  /node_modules|dist|\.next|storybook-static|__tests__|\.(test|spec)\.tsx$/;

const collectTsx = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (IGNORED.test(p)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(p);
    }
  };
  walk(dir);
  return out;
};

/**
 * Scan forward from `from` to the matching `>` that closes a JSX opening tag,
 * skipping over quoted strings, `{...}` expression containers, AND comments —
 * all three can legally contain a bare `>`.
 *
 * Comments matter more than they look. A `//` line comment inside an opening
 * tag routinely mentions markup:
 *
 *   <Button
 *     // Tamagui forwards the host node; on web that is the <button> element.
 *     ref={triggerRef as never}
 *     variant="ghost"
 *
 * Without comment-skipping the `>` in `<button>` ends the tag early, so
 * `variant="ghost"` falls outside `openTag`, `readAttr` returns undefined, and
 * `classifyVariant` applies Button's `primary` default — flagging a ghost
 * button (which this file separately asserts is safe at every rung) as at-risk.
 * That was a live false positive on WorkspaceSwitcher's trigger.
 *
 * The same truncation shifts `body` to start mid-tag, so it is not only a
 * false-positive risk: a genuinely at-risk button could have its `<Text>`
 * children mis-attributed and go unchecked. A guard that reads tags wrong in
 * either direction is the exact failure this file was written to prevent.
 */
const endOfOpeningTag = (src: string, from: number): number => {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    // Comments are skipped at ANY depth — they are equally legal inside an
    // expression container. `/>` is not a comment: the next char decides.
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
};

type ButtonEl = { index: number; openTag: string; body: string };

const findButtons = (src: string): ButtonEl[] => {
  const out: ButtonEl[] = [];
  const re = /<Button\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const close = endOfOpeningTag(src, m.index + "<Button".length);
    if (close === -1) continue;
    const openTag = src.slice(m.index, close + 1);
    if (src[close - 1] === "/") {
      out.push({ index: m.index, openTag, body: "" });
      continue;
    }
    // Walk to the matching </Button>, honouring nesting.
    const tagRe = /<(\/?)Button\b/g;
    tagRe.lastIndex = close + 1;
    let nest = 1;
    let end = -1;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(src))) {
      if (t[1] === "/") {
        if (--nest === 0) {
          end = t.index;
          break;
        }
      } else nest++;
    }
    if (end === -1) continue;
    out.push({ index: m.index, openTag, body: src.slice(close + 1, end) });
  }
  return out;
};

/**
 * Read a JSX attribute, distinguishing a string literal from an expression
 * container. The expression case brace-matches rather than using `[^}]*`, so
 * nested braces (`variant={cfg({ a: 1 })}`) don't truncate the read.
 */
type Attr =
  | { kind: "literal"; value: string }
  | { kind: "expression"; raw: string }
  | undefined;

const readAttr = (tag: string, name: string): Attr => {
  const m = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|\\{)`));
  if (!m) return undefined;
  if (m[1] !== undefined) return { kind: "literal", value: m[1] };

  // Brace-match from the `{` that terminated the match.
  const open = m.index! + m[0].length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0)
      return { kind: "expression", raw: tag.slice(open + 1, i) };
  }
  return { kind: "expression", raw: tag.slice(open + 1) };
};

/** Every quoted string literal inside an expression, in source order. */
const quotedLiterals = (expr: string): string[] =>
  Array.from(expr.matchAll(/"([^"]*)"|'([^']*)'/g)).map((m) => m[1] ?? m[2]);

/**
 * What a call site's `variant=` resolves to, from a source scanner's view.
 *
 * A literal-only reader was the hole this guard shipped with: it returned the
 * RAW EXPRESSION TEXT for `variant={...}`, which never matches a variant name,
 * so every dynamic-variant button was silently skipped — including
 * AdminTableParts' FilterChips, whose `primary` branch rested at 2.85:1.
 */
type VariantRead =
  | { risk: "at-risk"; label: string }
  | { risk: "safe" }
  /** Non-literal expression we cannot resolve (`variant={variant}`). */
  | { risk: "unresolved"; label: string };

const classifyVariant = (attr: Attr): VariantRead => {
  // Button's defaultVariants: variant="primary".
  if (!attr)
    return VARIANTS_REQUIRING_INHERIT.includes("primary")
      ? { risk: "at-risk", label: "primary (default)" }
      : { risk: "safe" };

  if (attr.kind === "literal")
    return VARIANTS_REQUIRING_INHERIT.includes(attr.value)
      ? { risk: "at-risk", label: `"${attr.value}"` }
      : { risk: "safe" };

  const literals = quotedLiterals(attr.raw);
  if (literals.length === 0)
    // Cannot see the variant at all. A guard whose whole purpose is "the atom
    // was legible while every live instance wasn't" must not certify what it
    // cannot see — treat it as at-risk so the (always-safe) tone="inherit" fix
    // is required rather than the button being waved through.
    return { risk: "unresolved", label: `{${attr.raw.trim()}} — unresolvable` };

  const risky = literals.filter((l) => VARIANTS_REQUIRING_INHERIT.includes(l));
  return risky.length
    ? { risk: "at-risk", label: `{${attr.raw.trim()}} → ${risky.join(", ")}` }
    : { risk: "safe" };
};

const findTextOpenTags = (body: string): string[] => {
  const out: string[] = [];
  const re = /<Text\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const close = endOfOpeningTag(body, m.index + "<Text".length);
    if (close === -1) continue;
    out.push(body.slice(m.index, close + 1));
  }
  return out;
};

describe("Button call sites: <Text> labels must follow the button's colour", () => {
  it("derives the at-risk variant list from the atom", () => {
    // Sanity-check the derivation itself. `ghost` is $color at every rung, so a
    // bare <Text> happens to match it; `outlined` inverts and must not.
    expect(VARIANTS_REQUIRING_INHERIT).toContain("outlined");
    expect(VARIANTS_REQUIRING_INHERIT).toContain("primary");
    expect(VARIANTS_REQUIRING_INHERIT).toContain("secondary");
    expect(VARIANTS_REQUIRING_INHERIT).not.toContain("ghost");
  });

  // The guard's FIRST version read `variant={...}` as raw expression text,
  // which never matches a variant name, so it skipped every dynamic call site
  // and reported a clean repo while FilterChips' selected chip rested at
  // 2.85:1. These pin the reader so that hole cannot silently reopen.
  it("sees through dynamic variant expressions", () => {
    const read = (tag: string) => classifyVariant(readAttr(tag, "variant"));

    // The exact FilterChips shape that the literal-only reader waved through.
    expect(
      read(`<Button variant={selected === opt.value ? "primary" : "outlined"}>`)
        .risk,
    ).toBe("at-risk");
    // Only ONE branch at risk is still at risk.
    expect(read(`<Button variant={active ? "secondary" : "ghost"}>`).risk).toBe(
      "at-risk",
    );
    // Neither branch at risk → genuinely safe.
    expect(read(`<Button variant={active ? "ghost" : "ghost"}>`).risk).toBe(
      "safe",
    );
    // Absent → Button's defaultVariants primary.
    expect(read(`<Button onPress={x}>`).risk).toBe("at-risk");
    // Nested braces must not truncate the read.
    expect(read(`<Button variant={pick({ on: "primary" })}>`).risk).toBe(
      "at-risk",
    );
    // Unresolvable pass-through: we cannot see it, so we must not certify it.
    expect(read(`<Button variant={variant}>`).risk).toBe("unresolved");
  });

  // Regression: a `//` comment inside the opening tag that mentions markup
  // (`<button>`, `<a>`, `x > y`) used to end the tag at the comment's `>`, so
  // every attribute after it was invisible. WorkspaceSwitcher's ghost trigger
  // was reported as `primary (default)` and failed the repo scan.
  it("does not end an opening tag on a `>` inside a comment", () => {
    const withLineComment = [
      "<Button",
      "  // Tamagui forwards the host node; on web that is the <button> element.",
      '  ref={triggerRef as never}',
      '  variant="ghost"',
      ">",
    ].join("\n");
    const end = endOfOpeningTag(withLineComment, "<Button".length);
    expect(end).toBe(withLineComment.length - 1);
    expect(classifyVariant(readAttr(withLineComment, "variant")).risk).toBe(
      "safe",
    );

    // Block comments too, including one spanning the attribute list.
    const withBlockComment = [
      "<Button",
      "  /* renders a <button> on web, Pressable on native */",
      '  variant="ghost"',
      ">",
    ].join("\n");
    expect(
      classifyVariant(readAttr(withBlockComment, "variant")).risk,
    ).toBe("safe");

    // A self-closing `/>` must still terminate — `/` only starts a comment
    // when followed by `/` or `*`.
    expect(endOfOpeningTag(`<Button variant="ghost" />`, "<Button".length)).toBe(
      `<Button variant="ghost" />`.length - 1,
    );
  });

  it("no <Text> child paints its own colour inside a colour-inverting Button", () => {
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of collectTsx(root)) {
        const src = readFileSync(file, "utf8");
        if (!src.includes("<Button")) continue;

        for (const btn of findButtons(src)) {
          const variant = classifyVariant(readAttr(btn.openTag, "variant"));
          if (variant.risk === "safe") continue;

          for (const textTag of findTextOpenTags(btn.body)) {
            const hasExplicitColor = /\bcolor=/.test(textTag);
            const tone = readAttr(textTag, "tone");
            // Only a bare `tone="inherit"` is safe. A dynamic tone could
            // resolve to a self-painting colour on some branch.
            if (
              hasExplicitColor ||
              (tone?.kind === "literal" && tone.value === "inherit")
            )
              continue;

            const line = src.slice(0, btn.index).split("\n").length;
            offenders.push(
              `${file.replace(REPO_ROOT + "/", "")}:${line} — <Text> inside variant=${variant.label}`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      `These <Text> labels sit inside a Button whose label colour changes between rungs, but\n` +
        `carry neither tone="inherit" nor an explicit color — so they paint $color and ignore the\n` +
        `button's hover/press inversion (Text.tsx always applies its resolved colour).\n` +
        `Fix: add tone="inherit" so the label tracks the frame.\n\n${offenders.join("\n")}\n`,
    ).toEqual([]);
  });
});
