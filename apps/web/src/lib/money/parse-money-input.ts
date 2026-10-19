/**
 * Locale-tolerant money-input parsing for free-text dollar fields.
 *
 * WHY THIS EXISTS
 * ---------------
 * Admin money fields are free-text `TextInput`s that hold a DOLLAR STRING and
 * convert on submit. The old converter was `Math.round(parseFloat(x) * 100)`.
 * `parseFloat` is en-US-only: it stops at the first character it doesn't
 * understand and returns what it has so far. In the `es` locale — where the UI
 * itself renders money as `15,50 US$` — an organiser who types `15,50` got
 * `parseFloat("15,50") === 15`, i.e. a ticket saved at $15.00 instead of
 * $15.50. No error, no warning: silent money loss on every sale.
 *
 * This module is the single, pure, exhaustively-tested converter. It never
 * guesses: anything it cannot read with certainty is REFUSED so the caller can
 * stop the submit and tell the organiser, rather than banking a wrong number.
 *
 * DECISION RULES
 * --------------
 * 1. Currency decoration is dropped: symbols (`$`, `€`, but NOT the subunit
 *    marker `¢`) and a leading/trailing run from an ALLOWLIST of currency
 *    words (`US$`, `USD`). Any other letters — `15abc`, `nonsense` — are
 *    INVALID. Leading/trailing whitespace goes too.
 * 2. INTERNAL WHITESPACE is a grouping separator, not noise. fr/es/ru write
 *    `1 234,56`, so the space-separated integer runs must group properly
 *    (`^\d{1,3}( \d{3})+$`) or the whole input is INVALID; whitespace never
 *    appears in a fraction. This check is why `15 50` is refused rather than
 *    squeezed into `1550` — someone typing $15.50 on a phone keyboard would
 *    otherwise be billed $1550.00. A space can be a separator or a typo and
 *    nothing in the string says which, so we refuse instead of guessing.
 * 3. A leading or trailing `-` / `−` (U+2212) yields `negative`. Money fields
 *    here are never negative, and coercing a negative to 0 would be the same
 *    silent-loss bug in a different coat.
 * 4. Separator disambiguation, on the `.` / `,` that remain:
 *    - BOTH present → whichever occurs LAST is the decimal separator; the
 *      other is grouping and is stripped. (`1,234.56` → 123456 cents;
 *      `1.234,56` → 123456 cents.) The decimal separator must occur exactly
 *      once, or it's INVALID.
 *    - ONE kind, appearing MORE THAN ONCE → it can only be grouping
 *      (`1.234.567`). There is no decimal part.
 *    - ONE kind, appearing ONCE → decimal if the run after it is anything
 *      other than exactly 3 digits (`15,50`, `15.5`, `9,8765`), because
 *      grouping runs are always exactly 3. If it IS exactly 3 digits
 *      (`1,500` / `1.500`) the input is genuinely AMBIGUOUS — $1500 to an
 *      en typist, $1.50 to an es typist — and is refused with `ambiguous`
 *      rather than resolved by a coin flip. Exceptions: a `0` integer part
 *      (`0,500`) and an over-long first group (`1234,567`) can't be grouping,
 *      so those read as decimals.
 * 5. Grouping runs are validated (`1,23,456` → INVALID, per rule 4's promise
 *    not to guess).
 * 6. More than 2 decimal places ROUND (half-up) to cents rather than being
 *    refused — `12.3456` → 1235 cents.
 *
 *    Careful with 3-decimal examples: a lone separator with exactly 3 digits
 *    after it is the AMBIGUOUS case from rule 4, so `12.345` is REFUSED, not
 *    rounded. Three decimals only round when the shape rules grouping out —
 *    a `0` integer part (`0.005` → 1 cent) or an over-long first group
 *    (`1234,567` → 123457 cents). If you are here to "fix" that, read rule 4
 *    first: resolving the ambiguity is the bug, not the behaviour.
 * 7. Anything whose cents value is not a safe integer is INVALID, so a pasted
 *    20-digit number can never land as a silently-truncated float.
 * 8. Blank input is `empty`, NOT `0`. Each call site decides what blank means:
 *    a blank price is a free ticket; a blank "resale cap" is "no cap". Making
 *    that the caller's decision is the whole reason `empty` is its own reason
 *    code.
 *
 * Rounding is done in integer arithmetic on the digit string, not via
 * `value * 100`, so `1.0050` → 101 cents (exact half-up) rather than the 100
 * that float error produces for `Math.round(1.005 * 100)`. Same intent as the
 * old code, without the float artefact.
 */

/** Why an input could not be converted. See the module docs for each rule. */
export type ParseMoneyInputFailure =
  /** Nothing was entered (blank, whitespace, or a bare currency symbol). */
  | "empty"
  /** Unreadable: letters, stray punctuation, bad grouping, out of range. */
  | "invalid"
  /** Readable two ways (`1,500`) — refused rather than guessed. */
  | "ambiguous"
  /** A negative amount, which no money field here accepts. */
  | "negative";

