import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/types/repos/authz";
import { fail as failApp } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  dealChangeLineParts,
  dealChangeLineSchema,
  type DealChangeLine,
} from "../comms/deal-change-renderers";
import { DEAL_CHANGE_COPY } from "../comms/copy/deals";
import { NOTIFICATION_LOCALES } from "../comms/locale";
import {
  dealCurrency,
  describeDealChange,
  resolvePayeeNames,
  snapshotPayeeIds,
  type EventDealSnapshot,
} from "./_shared/deal-freeze";
import { mayRouteEventPayouts } from "./_shared/deal-target";

// ─────────────────────────────────────────────────────────────────────────────
// listDealChanges (freeze-the-deal FR-007)
//
// An event's frozen changes, newest first. Readers: anyone allowed to edit the
// deal (`mayRouteEventPayouts`, the EVENT deal-write gate), and anyone behind
// a payee on the event's terms now OR in any recorded change, before or after
// (a payee a change removed can still read why). A payee is "theirs" the way
// the change notice reaches them: a HUMAN payee is the actor; an ORGANIZATION
// payee's OWNER, ADMIN or FINANCE members. Nobody else learns the event has a
// deal, let alone what it says (pro-social 4: money stays private to the
// people it concerns): a stranger is refused before anything is read.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The org roles that count as "on the deal" for an ORGANIZATION payee. */
const PAYEE_READER_ORG_ROLES: readonly OrgRole[] = ["OWNER", "ADMIN", "FINANCE"];

export const listDealChangesInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    cursor: z.uuid().nullish(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    /**
     * The language each line's `text` is written in (the reader's). Absent →
     * English. The words are the change notice's own (`DEAL_CHANGE_COPY`), so
     * the deal page and the email never describe one change two ways.
     */
    locale: z.enum(NOTIFICATION_LOCALES).optional(),
  })
  .strict();

/** One changed line: the structured line plus the notice's words for it. */
export const dealChangeItemLineSchema = dealChangeLineSchema
  .extend({
    text: z
      .object({
        /** "Ticket sales, Paper Moth". */
        subject: z.string(),
        /** "10% of ticket money"; "not on the deal" for a line it added. */
        before: z.string(),
        /** "15% of ticket money"; "removed" for a line it took away. */
        after: z.string(),
      })
      .strict(),
  })
  .strict();

export const dealChangeItemSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    createdAt: z.date(),
    /** Null once the person who made the change is deleted. */
    actor: z
      .object({ humanId: z.uuid(), name: z.string().nullable() })
      .strict()
      .nullable(),
    /** What changed, before → after, payees by name. */
    lines: z.array(dealChangeItemLineSchema),
  })
  .strict();

/**
 * The event the history belongs to, for a reader who may not read the event
 * any other way (a payee on the deal page): its name and date, and the
 * freeze the history starts from. Only people the gate let in see it.
 */
