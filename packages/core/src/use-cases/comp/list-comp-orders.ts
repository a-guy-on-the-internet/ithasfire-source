/**
 * List Comp Orders — the read path behind an event's comps ledger.
 *
 * A plain `Order` read (`eventId` + `source = "COMP"`, `occurredAt desc`), NOT
 * a query against the audit log: a product table has no business depending on
 * the audit trail, and the trail is not shaped for paginated reads. The
 * provenance columns promoted in 20260730120000_order_comp_provenance exist
 * precisely so this can be a plain read.
 *
 * ── Authorization: ORG_EDIT_OR_FINANCE_ROLES ────────────────────────────────
 *
 * Deliberately WIDER than issuing (`issueCompTickets` requires
 * ORG_ADMIN_ROLES) and identical to the on-screen door list
 * (`searchEventAttendees`). The split follows the reasoning spelled out in
 * `export-event-attendees.ts`:
 *
 *  - ISSUING a comp gives away inventory and forgoes revenue. That is a
 *    money-shaped write and stays OWNER/ADMIN.
 *  - READING who got in free is part of running the event (an EDITOR working
 *    the door needs it) and part of reconciling it (FINANCE has to explain why
 *    twelve admissions produced $0). It is the same on-screen read right as
 *    the attendee table, which already exposes every one of these recipients
 *    with a COMP badge. The only disclosure this adds over that table is the
 *    organizer-authored reason text and a coworker's name.
 *  - Bulk EGRESS is the narrower right and is NOT granted here — there is no
 *    export in this use case. If one is added it takes its own
 *    ORG_FINANCE_ROLES gate and writes an audit entry, exactly as the attendee
 *    CSV export does.
 *
 * VIEWER and SCANNER are excluded: neither runs nor reconciles the event.
 *
 * ── No audit entry ──────────────────────────────────────────────────────────
 *
 * Rendering a table is not a disclosure event. The export precedent is
 * explicit that the log earns its meaning by recording the copy that leaves
 * the building; logging every page render would drown that signal. The write
 * side is already logged (`comp_issued`), which is what has to be answerable
 * after the fact.
 *
 * ── Two authors, one null ───────────────────────────────────────────────────
 *
 * `createCompOrder` has two callers: `issueCompTickets` (hand-issued, stamps
 * `compReason` + `compIssuedByHumanId`) and `grantVolunteerReward` (fired by a
 * reward trigger, leaves both null). A comp issued before the provenance
 * columns existed ALSO has both null. So `reason == null` carries two
 * completely different meanings and the UI must never be the thing that tries
 * to tell them apart. `origin` below is derived server-side from the presence
 * of a VolunteerRewardGrant referencing the order — the only fact that
 * actually separates them.
 */
import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  buildOffsetPaginatedResult,
  offsetPaginatedResultSchema,
  offsetPaginationInputSchema,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";
import { orderStatusSchema } from "@th/schema";
import { fail } from "@th/errors";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import {
  ORG_EDIT_OR_FINANCE_ROLES,
  requireOrgMembership,
} from "../../lib/rbac";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Comps run to tens per event, so one default page is normally the whole
 * ledger. The cap still exists because "normally" is not an access control:
 * `offsetPaginationInputSchema` carries `.max(OFFSET_MAX_LIMIT)` (200), so an
 * oversized `limit` is REJECTED at `parseInput` as invalid_input — it never
 * reaches `sanitizeOffsetPagination`, which here only supplies the default.
 * Either way the list can never come back unbounded.
 */
export const listCompOrdersInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
  })
  .merge(offsetPaginationInputSchema)
  .strict();

/**
 * How the comp came to exist. DERIVED server-side, never stored — see the
 * docblock above for why the UI cannot infer this from a null reason.
 */
export const compOrderOriginSchema = z.enum([
  "HAND_ISSUED",
  "VOLUNTEER_REWARD",
]);

export type CompOrderOrigin = z.infer<typeof compOrderOriginSchema>;

const compOrderTicketTypeSchema = z
  .object({
    ticketTypeId: z.string().uuid(),
    name: z.string().nullable(),
    quantity: z.number().int().nonnegative(),
  })
  .strict();

const compOrderRowSchema = z
  .object({
    orderId: z.string().uuid(),
    occurredAt: z.coerce.date(),
    /** CANCELLED shows up here — a revoked volunteer reward voids its comp. */
    status: orderStatusSchema,
    recipientHumanId: z.string().uuid(),
    recipientName: z.string().nullable(),
    recipientEmail: z.string().nullable(),
    ticketTypes: z.array(compOrderTicketTypeSchema),
    /**
     * Tickets on the comp, summed over the order's `kind = "ticket"` LINES.
     *
     * Note this deliberately diverges from `searchEventAttendees`, which
     * reports `_count.tickets` (minted Ticket rows). For the same order the two
     * can disagree — voiding a revoked reward's Ticket does not delete the
     * order line. A ledger is a record of what was ISSUED, so lines are the
     * right basis here; a door list counts what can be scanned, so tickets are
     * the right basis there.
     */
    quantity: z.number().int().nonnegative(),
    /**
     * Null means "no typed reason", which is the CORRECT and permanent state
     * for a reward-granted comp. Read it together with `origin`, never alone.
     */
    reason: z.string().nullable(),
    origin: compOrderOriginSchema,
    /**
     * Null on every VOLUNTEER_REWARD comp (no human issued it) and on
     * HAND_ISSUED comps that predate the provenance columns.
     *
     * THIS — not `reason` — is the legacy tell within HAND_ISSUED.
     * `issueCompTickets` ALWAYS stamps the issuer and only `reason` is
     * optional, so:
     *   origin=HAND_ISSUED, issuedByHumanId != null, reason == null
     *     → a modern hand-issue where nobody typed a reason. Not legacy.
     *   origin=HAND_ISSUED, issuedByHumanId == null
     *     → predates the provenance columns; the audit log is its record.
     */
    issuedByHumanId: z.string().nullable(),
    /**
     * Resolved display name. Null COLLAPSES TWO CASES on purpose, because no
     * caller has been shown to need them apart:
     *   - the id resolves to no human at all (`compIssuedByHumanId` carries no
     *     FK by design, so the issuer may have been deleted), and
     *   - the human exists but has a null `name`.
     * Both render as "unknown issuer". `issuedByHumanId` is still non-null in
     * both, so a caller that DOES need to tell them apart can look the id up
     * itself. A missing name never removes the row.
     */
    issuedByName: z.string().nullable(),
  })
  .strict();