export type ParseMoneyInputResult =
  | { ok: true; cents: number }
  | { ok: false; reason: ParseMoneyInputFailure };

/**
 * Symbols `Intl` (and organisers pasting from anywhere) may put on an amount.
 *
 * `¢` is deliberately ABSENT. Every symbol here is a whole-unit prefix, so
 * dropping it leaves the digits meaning what they said. `¢` is a SUBUNIT
 * marker: stripping it would read "15¢" as $15.00, a 100x overcharge of
 * exactly the kind this module exists to refuse. It falls through to the
 * numeric-body check and comes back `invalid` instead.
 */
const CURRENCY_SYMBOLS = /[$€£¥₹₩₪₫₴₽]/g;

/** All whitespace, plus the NBSP/narrow-NBSP `Intl.NumberFormat` emits. */
const WHITESPACE = /[\s\u00A0\u202F\u2009]/g;

/**
 * Letter runs we're willing to strip off either end of an amount. Deliberately
 * an ALLOWLIST, not "any short run": `15abc` must stay invalid, and a currency
 * parser is not what this module is. Covers the qualified symbol prefixes
 * `Intl` emits (`US$`, `MX$`, `A$`) and the ISO codes an organiser might paste.
 */
const CURRENCY_WORDS = new Set([
  "A",
  "R",
  "AU",
  "BR",
  "CA",
  "HK",
  "MX",
  "NZ",
  "SG",
  "US",
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "INR",
  "JPY",
  "KRW",
  "MXN",
  "NOK",
  "NZD",
  "PLN",
  "SEK",
  "SGD",
  "USD",
  "ZAR",
]);

/**
 * A space-grouped integer: `1 234`, `15 000`, `1 234 567`. fr/es/ru render
 * money this way, so whitespace BETWEEN DIGITS is a real grouping separator and
 * gets the same structural check `.`/`,` groups get. See rule 2 in the module
 * header for why skipping this check was a 100x bug.
 */
const SPACE_GROUPED = /^[0-9]{1,3}( [0-9]{3})+$/;

/** After cleanup, an amount may only be digits and separators. */
const NUMERIC_BODY = /^[0-9.,]+$/;

const fail = (reason: ParseMoneyInputFailure): ParseMoneyInputResult => ({
  ok: false,
  reason,
});

/**
 * Parse a free-text money field into integer cents.
 *
 * Accepts both `.` and `,` as the decimal separator so en and es typing both
 * work, and both grouping conventions so pasted formatted amounts work. Never
 * coerces unreadable input to a number — callers MUST handle `ok: false` by
 * refusing the submit (except `empty`, whose meaning is theirs to define).
 *
 * @example
 * parseMoneyInputToCents("15.50")    // { ok: true, cents: 1550 }
 * parseMoneyInputToCents("15,50")    // { ok: true, cents: 1550 }  ← es typing
 * parseMoneyInputToCents("1.234,56") // { ok: true, cents: 123456 }
 * parseMoneyInputToCents("1,500")    // { ok: false, reason: "ambiguous" }
 * parseMoneyInputToCents("nonsense") // { ok: false, reason: "invalid" }
 */
