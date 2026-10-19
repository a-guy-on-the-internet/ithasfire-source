import type {
  ConsentRepo,
  ConsentRecordInput,
  ConsentRecordRow,
} from "@th/ports/repos/consent";

import type { PrismaClientOrTx } from "./types";

const toRow = (r: {
  id: string;
  anonymousId: string;
  humanId: string | null;
  choice: "ALL" | "ESSENTIAL" | "RESET";
  source: "BANNER" | "FOOTER_MANAGE";
  privacyPolicyVersion: string;
  cookiePolicyVersion: string;
  ipHash: string | null;
  userAgent: string | null;
  createdAt: Date;
}): ConsentRecordRow => ({
  id: r.id,
  anonymousId: r.anonymousId,
  humanId: r.humanId,
  choice: r.choice,
  source: r.source,
  privacyPolicyVersion: r.privacyPolicyVersion,
  cookiePolicyVersion: r.cookiePolicyVersion,
  ipHash: r.ipHash,
  userAgent: r.userAgent,
  createdAt: r.createdAt,
});

export function makeConsentRepo(p: PrismaClientOrTx): ConsentRepo {
  return {
    async add(input: ConsentRecordInput) {
      const created = await p.consentRecord.create({
        data: {
          anonymousId: input.anonymousId,
          humanId: input.humanId,
          choice: input.choice,
          source: input.source,
          privacyPolicyVersion: input.privacyPolicyVersion,
          cookiePolicyVersion: input.cookiePolicyVersion,
          ipHash: input.ipHash,
          userAgent: input.userAgent,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async listByHumanId(humanId) {
      const rows = await p.consentRecord.findMany({
        where: { humanId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toRow);
    },

    async listByAnonymousId(anonymousId) {
      const rows = await p.consentRecord.findMany({
        where: { anonymousId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toRow);
    },
  };
}
