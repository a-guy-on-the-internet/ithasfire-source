import { describe, expect, it } from "vitest";

import { AppError } from "@th/errors";
import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { formatErrorMessage } from "../format-error-message";

/**
 * `updatePlaceVerificationStatus` refuses a staff Verify/Reject whose place
 * changed status since it was read with `fail("CONFLICT", { meta })`. No
 * custom message (the detail rides in `meta.reason`), so the wire message IS
 * the code and the toast shows the conflict copy, not "Something went wrong".
 * A custom message such as "place_verification_changed" has no
 * `errors.*` key and fell through to the generic fallback.
 */
describe("formatErrorMessage: CONFLICT from a stale verification flip", () => {
  const thrown = new AppError("CONFLICT", {
    meta: { reason: "place_verification_changed" },
  });
  // What a tRPC client error looks like by the time a call site catches it.
  const wire = new Error("CONFLICT");

  it("renders the en conflict sentence", () => {
    const t = createTranslator("en", enMessages as never).t;
    const expected =
      "This action conflicts with the current state. Please refresh and try again.";

    expect(thrown.message).toBe("CONFLICT");
    expect(formatErrorMessage(thrown, t)).toBe(expected);
    expect(formatErrorMessage(wire, t)).toBe(expected);
  });

  it("renders the es conflict sentence", () => {
    const t = createTranslator("es", esMessages as never).t;

    expect(formatErrorMessage(wire, t)).toBe(
      "Esta acción entra en conflicto con el estado actual. Actualiza la página e inténtalo de nuevo.",
    );
  });
});