export const dealChangesEventSchema = z
  .object({
    title: z.string(),
    startsAt: z.date().nullable(),
    /** The event's IANA zone; dates on the page are the event's local time. */
    timezone: z.string().nullable(),
    /** Null = not frozen (no change has been recorded yet either). */
    dealFrozenAt: z.date().nullable(),
    /** Null = frozen automatically (first publish, the backfill), or not frozen. */
    frozenBy: z
      .object({ humanId: z.uuid(), name: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

export const listDealChangesOutputSchema = z
  .object({
    eventId: z.uuid(),
    event: dealChangesEventSchema,
    items: z.array(dealChangeItemSchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();

export type ListDealChangesInput = z.input<typeof listDealChangesInputSchema>;
export type ListDealChangesOutput = z.infer<typeof listDealChangesOutputSchema>;
export type DealChangeItem = z.infer<typeof dealChangeItemSchema>;

export type ListDealChangesDeps = {
  repos: Pick<Repos, "events" | "authz" | "deals" | "payees" | "humans" | "organizations">;
};

export async function listDealChanges(
  deps: ListDealChangesDeps,
  rawInput: unknown,
): Promise<ListDealChangesOutput> {
  const input = parseInput(listDealChangesInputSchema, rawInput);
  const { repos } = deps;

  const event = await repos.events.getById(input.eventId);
  if (!event) throw failApp("EVENT_NOT_FOUND");

  const owner = { orgId: event.orgId ?? null, humanId: event.humanId ?? null };
  const isEditor = await mayRouteEventPayouts(repos.authz, owner, input.actorHumanId);
  if (!isEditor && !(await isPayeeOnEvent(repos, event, input.actorHumanId))) {
    // Same refusal whether or not the event has any changes.
    throw failApp("INSUFFICIENT_ROLE");
  }

  const page = await repos.deals.listDealChanges({
    eventId: event.id,
    limit: input.limit ?? DEFAULT_LIMIT,
    cursor: input.cursor ?? null,
  });

  const frozenById = event.dealFrozenByHumanId ?? null;
  const actorIds = [
    ...new Set(
      [...page.items.map((c) => c.actorHumanId), frozenById].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const actors = actorIds.length ? await repos.humans.getByIds(actorIds) : [];
  const actorName = new Map(actors.map((h) => [h.id, h.name?.trim() || null]));

  const payeeIds = [
    ...new Set(page.items.flatMap((c) => [...snapshotPayeeIds(c.before), ...snapshotPayeeIds(c.after)])),
  ];
  const names = await resolvePayeeNames(repos, payeeIds);

  const copy = DEAL_CHANGE_COPY[input.locale ?? "en"];
  const items: DealChangeItem[] = page.items.map((c) => {
    const before = c.before as EventDealSnapshot;
    const after = c.after as EventDealSnapshot;
    const currency = dealCurrency({ before, after }, event.currency ?? null);
    return {
      id: c.id,
      eventId: c.eventId,
      createdAt: c.createdAt,
      actor: c.actorHumanId
        ? { humanId: c.actorHumanId, name: actorName.get(c.actorHumanId) ?? null }
        : null,
      lines: describeDealChange(before, after).map((d) => {
        const line: DealChangeLine = {
          section: d.section,
          payeeName: d.payeeId ? (names.get(d.payeeId) ?? null) : null,
          label: d.label ? d.label.slice(0, 300) : null,
          before: d.before,
          after: d.after,
        };
        return { ...line, text: dealChangeLineParts(copy, line, currency) };
      }),
    };
  });

  return listDealChangesOutputSchema.parse({
    eventId: event.id,
    event: {
      title: event.title ?? "",
      startsAt: event.startsAt ?? null,
      timezone: event.timezone ?? null,
      dealFrozenAt: event.dealFrozenAt ?? null,
      frozenBy: frozenById
        ? { humanId: frozenById, name: actorName.get(frozenById) ?? null }
        : null,
    },
    items,
    nextCursor: page.nextCursor,
  });
}

/**
 * Is the actor behind a payee on the event's terms (PRIMARY or RESALE, now),
 * or on either side of any recorded change?
 */
async function isPayeeOnEvent(
  repos: ListDealChangesDeps["repos"],
  event: { id: string; payoutTermsId?: string | null; resalePayoutTermsId?: string | null },
  actorHumanId: string,
): Promise<boolean> {
  const payeeIds = new Set<string>();
  for (const termsId of [event.payoutTermsId, event.resalePayoutTermsId]) {
    if (!termsId) continue;
    const deal = await repos.deals.getTermsDeal(termsId);
    if (!deal) continue;
    if (deal.remainderPayeeId) payeeIds.add(deal.remainderPayeeId);
    for (const c of deal.clauses) payeeIds.add(c.payeeId);
    for (const d of deal.deductions) payeeIds.add(d.creditedPayeeId);
  }
  for (const change of await repos.deals.listDealChangeSnapshots(event.id)) {
    for (const id of snapshotPayeeIds(change.before)) payeeIds.add(id);
    for (const id of snapshotPayeeIds(change.after)) payeeIds.add(id);
  }
  if (payeeIds.size === 0) return false;

  const payees = await repos.payees.getByIds([...payeeIds]);
  const orgIds: string[] = [];
  for (const p of payees) {
    if (p.subjectType === "HUMAN" && p.subjectId === actorHumanId) return true;
    if (p.subjectType === "ORGANIZATION") orgIds.push(p.subjectId);
  }
  if (orgIds.length === 0) return false;
  const memberships = await repos.authz.getOrgMemberships({
    orgIds: [...new Set(orgIds)],
    humanId: actorHumanId,
  });
  return memberships.some((m) => PAYEE_READER_ORG_ROLES.includes(m.role));
}
