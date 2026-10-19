import { describe, expect, it } from "vitest";

import { AppError } from "@th/errors";
import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { formatErrorMessage } from "../format-error-message";

const GENERIC = "Something went wrong. Please try again or contact support.";

/**
 * Ban that sticks (owner ruling 2026-10-07: "Refuse, but tell them why").
 * `claimOccurrence` refuses a NEW shift claim on a withheld owner's ask with
 * `fail("SHIFT_SIGNUPS_PAUSED")`. No custom message, so the wire message IS
 * the code, which is what the tRPC client error carries into the catch.
 */
describe("formatErrorMessage: SHIFT_SIGNUPS_PAUSED", () => {
  const thrown = new AppError("SHIFT_SIGNUPS_PAUSED");
  // What a tRPC client error looks like by the time a call site catches it.
  const wire = new Error("SHIFT_SIGNUPS_PAUSED");

  it("renders the en sentence, not the generic fallback", () => {
    const t = createTranslator("en", enMessages as never).t;
    const expected =
      "The organiser can't take new volunteers right now. Shifts you already claimed still stand.";

    expect(thrown.message).toBe("SHIFT_SIGNUPS_PAUSED");
    expect(formatErrorMessage(thrown, t)).toBe(expected);
    expect(formatErrorMessage(wire, t)).toBe(expected);
  });

  it("renders the es sentence", () => {
    const t = createTranslator("es", esMessages as never).t;

    expect(formatErrorMessage(wire, t)).toBe(
      "El organizador no puede aceptar nuevos voluntarios por ahora. Los turnos que ya tomaste siguen en pie.",
    );
  });

  it("says nothing about a ban or moderation in either locale", () => {
    for (const [locale, messages] of [
      ["en", enMessages],
      ["es", esMessages],
    ] as const) {
      const t = createTranslator(locale, messages as never).t;
      expect(formatErrorMessage(wire, t)).not.toMatch(
        /\bban|suspend|moderat|prohib|bloque/i,
      );
    }
  });

  it("a call site that forgets `t` falls back to the generic copy (thread the translator)", () => {
    expect(formatErrorMessage(wire)).toBe(GENERIC);
  });
});
