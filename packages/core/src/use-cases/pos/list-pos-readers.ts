import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireOrgMembership } from "../../lib/rbac";

// ── Schema ───────────────────────────────────────────────────────────────────

export const listPosReadersInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  /**
   * When true, each reader is enriched with its live Stripe connectivity
   * state. Costs one Stripe round-trip per reader, so the settings screen asks
   * for it and the Sell-screen picker (which refetches often) does not.
   */
  includeStatus: z.boolean().default(false),
});

export type ListPosReadersInput = z.infer<typeof listPosReadersInputSchema>;

export const listPosReadersOutputSchema = z.object({
  readers: z.array(
    z.object({
      id: z.string().uuid(),
      stripeReaderId: z.string(),
      label: z.string(),
      placeId: z.string().nullable(),
      deviceType: z.string().nullable(),
      pairedByHumanId: z.string(),
      createdAt: z.date(),
      /** null when not requested, or when the status lookup failed. */
      status: z.enum(["online", "offline"]).nullable(),
      /** True while the reader is mid-action (already collecting a payment). */
      busy: z.boolean().nullable(),
    }),
  ),
});

export type ListPosReadersOutput = z.infer<typeof listPosReadersOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type ListPosReadersDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  /**
   * Deliberate-swallow reporter. A Stripe status lookup that fails degrades
   * the row to `status: null` rather than failing the whole list, so it must
   * be reported explicitly (see the Sentry convention in CLAUDE.md).
   */
  reportError?: ReporterPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Lists the readers paired to an org.
 *
 * Auth: ORG_SCAN_ROLES — anyone who can run a door needs to see the picker.
 * Pairing and unpairing are admin-only; reading the inventory is not.
 *
 * Status enrichment is best-effort: Stripe being slow or down must not stop an
 * operator from seeing their readers, so a failed lookup yields
 * `status: null` (rendered as "unknown") and is reported rather than thrown.
 */
export async function listPosReaders(
  deps: ListPosReadersDeps,
  rawInput: unknown,
): Promise<ListPosReadersOutput> {
  const input = parseInput(listPosReadersInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const rows = await deps.repos.posReaders.listByOrg({ orgId: input.orgId });

  const readers = await Promise.all(
    rows.map(async (row) => {
      const base = {
        id: row.id,
        stripeReaderId: row.stripeReaderId,
        label: row.label,
        placeId: row.placeId,
        deviceType: row.deviceType,
        pairedByHumanId: row.pairedByHumanId,
        createdAt: row.createdAt,
        status: null as "online" | "offline" | null,
        busy: null as boolean | null,
      };

      if (!input.includeStatus) {
        return base;
      }

      try {
        const live = await deps.payments.getTerminalReader({
          readerId: row.stripeReaderId,
        });
        return {
          ...base,
          status: live.status,
          busy: live.action?.status === "in_progress",
        };
      } catch (err) {
        deps.logger?.error("pos.reader.status_lookup_failed", {
          posReaderId: row.id,
          stripeReaderId: row.stripeReaderId,
          err,
        });
        try {
          deps.reportError?.(err, {
            tags: { area: "pos", op: "list_readers_status" },
            extra: { posReaderId: row.id, orgId: input.orgId },
          });
        } catch {
          // A throwing reporter must never change list behaviour.
        }
        return base;
      }
    }),
  );

  return listPosReadersOutputSchema.parse({ readers });
}
