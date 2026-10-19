import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import {
  EVENT_ID,
  LINE_ID,
  NOW,
  OUTSIDER_ID,
  THIRD_PARTY_HUMAN_ID,
  VENUE_ADMIN_ID,
  VENUE_ORG_ID,
  VENUE_PAYEE_ID,
  VENUE_VIEWER_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildPayeeRecord,
  makeAuditFake,
  makeClock,
  withTx,
} from "../../booking-agreements/__tests__/helpers";
import { confirmPayoutLine, type ConfirmPayoutLineDeps } from "../confirm-payout-line";

// ─────────────────────────────────────────────────────────────────────────────
// Deps builder
// ─────────────────────────────────────────────────────────────────────────────

const COUNTER_NOTE = "Asking for a bigger cut given the longer set.";

const CAS_CONFLICT = {
  code: "conflict",
  message: "payout_line_confirmation_changed",
} as const;

function buildDeps({
  line = buildLineRecord(),
  payee = buildPayeeRecord(),
  agreement = null,
  orgAdminRole = "ADMIN",
  committedStatus,
  isDefault = false,
}: {
  line?: PayoutTermsLineRecord | null;
  payee?: PayeeRecord | null;
  /** What `agreements.getByPayoutTermsId` returns (null = non-agreement terms). */
  agreement?: AgreementRecord | null;
  orgAdminRole?: "OWNER" | "ADMIN" | "VIEWER";
  /**
   * Simulates a concurrent decision committing between this actor's read and
   * write: the CAS evaluates against THIS status instead of the snapshot the
   * use case saw via `getLineById`.
   */
  committedStatus?: PayoutTermsLineRecord["confirmationStatus"];
  /** The line's terms row is a default (a template). */
  isDefault?: boolean;
} = {}) {
  let current = line;

  const payoutTerms = {
    getById: vi.fn(async (id: string) => ({ id, isDefault })),
    getLineById: vi.fn(async () => current),
    updateLineConfirmation: vi.fn(
      async (input: {
        lineId: string;
        expectedFrom: readonly (
          | NonNullable<PayoutTermsLineRecord["confirmationStatus"]>
          | null
        )[];
        confirmationStatus: PayoutTermsLineRecord["confirmationStatus"];
        confirmedAt: Date | null;
        counterPercentBps?: number | null;
        counterNote?: string | null;
      }) => {
        if (!current) throw new Error("line missing");
        // Honor the write-time CAS like the Prisma adapter: the stored
        // status (null included — legacy rows) must be in `expectedFrom`.
        const stored =
          committedStatus !== undefined
            ? committedStatus
            : current.confirmationStatus;
        if (!input.expectedFrom.includes(stored)) {
          throw CAS_CONFLICT;
        }
        current = {
          ...current,
          confirmationStatus: input.confirmationStatus,
          confirmedAt: input.confirmedAt,
          ...(input.counterPercentBps !== undefined
            ? { counterPercentBps: input.counterPercentBps }
            : {}),
          ...(input.counterNote !== undefined
            ? { counterNote: input.counterNote }
            : {}),
        };
        return current;
      },
    ),
  };

  const payees = { getById: vi.fn(async () => payee) };

  const authz = {
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        humanId === VENUE_ADMIN_ID && orgIds.includes(VENUE_ORG_ID)
          ? [{ orgId: VENUE_ORG_ID, humanId, role: orgAdminRole }]
          : humanId === VENUE_VIEWER_ID && orgIds.includes(VENUE_ORG_ID)
            ? [{ orgId: VENUE_ORG_ID, humanId, role: "VIEWER" }]
            : [],
    ),
  };

  const agreements = {
    getByPayoutTermsId: vi.fn(async () => agreement),
  };

  const audit = makeAuditFake();

  const deps = {
    repos: withTx({
      payoutTerms,
      payees,
      authz,
      agreements,
      audit,
    }) as unknown as ConfirmPayoutLineDeps["repos"],
    clock: makeClock(),
  } satisfies ConfirmPayoutLineDeps;

  return { deps, payoutTerms, audit, line: () => current };
}

/** What the client displayed: `buildLineRecord()`'s economics. */
const SHOWN = { percent: 10, floorCents: 0, capPercent: null };

