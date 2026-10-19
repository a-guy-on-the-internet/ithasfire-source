import { Prisma } from "@prisma/client";
import type { Agreement } from "@prisma/client";
import type {
  AgreementsRepo,
  AgreementRecord,
  AgreementPartyType,
} from "@th/ports/repos/agreements";

import type { PrismaClientOrTx } from "./types";

export function makeAgreementsRepo(p: PrismaClientOrTx): AgreementsRepo {
  return {
    async getById(id) {
      const row = await p.agreement.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async getByEventId(eventId) {
      const row = await p.agreement.findUnique({ where: { eventId } });
      return row ? toRecord(row) : null;
    },

    async findByLinkedEventId(eventId) {
      // Finalized link first (see the port doc): the same event can be one
      // agreement's stale draft anchor AND another's finalized event, and the
      // money link is the authoritative answer. Two unique-index lookups, the
      // second only on a miss — deliberately NOT a single `OR`, which would
      // return whichever row the planner reached first.
      const finalized = await p.agreement.findUnique({ where: { eventId } });
      if (finalized) return toRecord(finalized);

      const draft = await p.agreement.findUnique({
        where: { draftEventId: eventId },
      });
      return draft ? toRecord(draft) : null;
    },

    async findManyByLinkedEventIds(eventIds) {
      // ONE query matching either link column. Unlike the single read, an
      // `OR` is fine here: every matching row comes back and the caller
      // applies the finalized-first precedence per event (port doc), so row
      // order decides nothing.
      if (eventIds.length === 0) return [];
      const ids = [...eventIds];
      const rows = await p.agreement.findMany({
        where: {
          OR: [{ eventId: { in: ids } }, { draftEventId: { in: ids } }],
        },
      });
      return rows.map(toRecord);
    },

    async findManyByIds(ids) {
      // Guard the empty case without a round trip (mirrors the events repo's
      // `findManyByIds`); `id: { in: [] }` would otherwise be a pointless query.
      if (ids.length === 0) return [];
      const rows = await p.agreement.findMany({ where: { id: { in: ids } } });
      return rows.map(toRecord);
    },

    async getByPayoutTermsId(payoutTermsId) {
      // Not unique at the schema level (nullable FK) — findFirst. In practice
      // each booking-accept clone mints a fresh PayoutTerms row per agreement.
      const row = await p.agreement.findFirst({ where: { payoutTermsId } });
      return row ? toRecord(row) : null;
    },

    async create(input) {
      const created = await p.agreement.create({
        data: {
          type: input.type,
          status: input.status ?? "DRAFT",
          proposerType: input.proposerType,
          proposerId: input.proposerId,
          counterpartyType: input.counterpartyType,
          counterpartyId: input.counterpartyId,
          placeId: input.placeId ?? null,
          payoutTermsId: input.payoutTermsId ?? null,
          title: input.title,
          description: input.description ?? null,
          proposedDate: input.proposedDate ?? null,
          proposedEndDate: input.proposedEndDate ?? null,
          guaranteeCents: input.guaranteeCents ?? null,
        },
      });
      return toRecord(created);
    },

    async updateHeader(input) {
      const data: Prisma.AgreementUncheckedUpdateManyInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.proposedDate !== undefined)
        data.proposedDate = input.proposedDate;
      if (input.proposedEndDate !== undefined)
        data.proposedEndDate = input.proposedEndDate;
      if (input.guaranteeCents !== undefined)
        data.guaranteeCents = input.guaranteeCents;
      if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;

      // Guarded compare-and-swap (mirrors booking-requests `updateStatus`):
      // under READ COMMITTED an in-tx re-read takes no lock, so the status
      // WHERE must travel with the write. A concurrent DRAFT→PROPOSED
      // transition matches zero rows and surfaces as a conflict instead of
      // editing a proposal the other side is already reviewing.
      const result = await p.agreement.updateMany({
        where: { id: input.id, status: { in: [...input.expectedFrom] } },
        data,
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "agreement_status_changed",
        } as const;
      }
      return refetch(p, input.id);
    },

    async listByParty({ partyType, partyId, statuses }) {
      const rows = await p.agreement.findMany({
        where: {
          OR: [
            { proposerType: partyType, proposerId: partyId },
            { counterpartyType: partyType, counterpartyId: partyId },
          ],
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
        orderBy: { updatedAt: "desc" },
      });
      return rows.map(toRecord);
    },

    async updateStatus(input) {
      const data: Prisma.AgreementUncheckedUpdateManyInput = {
        status: input.status,
      };
      if (input.proposedAt !== undefined) data.proposedAt = input.proposedAt;
      if (input.acceptedAt !== undefined) data.acceptedAt = input.acceptedAt;
      if (input.declinedAt !== undefined) data.declinedAt = input.declinedAt;
      if (input.declinedReason !== undefined)
        data.declinedReason = input.declinedReason;
      if (input.fulfilledAt !== undefined) data.fulfilledAt = input.fulfilledAt;
      // Same guarded write as the transition (booking-the-night FR-002): the
      // send's actor only lands if the send itself wins its CAS.
      if (input.sentForReviewByHumanId !== undefined)
        data.sentForReviewByHumanId = input.sentForReviewByHumanId;
      if (input.eventId !== undefined) data.eventId = input.eventId;
      // Divergent finalize: retire the minted-draft anchor in the same
      // guarded write (see UpdateAgreementStatusInput.clearDraftEventId).
      if (input.clearDraftEventId) data.draftEventId = null;

      try {
        // Guarded compare-and-swap (see booking-requests adapter for the
        // rationale). When stamping an eventId (finalize) the WHERE also
        // requires the stored eventId to still be NULL so two concurrent
        // finalizes can't both claim the link; `expectEventIdNull` applies
        // the same fence without stamping (reopen vs concurrent finalize —
        // finalize keeps the row ACCEPTED, so a status-only CAS can't see it).
        const result = await p.agreement.updateMany({
          where: {
            id: input.id,
            status: { in: [...input.expectedFrom] },
            ...(input.eventId !== undefined || input.expectEventIdNull
              ? { eventId: null }
              : {}),
            // booking-the-night P2d-2 (carry b): the anchor the caller
            // decided on. Under READ COMMITTED a concurrent `setDraftEvent`
            // holding this row makes the update wait, then re-evaluate this
            // predicate on the new row — so it matches zero rows instead of
            // linking beside a freshly minted live draft.
            ...(input.expectedDraftEventId !== undefined
              ? { draftEventId: input.expectedDraftEventId }
              : {}),
          },
          data,
        });
        if (result.count === 0) {
          throw {
            code: "conflict",
            message: "agreement_status_changed",
          } as const;
        }
      } catch (error) {
        // `Agreement.eventId` is unique — a P2002 here means another
        // agreement already claimed the event. Map the race loser to the
        // same domain error as the use-case pre-check.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "event_already_has_agreement",
            message: "event_already_has_agreement",
            cause: error,
          } as const;
        }
        // FK violation (P2003) on the send's actor: the human was deleted
        // between the caller's checks and this stamp (booking-the-night
        // FR-002). Same retryable conflict family as `draft_event_missing`
        // below, instead of an unmapped 500. Matched by the EXACT constraint
        // name — `eventId` is an FK too, and its violation is not this.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2003" &&
          namesConstraint(error, SENT_FOR_REVIEW_BY_FK)
        ) {
          throw {
            code: "conflict",
            message: "agreement_sender_missing",
            cause: error,
          } as const;
        }
        throw error;
      }
      return refetch(p, input.id);
    },

    async setDraftEvent(input) {
      try {
        // Guarded compare-and-swap: only an ACCEPTED (per expectedFrom),
        // never-finalized (`eventId IS NULL`), anchor-free
        // (`draftEventId IS NULL`) row takes the stamp. A concurrent create /
        // finalize / cancel matches zero rows and surfaces as the same
        // conflict family the other guarded writes use. After an event
        // deletion the FK's SetNull re-opens the anchor, so a venue that
        // discarded the draft can mint a fresh one.
        const result = await p.agreement.updateMany({
          where: {
            id: input.id,
            status: { in: [...input.expectedFrom] },
            // Anchor-free, or exactly the dead draft being replaced.
            draftEventId: input.replacingDraftEventId ?? null,
            eventId: null,
          },
          data: { draftEventId: input.draftEventId },
        });
        if (result.count === 0) {
          throw {
            code: "conflict",
            message: "agreement_status_changed",
          } as const;
        }
      } catch (error) {
        // `Agreement.draftEventId` is unique — a P2002 means the event is
        // already another agreement's draft (unreachable while every create
        // mints a fresh event). Same conflict shape as the CAS loser.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "conflict",
            message: "agreement_status_changed",
            cause: error,
          } as const;
        }
        // FK violation (P2003): the event was deleted between the caller's
        // liveness check and this stamp. Surface as a retryable conflict —
        // the retry's envelope resolution advances a generation and mints
        // fresh instead of dying on an unmapped Prisma error.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2003"
        ) {
          throw {
            code: "conflict",
            message: "draft_event_missing",
            cause: error,
          } as const;
        }
        throw error;
      }
      return refetch(p, input.id);
    },
  };
}

