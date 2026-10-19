/**
 * Fire-and-forget notification helpers for resale lifecycle events.
 *
 * Each function sends an in-app notification + email for a specific event.
 * They are called inline from their respective use cases. Failures are
 * logged, never thrown.
 */
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { formatCents } from "../../lib/currency-utils";
import { trimTrailingSlash } from "../../lib/url";
import { buildDirectInAppNotice } from "../comms/direct-in-app";
import {
  resaleClaimOpenedRenderer,
  resaleClaimResolvedRenderer,
  resaleListingCreatedRenderer,
  type ResaleClaimOpenedPayload,
  type ResaleClaimResolvedPayload,
  type ResaleListingCreatedPayload,
} from "../comms/direct-money-safety-renderers";

// ── Shared deps ────────────────────────────────────────────────────────────

export type ResaleNotifyDeps = {
  repos: Repos;
  mailer: MailerPort;
  logger?: LoggerPort;
  /**
   * Reports an in-app row whose render payload could not be stored (it then
   * stays English for every reader); see `buildDirectInAppNotice`.
   */
  reportError?: ReporterPort | null;
};

// ── 1. Listing created (seller confirmation) ───────────────────────────────

export async function notifyListingCreated(
  deps: ResaleNotifyDeps,
  params: {
    listingId: string;
    sellerHumanId: string;
    eventId: string;
    askPriceCents: number;
    currency: string;
    publicAppUrl: string;
  },
): Promise<void> {
  const logger = deps.logger?.child({ notify: "listing_created" });

  try {
    const [sellerWithIdentity, event] = await Promise.all([
      deps.repos.humans.getByIdWithIdentity(params.sellerHumanId),
      deps.repos.events.getById(params.eventId),
    ]);

    if (!sellerWithIdentity) {
      logger?.warn("notify.listing_created.seller_not_found", {
        sellerHumanId: params.sellerHumanId,
      });
      return;
    }

    const { identity } = sellerWithIdentity;
    const eventTitle = event?.title ?? "your event";
    const formattedPrice = formatCents(params.askPriceCents, params.currency);
    const url = `${trimTrailingSlash(params.publicAppUrl)}/my/resale`;

    // In-app notification (English text + template for the reader's
    // language: comms/direct-money-safety-renderers.ts)
    const payload: ResaleListingCreatedPayload = {
      listingId: params.listingId,
      eventTitle: event?.title ?? null,
      askPriceCents: params.askPriceCents,
      currency: params.currency,
      listingUrl: url,
    };
    const row = buildDirectInAppNotice(
      { logger, reportError: deps.reportError },
      resaleListingCreatedRenderer,
      payload,
      { useCase: "resale.notifyListingCreated" },
    );
    await deps.repos.notifications?.create({
      humanId: params.sellerHumanId,
      title: row.title,
      body: row.body,
      kind: row.kind,
      metadata: { variant: row.variant },
      tags: ["resale", "listing"],
      ...(row.action ? { action: row.action } : {}),
      template: row.template ?? null,
    });

    // Email
    await deps.mailer.send({
      to: { to: identity.email },
      subject: `Your ticket for ${eventTitle} is listed for resale`,
      text: [
        `Your ticket for ${eventTitle} is now listed for resale at ${formattedPrice}.`,
        "",
        "What happens next:",
        "  - Buyers can now see your listing and purchase it.",
        `  - You can manage or cancel your listing at ${url}`,
        "  - You'll be notified when your ticket sells.",
        "",
        "Thanks for using Ithas Fire!",
      ].join("\n"),
      idempotencyKey: `resale-listing-created:${params.listingId}`,
    });

    logger?.info("notify.listing_created.sent", {
      listingId: params.listingId,
      sellerEmail: identity.email,
    });
  } catch (err) {
    logger?.warn("notify.listing_created.failed", {
      error: err instanceof Error ? err.message : String(err),
      listingId: params.listingId,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "resale.notifyListingCreated" },
        extra: { listingId: params.listingId },
      });
    } catch {
      // A throwing reporter must never change the (swallowed) outcome.
    }
  }
}

// ── 2. Claim opened (notify seller) ────────────────────────────────────────

export async function notifyClaimOpened(
  deps: ResaleNotifyDeps,
  params: {
    claimId: string;
    respondentId: string;
    eventId: string;
    kind: string;
    deadline: string;
    publicAppUrl: string;
  },
): Promise<void> {
  const logger = deps.logger?.child({ notify: "claim_opened" });

  try {
    const [sellerWithIdentity, event] = await Promise.all([
      deps.repos.humans.getByIdWithIdentity(params.respondentId),
      deps.repos.events.getById(params.eventId),
    ]);

    if (!sellerWithIdentity) {
      logger?.warn("notify.claim_opened.seller_not_found", {
        respondentId: params.respondentId,
      });
      return;
    }

    const { identity } = sellerWithIdentity;
    const eventTitle = event?.title ?? "your event";
    const url = `${trimTrailingSlash(params.publicAppUrl)}/my/resale/claims/${params.claimId}`;

    // In-app notification (English text + template for the reader's
    // language: comms/direct-money-safety-renderers.ts)
    const payload: ResaleClaimOpenedPayload = {
      claimId: params.claimId,
      eventTitle: event?.title ?? null,
      claimKind: params.kind,
      deadlineIso: params.deadline,
      claimUrl: url,
    };
    const row = buildDirectInAppNotice(
      { logger, reportError: deps.reportError },
      resaleClaimOpenedRenderer,
      payload,
      { useCase: "resale.notifyClaimOpened" },
    );
    await deps.repos.notifications?.create({
      humanId: params.respondentId,
      title: row.title,
      body: row.body,
      kind: row.kind,
      metadata: { variant: row.variant },
      tags: ["resale", "claim"],
      ...(row.action ? { action: row.action } : {}),
      template: row.template ?? null,
    });

    // Email
    await deps.mailer.send({
      to: { to: identity.email },
      subject: `A claim has been filed against your resale ticket for ${eventTitle}`,
      text: [
        `A buyer has filed a claim on the ticket you sold for ${eventTitle}.`,
        "",
        `  Claim type: ${params.kind.replace(/_/g, " ")}`,
        "",
        "What you should do:",
        `  - Review the claim details at ${url}`,
        "  - Reply with your side as soon as you can. You can reply until support decides the claim, and support can decide it at any time.",
        "",
        "Ithas Fire Support",
      ].join("\n"),
      idempotencyKey: `resale-claim-opened:${params.claimId}`,
    });

    logger?.info("notify.claim_opened.sent", {
      claimId: params.claimId,
      sellerEmail: identity.email,
    });
  } catch (err) {
    logger?.warn("notify.claim_opened.failed", {
      error: err instanceof Error ? err.message : String(err),
      claimId: params.claimId,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "resale.notifyClaimOpened" },
        extra: { claimId: params.claimId },
      });
    } catch {
      // A throwing reporter must never change the (swallowed) outcome.
    }
  }
}

