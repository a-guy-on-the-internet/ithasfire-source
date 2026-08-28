import type { PrismaClient } from "@prisma/client";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import {
  saveEventForOrg,
  saveEventForHuman,
  publishEvent,
  type PublishEventInput,
} from "@th/core/use-cases/events";
import { hashEventPassword } from "@th/core/lib/security/event-password";
import { upsertTicketType } from "@th/core/use-cases/ticket-types/upsert-ticket-type";

import { DEMO_IDS } from "./ids.js";
import { ensureSeedPrimaryPayoutLine } from "./finance.js";
import {
  slugify,
  buildStartDate,
  seededCoordsForFixture,
  createInMemoryIdempotency,
} from "./utils.js";
import { buildSeedEventBody, DEMO_EVENT_IMAGES } from "./fixtures.js";
import type { EventSeedFixture, HumanEventFixture } from "./fixtures.js";

// Realistic US admission/amusement tax rates (basis points) for seed regions.
// These approximate the combined state + local entertainment tax.
const REGION_TAX_RATE_BPS: Record<string, number> = {
  "ca-sf": 862, // ~8.625% (CA state + SF local)
  "ny-nyc": 888, // ~8.875% (NY state + NYC local)
  "tx-aus": 825, // ~8.25%  (TX state + Austin local)
};

const SEED_HOST_ATTESTATION = {
  legalRightToHost: true,
  zoningAndNoiseCompliance: true,
  alcoholCompliance: true,
  taxResponsibility: true,
  organizerFaqReviewed: true,
} satisfies NonNullable<PublishEventInput["attestation"]>;

// ── Org-owned events ─────────────────────────────────────────────────────

