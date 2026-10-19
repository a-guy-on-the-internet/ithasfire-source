import { describe, expect, it } from "vitest";

import { INTERNAL_CODES, USER_FACING_CODES, toKey } from "@th/errors";
import { icuArgumentNames } from "@th/locale";

import enMessages from "../messages/en";
import esMessages from "../messages/es";

/**
 * Drift guard for the error contract (FR-007). The {@link AppErrorCode} union is
 * TIERED:
 *   - {@link USER_FACING_CODES} — every code MUST resolve, via {@link toKey}, to a
 *     present, non-empty `errors.*` copy key in BOTH en and es. Otherwise
 *     `normalizeError(err, t)` silently degrades to a humanized SCREAMING_SNAKE
 *     string for that code.
 *   - {@link INTERNAL_CODES} — infra/dependency/invariant failures that must NEVER
 *     show user copy. Their key must be ABSENT from the catalog so a generic safe
 *     fallback is used and no internal detail can leak.
 *
 * The catalogs live only in apps/web, so this parity test lives here
 * (packages/errors can't depend on an app) and imports the tier subsets from
 * `@th/errors`.
 *
 * If you add a USER_FACING code, add its `errors.<camelCaseKey>` entry to both
 * en.ts and es.ts. If a code is internal-only, put it in INTERNAL_CODES (not the
 * catalog).
 */
const LOCALES = [
  { name: "en", errors: enMessages.errors as Record<string, string> },
  { name: "es", errors: esMessages.errors as Record<string, string> },
] as const;

describe("error-code → i18n catalog parity", () => {
  for (const { name, errors } of LOCALES) {
    describe(`${name} catalog`, () => {
      it.each(USER_FACING_CODES.map((code) => [code, toKey(code)] as const))(
        "user-facing %s resolves to errors.%s",
        (_code, key) => {
          expect(errors).toHaveProperty(key);
          expect(typeof errors[key]).toBe("string");
          expect(errors[key].length).toBeGreaterThan(0);
        },
      );

      it.each(INTERNAL_CODES.map((code) => [code, toKey(code)] as const))(
        "internal %s is ABSENT from the catalog (errors.%s)",
        (_code, key) => {
          expect(errors).not.toHaveProperty(key);
        },
      );
    });
  }

  it("en and es expose the same errors.* keys (no one-sided drift)", () => {
    const enKeys = Object.keys(enMessages.errors).sort();
    const esKeys = Object.keys(esMessages.errors).sort();
    expect(esKeys).toEqual(enKeys);
  });
});

/**
 * Interpolation guard — the reason this catalog gets a NO-ARGUMENTS rule
 * rather than the en-vs-es argument-parity rule the other gates use.
 *
 * Error copy is resolved by `resolveCode` (packages/errors/src/normalize-error.ts),
 * whose translator is typed `t?: (key: string) => string` — a ONE-argument
 * function. There is no seam through which a value could ever be passed, and
 * every `normalizeError(err, t)` call site in the app conforms to that shape.
 *
 * `createTranslator`'s `t` then hands the message to `IntlMessageFormat` with
 * `values = {}`, and IntlMessageFormat THROWS on an unsupplied argument:
 *
 *   Error: The intl string context variable "eventName" was not provided to
 *   the string "Could not find {eventName}."
 *
 * So a single interpolated `errors.*` string does not degrade to a literal
 * `{eventName}` on screen — it throws from inside the error-rendering path,
 * i.e. the handler for the original failure blows up. Both catalogs are
 * argument-free today (493 keys each); this keeps them that way.
 *
 * A plain en-vs-es parity assert would be VACUOUS here ([] vs []) and would
 * still pass if someone added `{name}` to BOTH locales — which is exactly the
 * defect. Asserting the empty set is the assertion with teeth.
 *
 * If error copy ever legitimately needs interpolation, this test is the place
 * that says so: widen `resolveCode`'s translator to accept values first, then
 * relax this to the shared en-vs-es `icuArgumentNames` comparison.
 */
describe("error copy is argument-free (it is rendered with no values)", () => {
  for (const { name, errors } of LOCALES) {
    it(`${name}: no errors.* message references an ICU argument`, () => {
      const offenders = Object.entries(errors)
        .map(([key, value]) => [key, icuArgumentNames(value)] as const)
        .filter(([, args]) => args.length > 0)
        .map(([key, args]) => `${key}: {${args.join("}, {")}}`);
      expect(offenders).toEqual([]);
    });
  }
});

/**
 * Quality guard. The parity tests above prove a copy key EXISTS and is non-empty;
 * they do not prove it SAYS anything. The catalog was bootstrapped by a templater
 * that collapsed ~64% of codes onto a handful of catch-all phrases ("No se pudo
 * completar la acción solicitada." etc.) — present, but useless to the user. After
 * the 2026-06 copy rewrite, this guard stops the rot from creeping back: a new
 * code that resolves to a catch-all fails CI by name.
 *
 * To make it pass, write real copy that names the thing + action. If a generic
 * line is genuinely correct (internal type-guard, redirect signal), add the key to
 * GENERIC_OK — a deliberate, reviewer-visible decision, not a silent default.
 */
const CATCH_ALL_PHRASES = new Set([
  // es
  "No se pudo completar la acción solicitada.",
  "Esto no se puede realizar en su estado actual.",
  "No es válido. Compruébalo e inténtalo de nuevo.",
  "Esto ya existe o ya se ha realizado.",
  "Falta información obligatoria. Complétala e inténtalo de nuevo.",
  // en
  "This can't be done in its current state.",
  "That isn't valid. Please check it and try again.",
  "Something required is missing. Please complete it and try again.",
  "That item already exists or has already been done.",
]);

/**
 * Codes where a generic line is genuinely correct — internal type-guards, payload
 * validation, and redirect/control signals that should never surface specific copy.
 * Adding a key here is an intentional opt-out; keep it small.
 */
const GENERIC_OK = new Set([
  "eventSlugContextMissing",
  "eventSlugRedirect",
  "formMismatch",
  "humanMismatch",
  "invalidArgument",
  "invalidNotificationPayload",
  "unknownNotificationCategory",
  "unknownNotificationVariant",
  "unknownOwnerScope",
  "unknownOwnerType",
  "unsupportedSubjectType",
]);

describe("error copy says something specific (no catch-all regression)", () => {
  for (const { name, errors } of LOCALES) {
    it(`${name}: no code outside the allow-list resolves to a catch-all phrase`, () => {
      const offenders = Object.entries(errors)
        .filter(
          ([key, value]) =>
            CATCH_ALL_PHRASES.has(value) && !GENERIC_OK.has(key),
        )
        .map(([key]) => key);
      expect(offenders).toEqual([]);
    });
  }

  it("the GENERIC_OK allow-list has no stale entries", () => {
    const allKeys = new Set(Object.keys(enMessages.errors));
    const stale = [...GENERIC_OK].filter((key) => !allKeys.has(key));
    expect(stale).toEqual([]);
  });
});
