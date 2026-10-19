export interface TicketAttributionRecord {
  id: string;
  eventId: string;
  orderId: string;
  idempotencyKey: string;
  attributedToEventHumanId: string | null;
  attributedToHumanId: string | null;
  source: "REF_LINK" | "CHECKOUT_SELECT" | "NONE";
  trackingConsent: "GRANTED" | "DENIED" | "UNKNOWN";
  refRaw: string | null;
  refEventHumanId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  fanHumanId: string | null;
  fanCity: string | null;
  fanState: string | null;
  fanCountry: string | null;
  checkoutArtistSelection: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTicketAttributionInput {
  eventId: string;
  orderId: string;
  idempotencyKey: string;
  attributedToEventHumanId?: string | null;
  attributedToHumanId?: string | null;
  source: "REF_LINK" | "CHECKOUT_SELECT" | "NONE";
  trackingConsent?: "GRANTED" | "DENIED" | "UNKNOWN";
  refRaw?: string | null;
  refEventHumanId?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  fanHumanId?: string | null;
  fanCity?: string | null;
  fanState?: string | null;
  fanCountry?: string | null;
  checkoutArtistSelection?: string | null;
}

export interface TicketAttributionsRepo {
  create(input: CreateTicketAttributionInput): Promise<TicketAttributionRecord>;
  findByEventAndOrder(
    eventId: string,
    orderId: string,
  ): Promise<TicketAttributionRecord | null>;
  findByIdempotencyKey(key: string): Promise<TicketAttributionRecord | null>;
  listByEvent(eventId: string): Promise<TicketAttributionRecord[]>;
  listByAttributedHuman(humanId: string): Promise<TicketAttributionRecord[]>;
}
