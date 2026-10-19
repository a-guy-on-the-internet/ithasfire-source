import type {
  TicketAttributionsRepo,
  TicketAttributionRecord,
  CreateTicketAttributionInput,
} from "@th/ports/repos/ticket-attributions";
import { Prisma } from "@prisma/client";

import type { PrismaClientOrTx } from "./types";

const TICKET_ATTRIBUTION_SELECT = {
  id: true,
  eventId: true,
  orderId: true,
  idempotencyKey: true,
  attributedToEventHumanId: true,
  attributedToHumanId: true,
  source: true,
  trackingConsent: true,
  refRaw: true,
  refEventHumanId: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  fanHumanId: true,
  fanCity: true,
  fanState: true,
  fanCountry: true,
  checkoutArtistSelection: true,
  createdAt: true,
  updatedAt: true,
} as const;

const mapRecord = (
  row: Prisma.TicketAttributionGetPayload<{
    select: typeof TICKET_ATTRIBUTION_SELECT;
  }>,
): TicketAttributionRecord => ({
  id: row.id,
  eventId: row.eventId,
  orderId: row.orderId,
  idempotencyKey: row.idempotencyKey,
  attributedToEventHumanId: row.attributedToEventHumanId ?? null,
  attributedToHumanId: row.attributedToHumanId ?? null,
  source: row.source,
  trackingConsent: row.trackingConsent,
  refRaw: row.refRaw ?? null,
  refEventHumanId: row.refEventHumanId ?? null,
  utmSource: row.utmSource ?? null,
  utmMedium: row.utmMedium ?? null,
  utmCampaign: row.utmCampaign ?? null,
  fanHumanId: row.fanHumanId ?? null,
  fanCity: row.fanCity ?? null,
  fanState: row.fanState ?? null,
  fanCountry: row.fanCountry ?? null,
  checkoutArtistSelection: row.checkoutArtistSelection ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function makeTicketAttributionsRepo(
  p: PrismaClientOrTx,
): TicketAttributionsRepo {
  return {
    async create(input: CreateTicketAttributionInput) {
      const row = await p.ticketAttribution.create({
        data: {
          eventId: input.eventId,
          orderId: input.orderId,
          idempotencyKey: input.idempotencyKey,
          attributedToEventHumanId: input.attributedToEventHumanId ?? null,
          attributedToHumanId: input.attributedToHumanId ?? null,
          source: input.source,
          trackingConsent: input.trackingConsent ?? "UNKNOWN",
          refRaw: input.refRaw ?? null,
          refEventHumanId: input.refEventHumanId ?? null,
          utmSource: input.utmSource ?? null,
          utmMedium: input.utmMedium ?? null,
          utmCampaign: input.utmCampaign ?? null,
          fanHumanId: input.fanHumanId ?? null,
          fanCity: input.fanCity ?? null,
          fanState: input.fanState ?? null,
          fanCountry: input.fanCountry ?? null,
          checkoutArtistSelection: input.checkoutArtistSelection ?? null,
        },
        select: TICKET_ATTRIBUTION_SELECT,
      });
      return mapRecord(row);
    },

    async findByEventAndOrder(eventId: string, orderId: string) {
      const row = await p.ticketAttribution.findUnique({
        where: { eventId_orderId: { eventId, orderId } },
        select: TICKET_ATTRIBUTION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async findByIdempotencyKey(key: string) {
      const row = await p.ticketAttribution.findUnique({
        where: { idempotencyKey: key },
        select: TICKET_ATTRIBUTION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async listByEvent(eventId: string) {
      const rows = await p.ticketAttribution.findMany({
        where: { eventId },
        orderBy: { createdAt: "desc" },
        select: TICKET_ATTRIBUTION_SELECT,
      });
      return rows.map(mapRecord);
    },

    async listByAttributedHuman(humanId: string) {
      const rows = await p.ticketAttribution.findMany({
        where: { attributedToHumanId: humanId },
        orderBy: { createdAt: "desc" },
        select: TICKET_ATTRIBUTION_SELECT,
      });
      return rows.map(mapRecord);
    },
  };
}
