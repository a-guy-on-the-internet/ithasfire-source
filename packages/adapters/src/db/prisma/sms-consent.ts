import type {
  ApplySmsConsentDecisionInput,
  ApplySmsConsentDecisionResult,
  SmsConsentRepo,
  SmsConsentRecord,
  SmsConsentStatus,
  UpsertSmsConsentInput,
  RecordSmsConsentEventInput,
} from "@th/ports/repos/sms-consent";
import { Prisma } from "@prisma/client";

import type { PrismaClientOrTx } from "./types";

type PrismaSmsConsentRow = {
  id: string;
  phoneE164: string;
  status: SmsConsentStatus;
  source: string;
  reasonKeyword: string | null;
  providerMessageId: string | null;
  actorHumanId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  optedOutAt: Date | null;
  optedInAt: Date | null;
};

const toRow = (r: PrismaSmsConsentRow): SmsConsentRecord => ({
  id: r.id,
  phoneE164: r.phoneE164,
  status: r.status,
  source: r.source,
  reasonKeyword: r.reasonKeyword,
  providerMessageId: r.providerMessageId,
  actorHumanId: r.actorHumanId,
  metadata:
    r.metadata == null ? {} : (r.metadata as Record<string, unknown>),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  optedOutAt: r.optedOutAt,
  optedInAt: r.optedInAt,
});

export function makeSmsConsentRepo(p: PrismaClientOrTx): SmsConsentRepo {
  return {
    async getByPhone(phoneE164: string): Promise<SmsConsentRecord | null> {
      const row = await p.smsConsent.findUnique({ where: { phoneE164 } });
      return row ? toRow(row as PrismaSmsConsentRow) : null;
    },

    /**
     * @deprecated Unordered write (see the port); use `applyDecisionIfNewer`.
     */
    async upsertStatus(
      input: UpsertSmsConsentInput,
    ): Promise<SmsConsentRecord> {
      const metadata =
        input.metadata == null
          ? Prisma.JsonNull
          : (input.metadata as Prisma.InputJsonValue);
      const shared = {
        status: input.status,
        source: input.source,
        reasonKeyword: input.reasonKeyword ?? null,
        providerMessageId: input.providerMessageId ?? null,
        actorHumanId: input.actorHumanId ?? null,
        optedOutAt: input.optedOutAt ?? null,
        optedInAt: input.optedInAt ?? null,
      };
      const row = await p.smsConsent.upsert({
        where: { phoneE164: input.phoneE164 },
        create: {
          phoneE164: input.phoneE164,
          ...shared,
          metadata: input.metadata == null ? undefined : metadata,
        },
        update: {
          ...shared,
          ...(input.metadata == null ? {} : { metadata }),
        },
      });
      return toRow(row as PrismaSmsConsentRow);
    },

    async applyDecisionIfNewer(
      input: ApplySmsConsentDecisionInput,
    ): Promise<ApplySmsConsentDecisionResult> {
      const eventAt = input.eventAt;
      const optingIn = input.status === "OPTED_IN";
      // Only the column matching the decision moves; the other keeps the
      // latest decision of its kind, which is what later calls compare to.
      const data = {
        status: input.status,
        source: input.source,
        reasonKeyword: input.reasonKeyword ?? null,
        providerMessageId: input.providerMessageId ?? null,
        actorHumanId: input.actorHumanId ?? null,
        ...(optingIn ? { optedInAt: eventAt } : { optedOutAt: eventAt }),
      };

      // First decision for this number: ON CONFLICT DO NOTHING, so a
      // concurrent insert never aborts the caller's transaction.
      const created = await p.smsConsent.createMany({
        data: [{ phoneE164: input.phoneE164, ...data }],
        skipDuplicates: true,
      });

      let applied = created.count === 1;
      if (!applied) {
        // Compare-and-set in one UPDATE: Postgres re-checks the WHERE on the
        // latest row version, so a concurrent STOP/START cannot interleave.
        // Ties go to the opt-out (port doc).
        const where: Prisma.SmsConsentWhereInput = optingIn
          ? {
              phoneE164: input.phoneE164,
              AND: [
                { OR: [{ optedOutAt: null }, { optedOutAt: { lt: eventAt } }] },
                { OR: [{ optedInAt: null }, { optedInAt: { lte: eventAt } }] },
              ],
            }
          : {
              phoneE164: input.phoneE164,
              AND: [
                { OR: [{ optedInAt: null }, { optedInAt: { lte: eventAt } }] },
                {
                  OR: [{ optedOutAt: null }, { optedOutAt: { lte: eventAt } }],
                },
              ],
            };
        const updated = await p.smsConsent.updateMany({ where, data });
        applied = updated.count === 1;
      }

      const row = await p.smsConsent.findUniqueOrThrow({
        where: { phoneE164: input.phoneE164 },
      });
      return { applied, record: toRow(row as PrismaSmsConsentRow) };
    },

    async recordEvent(input: RecordSmsConsentEventInput): Promise<void> {
      await p.smsConsentEvent.create({
        data: {
          phoneE164: input.phoneE164,
          eventType: input.eventType,
          source: input.source,
          providerMessageId: input.providerMessageId ?? null,
          payloadHash: input.payloadHash ?? null,
        },
      });
    },
  };
}
