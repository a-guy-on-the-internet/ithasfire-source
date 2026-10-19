import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import {
  notifyClaimOpened,
  notifyClaimResolved,
  notifyListingCreated,
} from "../notify-resale-events";
import { notifyResaleSellerSold } from "../notify-resale-seller-sold";
import { renderStoredNotification } from "../../comms/render-stored-notification";

// The in-app rows these producers write directly (not through `notify`).
// The English text is pinned EXACTLY as it was before the rows started
// carrying a template, so storing the template changed nothing a reader sees
// in English; the Spanish re-render is pinned in
// comms/__tests__/notification-copy-locale-direct-a.test.ts.

const SELLER_ID = "seller-uuid";
const BUYER_ID = "buyer-uuid";
const EVENT_ID = "event-uuid";
const LISTING_ID = "listing-uuid";
const ORDER_ID = "order-uuid";
const CLAIM_ID = "claim-uuid";
const APP = "https://ithasfire.com/";
const NOW = new Date("2026-03-10T12:00:00Z");

function human(id: string) {
  return {
    human: { id, name: "Test Human" },
    identity: { email: `${id}@example.com` },
  };
}

function makeDeps(opts: { eventTitle?: string | null } = {}) {
  const create = vi.fn(async (_input: CreateNotificationInput) => ({
    id: "notif-1",
    createdAt: NOW,
  }));
  const send = vi.fn(async (_m: { subject: string; text: string }) => ({
    result: { id: "m", status: "sent" },
  }));
  const eventTitle = opts.eventTitle === undefined ? "Test Concert" : opts.eventTitle;
  const repos = {
    humans: { getByIdWithIdentity: vi.fn(async (id: string) => human(id)) },
    events: {
      getById: vi.fn(async () =>
        eventTitle === null ? null : { id: EVENT_ID, title: eventTitle },
      ),
    },
    resaleListings: {
      getById: vi.fn(async () => ({
        id: LISTING_ID,
        sellerHumanId: SELLER_ID,
        eventId: EVENT_ID,
        askPriceCents: 4250,
        currency: "usd",
      })),
    },
    notifications: { create },
  } as unknown as Repos;
  const mailer = { send } as unknown as MailerPort;
  return { deps: { repos, mailer }, create, send };
}

function rows(create: ReturnType<typeof makeDeps>["create"]) {
  return create.mock.calls.map(([input]) => input);
}

describe("resale in-app rows: English pinned", () => {
  it("listing created", async () => {
    const { deps, create } = makeDeps();
    await notifyListingCreated(deps, {
      listingId: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: EVENT_ID,
      askPriceCents: 2500,
      currency: "usd",
      publicAppUrl: APP,
    });
    expect(rows(create)).toEqual([
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Ticket listed for resale",
        body: "Your ticket for Test Concert is now listed at $25.00.",
        kind: "INFO",
        tags: ["resale", "listing"],
        action: { label: "View listing", href: "https://ithasfire.com/my/resale" },
      }),
    ]);
  });

  it("listing created, event gone", async () => {
    const { deps, create } = makeDeps({ eventTitle: null });
    await notifyListingCreated(deps, {
      listingId: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: EVENT_ID,
      askPriceCents: 2500,
      currency: "usd",
      publicAppUrl: APP,
    });
    expect(rows(create)[0]!.body).toBe(
      "Your ticket for your event is now listed at $25.00.",
    );
  });

  it("claim opened", async () => {
    const { deps, create } = makeDeps();
    await notifyClaimOpened(deps, {
      claimId: CLAIM_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      kind: "entry_denied",
      deadline: "2026-03-13T12:00:00.000Z",
      publicAppUrl: APP,
    });
    expect(rows(create)).toEqual([
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Claim filed against your sale",
        body: 'A buyer has filed a "entry denied" claim on your resale ticket for Test Concert. Reply with your side as soon as you can: support can decide the claim at any time.',
        kind: "WARNING",
        tags: ["resale", "claim"],
        action: {
          label: "View claim",
          href: `https://ithasfire.com/my/resale/claims/${CLAIM_ID}`,
        },
      }),
    ]);
  });

  it.each([
    [
      "full_refund",
      "Your claim for the Test Concert resale ticket has been approved. A full refund will be processed.",
    ],
    [
      null,
      "Your claim for the Test Concert resale ticket has been approved. A full refund will be processed.",
    ],
  ])("claim approved (%s): buyer and seller", async (resolution, buyerBody) => {
    const { deps, create } = makeDeps();
    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "approved",
      resolution,
      publicAppUrl: APP,
    });
    const href = `https://ithasfire.com/my/resale/claims/${CLAIM_ID}`;
    expect(rows(create)).toEqual([
      expect.objectContaining({
        humanId: BUYER_ID,
        title: "Your claim has been approved",
        body: buyerBody,
        kind: "SUCCESS",
        tags: ["resale", "claim"],
        action: { label: "View claim", href },
      }),
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Claim resolved — refund issued",
        body: "A claim on your resale ticket for Test Concert has been resolved in the buyer's favor. The payout for this sale has been adjusted accordingly.",
        kind: "WARNING",
        tags: ["resale", "claim"],
        action: { label: "View details", href },
      }),
    ]);
  });

  it("claim denied: buyer and seller", async () => {
    const { deps, create, send } = makeDeps();
    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "denied",
      resolution: null,
      publicAppUrl: APP,
    });
    const href = `https://ithasfire.com/my/resale/claims/${CLAIM_ID}`;
    expect(rows(create)).toEqual([
      expect.objectContaining({
        humanId: BUYER_ID,
        title: "Your claim has been denied",
        body: "Your claim for the Test Concert resale ticket has been denied. See the claim details for more information.",
        kind: "INFO",
        action: { label: "View claim", href },
      }),
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Claim resolved in your favor",
        body: "A claim on your resale ticket for Test Concert has been resolved in your favor. The money from this sale is no longer on hold and will be paid out as usual.",
        kind: "SUCCESS",
        action: { label: "View details", href },
      }),
    ]);
    // The emails reuse the English title/body: pinned so they stay identical.
    expect(send.mock.calls.map(([m]) => [m.subject, m.text])).toEqual([
      [
        "Claim update: your claim has been denied — Test Concert",
        `Your claim for the Test Concert resale ticket has been denied. See the claim details for more information.\n\nView full details: ${href}\n\nIthas Fire Support`,
      ],
      [
        "Claim update: claim resolved in your favor — Test Concert",
        `A claim on your resale ticket for Test Concert has been resolved in your favor. The money from this sale is no longer on hold and will be paid out as usual.\n\nView full details: ${href}\n\nIthas Fire Support`,
      ],
    ]);
  });

  it("seller sold", async () => {
    const { deps, create } = makeDeps();
    await notifyResaleSellerSold(deps, {
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      publicAppUrl: APP,
    });
    expect(rows(create)).toEqual([
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Ticket sold!",
        body: "Your ticket for Test Concert sold for $42.50. Payout will be processed after the event.",
        kind: "SUCCESS",
        tags: ["resale", "sale"],
        action: { label: "View details", href: "https://ithasfire.com/my/resale" },
      }),
    ]);
  });
});

