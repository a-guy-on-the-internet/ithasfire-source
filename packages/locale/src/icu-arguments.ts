/**
 * ICU argument scanner shared by the i18n parity gates.
 *
 * ── Why it lives in `@th/locale` ──────────────────────────────────────────
 *
 * There are TWO catalog systems and both need this gate:
 *   - `apps/web/src/i18n/messages/{en,es}.ts` — the live app catalog.
 *   - `packages/locale/messages/{en,es}.json` — the base catalog behind
 *     `@th/ui`'s provider-less translator, Storybook, and help-centre SSR.
 *
 * A test in `packages/locale` cannot import from an app, so the scanner cannot
 * stay under `apps/web/src/i18n/test-helpers/`. It is exported from the package
 * barrel instead; `apps/web` already depends on `@th/locale` (`workspace:*`),
 * so both gates reach the same implementation.
 *
 * It is test-only in practice — no runtime module imports it — and the package
 * is `"sideEffects": false` with no dependencies here, so it tree-shakes out of
 * app bundles.
 *
 * It sits at `src/icu-arguments.ts` rather than `src/__tests__/`: `packages/locale`
 * ships NO vitest config, so vitest's default `include`
 * (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) applies and a bare helper under
 * `__tests__/` would NOT be collected as a suite there. That hazard is real in
 * `apps/web`, whose `vitest.config.ts` additionally collects
 * `src/**\/__tests__/**\/*.{ts,tsx}` and fails such a file with "No test suite
 * found in file" — which is why the helper was outside `__tests__/` in its old
 * home too. Keeping it in `src/` is correct under both regimes.
 *
 * Typechecking: `packages/locale/tsconfig.json` includes all of `src`, so this
 * file is covered by the package build. The repo-root `pnpm typecheck`
 * (`tsconfig.base.json`) excludes `**\/__tests__\/**` and `**\/*.test.ts`, so it
 * covers this file but NOT the gates that import it. `apps/web`, by contrast,
 * DOES typecheck its test files: its tsconfig declares its own `exclude`
 * (node_modules + stories only) and a child `exclude` REPLACES the parent's
 * rather than merging, so `tsconfig.base.json`'s test exclusions do not reach it
 * and `include: ["**\/*.ts", "**\/*.tsx"]` picks up every gate. Run
 * `cd apps/web && pnpm exec tsc --noEmit` for those.
 *
 * Its own gate is `src/__tests__/icu-arguments.test.ts` — the extractor IS the
 * parity check, so it needs a check of its own.
 */

/**
 * The ARGUMENT NAMES an ICU message references — `{name}` and `{name, …}` at
 * message level, recursing into plural/select branches (which may legitimately
 * contain their own arguments) but never mistaking branch TEXT for one.
 *
 * Sorted and de-duplicated, so the result is the message's argument SET: two
 * locales must reference the same arguments, in whatever order and however
 * many times each.
 *
 * ── Why the obvious regex is wrong ────────────────────────────────────────
 *
 * Two flat-regex versions of this check shipped before it, and BOTH had a
 * false-positive AND a false-negative direction. A gate that fails on correct
 * input and passes on broken input is worse than no gate: the first half gets
 * it deleted, the second half is why it was written.
 *
 * 1. `/\{(\w+)/g` (the spotlight gate's original) grabbed the word after EVERY
 *    `{`, so sub-message TEXT read as an argument.
 *      - False POSITIVE: branch text is *supposed* to differ per locale, so
 *        `{count, plural, =0 {Filters} …}` vs `{count, plural, =0 {Filtros} …}`
 *        compared as `["Filters","Filters","count"]` vs
 *        `["Filtros","Filtros","count"]` — a "mismatch" on a CORRECT pair.
 *        `spotlight.facetsToggle` is exactly that message and is live in both
 *        catalogs today. Every other plural escaped only by luck: their
 *        branches start with `#`, which is not `\w`.
 *      - False NEGATIVE: because branch text lands in the same flat multiset
 *        as real arguments, locale-specific words can pad the set back into
 *        agreement and mask a genuine rename.
 *
 * 2. `/\{(\w+)\}/g` (the pagination gate's original) requires the closing
 *    brace, which kills most of the false positives but is blind to every
 *    argument that carries a type or a sub-message — the `{name, number}` and
 *    `{name, plural, …}` forms. Measured on a real one-sided rename:
 *
 *      en "Rows {start}–{end} of {total, plural, other {# of {pages} pages}}"
 *      es "Filas {start}–{end} de {n, plural, other {# de {pages} paginas}}"
 *
 *      /\{(\w+)\}/g   -> ["end","pages","start"] both sides  => PASSES
 *      icuArgumentNames -> ["end","pages","start","total"] vs
 *                          ["end","n","pages","start"]       => FAILS
 *
 *    `total` → `n` in one locale only is a real defect (the plural selector
 *    argument no longer exists, so the message throws at format time), and the
 *    old gate could not see it.
 */
export function icuArgumentNames(message: string): string[] {
  const names = new Set<string>();
  let i = 0;

  /** Scan a message body; returns at the `}` closing an enclosing branch. */
  const readMessage = (): void => {
    while (i < message.length) {
      const ch = message[i];
      if (ch === "}") return;
      if (ch === "'") {
        const next = message[i + 1];
        // A quote only escapes when it precedes `{`, `}` or another quote —
        // otherwise it is an ordinary apostrophe ("don't").
        if (next === "'") {
          i += 2;
        } else if (next === "{" || next === "}") {
          i += 2;
          while (i < message.length && message[i] !== "'") i++;
          i++;
        } else {
          i++;
        }
        continue;
      }
      if (ch === "{") {
        i++;
        readArgument();
        continue;
      }
      i++;
    }
  };

  /** Called just past a `{`. Consumes through the matching `}`. */
  const readArgument = (): void => {
    while (i < message.length && /\s/.test(message[i]!)) i++;
    let name = "";
    while (i < message.length && /[\w.]/.test(message[i]!)) {
      name += message[i];
      i++;
    }
    if (name) names.add(name);
    while (i < message.length && /\s/.test(message[i]!)) i++;

    if (message[i] === "}") {
      i++;
      return;
    }
    if (message[i] !== ",") {
      // Not argument syntax (e.g. stray brace) — skip to the closing brace.
      while (i < message.length && message[i] !== "}") i++;
      i++;
      return;
    }

    // Style section: plain text until `}`, except `{…}` sub-messages, whose
    // bodies are messages in their own right.
    i++;
    while (i < message.length) {
      const ch = message[i];
      if (ch === "}") {
        i++;
        return;
      }
      if (ch === "{") {
        i++;
        readMessage();
        if (message[i] === "}") i++;
        continue;
      }
      i++;
    }
  };

  readMessage();
  return [...names].sort();
}