export const upsertEventWithTickets = async (
  prisma: PrismaClient,
  fixture: EventSeedFixture,
  options: {
    categoryId: string;
    orgPayeeMap: Record<string, { payeeId: string; agreementId: string }>;
    fixtureIndex: number;
  },
) => {
  const orgId = fixture.orgId ?? DEMO_IDS.org;
  const actorHumanId = fixture.actorHumanId ?? DEMO_IDS.human;
  const orgPayee = options.orgPayeeMap[orgId];
  if (!orgPayee) throw new Error(`No payee/agreement found for org ${orgId}`);

  const startsAt = buildStartDate(fixture.daysFromNow, fixture.startHour);
  const endsAt = new Date(
    startsAt.getTime() + fixture.durationHours * 60 * 60 * 1000,
  );
  const coords = seededCoordsForFixture(fixture.regionCode, fixture.slug);

  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const idempotency = createInMemoryIdempotency();
  const deps = { repos, clock, idempotency };

  // De-dupe by slug: if it already exists, update that event via use-case.
  const existing = await prisma.event.findUnique({
    where: { slug: fixture.slug },
    select: { id: true, status: true },
  });

  // The canonical draft upsert can only update DRAFT events.
  // On re-runs, we might already have PUBLISHED/COMPLETED/CANCELLED events.
  // For seed determinism, delete and recreate in those cases.
  if (existing && existing.status && existing.status !== "DRAFT") {
    await prisma.event.delete({ where: { id: existing.id } });
  }

  const draft = await saveEventForOrg(deps, {
    eventId: existing && existing.status === "DRAFT" ? existing.id : undefined,
    orgId,
    actorHumanId,
    title: fixture.title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    location: fixture.placeId
      ? { placeId: fixture.placeId }
      : {
          addressText: fixture.addressText,
          lat: coords.lat,
          lng: coords.lng,
        },
    content: buildSeedEventBody(fixture.title, options.fixtureIndex),
    clientKey: `seed-event:${fixture.slug}`,
  });

  // Ensure required publish preconditions
  await prisma.event.update({
    where: { id: draft.eventId },
    data: {
      categoryId: options.categoryId,
      countryCode: "US",
    },
  });

  // publishEvent expects an ACTIVE PRIMARY payout terms linked to the event.
  // `saveEventForOrg` snapshots the org's default PayoutTerms into an
  // event-owned row at creation, so the event already has its own
  // `payoutTermsId`. The fallback below only fires if the org has no default
  // configured (in which case the snapshot was skipped) — and we still add
  // the primary payout line via `ensureSeedPrimaryPayoutLine` referencing
  // `orgPayee.payeeId`.
  const eventForPT = await prisma.event.findUnique({
    where: { id: draft.eventId },
    select: { payoutTermsId: true },
  });
  let eventAgreementId = eventForPT?.payoutTermsId ?? null;
  if (!eventAgreementId) {
    const created = await prisma.payoutTerms.create({
      data: {
        kind: "PRIMARY",
        status: "ACTIVE",
        settlementCurrency: "usd",
        version: 1,
        isDefault: false,
      },
      select: { id: true },
    });
    eventAgreementId = created.id;
    await prisma.event.update({
      where: { id: draft.eventId },
      data: { payoutTermsId: eventAgreementId },
    });
  }

  // Shared org agreements are reused across parallel seed jobs.
  // Avoid delete/recreate so publish preconditions never observe a zero-line gap.
  await ensureSeedPrimaryPayoutLine(prisma, eventAgreementId, orgPayee.payeeId);

  // Ticket types: create via use case so audit/idempotency invariants stay consistent.
  for (const ticket of fixture.tickets) {
    await upsertTicketType(deps, {
      actorHumanId,
      eventId: draft.eventId,
      name: ticket.name,
      priceCents: ticket.priceCents,
      capacity: ticket.capacity,
      clientKey: `seed-tt:${fixture.slug}:${slugify(ticket.name)}`,
    });
  }

  // Publish only when fixture wants it.
  if (fixture.status === "PUBLISHED") {
    await publishEvent(deps, {
      actorHumanId,
      eventId: draft.eventId,
      clientKey: `seed-publish:${fixture.slug}`,
      ipAddress: null,
      userAgent: "seed/events",
      attestation: SEED_HOST_ATTESTATION,
    });

    // Stamp a realistic admission tax rate for local dev.
    // In production this comes from the venue's Place / SavedLocation (Ziptax
    // lookup); seed events don't go through that flow, so we set it directly.
    // Mark the source as "seed" so it's distinguishable from real "ziptax"
    // stamps (and so QA can tell which rows actually exercised the code path).
    const seedTaxBps = REGION_TAX_RATE_BPS[fixture.regionCode] ?? 825;
    await prisma.event.update({
      where: { id: draft.eventId },
      data: { admissionTaxRateBps: seedTaxBps, taxRateSource: "seed" },
    });
  }

  // For non-published fixtures, keep their original status by updating directly.
  if (fixture.status !== "PUBLISHED") {
    await prisma.event.update({
      where: { id: draft.eventId },
      data: { status: fixture.status as any },
    });
  }

  // Ensure visibility/gateType match fixture, and set password hash if PASSWORD gated.
  const now = new Date();
  await prisma.event.update({
    where: { id: draft.eventId },
    data: {
      visibility: fixture.visibility,
      gateType: fixture.gateType,
      ...(fixture.gateType === "PASSWORD" && fixture.gatePassword
        ? {
            passwordHash: hashEventPassword(fixture.gatePassword),
            passwordUpdatedAt: now,
          }
        : {}),
    },
    select: { id: true },
  });

  // If APPLICATION gated, create application form and questions
  if (
    fixture.gateType === "APPLICATION" &&
    fixture.applicationQuestions?.length
  ) {
    const existingForm = await prisma.eventApplicationForm.findFirst({
      where: { eventId: draft.eventId },
    });

    if (!existingForm) {
      const form = await prisma.eventApplicationForm.create({
        data: {
          eventId: draft.eventId,
        },
      });

      for (let i = 0; i < fixture.applicationQuestions.length; i++) {
        const q = fixture.applicationQuestions[i]!;
        await prisma.eventApplicationQuestion.create({
          data: {
            formId: form.id,
            label: q.prompt,
            type: q.type,
            isRequired: true,
            order: i,
          },
        });
      }
    }
  }

  const event = await prisma.event.findUnique({
    where: { id: draft.eventId },
    select: {
      id: true,
      slug: true,
      title: true,
      startsAt: true,
      status: true,
      regionCode: true,
    },
  });
  if (!event) {
    throw new Error(`seed_failed_event_missing:${draft.eventId}`);
  }
  return event as any;
};

// ── Event images ─────────────────────────────────────────────────────────

/**
 * Adds a demo image to an event using Unsplash URLs.
 * Images are rotated based on event index for visual variety.
 * Also sets it as the hero image for the event.
 */
export const ensureEventImage = async (
  prisma: PrismaClient,
  eventId: string,
  eventIndex: number,
) => {
  const imageData = DEMO_EVENT_IMAGES[eventIndex % DEMO_EVENT_IMAGES.length];
  if (!imageData) return;

  const imageKey = `demo-cover-${eventIndex}`;

  const existing = await prisma.image.findUnique({
    where: { ownerId_key: { ownerId: eventId, key: imageKey } },
  });

  let imageId: string;

  if (existing) {
    await prisma.image.update({
      where: { id: existing.id },
      data: {
        publicUrl: imageData.url,
        attached: true,
        attachedAt: new Date(),
      },
    });
    imageId = existing.id;
  } else {
    const newImage = await prisma.image.create({
      data: {
        ownerType: "EVENT",
        ownerId: eventId,
        eventId,
        key: imageKey,
        publicUrl: imageData.url,
        contentType: "image/jpeg",
        attached: true,
        attachedAt: new Date(),
        createdByHumanId: DEMO_IDS.human,
      },
    });
    imageId = newImage.id;
  }

  await prisma.event.update({
    where: { id: eventId },
    data: { heroImageId: imageId },
  });
};

