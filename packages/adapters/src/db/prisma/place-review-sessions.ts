import { Prisma } from "@prisma/client";

import type {
  PlaceReviewSessionsRepo,
  PlaceReviewSessionRecord,
  UpsertPlaceReviewSessionInput,
  UpdateSessionStepInput,
  CaptureSessionEmailInput,
  CompleteSessionInput,
  FindAbandonedSessionsInput,
  BindSessionReviewInput,
} from "@th/ports/repos/place-review-sessions";

import type { PrismaClientOrTx } from "./types";

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

type SessionRow = {
  id: string;
  sessionToken: string;
  humanId: string | null;
  placeId: string;
  email: string | null;
  emailCapturedAt: Date | null;
  lastStepKey: string | null;
  lastStepAt: Date | null;
  pageReached: number;
  completedAt: Date | null;
  placeReviewId: string | null;
  abandonmentEmailSentAt: Date | null;
  recoveryUnsubscribedAt: Date | null;
  incentiveShownAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toSessionRecord(row: SessionRow): PlaceReviewSessionRecord {
  return {
    id: row.id,
    sessionToken: row.sessionToken,
    humanId: row.humanId,
    placeId: row.placeId,
    email: row.email,
    emailCapturedAt: row.emailCapturedAt,
    lastStepKey: row.lastStepKey,
    lastStepAt: row.lastStepAt,
    pageReached: row.pageReached,
    completedAt: row.completedAt,
    placeReviewId: row.placeReviewId,
    abandonmentEmailSentAt: row.abandonmentEmailSentAt,
    recoveryUnsubscribedAt: row.recoveryUnsubscribedAt,
    incentiveShownAt: row.incentiveShownAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makePlaceReviewSessionsRepo(
  p: PrismaClientOrTx,
): PlaceReviewSessionsRepo {
  return {
    async upsert(input: UpsertPlaceReviewSessionInput) {
      const where = {
        sessionToken_placeId: {
          sessionToken: input.sessionToken,
          placeId: input.placeId,
        },
      };
      const update = { humanId: input.humanId ?? undefined };

      try {
        const row = await p.placeReviewSession.upsert({
          where,
          create: {
            sessionToken: input.sessionToken,
            placeId: input.placeId,
            humanId: input.humanId ?? null,
          },
          update,
        });
        return toSessionRecord(row);
      } catch (error) {
        // Prisma's upsert is not atomic here — it SELECTs, misses, then
        // INSERTs — so two callers racing on the same (sessionToken, placeId)
        // both miss and both insert. That is the normal case, not an exotic
        // one: the review form opens the same token+place from two tabs, or
        // remounts. The loser takes P2002 on the compound unique, and the row
        // it wanted now exists, so finish as the update branch would have.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const row = await p.placeReviewSession.update({
            where,
            data: update,
          });
          return toSessionRecord(row);
        }
        throw error;
      }
    },

    async getBySessionTokenAndPlace(sessionToken: string, placeId: string) {
      const row = await p.placeReviewSession.findUnique({
        where: { sessionToken_placeId: { sessionToken, placeId } },
      });
      return row ? toSessionRecord(row) : null;
    },

    async bindReview(input: BindSessionReviewInput) {
      // `where` equals the create's unique pair, so Prisma issues a native
      // INSERT … ON CONFLICT DO UPDATE — race-safe inside the caller's tx
      // (a P2002 there would abort the transaction, so no catch-and-retry).
      const row = await p.placeReviewSession.upsert({
        where: {
          sessionToken_placeId: {
            sessionToken: input.sessionToken,
            placeId: input.placeId,
          },
        },
        create: {
          sessionToken: input.sessionToken,
          placeId: input.placeId,
          humanId: input.humanId ?? null,
          placeReviewId: input.placeReviewId,
          completedAt: input.completedAt,
        },
        update: {
          placeReviewId: input.placeReviewId,
          completedAt: input.completedAt,
        },
      });
      return toSessionRecord(row);
    },

    async getBySessionToken(sessionToken: string) {
      const row = await p.placeReviewSession.findFirst({
        where: { sessionToken },
        orderBy: { createdAt: "desc" },
      });
      return row ? toSessionRecord(row) : null;
    },

    async updateStep(input: UpdateSessionStepInput) {
      await p.placeReviewSession.updateMany({
        where: { sessionToken: input.sessionToken },
        data: {
          lastStepKey: input.lastStepKey,
          lastStepAt: new Date(),
          pageReached: input.pageReached,
        },
      });
    },

    async captureEmail(input: CaptureSessionEmailInput) {
      // Find the most recent session for this token
      const session = await p.placeReviewSession.findFirst({
        where: { sessionToken: input.sessionToken },
        orderBy: { createdAt: "desc" },
      });
      if (!session) throw new Error("Session not found");

      // Try to match to an existing human by email via AuthUser
      const authUser = await p.authUser.findFirst({
        where: { email: input.email },
        select: { humanId: true },
      });
      const human = authUser?.humanId ? { id: authUser.humanId } : null;

      const row = await p.placeReviewSession.update({
        where: { id: session.id },
        data: {
          email: input.email,
          emailCapturedAt: new Date(),
          ...(human ? { humanId: human.id } : {}),
        },
      });
      return toSessionRecord(row);
    },

    async complete(input: CompleteSessionInput) {
      const session = await p.placeReviewSession.findFirst({
        where: { sessionToken: input.sessionToken },
        orderBy: { createdAt: "desc" },
      });
      if (!session) throw new Error("Session not found");

      const row = await p.placeReviewSession.update({
        where: { id: session.id },
        data: {
          completedAt: new Date(),
          placeReviewId: input.placeReviewId,
        },
      });
      return toSessionRecord(row);
    },

    async findAbandoned(input: FindAbandonedSessionsInput) {
      const rows = await p.placeReviewSession.findMany({
        where: {
          completedAt: null,
          email: { not: null },
          lastStepAt: { lt: input.staleAfter },
          abandonmentEmailSentAt: null,
          recoveryUnsubscribedAt: null,
        },
        take: input.limit ?? 100,
        orderBy: { lastStepAt: "asc" },
      });
      return rows.map(toSessionRecord);
    },

    async markAbandonmentEmailSent(id: string) {
      await p.placeReviewSession.update({
        where: { id },
        data: { abandonmentEmailSentAt: new Date() },
      });
    },

    async markRecoveryUnsubscribed(email: string) {
      await p.placeReviewSession.updateMany({
        where: { email },
        data: { recoveryUnsubscribedAt: new Date() },
      });
    },

    async isRecoveryUnsubscribed(email: string) {
      const count = await p.placeReviewSession.count({
        where: { email, recoveryUnsubscribedAt: { not: null } },
      });
      return count > 0;
    },
  };
}
