import { describe, expect, it } from "vitest";

import {
  SAVED_SNIPPET_BODY_MAX,
  SAVED_SNIPPET_LABEL_MAX,
  SAVED_SNIPPETS_MAX_PER_KIND,
} from "@th/types/repos/saved-snippets";

import {
  sanitizePlainText,
  sanitizePlainTextMultiline,
} from "../../../lib/sanitize-plain-text";
import { BOOKING_ACT_DECLINE_REASON_MAX_LENGTH } from "../../booking-requests/answer-booking-request-act";
import {
  DEFAULT_STARTER_LOCALE,
  STARTER_DECLINE_REASONS,
  STARTER_LOCALES,
  STARTER_REASON_KEYS,
  starterSnippetsFor,
  toStarterLocale,
} from "../_shared/starter-reasons";

describe("platform starter reasons", () => {
  it("every locale has every key (en/es parity) and no extras", () => {
    for (const locale of STARTER_LOCALES) {
      expect(Object.keys(STARTER_DECLINE_REASONS[locale]).sort()).toEqual(
        [...STARTER_REASON_KEYS].sort(),
      );
    }
    expect(STARTER_REASON_KEYS.length).toBeGreaterThanOrEqual(5);
    expect(STARTER_REASON_KEYS.length).toBeLessThanOrEqual(6);
  });

  it("every starter fits the columns AND an act's pass (240), so the picker offers it on every field", () => {
    expect(BOOKING_ACT_DECLINE_REASON_MAX_LENGTH).toBe(240);
    for (const locale of STARTER_LOCALES) {
      for (const key of STARTER_REASON_KEYS) {
        const { label, body } = STARTER_DECLINE_REASONS[locale][key];
        const where = `${locale}.${key}`;
        expect(label.length, where).toBeGreaterThan(0);
        expect(label.length, where).toBeLessThanOrEqual(SAVED_SNIPPET_LABEL_MAX);
        expect(body.length, where).toBeGreaterThan(0);
        expect(body.length, where).toBeLessThanOrEqual(SAVED_SNIPPET_BODY_MAX);
        expect(body.length, where).toBeLessThanOrEqual(BOOKING_ACT_DECLINE_REASON_MAX_LENGTH);
      }
    }
  });

  it("every starter is already plain text (the sanitizers leave it unchanged)", () => {
    for (const locale of STARTER_LOCALES) {
      for (const key of STARTER_REASON_KEYS) {
        const { label, body } = STARTER_DECLINE_REASONS[locale][key];
        expect(sanitizePlainText(label), `${locale}.${key}.label`).toBe(label);
        expect(sanitizePlainTextMultiline(body), `${locale}.${key}.body`).toBe(body);
      }
    }
  });

  it("labels are distinct within a locale, and the copy avoids 'venue' (CONTEXT.md: Place)", () => {
    for (const locale of STARTER_LOCALES) {
      const labels = STARTER_REASON_KEYS.map((k) => STARTER_DECLINE_REASONS[locale][k].label);
      expect(new Set(labels).size).toBe(labels.length);
    }
    for (const key of STARTER_REASON_KEYS) {
      const { label, body } = STARTER_DECLINE_REASONS.en[key];
      expect(`${label} ${body}`.toLowerCase()).not.toContain("venue");
    }
  });

  it("starterSnippetsFor returns the copy order for DECLINE_REASON and nothing for ASK", () => {
    expect(starterSnippetsFor("DECLINE_REASON", "es").map((s) => s.label)).toEqual(
      STARTER_REASON_KEYS.map((k) => STARTER_DECLINE_REASONS.es[k].label),
    );
    expect(starterSnippetsFor("ASK", "en")).toEqual([]);
    expect(STARTER_REASON_KEYS.length).toBeLessThan(SAVED_SNIPPETS_MAX_PER_KIND);
  });

  it("toStarterLocale matches the language subtag and returns null for anything else", () => {
    expect(DEFAULT_STARTER_LOCALE).toBe("en");
    expect(toStarterLocale("es")).toBe("es");
    expect(toStarterLocale("es-MX")).toBe("es");
    expect(toStarterLocale("ES_es")).toBe("es");
    expect(toStarterLocale(" en-GB ")).toBe("en");
    expect(toStarterLocale("fr")).toBeNull();
    expect(toStarterLocale("")).toBeNull();
    expect(toStarterLocale(null)).toBeNull();
    expect(toStarterLocale(undefined)).toBeNull();
  });
});