/** The constraint name migration 20261001140000_booking_the_night creates. */
const SENT_FOR_REVIEW_BY_FK = "Agreement_sentForReviewByHumanId_fkey";

/**
 * Whether a Prisma error names `constraint`. Probes the engine-dependent
 * slots calendars.ts documents (`namesPrimarySpaceFk`): driver-adapter mode
 * (Prisma 7, the only mode this repo runs) nests the constraint under
 * `meta.driverAdapterError.cause`, the classic engine puts it on
 * `meta.field_name`. EXACT name, never a guess at a column.
 */
function namesConstraint(
  error: Prisma.PrismaClientKnownRequestError,
  constraint: string,
): boolean {
  const meta = (error.meta ?? {}) as {
    field_name?: unknown;
    constraint?: unknown;
    driverAdapterError?: {
      cause?: { constraint?: unknown; originalMessage?: unknown };
    };
  };
  const cause = meta.driverAdapterError?.cause;
  for (const slot of [
    meta.field_name,
    meta.constraint,
    cause?.constraint,
    cause?.originalMessage,
  ]) {
    if (typeof slot === "string" && slot.includes(constraint)) return true;
    if (
      slot !== null &&
      typeof slot === "object" &&
      "index" in slot &&
      (slot as { index: unknown }).index === constraint
    ) {
      return true;
    }
  }
  return false;
}