export function parseMoneyInputToCents(raw: string): ParseMoneyInputResult {
  if (typeof raw !== "string") return fail("invalid");

  // 1. Normalise every flavour of space to a plain one and drop currency
  //    symbols. Whitespace is NOT stripped here — between digits it is a
  //    grouping separator that has to be structurally checked (step 4).
  let s = collapse(raw.replace(WHITESPACE, " ").replace(CURRENCY_SYMBOLS, " "));
  if (s === "") return fail("empty");

  // 2. Sign. A negative is refused outright, never floored to 0.
  let negative = false;
  while (s.startsWith("-") || s.startsWith("−") || s.startsWith("+")) {
    if (!s.startsWith("+")) negative = true;
    s = collapse(s.slice(1));
  }
  while (s.endsWith("-") || s.endsWith("−") || s.endsWith("+")) {
    if (!s.endsWith("+")) negative = true;
    s = collapse(s.slice(0, -1));
  }
  if (s === "") return fail("invalid"); // a bare sign is not an amount

  // 3. Strip a recognised currency word off either end (`US$ 15` → `US 15` →
  //    `15`, `15 USD` → `15`). Anything else made of letters is not a currency
  //    marker, so it stays put and trips the numeric-body check below.
  const leading = /^[A-Za-z]+/.exec(s)?.[0] ?? "";
  if (leading !== "" && CURRENCY_WORDS.has(leading.toUpperCase())) {
    s = collapse(s.slice(leading.length));
  }
  const trailing = /[A-Za-z]+$/.exec(s)?.[0] ?? "";
  if (trailing !== "" && CURRENCY_WORDS.has(trailing.toUpperCase())) {
    s = collapse(s.slice(0, s.length - trailing.length));
  }
  if (s === "") return fail("invalid"); // it was currency markers all the way down

  // 4. Whatever whitespace is LEFT is internal, i.e. between digits, i.e. a
  //    thousands separator — the fr/es/ru `1 234,56` form. Check its structure
  //    exactly as hard as `.`/`,` grouping is checked before removing it.
  //
  //    Skipping this check is a 100x bug, not a cosmetic one: "15 50" (an
  //    organiser reaching for the space bar on a phone keyboard) would strip to
  //    "1550" and bank $1550.00 for a $15.50 ticket. Refusing is the only safe
  //    answer — a space can be a group separator or a typo and nothing in the
  //    string says which.
  if (s.includes(" ")) {
    const firstSeparator = s.search(/[.,]/);
    const head = firstSeparator === -1 ? s : s.slice(0, firstSeparator);
    const tail = firstSeparator === -1 ? "" : s.slice(firstSeparator);
    // Whitespace never appears in a fraction, and the integer part must be
    // grouped the way every locale that uses spaces actually groups.
    if (tail.includes(" ") || !SPACE_GROUPED.test(head)) return fail("invalid");
    s = s.split(" ").join("");
  }

  if (!NUMERIC_BODY.test(s)) return fail("invalid");
  if (negative) return fail("negative");

  // 5. Decide which separator (if either) is the decimal point.
  const dots = countOf(s, ".");
  const commas = countOf(s, ",");

  let integerText: string;
  let fractionText: string;

  if (dots > 0 && commas > 0) {
    // Last one wins as the decimal separator; the other is grouping.
    const decimalChar = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const groupChar = decimalChar === "." ? "," : ".";
    if (countOf(s, decimalChar) !== 1) return fail("invalid");
    const at = s.lastIndexOf(decimalChar);
    integerText = s.slice(0, at);
    fractionText = s.slice(at + 1);
    if (!isValidGrouping(integerText, groupChar)) return fail("invalid");
    integerText = integerText.split(groupChar).join("");
  } else if (dots === 0 && commas === 0) {
    integerText = s;
    fractionText = "";
  } else {
    const sepChar = dots > 0 ? "." : ",";
    const count = dots > 0 ? dots : commas;
    const at = s.lastIndexOf(sepChar);
    const before = s.slice(0, at);
    const after = s.slice(at + 1);

    if (count > 1) {
      // Repeated → can only be grouping; there is no decimal part.
      if (!isValidGrouping(s, sepChar)) return fail("invalid");
      integerText = s.split(sepChar).join("");
      fractionText = "";
    } else if (
      after.length === 3 &&
      before !== "0" &&
      isValidGrouping(s, sepChar)
    ) {
      // `1,500` reads as 1500 (en grouping) or 1.5 (es decimal). Refuse.
      // `1234,567` can't be grouping (a first group is at most 3 digits), so
      // it falls through to the decimal branch instead of being refused.
      return fail("ambiguous");
    } else {
      // Any other run length can't be a group, so it's the decimal part.
      integerText = before;
      fractionText = after;
    }
  }

  if (!/^[0-9]*$/.test(integerText) || !/^[0-9]*$/.test(fractionText)) {
    return fail("invalid");
  }
  if (integerText === "" && fractionText === "") return fail("invalid");

  // 6. Integer-only arithmetic → no float artefacts, half-up on the 3rd decimal.
  const wholeCents = Number(integerText === "" ? "0" : integerText) * 100;
  if (!Number.isSafeInteger(wholeCents)) return fail("invalid");

  const firstTwo = fractionText.slice(0, 2).padEnd(2, "0");
  const roundsHalfUp = (fractionText[2] ?? "0") >= "5";
  const cents = wholeCents + Number(firstTwo) + (roundsHalfUp ? 1 : 0);

  if (!Number.isSafeInteger(cents)) return fail("invalid");
  return { ok: true, cents };
}

/**
 * Trim, and squeeze runs of spaces down to one.
 *
 * Run after every strip step so removing a symbol/sign/currency word can't
 * manufacture whitespace that then looks internal: `US$ 15.50` must end up
 * `15.50`, not ` 15.50` (which step 4 would read as a broken space group).
 */
function collapse(s: string): string {
  return s.replace(/ {2,}/g, " ").trim();
}

function countOf(s: string, char: string): number {
  let n = 0;
  for (const c of s) if (c === char) n += 1;
  return n;
}

/**
 * A grouped integer is `ddd?` then any number of exactly-3-digit runs:
 * `1,234,567` yes; `1,23,456` and `1234,567` no.
 */
function isValidGrouping(text: string, groupChar: string): boolean {
  const parts = text.split(groupChar);
  if (parts.length === 1) return /^[0-9]+$/.test(text);
  const [first, ...rest] = parts;
  if (!first || !/^[0-9]{1,3}$/.test(first)) return false;
  return rest.every((part) => /^[0-9]{3}$/.test(part));
}
