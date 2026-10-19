import { describe, expect, it } from "vitest";

import { AppError } from "@th/errors";
import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { formatErrorMessage } from "../format-error-message";

const GENERIC = "Something went wrong. Please try again or contact support.";

/**
 * Ban that sticks, staff side (owner ruling 2026-10-08). Approving a pending
 * volunteer (`reviewVolunteerSignup`, single and batch) and assigning one to
 * a shift (`assignOccurrenceClaim`) on a withheld owner's event or ask fail
 * with `fail("VOLUNTEER_APPROVALS_PAUSED")`. No custom message, so the wire
 * message IS the code; the batch returns the same code per id.
 */
describe("formatErrorMessage: VOLUNTEER_APPROVALS_PAUSED", () => {
  const thrown = new AppError("VOLUNTEER_APPROVALS_PAUSED");
  // What a tRPC client error looks like by the time a call site catches it.
  const wire = new Error("VOLUNTEER_APPROVALS_PAUSED");

  it("renders the en sentence, not the generic fallback", () => {
    const t = createTranslator("en", enMessages as never).t;
    const expected =
      "New volunteers can't be added right now. Volunteers already approved keep their place, and you can still reject applications.";

    expect(thrown.message).toBe("VOLUNTEER_APPROVALS_PAUSED");
    expect(formatErrorMessage(thrown, t)).toBe(expected);
    expect(formatErrorMessage(wire, t)).toBe(expected);
  });

  it("renders the es sentence", () => {
    const t = createTranslator("es", esMessages as never).t;

    expect(formatErrorMessage(wire, t)).toBe(
      "Ahora no se pueden sumar nuevos voluntarios. Quienes ya fueron aprobados conservan su lugar, y todavía puedes rechazar solicitudes.",
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
