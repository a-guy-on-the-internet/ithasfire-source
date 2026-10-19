import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_ERROR_CODES, AppError, toKey } from "@th/errors";
import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";

import {
  __resetWarnedCodes,
  formatErrorMessage,
  ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE,
  ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE,
} from "../format-error-message";

const GENERIC = "Something went wrong. Please try again or contact support.";

/**
 * A fake translator with next-intl's miss semantics: a missing key resolves to
 * the key itself, which is exactly how `formatErrorMessage` detects a miss.
 */
function fakeT(catalog: Record<string, string>) {
  const asked: string[] = [];
  const t = (key: string) => {
    asked.push(key);
    return catalog[key] ?? key;
  };
  return { t, asked };
}

beforeEach(() => {
  // The warn dedupe is module-scoped state that `vi.restoreAllMocks()` cannot
  // touch. Without this, the drift guard below (which pushes all ~508 codes
  // through an empty catalog) poisons the Set for every later test, and the
  // dedupe assertions would only pass by accident of using invented code names.
  __resetWarnedCodes();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatErrorMessage — i18n key normalisation", () => {
  it("resolves a canonical SCREAMING_SNAKE code to its translated string", () => {
    // `AppError.message` IS the code (`super(opts.message ?? code)`) and the
    // tRPC boundary passes it through verbatim, so this is the live shape.
    const { t, asked } = fakeT({
      "errors.eventNotTicketed":
        "This is a free RSVP event — it doesn't sell tickets.",
    });

    expect(formatErrorMessage(new Error("EVENT_NOT_TICKETED"), t)).toBe(
      "This is a free RSVP event — it doesn't sell tickets.",
    );
    expect(asked).toEqual(["errors.eventNotTicketed"]);
  });

  it("still resolves a legacy lowercase snake_case code (regression)", () => {
    const { t, asked } = fakeT({
      "errors.invalidImageType":
        "Unsupported image format. Use JPEG, PNG, GIF, or WebP.",
    });

    expect(formatErrorMessage(new Error("invalid_image_type"), t)).toBe(
      "Unsupported image format. Use JPEG, PNG, GIF, or WebP.",
    );
    expect(asked).toEqual(["errors.invalidImageType"]);
  });

  it("resolves the venue-owned withdraw refusal (`venue_owned_event`) to its catalog copy", () => {
    const { t, asked } = fakeT({
      "errors.venueOwnedEvent": "This is your own event, so there's no confirmation to withdraw.",
    });
    expect(formatErrorMessage(new Error("venue_owned_event"), t)).toBe(
      "This is your own event, so there's no confirmation to withdraw.",
    );
    expect(asked).toEqual(["errors.venueOwnedEvent"]);
  });

  it("folds digits into the preceding segment rather than leaving an underscore", () => {
    // The old `_([a-z])` class never matched `_5`, so "HTTP_500" produced the
    // un-camelised "http_500". Digits are in the class now, matching `toKey`.
    const { t, asked } = fakeT({ "errors.http500": "Server error." });

    expect(formatErrorMessage(new Error("HTTP_500"), t)).toBe("Server error.");
    expect(asked).toEqual(["errors.http500"]);

    const lower = fakeT({ "errors.http500": "Server error." });
    expect(formatErrorMessage(new Error("http_500"), lower.t)).toBe(
      "Server error.",
    );
    expect(lower.asked).toEqual(["errors.http500"]);
  });

  it("agrees with @th/errors `toKey` for every canonical code (drift guard)", () => {
    // The catalog keys were generated from `toKey` and `error-code-parity.test.ts`
    // gates them against it. If this funnel's normaliser drifts, every code it
    // disagrees on silently degrades to the generic fallback again.
    // The empty fake catalog means every code also trips the unmapped-code
    // warning; silence it so the drift guard doesn't drown the reporter.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mismatches: string[] = [];

    for (const code of APP_ERROR_CODES) {
      const { t, asked } = fakeT({});
      formatErrorMessage(new Error(code), t);
      const expected = `errors.${toKey(code)}`;
      if (asked[0] !== expected) {
        mismatches.push(`${code}: got ${asked[0]}, want ${expected}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});

describe("formatErrorMessage — unmapped codes", () => {
  it("falls back to the generic message AND warns for an unmapped SCREAMING code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t } = fakeT({});

    expect(formatErrorMessage(new Error("EVENT_NOT_TICKETED"), t)).toBe(
      GENERIC,
    );
    // A real code deliberately, to prove the dedupe reset works: before
    // `__resetWarnedCodes()` this assertion passed only because the code name
    // was invented and therefore hadn't been poisoned by the drift guard.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("no copy for error code");
    expect(warn.mock.calls[0]![0]).toContain("EVENT_NOT_TICKETED");
    // Points at the catalog, because the catalog WAS consulted and missed.
    expect(warn.mock.calls[0]![0]).toContain("errors.eventNotTicketed");
  });

  it("warns for an unmapped lowercase code too (regression)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t } = fakeT({});

    expect(formatErrorMessage(new Error("totally_made_up_lower"), t)).toBe(
      GENERIC,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("totally_made_up_lower");
  });

  it("blames the CALL SITE, not the catalog, when no translator was supplied", () => {
    // The warn sits after the `if (t)` block, so it also fires when the lookup
    // never happened. Diagnosing that as "unmapped error code" sent devs hunting
    // for a catalog entry that already exists — `errors.eventNotTicketed` is
    // present and good. The two states must read differently.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(formatErrorMessage(new Error("EVENT_NOT_TICKETED"))).toBe(GENERIC);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain("EVENT_NOT_TICKETED");
    expect(msg).toContain("passed no `t`");
    expect(msg).not.toContain("no copy for error code");
  });

  it("warns only once per distinct code so a retrying mutation can't flood", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t } = fakeT({});

    formatErrorMessage(new Error("REPEATED_UNMAPPED_CODE"), t);
    formatErrorMessage(new Error("REPEATED_UNMAPPED_CODE"), t);
    formatErrorMessage(new Error("REPEATED_UNMAPPED_CODE"), t);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not let the no-translator nudge suppress a later genuine miss", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { t } = fakeT({});

    formatErrorMessage(new Error("SOME_UNKNOWN_CODE"));
    formatErrorMessage(new Error("SOME_UNKNOWN_CODE"), t);

    // Different diagnoses, different fixes — both must be reported once each.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain("passed no `t`");
    expect(warn.mock.calls[1]![0]).toContain("no copy for error code");
  });

  it("does not warn for tokens that aren't code-shaped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Mixed-case single word: not a code, and it has no space so it never hits
    // the human-sentence branch either.
    expect(formatErrorMessage(new Error("Failure"))).toBe(GENERIC);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("formatErrorMessage — earlier branches are unaffected", () => {
  it("passes a real human-readable sentence through untouched", () => {
    const sentence = "The end date must be after the start date.";
    const { t, asked } = fakeT({});

    expect(formatErrorMessage(new Error(sentence), t)).toBe(sentence);
    // Returned before the i18n lookup, so the translator is never consulted.
    expect(asked).toEqual([]);
    expect(formatErrorMessage(new Error(sentence))).toBe(sentence);
  });

  it("summarises leaked Zod / tRPC validation JSON", () => {
    const raw = JSON.stringify([
      {
        code: "too_small",
        path: ["title"],
        message: "String must contain at least 1 character(s)",
      },
      { code: "invalid_type", path: ["startsAt"], message: "Required" },
    ]);

    expect(formatErrorMessage(new Error(raw))).toBe(
      "Please fix the following: title: String must contain at least 1 character(s); startsAt: Required.",
    );
  });

  it("falls through to normal handling when a `[`-prefixed message isn't valid JSON", () => {
    const { t } = fakeT({ "errors.eventNotFound": "Event not found." });
    expect(formatErrorMessage(new Error("[not json"), t)).toBe(GENERIC);
  });

  it("returns the neutral message for an empty error", () => {
    expect(formatErrorMessage(new Error(""))).toBe(
      "Something went wrong. Please try again.",
    );
    expect(formatErrorMessage(null)).toBe(
      "Something went wrong. Please try again.",
    );
  });
});

describe("formatErrorMessage — no translator supplied", () => {
  it("still serves the hardcoded dictionary for a lowercase code", () => {
    expect(formatErrorMessage(new Error("event_not_found"))).toBe(
      "Event not found.",
    );
    expect(formatErrorMessage(new Error("seat_unavailable"))).toBe(
      "One or more selected seats are no longer available.",
    );
  });

  it("serves the dictionary's non-code key verbatim", () => {
    // "endsAt must be after startsAt" starts lowercase, so it skips the
    // human-sentence branch and must still hit the dictionary by raw key.
    expect(formatErrorMessage(new Error("endsAt must be after startsAt"))).toBe(
      "The end date must be after the start date.",
    );
  });

  it("keeps the dictionary lookup CASE-SENSITIVE so INTERNAL codes can't leak copy", () => {
    // DELIBERATE. `SETTLEMENT_RELOAD_FAILED` is an INTERNAL_CODE — i18n-exempt,
    // and `error-code-parity.test.ts` asserts it is ABSENT from en/es precisely
    // so no internal detail reaches a user. A stale lowercase twin still sits in
    // ERROR_MESSAGES, so "helpfully" making the dict lookup case-insensitive
    // (`ERROR_MESSAGES[raw.toLowerCase()]`) would resurrect that copy and defeat
    // the tier split. It must stay keyed by `raw`.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatErrorMessage(new Error("settlement_reload_failed"))).toBe(
      "Settlement could not be verified. Please try again.",
    );
    expect(formatErrorMessage(new Error("SETTLEMENT_RELOAD_FAILED"))).toBe(
      GENERIC,
    );
  });

  it("documents the KNOWN GAP: a screaming code with no translator gets the generic message", () => {
    // Not a bug to fix here — the fix is threading `t` at the call site (which
    // is why the warning above names the call site). Pinned so the gap is
    // visible rather than rediscovered.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatErrorMessage(new Error("EVENT_NOT_FOUND"))).toBe(GENERIC);
    // ...whereas the same code WITH a translator resolves.
    const { t } = fakeT({ "errors.eventNotFound": "Event not found." });
    expect(formatErrorMessage(new Error("EVENT_NOT_FOUND"), t)).toBe(
      "Event not found.",
    );
  });

  it("prefers the translated string over the hardcoded dictionary", () => {
    const { t } = fakeT({ "errors.eventNotFound": "Evento no encontrado." });
    expect(formatErrorMessage(new Error("event_not_found"), t)).toBe(
      "Evento no encontrado.",
    );
  });

  it("falls back to the hardcoded dictionary when the catalog misses", () => {
    const { t } = fakeT({});
    expect(formatErrorMessage(new Error("event_not_found"), t)).toBe(
      "Event not found.",
    );
  });
});

describe("formatErrorMessage — ORDER_DISPUTED_REFUND_BLOCKED (INTERNAL tier, explained on purpose)", () => {
  // The code is INTERNAL only until its catalog entries land, so the sentence
  // has to come from the dictionary — keyed SCREAMING because the tRPC
  // boundary passes the AppError message (=== code) through verbatim.
  it("serves the dispute sentence with no translator (admin panel path)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatErrorMessage(new Error("ORDER_DISPUTED_REFUND_BLOCKED"))).toBe(
      ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("serves the dispute sentence when the catalog misses (buyer page path)", () => {
    const { t, asked } = fakeT({});
    expect(
      formatErrorMessage(new Error("ORDER_DISPUTED_REFUND_BLOCKED"), t),
    ).toBe(ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE);
    expect(asked).toEqual(["errors.orderDisputedRefundBlocked"]);
  });

  it("keeps a separate, permanent sentence for a LOST dispute", () => {
    expect(ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE).toBe(
      "This charge was lost to a chargeback. The cardholder already has the money back, so no refund is possible.",
    );
    expect(ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE).not.toContain(
      "Once the dispute closes",
    );
  });

  it("reads as plain second-person copy, not an identifier", () => {
    expect(ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE).toBe(
      "This order is under dispute with the buyer's card issuer, so it can't be refunded right now. Once the dispute closes you can refund it if anything is still owed.",
    );
  });
});

/**
 * The other blocks above drive a FAKE catalog, which proves the lookup rule but
 * not that the rule pays off against the copy we actually ship. This one wires
 * the real `AppError`, the real en catalog and the real translator end to end,
 * so it fails if any link in that chain moves: the code stops being the message,
 * the transport stops passing the message through, or the catalog entry is
 * renamed away.
 */
describe("formatErrorMessage — a real thrown AppError against the real en catalog", () => {
  it("needs `t` to say anything useful about CANNOT_DEMOTE_LAST_OWNER", () => {
    // `throw fail("CANNOT_DEMOTE_LAST_OWNER")` in
    // packages/core/src/use-cases/orgs/update-member-role.ts builds this, and
    // `AppError` does `super(opts.message ?? code)` — so message IS the code.
    const thrown = new AppError("CANNOT_DEMOTE_LAST_OWNER");
    expect(thrown.message).toBe("CANNOT_DEMOTE_LAST_OWNER");

    const t = createTranslator("en", enMessages as never).t;

    // Without a translator the SCREAMING code misses the case-sensitive legacy
    // dictionary — which is the whole reason admin call sites had to thread `t`.
    expect(formatErrorMessage(thrown)).toBe(GENERIC);

    // With one, `errors.cannotDemoteLastOwner` answers.
    expect(formatErrorMessage(thrown, t)).toBe(
      "You can't change this role because an organization must always have at least one owner.",
    );

    // The dictionary does hold copy for this code — under the lowercase key
    // no server has thrown since the AppError migration.
    expect(formatErrorMessage("cannot_demote_last_owner")).toBe(
      "Cannot remove the last owner of the group.",
    );
  });
});

describe("formatErrorMessage: Object.prototype member names", () => {
  // A plain-object lookup returns a FUNCTION for these. Every caller must get
  // the generic fallback STRING instead.
  const PROTO_KEYS = ["constructor", "toString", "__proto__", "hasOwnProperty"];

  it.each(PROTO_KEYS)("returns the generic string for %s without t", (key) => {
    const out = formatErrorMessage(new Error(key));
    expect(typeof out).toBe("string");
    expect(out).toBe(GENERIC);
  });

  it.each(PROTO_KEYS)("returns the generic string for %s with t", (key) => {
    const { t } = fakeT({});
    const out = formatErrorMessage(new Error(key), t);
    expect(typeof out).toBe("string");
    expect(out).toBe(GENERIC);
  });
});