const baseInput = {
  actorHumanId: THIRD_PARTY_HUMAN_ID,
  payoutTermsLineId: LINE_ID,
  answered: SHOWN,
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM (unchanged semantics)
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmPayoutLine — CONFIRM", () => {
  it("stamps CONFIRMED + confirmedAt for the human payee", async () => {
    const { deps, audit, line } = buildDeps();

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "CONFIRM",
    });

    expect(result).toEqual({
      lineId: LINE_ID,
      confirmationStatus: "CONFIRMED",
      confirmedAt: NOW,
    });
    expect(line()?.counterPercentBps).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payout_line_confirmed" }),
    );
  });

  it("accepts the original terms from COUNTERED — and clears the stale ask", async () => {
    const { deps, line } = buildDeps({
      line: buildLineRecord({
        confirmationStatus: "COUNTERED",
        counterPercentBps: 1500,
        counterNote: COUNTER_NOTE,
      }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "CONFIRM",
    });

    expect(result.confirmationStatus).toBe("CONFIRMED");
    expect(line()?.counterPercentBps).toBeNull();
    expect(line()?.counterNote).toBeNull();
  });

  it("rejects CONFIRM on a DECLINED line (decline is terminal per version)", async () => {
    const { deps } = buildDeps({
      line: buildLineRecord({ confirmationStatus: "DECLINED" }),
    });

    await expect(
      confirmPayoutLine(deps, { ...baseInput, decision: "CONFIRM" }),
    ).rejects.toMatchObject({ code: "LINE_DECLINED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COUNTER
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmPayoutLine — COUNTER", () => {
  it("writes COUNTERED with the ask + note, clears confirmedAt, audits", async () => {
    const { deps, payoutTerms, audit, line } = buildDeps({
      line: buildLineRecord({ confirmedAt: NOW }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "COUNTER",
      counterPercentBps: 1250,
      counterNote: COUNTER_NOTE,
    });

    expect(result).toEqual({
      lineId: LINE_ID,
      confirmationStatus: "COUNTERED",
      confirmedAt: null,
    });
    expect(payoutTerms.updateLineConfirmation).toHaveBeenCalledWith({
      lineId: LINE_ID,
      expectedFrom: ["PENDING", "COUNTERED", null],
      confirmationStatus: "COUNTERED",
      confirmedAt: null,
      counterPercentBps: 1250,
      counterNote: COUNTER_NOTE,
    });
    expect(line()?.counterPercentBps).toBe(1250);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payout_line_countered",
        data: expect.objectContaining({
          counterPercentBps: 1250,
          previousStatus: "PENDING",
        }),
      }),
    );
  });

  it("never mutates the line's actual percent (a counter is only an ask)", async () => {
    const { deps, line } = buildDeps();

    await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "COUNTER",
      counterPercentBps: 5000,
      counterNote: COUNTER_NOTE,
    });

    expect(line()?.percent).toBe(10);
  });

  it("lets the payee re-counter their own COUNTERED line to update the ask", async () => {
    const { deps, line } = buildDeps({
      line: buildLineRecord({
        confirmationStatus: "COUNTERED",
        counterPercentBps: 1500,
        counterNote: COUNTER_NOTE,
      }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "COUNTER",
      counterPercentBps: 1200,
      counterNote: "Meeting you halfway on the split for this one.",
    });

    expect(result.confirmationStatus).toBe("COUNTERED");
    expect(line()?.counterPercentBps).toBe(1200);
  });

  it("rejects COUNTER without a note (and without bps) as invalid_input", async () => {
    const { deps, payoutTerms } = buildDeps();

    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        decision: "COUNTER",
        counterPercentBps: 1250,
      }),
    ).rejects.toMatchObject({ code: "COUNTER_FIELDS_REQUIRED" });
    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        decision: "COUNTER",
        counterNote: COUNTER_NOTE,
      }),
    ).rejects.toMatchObject({ code: "COUNTER_FIELDS_REQUIRED" });
    expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
  });

  it("rejects a too-short note via schema validation", async () => {
    const { deps } = buildDeps();

    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        decision: "COUNTER",
        counterPercentBps: 1250,
        counterNote: "too short",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects COUNTER on a CONFIRMED line (edit economics to reset instead)", async () => {
    const { deps } = buildDeps({
      line: buildLineRecord({
        confirmationStatus: "CONFIRMED",
        confirmedAt: NOW,
      }),
    });

    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        decision: "COUNTER",
        counterPercentBps: 1250,
        counterNote: COUNTER_NOTE,
      }),
    ).rejects.toMatchObject({ code: "LINE_NOT_COUNTERABLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DECLINE
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmPayoutLine — DECLINE", () => {
  it("writes DECLINED from PENDING with cleared counter fields", async () => {
    const { deps, audit } = buildDeps();

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "DECLINE",
    });

    expect(result).toEqual({
      lineId: LINE_ID,
      confirmationStatus: "DECLINED",
      confirmedAt: null,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payout_line_declined" }),
    );
  });

  it("declines from COUNTERED, superseding the open ask", async () => {
    const { deps, line } = buildDeps({
      line: buildLineRecord({
        confirmationStatus: "COUNTERED",
        counterPercentBps: 1500,
        counterNote: COUNTER_NOTE,
      }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "DECLINE",
    });

    expect(result.confirmationStatus).toBe("DECLINED");
    expect(line()?.counterPercentBps).toBeNull();
    expect(line()?.counterNote).toBeNull();
  });

  it("rejects DECLINE on CONFIRMED and on already-DECLINED lines", async () => {
    const confirmed = buildDeps({
      line: buildLineRecord({
        confirmationStatus: "CONFIRMED",
        confirmedAt: NOW,
      }),
    });
    await expect(
      confirmPayoutLine(confirmed.deps, { ...baseInput, decision: "DECLINE" }),
    ).rejects.toMatchObject({ code: "LINE_NOT_DECLINABLE" });

    const declined = buildDeps({
      line: buildLineRecord({ confirmationStatus: "DECLINED" }),
    });
    await expect(
      confirmPayoutLine(declined.deps, { ...baseInput, decision: "DECLINE" }),
    ).rejects.toMatchObject({ code: "LINE_NOT_DECLINABLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-finalize fence
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmPayoutLine — post-finalize fence", () => {
  const finalized = buildAgreementRecord({
    status: "ACCEPTED",
    eventId: EVENT_ID,
  });

  it.each(["CONFIRM", "COUNTER", "DECLINE"] as const)(
    "rejects %s once the owning agreement is finalized",
    async (decision) => {
      const { deps, payoutTerms } = buildDeps({ agreement: finalized });

      await expect(
        confirmPayoutLine(deps, {
          ...baseInput,
          decision,
          ...(decision === "COUNTER"
            ? { counterPercentBps: 1250, counterNote: COUNTER_NOTE }
            : {}),
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });
      expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
    },
  );

  it("allows decisions while the owning agreement is unfinalized", async () => {
    const { deps } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED", eventId: null }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "CONFIRM",
    });

    expect(result.confirmationStatus).toBe("CONFIRMED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write-time CAS (race losers conflict instead of overwriting committed state)
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmPayoutLine — write-time CAS", () => {
  it("rejects a stale COUNTER after a concurrent CONFIRM committed", async () => {
    // Actor B read the line as PENDING; actor A's CONFIRM (and possibly a
    // finalize) committed in between. B's COUNTER must lose at write time.
    const { deps, line } = buildDeps({ committedStatus: "CONFIRMED" });

    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        decision: "COUNTER",
        counterPercentBps: 1250,
        counterNote: COUNTER_NOTE,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "payout_line_confirmation_changed",
    });
    // The committed state was not overwritten.
    expect(line()?.confirmationStatus).toBe("PENDING");
    expect(line()?.counterPercentBps).toBeNull();
  });

  it("rejects a stale CONFIRM after a concurrent DECLINE committed", async () => {
    const { deps, line } = buildDeps({ committedStatus: "DECLINED" });

    await expect(
      confirmPayoutLine(deps, { ...baseInput, decision: "CONFIRM" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "payout_line_confirmation_changed",
    });
    expect(line()?.confirmedAt).toBeNull();
  });

  it("rejects a stale DECLINE after a concurrent CONFIRM committed", async () => {
    const { deps } = buildDeps({ committedStatus: "CONFIRMED" });

    await expect(
      confirmPayoutLine(deps, { ...baseInput, decision: "DECLINE" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "payout_line_confirmation_changed",
    });
  });

  it.each([
    ["CONFIRM", ["PENDING", "COUNTERED", "CONFIRMED", null]],
    ["COUNTER", ["PENDING", "COUNTERED", null]],
    ["DECLINE", ["PENDING", "COUNTERED", null]],
  ] as const)(
    "passes the %s guard expectedFrom = %j",
    async (decision, expectedFrom) => {
      const { deps, payoutTerms } = buildDeps();

      await confirmPayoutLine(deps, {
        ...baseInput,
        decision,
        ...(decision === "COUNTER"
          ? { counterPercentBps: 1250, counterNote: COUNTER_NOTE }
          : {}),
      });

      expect(payoutTerms.updateLineConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({ expectedFrom }),
      );
    },
  );

  it("still confirms a legacy line with a null status (null in the guard)", async () => {
    const { deps, line } = buildDeps({
      line: buildLineRecord({ confirmationStatus: null }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      decision: "CONFIRM",
    });

    expect(result.confirmationStatus).toBe("CONFIRMED");
    expect(line()?.confirmationStatus).toBe("CONFIRMED");
    expect(line()?.confirmedAt).toEqual(NOW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AuthZ + guards (unchanged from the CONFIRM-only version)
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmPayoutLine — authz and guards", () => {
  it("rejects a non-payee human for every decision", async () => {
    for (const decision of ["CONFIRM", "COUNTER", "DECLINE"] as const) {
      const { deps } = buildDeps();
      await expect(
        confirmPayoutLine(deps, {
          ...baseInput,
          actorHumanId: OUTSIDER_ID,
          decision,
          ...(decision === "COUNTER"
            ? { counterPercentBps: 1250, counterNote: COUNTER_NOTE }
            : {}),
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }
  });

  it("allows an org OWNER/ADMIN to counter an org payee's line", async () => {
    const { deps } = buildDeps({
      line: buildLineRecord({ payeeId: VENUE_PAYEE_ID }),
      payee: buildPayeeRecord({
        id: VENUE_PAYEE_ID,
        subjectType: "ORGANIZATION",
        subjectId: VENUE_ORG_ID,
      }),
    });

    const result = await confirmPayoutLine(deps, {
      ...baseInput,
      actorHumanId: VENUE_ADMIN_ID,
      decision: "COUNTER",
      counterPercentBps: 2000,
      counterNote: COUNTER_NOTE,
    });

    expect(result.confirmationStatus).toBe("COUNTERED");
  });

  it("rejects org members below ADMIN for org payee lines", async () => {
    const { deps } = buildDeps({
      line: buildLineRecord({ payeeId: VENUE_PAYEE_ID }),
      payee: buildPayeeRecord({
        id: VENUE_PAYEE_ID,
        subjectType: "ORGANIZATION",
        subjectId: VENUE_ORG_ID,
      }),
    });

    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        actorHumanId: VENUE_VIEWER_ID,
        decision: "DECLINE",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects decisions on lines that don't require confirmation", async () => {
    const { deps } = buildDeps({
      line: buildLineRecord({
        requiresConfirmation: false,
        confirmationStatus: null,
      }),
    });

    await expect(
      confirmPayoutLine(deps, { ...baseInput, decision: "DECLINE" }),
    ).rejects.toMatchObject({ code: "LINE_DOES_NOT_REQUIRE_CONFIRMATION" });
  });

  it("404s on a missing line", async () => {
    const { deps } = buildDeps({ line: null });

    await expect(
      confirmPayoutLine(deps, { ...baseInput, decision: "CONFIRM" }),
    ).rejects.toMatchObject({ code: "PAYOUT_LINE_NOT_FOUND" });
  });
});

// ── P4b (deal terms) ── review B1, round 2 ──────────────────────────────────

describe("confirmPayoutLine — under the terms row lock", () => {
  it("takes the lock first, then refuses a CONFIRM if the line's percent moved since the payee saw it", async () => {
    const { deps, payoutTerms, line } = buildDeps();
    // `withTx`'s default terms-row lock (granted).
    const { lockTerms } = (deps.repos as unknown as { deals: { lockTerms: ReturnType<typeof vi.fn> } }).deals;
    // A deal write commits between the pre-transaction read and the lock:
    // same line, new percent, reset to PENDING.
    let reads = 0;
    payoutTerms.getLineById.mockImplementation(async () => {
      reads += 1;
      const l = line()!;
      return reads === 1 ? l : { ...l, percent: l.percent + 5 };
    });
    await expect(confirmPayoutLine(deps, { ...baseInput, decision: "CONFIRM" })).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "answered_terms_changed" },
    });
    expect(lockTerms).toHaveBeenCalledTimes(1);
    expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
  });

  it("refuses a CONFIRM if the line now names a different payee", async () => {
    const { deps, payoutTerms, line } = buildDeps();
    let reads = 0;
    payoutTerms.getLineById.mockImplementation(async () => {
      reads += 1;
      const l = line()!;
      return reads === 1 ? l : { ...l, payeeId: VENUE_PAYEE_ID };
    });
    await expect(confirmPayoutLine(deps, { ...baseInput, decision: "CONFIRM" })).rejects.toMatchObject({
      code: "conflict",
      message: "payout_line_confirmation_changed",
    });
    expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
  });
});

// ── A1b: a default is a template; answer what you saw ───────────────────────

describe("confirmPayoutLine — a default terms row is never answered", () => {
  it.each(["CONFIRM", "COUNTER", "DECLINE"] as const)(
    "refuses %s on a default row, writing nothing",
    async (decision) => {
      const { deps, payoutTerms, audit, line } = buildDeps({ isDefault: true });
      await expect(
        confirmPayoutLine(deps, {
          ...baseInput,
          decision,
          ...(decision === "COUNTER"
            ? { counterPercentBps: 1250, counterNote: COUNTER_NOTE }
            : {}),
        }),
      ).rejects.toMatchObject({
        code: "AGREEMENT_NOT_EDITABLE",
        meta: { reason: "default_terms_are_a_template" },
      });
      expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(line()?.confirmationStatus).toBe("PENDING");
    },
  );

  it("an event's own (non-default) terms confirm as before", async () => {
    const { deps, line } = buildDeps({ isDefault: false });
    await expect(
      confirmPayoutLine(deps, { ...baseInput, decision: "CONFIRM" }),
    ).resolves.toMatchObject({ confirmationStatus: "CONFIRMED" });
    expect(line()?.confirmationStatus).toBe("CONFIRMED");
  });
});

describe("confirmPayoutLine — the answer is to the terms the client displayed", () => {
  it("matching economics (percent, floor, cap) confirm", async () => {
    const { deps, line } = buildDeps({
      line: buildLineRecord({ percent: 25, floorCents: 500, capPercent: 40 }),
    });
    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        answered: { percent: 25, floorCents: 500, capPercent: 40 },
        decision: "CONFIRM",
      }),
    ).resolves.toMatchObject({ confirmationStatus: "CONFIRMED" });
    expect(line()?.confirmationStatus).toBe("CONFIRMED");
  });

  it.each([
    ["percent", { ...SHOWN, percent: 11 }],
    ["floorCents", { ...SHOWN, floorCents: 100 }],
    ["capPercent", { ...SHOWN, capPercent: 50 }],
  ])("a different %s conflicts for every decision, writing nothing", async (_field, answered) => {
    for (const decision of ["CONFIRM", "COUNTER", "DECLINE"] as const) {
      const { deps, payoutTerms, audit, line } = buildDeps();
      await expect(
        confirmPayoutLine(deps, {
          ...baseInput,
          answered,
          decision,
          ...(decision === "COUNTER"
            ? { counterPercentBps: 1250, counterNote: COUNTER_NOTE }
            : {}),
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        meta: { reason: "answered_terms_changed" },
      });
      expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(line()?.confirmationStatus).toBe("PENDING");
    }
  });

  it("stale view: shown 30%, the organiser re-saves the same line at 5% (PENDING), the payee clicks Confirm → conflict", async () => {
    // The payee rendered the line at 30%. Before they click, an edit keeps the
    // line id, moves it to 5% and resets it to PENDING. The use case's own
    // read sees 5% — so the old self-comparison would have let this through.
    const { deps, payoutTerms, audit, line } = buildDeps({
      line: buildLineRecord({ percent: 5, confirmationStatus: "PENDING" }),
    });
    await expect(
      confirmPayoutLine(deps, {
        ...baseInput,
        answered: { ...SHOWN, percent: 30 },
        decision: "CONFIRM",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      meta: { reason: "answered_terms_changed" },
    });
    expect(payoutTerms.updateLineConfirmation).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(line()).toMatchObject({ percent: 5, confirmationStatus: "PENDING", confirmedAt: null });
  });

  it("requires the displayed economics", async () => {
    const { deps } = buildDeps();
    const { answered: _omit, ...withoutAnswered } = baseInput;
    await expect(
      confirmPayoutLine(deps, { ...withoutAnswered, decision: "CONFIRM" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
