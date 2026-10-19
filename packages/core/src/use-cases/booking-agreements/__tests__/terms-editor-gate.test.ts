import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { cancelBookingAgreement } from "../cancel-booking-agreement";
import { pullBackBookingAgreement } from "../pull-back-booking-agreement";
import { removeBookingAgreementLine } from "../remove-booking-agreement-line";
import { reopenBookingAgreement } from "../reopen-booking-agreement";
import { respondToBookingAgreement } from "../respond-to-booking-agreement";
import { sendBookingAgreementForReview } from "../send-booking-agreement-for-review";
import { withdrawBookingRequest } from "../../booking-requests/withdraw-booking-request";
import type { WithdrawBookingRequestDeps } from "../../booking-requests/withdraw-booking-request";
import { buildBookingRequestRecord } from "../../booking-requests/__tests__/helpers";
import { updateBookingAgreementHeader } from "../update-booking-agreement-header";
import { upsertBookingAgreementLine } from "../upsert-booking-agreement-line";
import type { BookingAgreementLineDeps } from "../upsert-booking-agreement-line";
import type { UpdateBookingAgreementHeaderDeps } from "../update-booking-agreement-header";
import {
  resolveAgreementTermsSide,
  termsSideForRequest,
} from "../_shared/agreement-editor-side";
import {
  AGREEMENT_ID,
  LINE_ID,
  NOW,
  ORGANIZER_ADMIN_ID,
  PERFORMER_ID,
  THIRD_PARTY_HUMAN_ID,
  THIRD_PARTY_PAYEE_ID,
  VENUE_ADMIN_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildLinkedBookingRequest,
  buildOrganizerAgreementRecord,
  buildPayeeRecord,
  buildTransitionDeps,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
  makeBookingRequestsFake,
  makeClock,
  withTx,
  type LinkedRequestOption,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// "Terms should only be editable by the venue/organizer side of the request."
//
// One matrix, six mutations. Three shapes of agreement:
//   - UNLINKED (no booking request) — nobody is the act; either party edits,
//     exactly as before the decision.
//   - TO_VENUE — the performer (PROPOSER) is the act; the venue org edits.
//   - TO_PERFORMER — the performer is now the COUNTERPARTY, and still the act;
//     the organizer org (PROPOSER) edits. Same rule, mirrored layout — which is
//     why the resolver keys off the request's owner pair, not proposer/
//     counterparty.
// ─────────────────────────────────────────────────────────────────────────────

const TERMS_EDITOR_ONLY = { code: "TERMS_EDITOR_ONLY" } as const;

function buildHeaderDeps(
  agreement: AgreementRecord,
  options: LinkedRequestOption = {},
) {
  const agreements = makeAgreementsRepoFake(agreement);
  return {
    repos: withTx({
      agreements: agreements.repo,
      authz: makeAuthzFake(),
      audit: makeAuditFake(),
      bookingRequests: makeBookingRequestsFake(options),
    }) as unknown as UpdateBookingAgreementHeaderDeps["repos"],
    clock: makeClock(),
  } satisfies UpdateBookingAgreementHeaderDeps;
}

function buildLineDeps(
  agreement: AgreementRecord,
  options: LinkedRequestOption = {},
) {
  const agreements = makeAgreementsRepoFake(agreement);
  let lines: PayoutTermsLineRecord[] = [
    buildLineRecord({ id: LINE_ID, payeeId: THIRD_PARTY_PAYEE_ID }),
  ];
  const deps = {
    repos: withTx({
      agreements: agreements.repo,
      authz: makeAuthzFake(),
      audit: makeAuditFake(),
      bookingRequests: makeBookingRequestsFake(options),
      payoutTerms: {
        listLines: vi.fn(async () => lines),
        replaceLines: vi.fn(async (_id: string, inputs: unknown[]) => {
          lines = inputs as PayoutTermsLineRecord[];
        }),
      },
      payees: {
        upsertForSubject: vi.fn(async () =>
          buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID }),
        ),
      },
      humans: {
        getByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id }))),
      },
      organizations: { getById: vi.fn(async () => null) },
    }) as unknown as BookingAgreementLineDeps["repos"],
    clock: makeClock(),
  } satisfies BookingAgreementLineDeps;
  return { deps, replaceLines: () => lines };
}

