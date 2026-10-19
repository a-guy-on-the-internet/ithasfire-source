import type { PlaceClaimEmailChallengesRepo } from "@th/ports/repos/place-claim-email-challenges";
import type {
  CreatePlaceClaimEmailChallengeInput,
  PlaceClaimEmailChallengeRecord,
} from "@th/types/repos/place-claim-email-challenges";

import type { PrismaClientOrTx } from "./types";

type ChallengeRow = {
  id: string;
  placeId: string;
  humanId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  verifiedAt: Date | null;
  attempts: number;
  createdAt: Date;
};

function mapRow(row: ChallengeRow): PlaceClaimEmailChallengeRecord {
  return {
    id: row.id,
    placeId: row.placeId,
    humanId: row.humanId,
    email: row.email,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    verifiedAt: row.verifiedAt,
    attempts: row.attempts,
    createdAt: row.createdAt,
  };
}

export function makePlaceClaimEmailChallengesRepo(
  p: PrismaClientOrTx,
): PlaceClaimEmailChallengesRepo {
  return {
    create: async (input: CreatePlaceClaimEmailChallengeInput) => {
      const row = await p.placeClaimEmailChallenge.create({
        data: {
          placeId: input.placeId,
          humanId: input.humanId,
          email: input.email,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
        },
      });
      return mapRow(row);
    },

    getById: async (id: string) => {
      const row = await p.placeClaimEmailChallenge.findUnique({
        where: { id },
      });
      return row ? mapRow(row) : null;
    },

    getActiveForPlaceHuman: async ({ placeId, humanId, now }) => {
      const row = await p.placeClaimEmailChallenge.findFirst({
        where: {
          placeId,
          humanId,
          verifiedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
      });
      return row ? mapRow(row) : null;
    },

    markVerified: async ({ id, verifiedAt }) => {
      const row = await p.placeClaimEmailChallenge.update({
        where: { id },
        data: { verifiedAt },
      });
      return mapRow(row);
    },

    incrementAttempts: async (id: string) => {
      const row = await p.placeClaimEmailChallenge.update({
        where: { id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      return row.attempts;
    },

    expire: async ({ id, now }) => {
      await p.placeClaimEmailChallenge.update({
        where: { id },
        data: { expiresAt: now },
      });
    },
  };
}