/** The row as the inbox reads it back from the database. */
function stored(row: CreateNotificationInput) {
  return {
    id: "notif-1",
    title: row.title ?? null,
    body: row.body,
    action: row.action ?? null,
    metadata: row.metadata ?? null,
    templateKey: row.template?.key ?? null,
    templateVersion: row.template?.version ?? null,
    templateVariables: row.template?.variables ?? null,
    createdAt: NOW,
  };
}

function expectTemplate(row: CreateNotificationInput, variant: string) {
  expect(row.template).toEqual({
    key: variant,
    version: "1",
    variables: expect.any(Object),
  });
  expect(row.metadata).toEqual({ variant });
}

describe("resale in-app rows: stored template, re-rendered in Spanish", () => {
  it("listing created", async () => {
    const { deps, create } = makeDeps();
    await notifyListingCreated(deps, {
      listingId: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: EVENT_ID,
      askPriceCents: 2500,
      currency: "usd",
      publicAppUrl: APP,
    });
    const row = rows(create)[0]!;
    expectTemplate(row, "resale.listing-created");
    expect(row.template!.variables).toEqual({
      listingId: LISTING_ID,
      eventTitle: "Test Concert",
      askPriceCents: 2500,
      currency: "usd",
      listingUrl: "https://ithasfire.com/my/resale",
    });
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("Entrada publicada en reventa");
    expect(es.body).toBe("Tu entrada para Test Concert ya está en reventa a $25.00.");
    expect(es.action).toEqual({
      label: "Ver anuncio",
      href: "https://ithasfire.com/my/resale",
    });
  });

  it("claim opened", async () => {
    const { deps, create } = makeDeps();
    await notifyClaimOpened(deps, {
      claimId: CLAIM_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      kind: "entry_denied",
      deadline: "2026-03-13T12:00:00.000Z",
      publicAppUrl: APP,
    });
    const row = rows(create)[0]!;
    expectTemplate(row, "resale.claim-opened");
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("Presentaron una reclamación sobre tu venta");
    expect(es.body).toBe(
      "Quien compró tu entrada de reventa para Test Concert presentó una reclamación por «acceso denegado». Responde con tu versión lo antes posible: el equipo de soporte puede resolver la reclamación en cualquier momento.",
    );
    expect(es.action?.label).toBe("Ver reclamación");
  });

  it("claim resolved: both rows", async () => {
    const { deps, create } = makeDeps();
    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "approved",
      resolution: "full_refund",
      publicAppUrl: APP,
    });
    const [buyer, seller] = rows(create);
    expectTemplate(buyer!, "resale.claim-resolved");
    expectTemplate(seller!, "resale.claim-resolved");
    expect(buyer!.template!.variables).toMatchObject({ audience: "buyer" });
    expect(seller!.template!.variables).toMatchObject({ audience: "seller" });
    expect(renderStoredNotification({}, stored(buyer!), "es").body).toBe(
      "Tu reclamación sobre la entrada de reventa para Test Concert fue aprobada. Se procesará un reembolso completo.",
    );
    expect(renderStoredNotification({}, stored(seller!), "es").title).toBe(
      "Reclamación resuelta: se emitió un reembolso",
    );
  });

  it("seller sold", async () => {
    const { deps, create } = makeDeps();
    await notifyResaleSellerSold(deps, {
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      publicAppUrl: APP,
    });
    const row = rows(create)[0]!;
    expectTemplate(row, "resale.seller-sold");
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("¡Vendiste tu entrada!");
    expect(es.body).toBe(
      "Tu entrada para Test Concert se vendió por $42.50. El pago se procesará después del evento.",
    );
    expect(es.action).toEqual({
      label: "Ver detalles",
      href: "https://ithasfire.com/my/resale",
    });
  });
});
