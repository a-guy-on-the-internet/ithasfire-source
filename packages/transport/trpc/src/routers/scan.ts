import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  resolveScanPayload,
  resolveScanPayloadInputSchema,
} from "@th/core/use-cases/scanning";
import {
  searchOrgTickets,
  searchOrgTicketsInputSchema,
} from "@th/core/use-cases/tickets/search-org-tickets";
import {
  searchVolunteerSignupsForCheckIn,
  searchVolunteerSignupsForCheckInInputSchema,
} from "@th/core/use-cases/volunteering";

import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

function requireActor(ctx: { actorHumanId: string | null }): string {
  if (!ctx.actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return ctx.actorHumanId;
}

/**
 * Placeholder volunteer-scan-token port. The router itself only invokes
 * `verify` indirectly through `resolveScanPayload`, but the procedures here
 * may receive a request before the scan-token port is configured (e.g. on
 * dev environments without the secret). When invoked we throw a typed
 * `not_configured` error; `resolveScanPayload` only swallows known
 * volunteer-token failures (`volunteer_qr_invalid`, `volunteer_qr_expired`)
 * and re-throws operational errors like this one, so a misconfigured
 * environment surfaces immediately to the caller instead of silently
 * routing every scan through the ticket branch.
 */
const unconfiguredScanTokenPort = {
  async sign(): Promise<never> {
    throw {
      code: "not_configured",
      message: "volunteer_scan_token_not_configured",
    } as const;
  },
  async verify(): Promise<never> {
    throw {
      code: "not_configured",
      message: "volunteer_scan_token_not_configured",
    } as const;
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas (strip actorHumanId — injected from ctx)
// ─────────────────────────────────────────────────────────────────────────────

const resolvePayloadInput = resolveScanPayloadInputSchema.omit({
  actorHumanId: true,
});

const searchUnifiedInput = z
  .object({
    eventId: z.string().uuid(),
    /** Free-text query — matched against tickets and volunteer signups. */
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const scanRouter = {
  /**
   * Resolve an opaque scan payload (volunteer token or ticket code) for a
   * specific event. Read-only. The actual mutation (markScanned /
   * checkInVolunteer) is performed by the existing `tickets.scanTicket`
   * and `volunteer.checkIn` mutations after the operator confirms.
   */
  resolvePayload: authedProcedure
    .input(resolvePayloadInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);
      return call(() =>
        resolveScanPayload(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            volunteerScanToken:
              ctx.volunteerScanToken ?? unconfiguredScanTokenPort,
            clock: ctx.clock,
            logger: ctx.logger,
            // `metrics` is intentionally omitted: the trpc context does not
            // (yet) carry a MetricsPort. Telemetry is best-effort and the
            // use case treats `undefined` as a no-op.
          },
          { ...input, actorHumanId },
        ),
      );
    }),

  /**
   * Manual fallback for the unified scanner UI. Fans out a single text query
   * to both the ticket search and the volunteer-signup search and returns
   * each list separately so the UI can render two sections.
   *
   * The two downstream use cases do NOT enforce the same floor, and this
   * comment used to claim they did: `searchOrgTickets` requires
   * ORG_SCAN_ROLES (which admits SCANNER), while
   * `searchVolunteerSignupsForCheckIn` requires the stricter ORG_EDIT_ROLES.
   * So a SCANNER-role operator gets ticket results and an INSUFFICIENT_ROLE
   * from the volunteer half. Both run under `Promise.all`, so that rejection
   * fails the whole procedure — worth knowing before "why does search 403 for
   * my door staff?" gets debugged from scratch.
   */
  searchUnified: authedProcedure
    .input(searchUnifiedInput)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx);

      // Resolve the event's orgId — `searchOrgTickets` is keyed on orgId
      // (covers cross-event lookups in the same org), while volunteer
      // search is event-scoped.
      const event = await call(() =>
        ctx.repos.events.getById(input.eventId).then((e) => {
          if (!e || !e.orgId) {
            throw { code: "not_found", message: "event_not_found" } as const;
          }
          return e;
        }),
      );

      const ticketsInput = searchOrgTicketsInputSchema.parse({
        actorHumanId,
        orgId: event.orgId,
        query: input.query,
        limit: input.limit,
      });
      const volunteersInput = searchVolunteerSignupsForCheckInInputSchema.parse(
        {
          actorHumanId,
          eventId: input.eventId,
          query: input.query,
          limit: input.limit,
        },
      );

      const [tickets, volunteers] = await Promise.all([
        call(() =>
          searchOrgTickets(
            { repos: ctx.repos, logger: ctx.logger },
            ticketsInput,
          ),
        ),
        call(() =>
          searchVolunteerSignupsForCheckIn(
            {
              repos: ctx.repos,
              authz: ctx.authz,
              clock: ctx.clock,
              logger: ctx.logger,
              volunteerScanToken:
                ctx.volunteerScanToken ?? unconfiguredScanTokenPort,
            },
            volunteersInput,
          ),
        ),
      ]);

      return { tickets, volunteers };
    }),
};

export type ScanRouter = typeof scanRouter;