const upsertInput = (actorHumanId: string) => ({
  actorHumanId,
  agreementId: AGREEMENT_ID,
  lineId: LINE_ID,
  payeeRef: { kind: "human" as const, id: THIRD_PARTY_HUMAN_ID },
  percent: 15,
});

type Shape = {
  name: string;
  agreement: (overrides?: Partial<AgreementRecord>) => AgreementRecord;
  linked: LinkedRequestOption;
  editorId: string;
};

const SHAPES: Shape[] = [
  {
    name: "TO_VENUE (performer is the proposer)",
    agreement: buildAgreementRecord,
    linked: { bookingRequest: buildLinkedBookingRequest("TO_VENUE") },
    editorId: VENUE_ADMIN_ID,
  },
  {
    name: "TO_PERFORMER (performer is the counterparty)",
    agreement: buildOrganizerAgreementRecord,
    linked: { bookingRequest: buildLinkedBookingRequest("TO_PERFORMER") },
    editorId: ORGANIZER_ADMIN_ID,
  },
];

describe.each(SHAPES)("terms-editor gate — $name", ({
  agreement,
  linked,
  editorId,
}) => {
  it("updateHeader: editor allowed, act refused", async () => {
    await expect(
      updateBookingAgreementHeader(buildHeaderDeps(agreement(), linked), {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
        title: "Friday headline slot",
      }),
    ).resolves.toMatchObject({ title: "Friday headline slot" });

    const actDeps = buildHeaderDeps(agreement(), linked);
    await expect(
      updateBookingAgreementHeader(actDeps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        title: "Act rewrites the deal",
      }),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    // Refused BEFORE the transaction — nothing written, nothing audited.
    expect(actDeps.repos.tx).not.toHaveBeenCalled();
  });

  it("upsertLine: editor allowed, act refused", async () => {
    const editor = buildLineDeps(agreement(), linked);
    await expect(
      upsertBookingAgreementLine(editor.deps, upsertInput(editorId)),
    ).resolves.toMatchObject({ percent: 15 });

    const act = buildLineDeps(agreement(), linked);
    await expect(
      upsertBookingAgreementLine(act.deps, upsertInput(PERFORMER_ID)),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    expect(act.replaceLines()[0]?.percent).toBe(10);
  });

  it("removeLine: editor allowed, act refused", async () => {
    const editor = buildLineDeps(agreement(), linked);
    await expect(
      removeBookingAgreementLine(editor.deps, {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
        lineId: LINE_ID,
      }),
    ).resolves.toMatchObject({ removed: true });

    const act = buildLineDeps(agreement(), linked);
    await expect(
      removeBookingAgreementLine(act.deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        lineId: LINE_ID,
      }),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    expect(act.replaceLines()).toHaveLength(1);
  });

  it("sendForReview: editor allowed, act refused", async () => {
    const editor = buildTransitionDeps(agreement(), linked);
    await expect(
      sendBookingAgreementForReview(editor.deps, {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
      }),
    ).resolves.toMatchObject({ status: "PROPOSED" });

    const act = buildTransitionDeps(agreement(), linked);
    await expect(
      sendBookingAgreementForReview(act.deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    expect(act.agreements.record()?.status).toBe("DRAFT");
  });

  it("pullBack: editor allowed, act refused", async () => {
    const proposed = () => agreement({ status: "PROPOSED", proposedAt: NOW });

    const editor = buildTransitionDeps(proposed(), linked);
    await expect(
      pullBackBookingAgreement(editor.deps, {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
      }),
    ).resolves.toMatchObject({ status: "DRAFT" });

    const act = buildTransitionDeps(proposed(), linked);
    await expect(
      pullBackBookingAgreement(act.deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    expect(act.agreements.record()?.status).toBe("PROPOSED");
  });

  it("respond: the INVERSE — act allowed, editor refused (no self-accept)", async () => {
    const proposed = () => agreement({ status: "PROPOSED", proposedAt: NOW });

    const act = buildTransitionDeps(proposed(), linked);
    await expect(
      respondToBookingAgreement(act.deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        action: "accept",
      }),
    ).resolves.toMatchObject({ status: "ACCEPTED" });

    const editor = buildTransitionDeps(proposed(), linked);
    await expect(
      respondToBookingAgreement(editor.deps, {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
        action: "accept",
      }),
    ).rejects.toMatchObject({ code: "ACT_RESPONSE_ONLY" });
    expect(editor.agreements.record()?.status).toBe("PROPOSED");
  });

  it("cancel: editor allowed, act refused (the act's exit is DECLINE)", async () => {
    const proposed = () => agreement({ status: "PROPOSED", proposedAt: NOW });

    const editor = buildTransitionDeps(proposed(), linked);
    await expect(
      cancelBookingAgreement(editor.deps, {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
        reason: "The room is no longer available that night.",
      }),
    ).resolves.toMatchObject({ status: "CANCELLED" });

    const act = buildTransitionDeps(proposed(), linked);
    await expect(
      cancelBookingAgreement(act.deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
        reason: "We would rather not play this one.",
      }),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    expect(act.agreements.record()?.status).toBe("PROPOSED");
    expect(act.agreements.repo.updateStatus).not.toHaveBeenCalled();
  });

  it("reopen: editor allowed, act refused", async () => {
    const accepted = () => agreement({ status: "ACCEPTED", acceptedAt: NOW });

    const editor = buildTransitionDeps(accepted(), linked);
    await expect(
      reopenBookingAgreement(editor.deps, {
        actorHumanId: editorId,
        agreementId: AGREEMENT_ID,
      }),
    ).resolves.toMatchObject({ status: "DRAFT" });

    const act = buildTransitionDeps(accepted(), linked);
    await expect(
      reopenBookingAgreement(act.deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).rejects.toMatchObject(TERMS_EDITOR_ONLY);
    expect(act.agreements.record()?.status).toBe("ACCEPTED");
  });
});

describe("terms-editor gate — UNLINKED agreement keeps the either-party rule", () => {
  // `bookingRequest` omitted ⇒ findByAgreementId → null. The same human that
  // is the act on a linked agreement is just "a party" here.
  it("the performer-side human may still do everything", async () => {
    const performer = { actorHumanId: PERFORMER_ID, agreementId: AGREEMENT_ID };

    await expect(
      updateBookingAgreementHeader(buildHeaderDeps(buildAgreementRecord()), {
        ...performer,
        title: "Still collaborative",
      }),
    ).resolves.toMatchObject({ title: "Still collaborative" });

    await expect(
      upsertBookingAgreementLine(
        buildLineDeps(buildAgreementRecord()).deps,
        upsertInput(PERFORMER_ID),
      ),
    ).resolves.toMatchObject({ percent: 15 });

    await expect(
      removeBookingAgreementLine(buildLineDeps(buildAgreementRecord()).deps, {
        ...performer,
        lineId: LINE_ID,
      }),
    ).resolves.toMatchObject({ removed: true });

    await expect(
      sendBookingAgreementForReview(
        buildTransitionDeps(buildAgreementRecord()).deps,
        performer,
      ),
    ).resolves.toMatchObject({ status: "PROPOSED" });

    await expect(
      pullBackBookingAgreement(
        buildTransitionDeps(buildAgreementRecord({ status: "PROPOSED" })).deps,
        performer,
      ),
    ).resolves.toMatchObject({ status: "DRAFT" });

    await expect(
      reopenBookingAgreement(
        buildTransitionDeps(buildAgreementRecord({ status: "ACCEPTED" })).deps,
        performer,
      ),
    ).resolves.toMatchObject({ status: "DRAFT" });

    // And the venue admin may still respond — nobody is "the act" here.
    await expect(
      respondToBookingAgreement(
        buildTransitionDeps(buildAgreementRecord({ status: "PROPOSED" })).deps,
        { actorHumanId: VENUE_ADMIN_ID, agreementId: AGREEMENT_ID, action: "accept" },
      ),
    ).resolves.toMatchObject({ status: "ACCEPTED" });
  });
});

describe("terms-editor gate — the link INVARIANT (a linked agreement stays linked)", () => {
  // The `!request → null` branch in the resolver means "either party edits".
  // It is only safe because no production path unlinks a request from its
  // agreement. Withdraw is the one sender-side status write; pin that it never
  // touches `agreementId` — including on the ACCEPTED row that owns one, which
  // booking-the-night N14 / FR-010 now lets the sender withdraw (its terms
  // are CANCELLED, never unlinked).
  function buildWithdrawDeps(request: ReturnType<typeof buildBookingRequestRecord>) {
    const updateStatus = vi.fn(
      async (input: { status: string; expectedFrom: string[] }) => {
        if (!input.expectedFrom.includes(request.status)) {
          throw { code: "conflict", message: "booking_request_status_changed" };
        }
        return { ...request, status: input.status };
      },
    );
    const agreements = makeAgreementsRepoFake(buildAgreementRecord({ status: "DRAFT" }));
    const deps = {
      repos: withTx({
        bookingRequests: { getById: vi.fn(async () => request), updateStatus },
        agreements: agreements.repo,
        authz: makeAuthzFake(),
        audit: makeAuditFake(),
      }) as unknown as WithdrawBookingRequestDeps["repos"],
      clock: makeClock(),
    } satisfies WithdrawBookingRequestDeps;
    return { deps, updateStatus, agreements };
  }

  it("withdraw of an ACCEPTED request that owns an agreement (N14): the terms are CANCELLED, the link is never touched", async () => {
    const request = buildBookingRequestRecord({
      status: "ACCEPTED",
      agreementId: AGREEMENT_ID,
      performerOwnerType: "human",
      performerOwnerId: PERFORMER_ID,
    });
    const { deps, updateStatus, agreements } = buildWithdrawDeps(request);

    await expect(
      withdrawBookingRequest(deps, {
        actorHumanId: PERFORMER_ID,
        bookingRequestId: request.id,
      }),
    ).resolves.toMatchObject({ status: "WITHDRAWN" });
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(Object.keys(updateStatus.mock.calls[0]![0])).toEqual([
      "id",
      "status",
      "expectedFrom",
    ]);
    expect(agreements.record()?.status).toBe("CANCELLED");
  });

  it("withdraw's status write carries no agreementId — it can never clear the link", async () => {
    const request = buildBookingRequestRecord({
      status: "PENDING",
      performerOwnerType: "human",
      performerOwnerId: PERFORMER_ID,
    });
    const { deps, updateStatus } = buildWithdrawDeps(request);

    await withdrawBookingRequest(deps, {
      actorHumanId: PERFORMER_ID,
      bookingRequestId: request.id,
    });

    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(Object.keys(updateStatus.mock.calls[0]![0])).toEqual([
      "id",
      "status",
      "expectedFrom",
    ]);
  });
});

describe("resolveAgreementTermsSide", () => {
  it("is null with no originating request", async () => {
    await expect(
      resolveAgreementTermsSide(
        { bookingRequests: makeBookingRequestsFake() } as never,
        buildAgreementRecord(),
        "proposer",
      ),
    ).resolves.toBeNull();
  });

  it("TO_VENUE: proposer = act, counterparty = editor", () => {
    const request = buildLinkedBookingRequest("TO_VENUE");
    const agreement = buildAgreementRecord();
    expect(termsSideForRequest(request, agreement, "proposer")).toBe("act");
    expect(termsSideForRequest(request, agreement, "counterparty")).toBe(
      "editor",
    );
  });

  it("TO_PERFORMER: the layout is mirrored — counterparty = act, proposer = editor", () => {
    const request = buildLinkedBookingRequest("TO_PERFORMER");
    const agreement = buildOrganizerAgreementRecord();
    expect(termsSideForRequest(request, agreement, "proposer")).toBe("editor");
    expect(termsSideForRequest(request, agreement, "counterparty")).toBe(
      "act",
    );
  });

  // The direction fallback (`booking-ledger.ts`) for a request with no act
  // pair yet — structurally unreachable today, pinned so a change there
  // cannot silently flip who edits.
  it("falls back to the direction rule when the act pair is null", () => {
    const toVenue = {
      ...buildLinkedBookingRequest("TO_VENUE"),
      performerOwnerType: null,
      performerOwnerId: null,
    };
    expect(
      termsSideForRequest(toVenue, buildAgreementRecord(), "proposer"),
    ).toBe("act");

    const toPerformer = {
      ...buildLinkedBookingRequest("TO_PERFORMER"),
      performerOwnerType: null,
      performerOwnerId: null,
    };
    expect(
      termsSideForRequest(
        toPerformer,
        buildOrganizerAgreementRecord(),
        "proposer",
      ),
    ).toBe("editor");
  });
});
