import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { ensurePlatformTerminalLocation } from "./ensure-platform-terminal-location";
import { fail } from "@th/errors";

// ── Schema ───────────────────────────────────────────────────────────────────

export const posMintConnectionTokenInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().min(1),
});

export type PosMintConnectionTokenInput = z.infer<
  typeof posMintConnectionTokenInputSchema
>;

export const posMintConnectionTokenOutputSchema = z.object({
  secret: z.string().min(1),
  /**
   * Stripe Terminal Location ID (`tml_xxx`) the SDK should bind the
   * Tap to Pay reader to. Single platform-level Location under SCT —
   * see `ensurePlatformTerminalLocation` for the why.
   */
  locationId: z.string().min(1),
});

export type PosMintConnectionTokenOutput = z.infer<
  typeof posMintConnectionTokenOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type PosMintConnectionTokenDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Mints a short-lived Stripe Terminal connection token bound to the
 * event's org Connect account.
 *
 * Authorisation: actor must hold a scanner-eligible role (ORG_SCAN_ROLES)
 * on the event's org. Operators cannot mint a token for an org they do not
 * belong to (NFR-002).
 *
 * The returned `secret` MUST NOT be logged and MUST NOT be persisted —
 * the caller hands it straight to the Stripe Terminal RN SDK.
 *
 * @throws `not_found` — eventId does not exist
 * @throws `forbidden` — actor lacks scanner role on the event's org, or
 *   the event is not org-owned (personal events have no Payee)
 * @throws `invalid_input` — org has no Payee / no stripeAccountId yet
 *   (Connect onboarding has not run)
 */
export async function posMintConnectionToken(
  deps: PosMintConnectionTokenDeps,
  rawInput: unknown,
): Promise<PosMintConnectionTokenOutput> {
  const input = parseInput(posMintConnectionTokenInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  const access = await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  if (access.via === "platform_admin") {
    await deps.repos.audit.log({
      entity: "pos_terminal",
      entityId: input.eventId,
      action: "pos.mint_connection_token.platform_admin_override",
      at: deps.clock.now(),
      data: {
        actorHumanId: input.actorHumanId,
        eventId: input.eventId,
        orgId: event.orgId,
      },
    });
  }

  const payeeRef = await deps.repos.payees.getBySubject({
    type: "ORGANIZATION",
    id: event.orgId,
  });
  if (!payeeRef) {
    throw fail("PAYEE_NOT_CONNECTED");
  }

  const payee = await deps.repos.payees.getById(payeeRef.id);
  if (!payee?.stripeAccountId) {
    throw fail("PAYEE_MISSING_STRIPE_ACCOUNT");
  }

  const [token, location] = await Promise.all([
    deps.payments.createTerminalConnectionToken({
      stripeAccountId: payee.stripeAccountId,
    }),
    ensurePlatformTerminalLocation({
      repos: deps.repos,
      payments: deps.payments,
      logger: deps.logger,
    }),
  ]);

  deps.logger?.info("pos.connection_token.minted", {
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
    orgId: event.orgId,
    payeeId: payee.id,
    locationId: location.locationId,
    // intentionally NOT logging the secret
  });
  deps.metrics?.increment("pos.connection_token.minted", {
    eventId: input.eventId,
  });

  return posMintConnectionTokenOutputSchema.parse({
    secret: token.secret,
    locationId: location.locationId,
  });
}
