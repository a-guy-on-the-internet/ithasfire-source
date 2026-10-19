import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";

import { parseInput } from "../../lib/io";
import type { AgreementParty, AgreementSide } from "./_shared/agreement-access";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const agreementStatusSchema = z.enum([
  "DRAFT",
  "PROPOSED",
  "COUNTERED",
  "ACCEPTED",
  "DECLINED",
  "CANCELLED",
  "FULFILLED",
  "EXPIRED",
  "DISPUTED",
]);

export const agreementPartyTypeSchema = z.enum(["human", "organization"]);

export const bookingAgreementSummarySchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    status: agreementStatusSchema,
    title: z.string(),
    placeId: z.uuid().nullable(),
    eventId: z.uuid().nullable(),
    payoutTermsId: z.uuid().nullable(),
    proposerType: agreementPartyTypeSchema,
    proposerId: z.uuid(),
    proposerDisplayName: z.string().nullable(),
    counterpartyType: agreementPartyTypeSchema,
    counterpartyId: z.uuid(),
    counterpartyDisplayName: z.string().nullable(),
    /** Which side the actor controls ("proposer" wins if somehow both). */
    actorSide: z.enum(["proposer", "counterparty"]),
    proposedDate: z.date().nullable(),
    proposedEndDate: z.date().nullable(),
    guaranteeCents: z.number().int().nullable(),
    proposedAt: z.date().nullable(),
    expiresAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export const listBookingAgreementsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    statuses: z.array(agreementStatusSchema).optional(),
  })
  .strict();

export const listBookingAgreementsOutputSchema = z
  .object({
    agreements: z.array(bookingAgreementSummarySchema),
  })
  .strict();

export type BookingAgreementSummary = z.infer<
  typeof bookingAgreementSummarySchema
>;
export type ListBookingAgreementsInput = z.infer<
  typeof listBookingAgreementsInputSchema
>;
export type ListBookingAgreementsOutput = z.infer<
  typeof listBookingAgreementsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListBookingAgreementsDeps = {
  repos: Pick<Repos, "agreements" | "authz" | "humans" | "organizations">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared display-name batching (also used by get-booking-agreement)
// ─────────────────────────────────────────────────────────────────────────────

export function partyKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Batch-resolve display names for a set of polymorphic party/subject refs:
 * one `humans.getByIds` + one `organizations.getByIds` total — never per
 * row (mirrors list-booking-requests). Unresolvable refs fall back to null.
 */
export async function resolvePartyDisplayNames(
  repos: Pick<Repos, "humans" | "organizations">,
  refs: Iterable<AgreementParty>,
): Promise<Map<string, string>> {
  const humanIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const ref of refs) {
    if (ref.type === "human") humanIds.add(ref.id);
    else orgIds.add(ref.id);
  }

  const [humans, orgs] = await Promise.all([
    humanIds.size > 0 ? repos.humans.getByIds([...humanIds]) : [],
    orgIds.size > 0 ? repos.organizations.getByIds([...orgIds]) : [],
  ]);

  const names = new Map<string, string>();
  for (const human of humans) {
    if (human.name) names.set(partyKey("human", human.id), human.name);
  }
  for (const org of orgs) {
    names.set(partyKey("organization", org.id), org.name);
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agreements where the actor is a party: their own human identity plus every
 * org they belong to (any role — listing is a read, not privileged beyond
 * membership; mutations re-check edit-level roles individually).
 */
export async function listBookingAgreements(
  deps: ListBookingAgreementsDeps,
  rawInput: unknown,
): Promise<ListBookingAgreementsOutput> {
  const input = parseInput(listBookingAgreementsInputSchema, rawInput);

  const memberships = await deps.repos.authz.listOrgMembershipsByHumanId({
    humanId: input.actorHumanId,
  });

  const parties: AgreementParty[] = [
    { type: "human", id: input.actorHumanId },
    ...memberships.map(
      (m): AgreementParty => ({ type: "organization", id: m.orgId }),
    ),
  ];
  const partyKeys = new Set(parties.map((p) => partyKey(p.type, p.id)));

  const byId = new Map<string, AgreementRecord>();
  for (const party of parties) {
    const records = await deps.repos.agreements.listByParty({
      partyType: party.type,
      partyId: party.id,
      ...(input.statuses ? { statuses: input.statuses } : {}),
    });
    for (const record of records) byId.set(record.id, record);
  }

  const records = [...byId.values()].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );

  const displayNames = await resolvePartyDisplayNames(
    deps.repos,
    records.flatMap((record): AgreementParty[] => [
      { type: record.proposerType, id: record.proposerId },
      { type: record.counterpartyType, id: record.counterpartyId },
    ]),
  );

  const summaries = records.map((record) =>
    toSummary(record, displayNames, actorSideFor(record, partyKeys)),
  );

  return listBookingAgreementsOutputSchema.parse({ agreements: summaries });
}

function actorSideFor(
  record: AgreementRecord,
  partyKeys: Set<string>,
): AgreementSide {
  return partyKeys.has(partyKey(record.proposerType, record.proposerId))
    ? "proposer"
    : "counterparty";
}

function toSummary(
  record: AgreementRecord,
  displayNames: Map<string, string>,
  actorSide: AgreementSide,
): BookingAgreementSummary {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    placeId: record.placeId,
    eventId: record.eventId,
    payoutTermsId: record.payoutTermsId,
    proposerType: record.proposerType,
    proposerId: record.proposerId,
    proposerDisplayName:
      displayNames.get(partyKey(record.proposerType, record.proposerId)) ??
      null,
    counterpartyType: record.counterpartyType,
    counterpartyId: record.counterpartyId,
    counterpartyDisplayName:
      displayNames.get(
        partyKey(record.counterpartyType, record.counterpartyId),
      ) ?? null,
    actorSide,
    proposedDate: record.proposedDate,
    proposedEndDate: record.proposedEndDate,
    guaranteeCents: record.guaranteeCents,
    proposedAt: record.proposedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
