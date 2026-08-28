import type { PrismaClient } from "@prisma/client";
import { DEMO_IDS } from "./ids.js";

// ─────────────────────────────────────────────────────────────────────────────
// Demo promo codes
//
// Seeds a couple of ORG-scoped promos against the primary demo org so the
// checkout flow has something to apply against. Both are marked `isPublic`
// so they're auto-applyable from URL share-links (?p=WELCOME10) — useful for
// dogfooding the shareable-cart path end to end.
//
// GLOBAL-scoped promos are intentionally NOT seeded here. The use case
// rejects scope=GLOBAL at creation time; the long-term answer for
// platform-wide discounts is account-tied `UserCredit`s, not codes. See
// `docs/specs/2026-05-16/user-credit.spec.md`.
// ─────────────────────────────────────────────────────────────────────────────

export const ensureDemoPromos = async (prisma: PrismaClient) => {
  await prisma.promo.upsert({
    where: { id: DEMO_IDS.promoDemoWelcome },
    update: {
      code: "WELCOME10",
      codeNormalized: "WELCOME10",
      kind: "PERCENT",
      value: 10,
      currency: "usd",
      scope: "ORG",
      scopeId: DEMO_IDS.org,
      status: "ACTIVE",
      stackable: false,
      isPublic: true,
      minOrderCents: 0,
      maxDiscountCents: null,
      maxRedemptions: null,
      maxRedemptionsPerHuman: null,
    },
    create: {
      id: DEMO_IDS.promoDemoWelcome,
      code: "WELCOME10",
      codeNormalized: "WELCOME10",
      kind: "PERCENT",
      value: 10,
      currency: "usd",
      scope: "ORG",
      scopeId: DEMO_IDS.org,
      status: "ACTIVE",
      stackable: false,
      isPublic: true,
      minOrderCents: 0,
    },
  });

  // A second code so we can test promo stacking / private-vs-public mix.
  // EARLYBIRD is a fixed $5 off the order; intentionally NOT public so the
  // URL-seed path (`?p=EARLYBIRD`) treats it as not-found and only manual
  // entry resolves it — useful for exercising the private-code path.
  await prisma.promo.upsert({
    where: { id: DEMO_IDS.promoDemoEarlyBird },
    update: {
      code: "EARLYBIRD",
      codeNormalized: "EARLYBIRD",
      kind: "AMOUNT",
      value: 500,
      currency: "usd",
      scope: "ORG",
      scopeId: DEMO_IDS.org,
      status: "ACTIVE",
      stackable: false,
      isPublic: false,
      minOrderCents: 1000,
      maxDiscountCents: null,
      maxRedemptions: null,
      maxRedemptionsPerHuman: null,
    },
    create: {
      id: DEMO_IDS.promoDemoEarlyBird,
      code: "EARLYBIRD",
      codeNormalized: "EARLYBIRD",
      kind: "AMOUNT",
      value: 500,
      currency: "usd",
      scope: "ORG",
      scopeId: DEMO_IDS.org,
      status: "ACTIVE",
      stackable: false,
      isPublic: false,
      minOrderCents: 1000,
    },
  });
};