export const listCompOrdersOutputSchema =
  offsetPaginatedResultSchema(compOrderRowSchema);

export type ListCompOrdersInput = z.infer<typeof listCompOrdersInputSchema>;
export type ListCompOrdersOutput = z.infer<typeof listCompOrdersOutputSchema>;
export type CompOrderRow = z.infer<typeof compOrderRowSchema>;

export type ListCompOrdersDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

export async function listCompOrders(
  deps: ListCompOrdersDeps,
  rawInput: unknown,
): Promise<ListCompOrdersOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "listCompOrders" });

  const execute = async () => {
    const input = parseInput(listCompOrdersInputSchema, rawInput);
    const { repos } = deps;

    // Owner scope is derived from the EVENT, not taken from the client. That
    // is what makes the eventId-only repo query safe: there is no orgId in the
    // input to mismatch against the event, so an admin of org A cannot read
    // org B's comps by passing B's eventId — the membership check runs against
    // whatever org actually owns the event.
    const event = await callOrDependencyFailed(
      () => repos.events.getById(input.eventId),
      scopedLogger,
      { action: "repos.events.getById", eventId: input.eventId },
    );
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    // No comps on a COMMUNITY listing (owner ruling 2026-10-07), so there is
    // no ledger to read. Refused by stewardship before the role check, for
    // the same reason as `issueCompTickets`: the owner arms refuse an
    // ownerless row only by accident, and must not be what keeps it shut.
    if (event.stewardship === "COMMUNITY") {
      throw fail("EVENT_NOT_TICKETED");
    }

    if (event.orgId) {
      await requireOrgMembership({
        repos,
        orgId: event.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_EDIT_OR_FINANCE_ROLES,
      });
    } else {
      // Personal events have no membership rows. `issueCompTickets` supports
      // them, so the ledger must too — otherwise comps could be issued on a
      // personal event and never read back. The owner, or an edit-role
      // delegate (owner ruling 2026-09-28; FINANCE delegates are not
      // edit-role delegates, so the org arm's FINANCE does not carry over).
      await ensureActorHoldsHumanEventRole(
        repos.authz,
        event.humanId,
        input.actorHumanId,
      );
    }

    const pagination = sanitizeOffsetPagination({
      limit: input.limit,
      offset: input.offset,
    });

    const page = await callOrDependencyFailed(
      () =>
        repos.orders.listEventCompOrders({
          eventId: input.eventId,
          limit: pagination.limit,
          offset: pagination.offset,
        }),
      scopedLogger,
      { action: "repos.orders.listEventCompOrders", eventId: input.eventId },
    );

    // Hydrate issuer names for THIS page only (bounded by the page cap). A
    // separate lookup rather than a join because `compIssuedByHumanId` carries
    // no FK by design — the stamp has to survive the issuer being deleted, and
    // an unresolved id must degrade to a null name, never drop the comp.
    const issuerIds = [
      ...new Set(
        page.items
          .map((item) => item.issuedByHumanId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const issuerNames = new Map<string, string | null>();
    if (issuerIds.length > 0) {
      const humans = await callOrDependencyFailed(
        () => repos.humans.getByIds(issuerIds),
        scopedLogger,
        { action: "repos.humans.getByIds", eventId: input.eventId },
      );
      for (const human of humans) {
        issuerNames.set(human.id, human.name ?? null);
      }
    }

    const items = page.items.map((item) => ({
      orderId: item.orderId,
      occurredAt: item.occurredAt,
      status: item.status,
      recipientHumanId: item.recipientHumanId,
      recipientName: item.recipientName,
      recipientEmail: item.recipientEmail,
      ticketTypes: item.ticketTypes,
      quantity: item.quantity,
      reason: item.reason,
      // THE point of this phase. A reward-granted comp and a hand-issued comp
      // whose provenance was never stamped are both `reason == null` +
      // `issuedByHumanId == null`; only the grant row tells them apart.
      origin: item.hasVolunteerRewardGrant
        ? ("VOLUNTEER_REWARD" as const)
        : ("HAND_ISSUED" as const),
      issuedByHumanId: item.issuedByHumanId,
      issuedByName: item.issuedByHumanId
        ? (issuerNames.get(item.issuedByHumanId) ?? null)
        : null,
    }));

    return listCompOrdersOutputSchema.parse(
      buildOffsetPaginatedResult({
        items,
        total: page.total,
        limit: pagination.limit,
        offset: pagination.offset,
      }),
    );
  };

  if (scopedLogger) {
    return scopedLogger.withTime("listCompOrders", execute);
  }

  return execute();
}
