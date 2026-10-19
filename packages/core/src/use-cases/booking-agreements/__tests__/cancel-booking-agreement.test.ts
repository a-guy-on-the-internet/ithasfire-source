import { describe, expect, it, vi } from "vitest";

import type { AgreementStatus } from "@th/types/repos/agreements";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import { cancelBookingAgreement } from "../cancel-booking-agreement";
import { systemEntriesFor } from "../../booking-requests/__tests__/helpers";
import {
  AGREEMENT_ID,
  EVENT_ID,
  LINKED_REQUEST_ID,
  NOW,
  ORGANIZER_ADMIN_ID,
  OUTSIDER_ID,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  VENUE_VIEWER_ID,
  buildAgreementRecord,
  buildLinkedBookingRequest,
  buildOrganizerAgreementRecord,
  buildTransitionDeps,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The terms editor's terminal exit. The act's exit is DECLINE (`respond`,
// PROPOSED only); this one is editor-only and works from any LIVE status.
// ─────────────────────────────────────────────────────────────────────────────

const REASON = "The room is no longer available that night.";

/** Venue admin on the TO_VENUE fixture — the terms editor on a linked agreement. */
const editorInput = {
  actorHumanId: VENUE_ADMIN_ID,
  agreementId: AGREEMENT_ID,
  reason: REASON,
};

const linked = { bookingRequest: buildLinkedBookingRequest("TO_VENUE") };

/** Repos that are NEVER consulted by a cancel — tripwires, not fakes. */
function untouchedRepos() {
  const trip = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "then") return undefined;
          return () => {
            throw new Error(`${name}.${String(prop)} must not be called`);
          };
        },
      },
    );
  return {
    bookingHolds: trip("bookingHolds"),
    payoutTerms: trip("payoutTerms"),
  };
}

function build(
  agreement = buildAgreementRecord({ status: "PROPOSED", proposedAt: NOW }),
  options: Parameters<typeof buildTransitionDeps>[1] = linked,
) {
  const built = buildTransitionDeps(agreement, options);
  // `buildTransitionDeps` wires an in-memory ledger through `withTx`; keep a
  // handle so the entry can be read back, and add the tripwires.
  Object.assign(built.deps.repos, untouchedRepos());
  return built;
}

