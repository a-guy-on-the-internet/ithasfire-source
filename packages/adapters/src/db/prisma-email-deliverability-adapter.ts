import { Prisma, type PrismaClient } from "@prisma/client";

import type { LoggerPort } from "@th/ports/logger";
import type {
  EmailDeliverabilityPort,
  EmailDeliveryEventRecord,
  EmailDeliveryStatus,
  RecordEmailDeliveryProviderEventInput,
} from "@th/ports/comms/email-deliverability";

const SUPPRESSING_STATUSES = new Set<EmailDeliveryStatus>([
  "BOUNCED",
  "COMPLAINED",
]);

/**
 * Default bounce-storm circuit-breaker thresholds. If more than
 * `DEFAULT_BOUNCE_STORM_THRESHOLD` permanent bounces land inside
 * `DEFAULT_BOUNCE_STORM_WINDOW_MS`, we stop auto-flagging accounts and raise an
 * operational alert instead — a flood of permanent bounces almost always means
 * a provider/config problem on our side, not thousands of genuinely bad
 * recipients, and mass-suppressing real users would be far worse than pausing.
 */
const DEFAULT_BOUNCE_STORM_THRESHOLD = 50;
const DEFAULT_BOUNCE_STORM_WINDOW_MS = 5 * 60_000;

/**
 * Minimal structural alert function. Matches the shape of the Discord webhook
 * alert sender (`DiscordAlertFn`) so the API can pass `fireDiscordAlert`
 * directly, but kept local so the adapter doesn't depend on a concrete sender.
 */
export type DeliverabilityAlertFn = (opts: {
  title: string;
  colour?: "info" | "warning" | "error";
  description?: string;
}) => Promise<void>;

export interface PrismaEmailDeliverabilityAdapterOptions {
  /** Operational alerter, fired when the bounce-storm breaker trips. */
  alert?: DeliverabilityAlertFn;
  logger?: LoggerPort;
  /** Permanent-bounce count within the window that trips the breaker. */
  bounceStormThreshold?: number;
  /** Rolling window (ms) over which permanent bounces are counted. */
  bounceStormWindowMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class PrismaEmailDeliverabilityAdapter implements EmailDeliverabilityPort {
  private readonly alert?: DeliverabilityAlertFn;
  private readonly logger?: LoggerPort;
  private readonly bounceStormThreshold: number;
  private readonly bounceStormWindowMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaEmailDeliverabilityAdapterOptions = {},
  ) {
    this.alert = options.alert;
    this.logger = options.logger;
    this.bounceStormThreshold =
      options.bounceStormThreshold ?? DEFAULT_BOUNCE_STORM_THRESHOLD;
    this.bounceStormWindowMs =
      options.bounceStormWindowMs ?? DEFAULT_BOUNCE_STORM_WINDOW_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getByEmail(email: string) {
    const normalizedEmail = normalizeEmail(email);
    const row = await this.prisma.authUser.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      select: {
        id: true,
        email: true,
        emailDeliveryStatus: true,
        emailDeliveryStatusAt: true,
        emailDeliveryStatusRef: true,
      },
    });

    if (!row) return null;

