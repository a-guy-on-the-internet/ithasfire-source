/**
 * Export Event Attendees
 *
 * CSV-shaped dump of the attendee list for one event. Deliberately a separate
 * use case from `searchEventAttendees` rather than a flag on it, for two
 * reasons that pull in opposite directions:
 *
 *  - The GATE IS NARROWER. Reading the door list is edit-OR-finance (running
 *    the event includes seeing who is coming). Taking a copy of it is
 *    finance-only. Bulk egress of buyer names and emails outlives the session
 *    and leaves the building; it is not the same right as paging through the
 *    same rows on screen.
 *  - The ACT IS RECORDED. This writes an audit entry; the paged read does not.
 *    That is the point of separating them — the log is what makes the export
 *    answerable after the fact, and it would be meaningless if every table
 *    render also wrote one.
 */
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { orderSourceSchema, orderStatusSchema } from "@th/schema";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES } from "../../lib/rbac";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on one synchronous export.
 *
 * `EXPORT_BACKGROUND_THRESHOLD` in the web app is 25k — the point at which an
 * export is meant to become a job rather than a response. This sits below it so
 * the ceiling is enforced server-side too, and `truncated` tells the caller it
 * happened instead of silently handing back a short file.
 */
export const ATTENDEE_EXPORT_MAX_ROWS = 10_000;

/** Page size used to walk the repo. Matches the repo's own max. */
const EXPORT_PAGE_SIZE = 200;

export const exportEventAttendeesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    orgId: z.string().uuid(),
    eventId: z.string().uuid(),
    /**
     * Same narrowing the on-screen table is showing. An export that ignored
     * the active filters would hand back a different dataset than the one the
     * user is looking at — and would make the audit entry describe something
     * other than what left.
     */
    query: z.string().max(200).default(""),
    status: orderStatusSchema.optional(),
  })
  .strict();

const exportRowSchema = z
  .object({
    orderId: z.string().uuid(),
    buyerName: z.string().nullable(),
    buyerEmail: z.string().email().nullable(),
    ticketCount: z.number().int(),
    amountGrossCents: z.number().int(),
    currency: z.string().min(1),
    status: orderStatusSchema,
    source: orderSourceSchema,
    occurredAt: z.coerce.date(),
  })
  .strict();

export const exportEventAttendeesOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    rows: z.array(exportRowSchema),
    /** True when the event has more attendees than `ATTENDEE_EXPORT_MAX_ROWS`. */
    truncated: z.boolean(),
    /** Total matching the filter, whether or not it fit in `rows`. */
    total: z.number().int(),
  })
  .strict();

export type ExportEventAttendeesInput = z.infer<
  typeof exportEventAttendeesInputSchema
>;
export type ExportEventAttendeesOutput = z.infer<
  typeof exportEventAttendeesOutputSchema
>;

export type ExportEventAttendeesDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

export async function exportEventAttendees(
  deps: ExportEventAttendeesDeps,
  rawInput: unknown,
): Promise<ExportEventAttendeesOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "exportEventAttendees" });

  const execute = async () => {
    const input = parseInput(exportEventAttendeesInputSchema, rawInput);

    // Finance only — NOT the edit-or-finance set the paged read allows.
    const permission = await callOrDependencyFailed(
      () =>
        deps.authz.hasOrgRole({
          actorHumanId: input.actorHumanId,
          orgId: input.orgId,
          requiredRoles: [...ORG_FINANCE_ROLES],
        }),
      scopedLogger,
      {
        action: "authz.hasOrgRole",
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
      },
    );

    if (!permission.allowed) {
      throw fail("FORBIDDEN");
    }

    // Walk the same repo method the table uses, so the export can never drift
    // from what the screen shows (same filters, same scoping, same status
    // default of SUCCEEDED + PART_REFUNDED).
    const rows: ExportEventAttendeesOutput["rows"] = [];
    let offset = 0;
    let total = 0;

    for (;;) {
      const page = await callOrDependencyFailed(
        () =>
          deps.repos.orders.searchEventAttendees({
            orgId: input.orgId,
            eventId: input.eventId,
            searchQuery: input.query || undefined,
            status: input.status,
            limit: EXPORT_PAGE_SIZE,
            offset,
          }),
        scopedLogger,
        {
          action: "repos.orders.searchEventAttendees",
          orgId: input.orgId,
          eventId: input.eventId,
        },
      );

      total = page.total;
      for (const item of page.items) {
        rows.push({
          orderId: item.orderId,
          buyerName: item.buyerName,
          buyerEmail: item.buyerEmail,
          ticketCount: item.ticketCount,
          amountGrossCents: item.amountGrossCents,
          currency: item.currency,
          status: item.status,
          source: item.source,
          occurredAt: item.occurredAt,
        });
      }

      offset += page.items.length;
      // Stop on a short page (end of data), on an empty page (defensive — a
      // repo that returned 0 forever would loop), or at the ceiling.
      if (
        page.items.length < EXPORT_PAGE_SIZE ||
        offset >= total ||
        rows.length >= ATTENDEE_EXPORT_MAX_ROWS
      ) {
        break;
      }
    }

    const truncated = rows.length < total;
    const exported = rows.slice(0, ATTENDEE_EXPORT_MAX_ROWS);

    // The record that makes this answerable later. Written AFTER the rows are
    // assembled so a failed read never logs a disclosure that didn't happen,
    // and guarded so a logging outage can't block an authorised export.
    try {
      await deps.repos.audit.log({
        entity: "event",
        entityId: input.eventId,
        action: "attendee_export",
        data: {
          orgId: input.orgId,
          actorHumanId: input.actorHumanId,
          rowCount: exported.length,
          total,
          truncated,
          // What the export was narrowed to, so the entry describes the
          // actual disclosure rather than implying the whole list.
          query: input.query || null,
          status: input.status ?? null,
        },
        at: deps.clock.now(),
      });
    } catch (err) {
      scopedLogger?.error("exportEventAttendees.auditLogFailed", { err });
    }

    return exportEventAttendeesOutputSchema.parse({
      eventId: input.eventId,
      rows: exported,
      truncated,
      total,
    });
  };

  return execute();
}