/** Post-updateMany re-read (updateMany returns only a count). */
async function refetch(
  p: PrismaClientOrTx,
  id: string,
): Promise<AgreementRecord> {
  const row = await p.agreement.findUniqueOrThrow({ where: { id } });
  return toRecord(row);
}

function toRecord(row: Agreement): AgreementRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    proposerType: row.proposerType as AgreementPartyType,
    proposerId: row.proposerId,
    counterpartyType: row.counterpartyType as AgreementPartyType,
    counterpartyId: row.counterpartyId,
    placeId: row.placeId ?? null,
    eventId: row.eventId ?? null,
    draftEventId: row.draftEventId ?? null,
    payoutTermsId: row.payoutTermsId ?? null,
    title: row.title,
    description: row.description ?? null,
    proposedDate: row.proposedDate ?? null,
    proposedEndDate: row.proposedEndDate ?? null,
    guaranteeCents: row.guaranteeCents ?? null,
    proposedAt: row.proposedAt ?? null,
    acceptedAt: row.acceptedAt ?? null,
    declinedAt: row.declinedAt ?? null,
    declinedReason: row.declinedReason ?? null,
    expiresAt: row.expiresAt ?? null,
    fulfilledAt: row.fulfilledAt ?? null,
    sentForReviewByHumanId: row.sentForReviewByHumanId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