    return {
      authUserId: row.id,
      email: row.email,
      status: row.emailDeliveryStatus,
      statusAt: row.emailDeliveryStatusAt,
      statusRef: row.emailDeliveryStatusRef,
    };
  }

  async recordProviderEvent(
    input: RecordEmailDeliveryProviderEventInput,
  ): Promise<EmailDeliveryEventRecord> {
    const normalizedEmail = normalizeEmail(input.email);
    // Bounce-storm detection happens inside the transaction, but the alert
    // itself is a network call — fire it only after the tx commits so we never
    // hold a DB transaction open on Discord's latency.
    let stormCount = 0;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const authUser = await tx.authUser.findFirst({
          where: { email: { equals: normalizedEmail, mode: "insensitive" } },
          select: { id: true, emailVerified: true },
        });

        const event = await tx.emailDeliveryEvent.create({
          data: {
            provider: input.provider,
            providerEventId: input.providerEventId,
            eventType: input.eventType,
            email: normalizedEmail,
            status: input.status,
            occurredAt: input.occurredAt,
            authUserId: authUser?.id ?? null,
            payload: input.payload as Prisma.InputJsonValue,
          },
        });

        if (authUser && SUPPRESSING_STATUSES.has(input.status)) {
          // Phase 6: never permanently suppress an unverified account. They may
          // have fat-fingered their address at sign-up; the verify-email flow
          // lets them correct it. Suppressing them would lock them out forever.
          if (!authUser.emailVerified) {
            this.logger?.info("email_delivery_flag_skipped_unverified", {
              authUserId: authUser.id,
              status: input.status,
              eventType: input.eventType,
            });
          } else {
            // Phase 7: bounce-storm circuit breaker. Only permanent bounces
            // count toward the storm — complaints and soft bounces are
            // genuinely user-driven and far rarer.
            const isPermanentBounce =
              input.eventType === "email.bounced" && input.status === "BOUNCED";

            if (isPermanentBounce) {
              stormCount = await tx.emailDeliveryEvent.count({
                where: {
                  eventType: "email.bounced",
                  status: "BOUNCED",
                  occurredAt: {
                    gte: new Date(
                      this.now().getTime() - this.bounceStormWindowMs,
                    ),
                  },
                },
              });
            }

            if (isPermanentBounce && stormCount > this.bounceStormThreshold) {
              this.logger?.error("email_delivery_bounce_storm_detected", {
                recentPermanentBounces: stormCount,
                windowMs: this.bounceStormWindowMs,
                threshold: this.bounceStormThreshold,
              });
            } else {
              await tx.authUser.update({
                where: { id: authUser.id },
                data: {
                  emailDeliveryStatus: input.status,
                  emailDeliveryStatusAt: input.occurredAt,
                  emailDeliveryStatusRef: input.providerEventId,
                },
              });
            }
          }
        }

        return mapEvent(event, false);
      });

      if (stormCount > this.bounceStormThreshold && this.alert) {
        const windowMinutes = Math.round(this.bounceStormWindowMs / 60_000);
        await this.alert({
          title: "Email bounce storm detected",
          colour: "error",
          description: `${stormCount} permanent bounces in the last ${windowMinutes} min exceeded the threshold of ${this.bounceStormThreshold}. Auto-suppression is paused to protect real users — investigate sending config before clearing.`,
        });
      }

      return result;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const event = await this.prisma.emailDeliveryEvent.findUniqueOrThrow({
          where: {
            provider_providerEventId: {
              provider: input.provider,
              providerEventId: input.providerEventId,
            },
          },
        });
        return mapEvent(event, true);
      }

      throw error;
    }
  }

  async clearByEmail(email: string): Promise<boolean> {
    const normalizedEmail = normalizeEmail(email);
    const result = await this.prisma.authUser.updateMany({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
      data: {
        emailDeliveryStatus: null,
        emailDeliveryStatusAt: null,
        emailDeliveryStatusRef: null,
      },
    });
    return result.count > 0;
  }

  async anonymizeForUser(authUserId: string): Promise<number> {
    const events = await this.prisma.emailDeliveryEvent.findMany({
      where: { authUserId },
      select: { id: true, email: true, payload: true },
    });

    let anonymized = 0;
    for (const event of events) {
      const sentinel = `deleted-${event.id}@deleted.local`;
      const scrubbedPayload = scrubEmailFromJson(
        event.payload,
        event.email,
        sentinel,
      );
      await this.prisma.emailDeliveryEvent.update({
        where: { id: event.id },
        data: {
          email: sentinel,
          authUserId: null,
          payload: (scrubbedPayload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      anonymized += 1;
    }

    return anonymized;
  }
}

export const createPrismaEmailDeliverabilityAdapter = (
  prisma: PrismaClient,
  options: PrismaEmailDeliverabilityAdapterOptions = {},
): EmailDeliverabilityPort =>
  new PrismaEmailDeliverabilityAdapter(prisma, options);

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Recursively replaces every string equal (case-insensitively) to `email` with
 * `sentinel` anywhere inside a JSON value. Used by GDPR erasure to scrub the
 * recipient address out of the raw provider payload while leaving the rest of
 * the event intact for bounce-storm forensics.
 */
const scrubEmailFromJson = (
  value: Prisma.JsonValue | null,
  email: string,
  sentinel: string,
): Prisma.JsonValue | null => {
  if (value === null) return null;
  if (typeof value === "string") {
    return value.toLowerCase() === email.toLowerCase() ? sentinel : value;
  }
  if (Array.isArray(value)) {
    return value.map(
      (item) => scrubEmailFromJson(item, email, sentinel) as Prisma.JsonValue,
    );
  }
  if (typeof value === "object") {
    const next: Record<string, Prisma.JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      next[key] = scrubEmailFromJson(
        nested ?? null,
        email,
        sentinel,
      ) as Prisma.JsonValue;
    }
    return next;
  }
  return value;
};

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

const mapEvent = (
  event: {
    id: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    email: string;
    status: EmailDeliveryStatus;
    occurredAt: Date;
    processedAt: Date;
    authUserId: string | null;
  },
  replayed: boolean,
): EmailDeliveryEventRecord => ({
  id: event.id,
  provider: event.provider,
  providerEventId: event.providerEventId,
  eventType: event.eventType,
  email: event.email,
  status: event.status,
  occurredAt: event.occurredAt,
  processedAt: event.processedAt,
  authUserId: event.authUserId,
  replayed,
});
