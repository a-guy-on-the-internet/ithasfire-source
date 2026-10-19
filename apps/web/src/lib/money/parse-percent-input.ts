/**
 * Locale-tolerant percent-input parsing for free-text share/percent fields.
 *
 * WHY THIS LIVES NEXT TO THE MONEY PARSER
 * ---------------------------------------
 * Basis points are percent × 100 — the exact same hundredths scaling that
 * makes cents dollars × 100. So the numeric core is literally the same core,
 * and this module is a thin, deliberately boring shell around
 * `parseMoneyInputToCents`: it decides what decoration a PERCENT field may
 * carry, then hands the bare number to the shared reader and re-labels the
 * hundredths it returns as basis points.
 *
 * Reusing it (rather than re-deriving the separator/grouping/ambiguity/
 * rounding/safe-integer rules) is the point: those rules were hardened through
 * two review rounds and 52 tests, and a second copy would drift.
 *
 * WHAT IT EXISTS TO KILL
 * ----------------------
 * `Number("12,5")` is `NaN`. The splits editor converted its percent field
 * with `Number(pctText) * 100` and fell back to `0` on `NaN` — so an `es`
 * organiser typing `12,5` for a payee's share silently wrote **0 bps**, and
 * that payee received NOTHING at settlement. Same locale bug class as the
 * money one, different units, worse blast radius.
 *
 * HOW IT DIFFERS FROM THE MONEY PARSER
 * ------------------------------------
 * 1. `%` is strippable decoration — one leading OR one trailing marker, so
 *    `50%`, `%50` and the fr-style `50 %` all read. A `%` anywhere else
 *    (`5%0`, `50%%`) is a typo, not a marker, and is INVALID.
 * 2. CURRENCY DECORATION IS NOT STRIPPED. `$12` as a percent is nonsense, not
 *    "12 percent" — the money parser's symbol/word allowlist would happily
 *    read it, so this module rejects the whole class up front with a
 *    character allowlist. Letters are rejected for the same reason: there is
 *    no `USD` to forgive in a percent field.
 * 3. RANGE VALIDATION. A share is 0–100 inclusive → 0–10000 bps. Anything
 *    outside that is refused with its own `out_of_range` reason so callers can
 *    say something more useful than "invalid".
 *
 * Everything else — `.`/`,` either way round, space/dot/comma grouping, the
 * `1,500`-is-ambiguous refusal, half-up rounding past two decimals, negatives
 * refused rather than floored, blank reported as `empty` for the caller to
 * interpret — is inherited unchanged from `parseMoneyInputToCents`.
 */

import {
  parseMoneyInputToCents,
  type ParseMoneyInputFailure,
} from "./parse-money-input";

/** Why a percent input could not be converted. */
export type ParsePercentInputFailure =
  | ParseMoneyInputFailure
  /** Read fine, but a share can only be 0–100 percent. */
  | "out_of_range";

export type ParsePercentInputResult =
  | { ok: true; basisPoints: number }
  | { ok: false; reason: ParsePercentInputFailure };

/** 100% — the largest share any single line may take. */
export const MAX_BASIS_POINTS = 10_000;

/**
 * Everything a percent field is allowed to contain: digits, both decimal
 * separators, grouping whitespace (`\s` already covers the NBSP and narrow
 * NBSP `Intl.NumberFormat` emits), signs, and the percent marker.
 *
 * An ALLOWLIST rather than a strip list, so `$12`, `12 USD` and `twelve` are
 * all refused before the shared money reader gets a chance to forgive their
 * currency decoration.
 */
const PERCENT_ALLOWED = /^[0-9.,+\-−%\s]*$/;

const fail = (reason: ParsePercentInputFailure): ParsePercentInputResult => ({
  ok: false,
  reason,
});

/**
 * Parse a free-text percent field into integer basis points.
 *
 * Never coerces unreadable input to a number — callers MUST handle `ok: false`
 * by refusing, never by defaulting to 0 (a 0-bps share pays the payee nothing,
 * which is exactly the silent failure this replaces). `empty` is the one
 * reason whose meaning belongs to the caller.
 *
 * @example
 * parsePercentInputToBasisPoints("12.5")  // { ok: true, basisPoints: 1250 }
 * parsePercentInputToBasisPoints("12,5")  // { ok: true, basisPoints: 1250 }  ← es typing
 * parsePercentInputToBasisPoints("50 %")  // { ok: true, basisPoints: 5000 }
 * parsePercentInputToBasisPoints("101")   // { ok: false, reason: "out_of_range" }
 * parsePercentInputToBasisPoints("$12")   // { ok: false, reason: "invalid" }
 */
export function parsePercentInputToBasisPoints(
  raw: string,
): ParsePercentInputResult {
  if (typeof raw !== "string") return fail("invalid");
  if (!PERCENT_ALLOWED.test(raw)) return fail("invalid");

  // One leading OR one trailing `%`, then nothing else may remain. `50 %`
  // (fr), `%50` (some tr/he keyboards) and `50%` all read; `5%0` does not.
  let body = raw.trim();
  if (body.startsWith("%")) body = body.slice(1);
  else if (body.endsWith("%")) body = body.slice(0, -1);
  if (body.includes("%")) return fail("invalid");

  // The shared core. It returns hundredths of the unit it was given — cents
  // for dollars, basis points for percent.
  const parsed = parseMoneyInputToCents(body);
  if (!parsed.ok) return parsed;

  if (parsed.cents > MAX_BASIS_POINTS) return fail("out_of_range");
  return { ok: true, basisPoints: parsed.cents };
}