describe("cancelBookingAgreement", () => {
  describe.each(["DRAFT", "PROPOSED", "ACCEPTED"] as const)(
    "from %s",
    (status) => {
      it("→ CANCELLED via CAS fenced on both status and eventId", async () => {
        const { deps, agreements, audit } = build(
          buildAgreementRecord({
            status,
            proposedAt: status === "DRAFT" ? null : NOW,
            acceptedAt: status === "ACCEPTED" ? NOW : null,
          }),
        );

        const result = await cancelBookingAgreement(deps, editorInput);

        expect(result).toEqual({
          agreementId: AGREEMENT_ID,
          status: "CANCELLED",
          acceptedAt: status === "ACCEPTED" ? NOW : null,
          declinedAt: null,
        });
        expect(agreements.repo.updateStatus).toHaveBeenCalledTimes(1);
        expect(agreements.repo.updateStatus).toHaveBeenCalledWith({
          id: AGREEMENT_ID,
          status: "CANCELLED",
          expectedFrom: ["DRAFT", "PROPOSED", "ACCEPTED"],
          expectEventIdNull: true,
        });
        // The act's fields are not the editor's to write.
        expect(agreements.record()).toMatchObject({
          status: "CANCELLED",
          declinedAt: null,
          declinedReason: null,
        });
        expect(audit.log).toHaveBeenCalledWith(
          expect.objectContaining({
            entity: "booking_agreement",
            entityId: AGREEMENT_ID,
            action: "booking_agreement.cancelled",
            data: expect.objectContaining({
              actorHumanId: VENUE_ADMIN_ID,
              actorSide: "counterparty",
              fromStatus: status,
              reason: REASON,
            }),
            at: NOW,
          }),
        );
      });
    },
  );

  describe.each([
    "DECLINED",
    "CANCELLED",
    "FULFILLED",
    "EXPIRED",
    "DISPUTED",
  ] satisfies AgreementStatus[])("from %s", (status) => {
    it("is refused with AGREEMENT_NOT_CANCELLABLE and writes nothing", async () => {
      const { deps, agreements, audit } = build(
        buildAgreementRecord({ status }),
      );

      await expect(
        cancelBookingAgreement(deps, editorInput),
      ).rejects.toMatchObject({ code: "AGREEMENT_NOT_CANCELLABLE" });

      expect(deps.repos.tx).not.toHaveBeenCalled();
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(agreements.record()?.status).toBe(status);
    });
  });

  it("refuses a finalized agreement with AGREEMENT_FINALIZED — before the status gate", async () => {
    // ACCEPTED would be cancellable; the stamped eventId is what refuses it,
    // and the caller must hear THAT, not a status complaint.
    const { deps, agreements } = build(
      buildAgreementRecord({
        status: "ACCEPTED",
        acceptedAt: NOW,
        eventId: EVENT_ID,
      }),
    );

    await expect(
      cancelBookingAgreement(deps, editorInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(agreements.record()?.status).toBe("ACCEPTED");

    // Same answer on a status that ALSO fails the status gate — finalized
    // wins because it is checked first.
    const terminal = build(
      buildAgreementRecord({ status: "FULFILLED", eventId: EVENT_ID }),
    );
    await expect(
      cancelBookingAgreement(terminal.deps, editorInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_FINALIZED" });
  });

  it("refuses the act side with TERMS_EDITOR_ONLY (its exit is DECLINE)", async () => {
    const { deps, agreements } = build();

    await expect(
      cancelBookingAgreement(deps, {
        ...editorInput,
        actorHumanId: PERFORMER_ID,
      }),
    ).rejects.toMatchObject({ code: "TERMS_EDITOR_ONLY" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(agreements.record()?.status).toBe("PROPOSED");
  });

  it("refuses non-party actors and viewer-role org members", async () => {
    const { deps } = build();

    await expect(
      cancelBookingAgreement(deps, {
        ...editorInput,
        actorHumanId: OUTSIDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    await expect(
      cancelBookingAgreement(deps, {
        ...editorInput,
        actorHumanId: VENUE_VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("refuses an unknown agreement", async () => {
    const { deps } = build(null as never);

    await expect(
      cancelBookingAgreement(deps, editorInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_FOUND" });
  });

  it("works for the organizer org on the mirrored TO_PERFORMER layout", async () => {
    const { deps } = build(
      buildOrganizerAgreementRecord({ status: "ACCEPTED", acceptedAt: NOW }),
      { bookingRequest: buildLinkedBookingRequest("TO_PERFORMER") },
    );

    await expect(
      cancelBookingAgreement(deps, {
        ...editorInput,
        actorHumanId: ORGANIZER_ADMIN_ID,
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });
  });

  // ── Reason: required, sanitized at the boundary ───────────────────────────
  describe("reason", () => {
    it("is required", async () => {
      const { deps, agreements } = build();
      const { reason: _omit, ...withoutReason } = editorInput;

      await expect(
        cancelBookingAgreement(deps, withoutReason),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });

    it("must be at least 3 characters after trimming", async () => {
      const { deps } = build();

      await expect(
        cancelBookingAgreement(deps, { ...editorInput, reason: "  no  " }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("rejects a reason that is nothing but markup — the floor applies to the CLEANED value", async () => {
      const { deps, agreements } = build();

      await expect(
        cancelBookingAgreement(deps, { ...editorInput, reason: "<b></b>" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(agreements.repo.updateStatus).not.toHaveBeenCalled();
    });

    it("strips markup and control characters before it reaches the ledger", async () => {
      const { deps } = build();

      await cancelBookingAgreement(deps, {
        ...editorInput,
        reason:
          "<script>alert(1)</script>Room is‮double-booked that night.",
      });

      const [entry] = systemEntriesFor(deps.repos, LINKED_REQUEST_ID);
      // `<script>` discarded WITH its content; the U+202E bidi override
      // between "is" and "double" dropped as a Cf character.
      expect(entry?.systemData?.reason).toBe(
        "Room isdouble-booked that night.",
      );
    });
  });

  // ── Ledger ────────────────────────────────────────────────────────────────
  describe("ledger", () => {
    it("appends booking_agreement.cancelled on the request's thread, on the editor's side, in the same tx", async () => {
      const { deps, audit } = build();

      await cancelBookingAgreement(deps, editorInput);

      expect(systemEntriesFor(deps.repos, LINKED_REQUEST_ID)).toEqual([
        {
          systemKind: "booking_agreement.cancelled",
          // The editor is the non-act party, which is the thread's VENUE slot
          // in BOTH directions.
          systemData: {
            agreementId: AGREEMENT_ID,
            actorSide: "PLACE",
            reason: REASON,
          },
          authorHumanId: VENUE_ADMIN_ID,
          authorSide: "SYSTEM",
        },
      ]);
      expect(deps.repos.tx).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledTimes(1);
    });

    it("names VENUE for the organizer org on TO_PERFORMER too", async () => {
      const { deps } = build(
        buildOrganizerAgreementRecord({ status: "PROPOSED", proposedAt: NOW }),
        { bookingRequest: buildLinkedBookingRequest("TO_PERFORMER") },
      );

      await cancelBookingAgreement(deps, {
        ...editorInput,
        actorHumanId: ORGANIZER_ADMIN_ID,
      });

      expect(
        systemEntriesFor(deps.repos, LINKED_REQUEST_ID)[0]?.systemData,
      ).toMatchObject({ actorSide: "PLACE" });
    });

    it("writes no ledger row when the agreement has no booking request (never a throw)", async () => {
      // Unlinked ⇒ nobody is the act ⇒ either party may cancel; there is
      // simply no thread to write to.
      const { deps, agreements } = build(
        buildAgreementRecord({ status: "DRAFT" }),
        {},
      );

      await expect(
        cancelBookingAgreement(deps, {
          ...editorInput,
          actorHumanId: PERFORMER_ID,
        }),
      ).resolves.toMatchObject({ status: "CANCELLED" });
      expect(agreements.record()?.status).toBe("CANCELLED");
      expect(systemEntriesFor(deps.repos, LINKED_REQUEST_ID)).toEqual([]);
    });

    it("fails the WHOLE transition when the ledger write fails", async () => {
      const { deps, audit } = build();
      (
        deps.repos as unknown as {
          bookingRequestMessages: ReturnType<
            typeof createFakeBookingRequestMessagesRepo
          >;
        }
      ).bookingRequestMessages.create = vi.fn(async () => {
        throw new Error("ledger write failed");
      });

      await expect(
        cancelBookingAgreement(deps, editorInput),
      ).rejects.toThrow("ledger write failed");
      // Audit sits after the append in the same tx callback.
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  // ── Notify ────────────────────────────────────────────────────────────────
  describe("notify", () => {
    it("pings the OTHER side with the cancelled event key, after commit", async () => {
      const notify = vi.fn(async () => ({}) as never);
      const { deps } = build(undefined, { ...linked, notify });

      await cancelBookingAgreement(deps, editorInput);

      // Venue admin cancels → the proposer (performer human) is the other side.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          humanId: PERFORMER_ID,
          variant: "notification.generic",
          idempotencyKey: `bookingAgreement:${AGREEMENT_ID}:cancelled:${PERFORMER_ID}`,
          payload: expect.objectContaining({
            title: "Agreement cancelled",
            metadata: { agreementId: AGREEMENT_ID },
          }),
        }),
      );
    });

    it("a throwing notify does not fail the cancel, and is REPORTED once", async () => {
      const notifyError = new Error("notify down");
      const notify = vi.fn(async () => {
        throw notifyError;
      });
      const reportError = vi.fn();
      const { deps, agreements } = build(undefined, {
        ...linked,
        notify,
        reportError,
      });

      await expect(
        cancelBookingAgreement(deps, editorInput),
      ).resolves.toMatchObject({ status: "CANCELLED" });
      expect(agreements.record()?.status).toBe("CANCELLED");
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(notifyError, {
        tags: {
          useCase: "booking-agreements.notify-party",
          eventKey: "cancelled",
        },
        extra: { agreementId: AGREEMENT_ID, actorHumanId: VENUE_ADMIN_ID },
      });
    });

    it("a throwing reporter changes nothing", async () => {
      const notify = vi.fn(async () => {
        throw new Error("notify down");
      });
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const { deps, agreements } = build(undefined, {
        ...linked,
        notify,
        reportError,
      });

      await expect(
        cancelBookingAgreement(deps, editorInput),
      ).resolves.toMatchObject({ status: "CANCELLED" });
      expect(agreements.record()?.status).toBe("CANCELLED");
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("nothing is reported when notify succeeds", async () => {
      const reportError = vi.fn();
      const { deps } = build(undefined, {
        ...linked,
        notify: vi.fn(async () => ({}) as never),
        reportError,
      });

      await cancelBookingAgreement(deps, editorInput);
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("surfaces the CAS conflict when a concurrent transition wins", async () => {
    const { deps, audit } = build(undefined, {
      ...linked,
      updateConflict: true,
    });

    await expect(
      cancelBookingAgreement(deps, editorInput),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("leaves draftEventId stamped (the orphaned draft is the organizer's to delete)", async () => {
    const DRAFT_EVENT_ID = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
    const { deps, agreements } = build(
      buildAgreementRecord({
        status: "ACCEPTED",
        acceptedAt: NOW,
        draftEventId: DRAFT_EVENT_ID,
      }),
    );

    await cancelBookingAgreement(deps, editorInput);

    expect(agreements.record()).toMatchObject({
      status: "CANCELLED",
      draftEventId: DRAFT_EVENT_ID,
    });
    expect(agreements.repo.updateStatus).toHaveBeenCalledWith(
      expect.not.objectContaining({ clearDraftEventId: true }),
    );
  });
});