// ── Human-owned (personal) events ────────────────────────────────────────

export const upsertHumanEventWithTickets = async (
  prisma: PrismaClient,
  fixture: HumanEventFixture,
  options: {
    actorHumanId: string;
    categoryId: string;
    payeeId: string;
    fixtureIndex: number;
  },
) => {
  const startsAt = buildStartDate(fixture.daysFromNow, fixture.startHour);
  const endsAt = new Date(
    startsAt.getTime() + fixture.durationHours * 60 * 60 * 1000,
  );
  const coords = seededCoordsForFixture(fixture.regionCode, fixture.slug);

  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const idempotency = createInMemoryIdempotency();
  const deps = { repos, clock, idempotency };

  const existing = await prisma.event.findUnique({
    where: { slug: fixture.slug },
    select: { id: true, status: true },
  });

  // On re-runs, delete non-DRAFT events so we can recreate them cleanly.
  if (existing && existing.status && existing.status !== "DRAFT") {
    await prisma.event.delete({ where: { id: existing.id } });
  }

  const draft = await saveEventForHuman(deps, {
    eventId: existing && existing.status === "DRAFT" ? existing.id : undefined,
    actorHumanId: options.actorHumanId,
    title: fixture.title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    location: {
      addressText: fixture.addressText,
      lat: coords.lat,
      lng: coords.lng,
    },
    clientKey: `seed-hevent:${fixture.slug}`,
    content: buildSeedEventBody(fixture.title, options.fixtureIndex),
  });

  // Set category & country
  await prisma.event.update({
    where: { id: draft.eventId },
    data: {
      categoryId: options.categoryId,
      countryCode: "US",
    },
  });

  // publishEvent expects an ACTIVE PRIMARY payout terms linked to the event.
  const humanEventForPT = await prisma.event.findUnique({
    where: { id: draft.eventId },
    select: { payoutTermsId: true },
  });
  let eventAgreementId = humanEventForPT?.payoutTermsId ?? null;
  if (!eventAgreementId) {
    const created = await prisma.payoutTerms.create({
      data: {
        kind: "PRIMARY",
        status: "ACTIVE",
        settlementCurrency: "usd",
        version: 1,
        isDefault: false,
      },
      select: { id: true },
    });
    eventAgreementId = created.id;
    await prisma.event.update({
      where: { id: draft.eventId },
      data: { payoutTermsId: eventAgreementId },
    });
  }

  await ensureSeedPrimaryPayoutLine(prisma, eventAgreementId, options.payeeId);

  // Ticket types
  for (const ticket of fixture.tickets) {
    await upsertTicketType(deps, {
      actorHumanId: options.actorHumanId,
      eventId: draft.eventId,
      name: ticket.name,
      priceCents: ticket.priceCents,
      capacity: ticket.capacity,
      clientKey: `seed-htt:${fixture.slug}:${slugify(ticket.name)}`,
    });
  }

  // Publish if fixture says so
  if (fixture.status === "PUBLISHED") {
    await publishEvent(deps, {
      actorHumanId: options.actorHumanId,
      eventId: draft.eventId,
      clientKey: `seed-hpublish:${fixture.slug}`,
      ipAddress: null,
      userAgent: "seed/events",
      attestation: SEED_HOST_ATTESTATION,
    });

    // Stamp a realistic admission tax rate for local dev. Source = "seed" so
    // it's distinguishable from real "ziptax" stamps in QA.
    const seedTaxBps = REGION_TAX_RATE_BPS[fixture.regionCode] ?? 825;
    await prisma.event.update({
      where: { id: draft.eventId },
      data: { admissionTaxRateBps: seedTaxBps, taxRateSource: "seed" },
    });
  }

  const event = await prisma.event.findUnique({
    where: { id: draft.eventId },
    select: {
      id: true,
      slug: true,
      title: true,
      startsAt: true,
      status: true,
      regionCode: true,
    },
  });
  if (!event)
    throw new Error(`seed_failed_human_event_missing:${draft.eventId}`);
  return event as any;
};
