import type { TxRepos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";
import { PERFORMER_ROLES } from "../../lib/event-human-roles";

export interface RecordAttributionInput {
  eventId: string;
  orderId: string;
  buyerHumanId: string;
  ref?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  checkoutArtistSelection?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingCountry?: string | null;
}

export async function recordAttribution(
  tx: TxRepos,
  input: RecordAttributionInput,
  logger?: LoggerPort,
): Promise<void> {
  const idempotencyKey = `ticket-attribution:v1:${input.eventId}:${input.orderId}`;

  // Check if already written (idempotency)
  const existing =
    await tx.ticketAttributions.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    logger?.info("recordAttribution.skip_duplicate", {
      orderId: input.orderId,
    });
    return;
  }

  // Validate the ref parameter
  let attributedToEventHumanId: string | null = null;
  let attributedToHumanId: string | null = null;
  let refEventHumanId: string | null = null;
  let source: "REF_LINK" | "CHECKOUT_SELECT" | "NONE" = "NONE";

  if (input.ref) {
    const eventHuman = await tx.eventHumans.getById(input.ref);
    if (
      eventHuman &&
      eventHuman.eventId === input.eventId &&
      (PERFORMER_ROLES as readonly string[]).includes(eventHuman.role)
    ) {
      attributedToEventHumanId = eventHuman.id;
      attributedToHumanId = eventHuman.humanId ?? null;
      refEventHumanId = eventHuman.id;
      source = "REF_LINK";
    }
  }

  // Fallback: checkout selection (only if ref didn't resolve)
  if (
    source === "NONE" &&
    input.checkoutArtistSelection &&
    input.checkoutArtistSelection !== "ALL_OF_THEM" &&
    input.checkoutArtistSelection !== "JUST_EXPLORING"
  ) {
    const eventHuman = await tx.eventHumans.getById(
      input.checkoutArtistSelection,
    );
    if (
      eventHuman &&
      eventHuman.eventId === input.eventId &&
      (PERFORMER_ROLES as readonly string[]).includes(eventHuman.role)
    ) {
      attributedToEventHumanId = eventHuman.id;
      attributedToHumanId = eventHuman.humanId ?? null;
      source = "CHECKOUT_SELECT";
    }
  }

  try {
    await tx.ticketAttributions.create({
      eventId: input.eventId,
      orderId: input.orderId,
      idempotencyKey,
      attributedToEventHumanId,
      attributedToHumanId,
      source,
      trackingConsent: "UNKNOWN",
      refRaw: input.ref ?? null,
      refEventHumanId,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      fanHumanId: input.buyerHumanId,
      fanCity: input.billingCity ?? null,
      fanState: input.billingState ?? null,
      fanCountry: input.billingCountry ?? null,
      checkoutArtistSelection: input.checkoutArtistSelection ?? null,
    });
  } catch (err: unknown) {
    // P2002 = unique constraint violation — another transaction already wrote this attribution
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      logger?.info("recordAttribution.skip_race_duplicate", {
        orderId: input.orderId,
      });
      return;
    }
    throw err;
  }

  await tx.audit.log({
    entity: "ticket_attribution",
    entityId: input.orderId,
    action: "ticket.attribution.recorded",
    data: {
      eventId: input.eventId,
      orderId: input.orderId,
      source,
      attributedToEventHumanId,
      ref: input.ref ?? null,
    },
    at: new Date(),
  });

  logger?.info("recordAttribution.written", {
    orderId: input.orderId,
    eventId: input.eventId,
    source,
    attributedToEventHumanId,
  });
}
