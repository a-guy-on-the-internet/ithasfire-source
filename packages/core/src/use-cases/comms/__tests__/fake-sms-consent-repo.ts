import type {
  ApplySmsConsentDecisionInput,
  SmsConsentRecord,
  SmsConsentRepo,
  UpsertSmsConsentInput,
} from "@th/ports/repos/sms-consent";

/**
 * In-memory SmsConsentRepo for unit tests. `applyDecisionIfNewer` follows the
 * port's ordering rule (the Prisma adapter's compare-and-set), so use-case
 * tests exercise the same stale/applied outcomes the database produces.
 */
export function makeFakeSmsConsentRepo(now: () => Date): SmsConsentRepo & {
  consents: Map<string, SmsConsentRecord>;
  events: Array<{ phoneE164: string; eventType: string; source: string }>;
} {
  const consents = new Map<string, SmsConsentRecord>();
  const events: Array<{
    phoneE164: string;
    eventType: string;
    source: string;
  }> = [];

  const write = (
    phoneE164: string,
    patch: Partial<SmsConsentRecord> & Pick<SmsConsentRecord, "status">,
  ): SmsConsentRecord => {
    const existing = consents.get(phoneE164);
    const row: SmsConsentRecord = {
      id: existing?.id ?? `consent-${phoneE164}`,
      phoneE164,
      source: existing?.source ?? "",
      reasonKeyword: null,
      providerMessageId: null,
      actorHumanId: null,
      metadata: existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now(),
      optedOutAt: existing?.optedOutAt ?? null,
      optedInAt: existing?.optedInAt ?? null,
      ...patch,
      updatedAt: now(),
    };
    consents.set(phoneE164, row);
    return row;
  };

  return {
    consents,
    events,
    async getByPhone(phoneE164) {
      return consents.get(phoneE164) ?? null;
    },
    async upsertStatus(input: UpsertSmsConsentInput) {
      return write(input.phoneE164, {
        status: input.status,
        source: input.source,
        reasonKeyword: input.reasonKeyword ?? null,
        providerMessageId: input.providerMessageId ?? null,
        actorHumanId: input.actorHumanId ?? null,
        optedOutAt: input.optedOutAt ?? null,
        optedInAt: input.optedInAt ?? null,
      });
    },
    async applyDecisionIfNewer(input: ApplySmsConsentDecisionInput) {
      const current = consents.get(input.phoneE164);
      const t = input.eventAt.getTime();
      const outAt = current?.optedOutAt?.getTime() ?? null;
      const inAt = current?.optedInAt?.getTime() ?? null;
      const stale =
        input.status === "OPTED_IN"
          ? (outAt !== null && t <= outAt) || (inAt !== null && t < inAt)
          : (inAt !== null && t < inAt) || (outAt !== null && t < outAt);
      if (current && stale) {
        return { applied: false, record: current };
      }
      const record = write(input.phoneE164, {
        status: input.status,
        source: input.source,
        reasonKeyword: input.reasonKeyword ?? null,
        providerMessageId: input.providerMessageId ?? null,
        actorHumanId: input.actorHumanId ?? null,
        ...(input.status === "OPTED_IN"
          ? { optedInAt: input.eventAt }
          : { optedOutAt: input.eventAt }),
      });
      return { applied: true, record };
    },
    async recordEvent(input) {
      events.push({
        phoneE164: input.phoneE164,
        eventType: input.eventType,
        source: input.source,
      });
    },
  };
}
