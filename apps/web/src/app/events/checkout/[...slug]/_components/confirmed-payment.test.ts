import { describe, expect, it } from "vitest";

import { stepperPayment } from "./confirmed-payment";

/**
 * Step 4 reads "Confirmed" only for a known-paid order (owner, 2026-10-14),
 * in every state of the confirmation, not just once the order is "ready".
 */
describe("stepperPayment — step 4 for every state of the confirmation", () => {
  it("ready: the order's own payment", () => {
    for (const payment of ["paid", "processing", "unknown"] as const) {
      expect(
        stepperPayment(
          { status: "ready", payment },
          { restoring: false, sessionPayment: "unknown" },
        ),
      ).toBe(payment);
    }
  });

  it("regression: a reload of a confirmation, still loading → 'checking' (neither Confirmed nor Not confirmed)", () => {
    expect(
      stepperPayment(
        { status: "loading" },
        { restoring: true, sessionPayment: "unknown" },
      ),
    ).toBe("checking");
  });

  it("regression: restore-unavailable (getMyOrder failing) → 'unknown', never paid", () => {
    expect(
      stepperPayment(
        { status: "restore-unavailable" },
        { restoring: true, sessionPayment: "unknown" },
      ),
    ).toBe("unknown");
  });

  it("regression: in session, 'unavailable' after a confirm that answered processing → 'processing', not Confirmed", () => {
    expect(
      stepperPayment(
        { status: "unavailable" },
        { restoring: false, sessionPayment: "processing" },
      ),
    ).toBe("processing");
  });

  it.each(["paid", "processing", "unknown"] as const)(
    "in session, loading or unavailable: what the confirm said (%s)",
    (sessionPayment) => {
      for (const status of ["loading", "unavailable"] as const) {
        expect(
          stepperPayment({ status }, { restoring: false, sessionPayment }),
        ).toBe(sessionPayment);
      }
    },
  );
});