// ── 3. Claim resolved (notify both buyer + seller) ─────────────────────────

export async function notifyClaimResolved(
  deps: ResaleNotifyDeps,
  params: {
    claimId: string;
    claimantId: string;
    respondentId: string;
    eventId: string;
    status: "approved" | "denied";
    resolution: string | null;
    publicAppUrl: string;
  },
): Promise<void> {
  const logger = deps.logger?.child({ notify: "claim_resolved" });

  try {
    const [buyerWithIdentity, sellerWithIdentity, event] = await Promise.all([
      deps.repos.humans.getByIdWithIdentity(params.claimantId),
      deps.repos.humans.getByIdWithIdentity(params.respondentId),
      deps.repos.events.getById(params.eventId),
    ]);

    const eventTitle = event?.title ?? "your event";
    const url = `${trimTrailingSlash(params.publicAppUrl)}/my/resale/claims/${params.claimId}`;

    const resolvedPayload = (
      audience: ResaleClaimResolvedPayload["audience"],
    ): ResaleClaimResolvedPayload => ({
      claimId: params.claimId,
      eventTitle: event?.title ?? null,
      audience,
      status: params.status,
      resolution: params.resolution,
      claimUrl: url,
    });

    // ── Notify buyer (claimant) ────────────────────────────────────────
    if (buyerWithIdentity) {
      const { identity: buyerIdentity } = buyerWithIdentity;

      // The email reuses the English in-app title/body, as it always has.
      const buyerRow = buildDirectInAppNotice(
        { logger, reportError: deps.reportError },
        resaleClaimResolvedRenderer,
        resolvedPayload("buyer"),
        { useCase: "resale.notifyClaimResolved" },
      );
      const buyerTitle = buyerRow.title;
      const buyerBody = buyerRow.body;

      await deps.repos.notifications?.create({
        humanId: params.claimantId,
        title: buyerTitle,
        body: buyerBody,
        kind: buyerRow.kind,
        metadata: { variant: buyerRow.variant },
        tags: ["resale", "claim"],
        ...(buyerRow.action ? { action: buyerRow.action } : {}),
        template: buyerRow.template ?? null,
      });

      await deps.mailer.send({
        to: { to: buyerIdentity.email },
        subject: `Claim update: ${buyerTitle.toLowerCase()} — ${eventTitle}`,
        text: [
          buyerBody,
          "",
          `View full details: ${url}`,
          "",
          "Ithas Fire Support",
        ].join("\n"),
        idempotencyKey: `resale-claim-resolved-buyer:${params.claimId}`,
      });

      logger?.info("notify.claim_resolved.buyer_sent", {
        claimId: params.claimId,
        buyerEmail: buyerIdentity.email,
      });
    }

    // ── Notify seller (respondent) ─────────────────────────────────────
    if (sellerWithIdentity) {
      const { identity: sellerIdentity } = sellerWithIdentity;

      // The email reuses the English in-app title/body, as it always has.
      const sellerRow = buildDirectInAppNotice(
        { logger, reportError: deps.reportError },
        resaleClaimResolvedRenderer,
        resolvedPayload("seller"),
        { useCase: "resale.notifyClaimResolved" },
      );
      const sellerTitle = sellerRow.title;
      const sellerBody = sellerRow.body;

      await deps.repos.notifications?.create({
        humanId: params.respondentId,
        title: sellerTitle,
        body: sellerBody,
        kind: sellerRow.kind,
        metadata: { variant: sellerRow.variant },
        tags: ["resale", "claim"],
        ...(sellerRow.action ? { action: sellerRow.action } : {}),
        template: sellerRow.template ?? null,
      });

      await deps.mailer.send({
        to: { to: sellerIdentity.email },
        subject: `Claim update: ${sellerTitle.toLowerCase()} — ${eventTitle}`,
        text: [
          sellerBody,
          "",
          `View full details: ${url}`,
          "",
          "Ithas Fire Support",
        ].join("\n"),
        idempotencyKey: `resale-claim-resolved-seller:${params.claimId}`,
      });

      logger?.info("notify.claim_resolved.seller_sent", {
        claimId: params.claimId,
        sellerEmail: sellerIdentity.email,
      });
    }
  } catch (err) {
    logger?.warn("notify.claim_resolved.failed", {
      error: err instanceof Error ? err.message : String(err),
      claimId: params.claimId,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "resale.notifyClaimResolved" },
        extra: { claimId: params.claimId },
      });
    } catch {
      // A throwing reporter must never change the (swallowed) outcome.
    }
  }
}
