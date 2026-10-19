import { z } from "zod";
import escapeHtml from "escape-html";
import { prosemirrorDocSchema } from "@th/schema";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput, describeError } from "../../lib/io";
import { eventPublicPath } from "../../lib/public-urls";
import { sanitizeAnnouncementHtml } from "../../lib/announcement-html";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { requireOwnerAccess, ORG_EDIT_ROLES } from "../../lib/rbac";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";
import {
  assertAudienceOwnedBy,
  MAX_AUDIENCE_FILTER_IDS,
} from "./audience-ownership";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  generateUnsubscribeToken,
  generateWaitlistUnsubscribeToken,
  generateOrgUnsubscribeToken,
} from "./unsubscribe-from-audience";
import { enforceQuota, incrementResourceUsage } from "../quotas/enforce-quota";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum HTML body size in bytes (~150 KB, matches industry standard). */
const MAX_BODY_HTML_BYTES = 150_000;

/** Maximum recipients per single announcement dispatch. */
const MAX_RECIPIENTS = 10_000;

const audienceTypeSchema = z.enum([
  "ALL_TICKET_HOLDERS",
  "EVENT_TICKET_HOLDERS",
  "MULTIPLE_EVENTS",
  "EVENT_TICKET_TIER",
  "CONTACT_LIST",
  "WAITLIST_SUBSCRIBERS",
]);

const audienceFilterSchema = z
  .union([
    z.object({
      eventIds: z
        .array(z.string().uuid())
        .min(1)
        .max(MAX_AUDIENCE_FILTER_IDS),
    }),
    z.object({
      eventId: z.string().uuid(),
      tierIds: z.array(z.string().uuid()).min(1).max(MAX_AUDIENCE_FILTER_IDS),
    }),
  ])
  .optional()
  .nullable();

export const sendAnnouncementInputBaseSchema = z
  .object({
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    subject: plainTextRequired(200),
    // Strict ProseMirror validation: any nested `mediaEmbed` nodes are
    // recursively checked against the strict media-embed allowlist.
    bodyDoc: prosemirrorDocSchema,
    bodyHtml: z
      .string()
      .min(1)
      .refine(
        (html) =>
          new TextEncoder().encode(html).byteLength <= MAX_BODY_HTML_BYTES,
        {
          message: `Email body must be under ${Math.round(MAX_BODY_HTML_BYTES / 1_000)} KB`,
        },
      ),
    audienceType: audienceTypeSchema,
    audienceRef: z.string().uuid().optional(),
    audienceFilter: audienceFilterSchema,
    excludedContactListId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(8).optional(),
  })
  .strict();

export const sendAnnouncementInputSchema =
  sendAnnouncementInputBaseSchema.refine(
    (data) => {
      if (data.audienceType === "EVENT_TICKET_HOLDERS" && !data.audienceRef) {
        return false;
      }
      if (data.audienceType === "CONTACT_LIST" && !data.audienceRef) {
        return false;
      }
      if (data.audienceType === "WAITLIST_SUBSCRIBERS" && !data.audienceRef) {
        return false;
      }
      if (data.audienceType === "MULTIPLE_EVENTS") {
        const filter = data.audienceFilter as
          | { eventIds?: string[] }
          | null
          | undefined;
        if (!filter?.eventIds?.length) return false;
      }
      if (data.audienceType === "EVENT_TICKET_TIER") {
        const filter = data.audienceFilter as
          | { eventId?: string; tierIds?: string[] }
          | null
          | undefined;
        if (!filter?.eventId || !filter?.tierIds?.length) return false;
      }
      return true;
    },
    {
      message:
        "Audience configuration is incomplete for the selected audience type",
    },
  );

export const sendAnnouncementOutputSchema = z.object({
  id: z.string().uuid(),
  sentAt: z.coerce.date(),
});

export type SendAnnouncementInput = z.infer<typeof sendAnnouncementInputSchema>;
export type SendAnnouncementOutput = z.infer<
  typeof sendAnnouncementOutputSchema
>;

/**
 * Input schema for the background notification dispatch job.
 * Exported for use by `apps/jobs`.
 */
export const announcementNotifyJobInputSchema = z.object({
  announcementId: z.string().uuid(),
  orgId: z.string().uuid(),
  subject: z.string(),
  eventId: z.string().uuid().nullable(),
  humanIds: z.array(z.string().uuid()).min(1),
});

export type AnnouncementNotifyJobInput = z.infer<
  typeof announcementNotifyJobInputSchema
>;

export type SendAnnouncementDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger: LoggerPort;
  mailer?: MailerPort;
  /** Base URL of the public web app (for unsubscribe links). */
  publicAppUrl?: string;
  /** HMAC secret for generating unsubscribe tokens. */
  unsubscribeSecret?: string;
  /**
   * Whether the process is running in a production (non-development)
   * environment. Threaded from the transport context (which derives it from
   * `NODE_ENV`). When true, the use case fails-closed rather than degrading:
   * it refuses to dispatch announcement email that lacks a working one-click
   * opt-out, since silently sending such mail is a CAN-SPAM violation.
   */
  isProduction?: boolean;
  /**
   * Physical mailing address included in the email footer for CAN-SPAM
   * compliance (e.g. "123 Main St, Anytown, ST 12345").
   */
  senderPhysicalAddress?: string;
  /**
   * Optional callback to deliver in-app / push notifications to recipients
   * who have an associated humanId. Injected by the transport layer.
   */
  notify?: (input: NotifyInput) => Promise<NotifyOutput>;
  /**
   * Optional callback to enqueue bulk notification dispatch as a background
   * job instead of sending inline. When provided, the use case delegates
   * the per-human notify loop to the jobs service.
   *
   * Payload shape matches `AnnouncementNotifyJobInput`.
   */
  /**
   * Reports a swallowed failure (recipient fetch, batch send, enqueue, …) to
   * the error tracker — CLAUDE.md convention for catch-and-continue branches.
   */
  reportError?: ReporterPort;
  enqueueNotifyJob?: (payload: {
    announcementId: string;
    orgId: string;
    subject: string;
    eventId: string | null;
    humanIds: string[];
  }) => Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────
// CAN-SPAM footer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appends a CAN-SPAM compliant footer to the announcement body HTML.
 *
 * Contains:
 *  - A visible one-click unsubscribe link (when URL available)
 *  - The sender's physical mailing address (when available)
 */
function buildEmailHtmlWithFooter(
  bodyHtml: string,
  unsubscribeUrl: string | null,
  physicalAddress: string | null,
): string {
  const parts: string[] = [];

  if (unsubscribeUrl) {
    parts.push(
      `<a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>`,
    );
  }

  if (physicalAddress) {
    // Escape HTML entities in the address via the maintained `escape-html`
    // package (also escapes `"`/`'`, which is strictly safer inside the span).
    const escaped = escapeHtml(physicalAddress);
    parts.push(`<span style="color:#9ca3af">${escaped}</span>`);
  }

  if (parts.length === 0) return bodyHtml;

  const footer = [
    '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center;line-height:1.6">',
    parts.join(" &middot; "),
    "</div>",
  ].join("");

  return bodyHtml + footer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline notify dispatch (used when no background job is configured)
// ─────────────────────────────────────────────────────────────────────────────

/** Best-effort report of a swallowed failure; a throwing reporter is ignored. */
function reportSwallowed(
  reportError: ReporterPort | undefined,
  error: unknown,
  site: string,
  extra: Record<string, unknown>,
): void {
  try {
    reportError?.(error, {
      tags: { useCase: "sendAnnouncement", site },
      extra,
    });
  } catch {
    // Reporting must never change behaviour.
  }
}

async function dispatchNotificationsInline(
  // `repos` is read-only here: the in-app action needs the event's SLUG.
  deps: Pick<SendAnnouncementDeps, "notify" | "logger" | "repos" | "reportError">,
  announcementId: string,
  input: { subject: string; eventId?: string | null; ownerId: string },
  humanIds: string[],
): Promise<void> {
  const notifyFn = deps.notify;
  if (!notifyFn) return;

  // ONE lookup for the whole audience: the in-app action must route by SLUG
  // (the public event route resolves by slug / slug history only, so an id
  // route 404s). Best-effort — a lookup failure costs the button, not the
  // announcement.
  let eventRoute: string | null = null;
  if (input.eventId) {
    try {
      const event = await deps.repos.events.getById(input.eventId);
      eventRoute = eventPublicPath(event?.slug);
    } catch (error) {
      deps.logger.error("announcement_event_route_failed", {
        eventId: input.eventId,
        error: describeError(error),
      });
      reportSwallowed(deps.reportError, error, "event_route", {
        eventId: input.eventId,
      });
    }
  }

  let notifiedCount = 0;
  let failedCount = 0;
  // First failure only, reported ONCE after the loop: a per-human report
  // would turn one outage into up to MAX_RECIPIENTS Sentry events.
  let firstError: unknown = undefined;

  for (const humanId of humanIds) {
    try {
      await notifyFn({
        humanId,
        variant: "notification.generic",
        payload: {
          category: "organizerMessages",
          body: input.subject,
          kind: "INFO",
          action: eventRoute
            ? { label: "View event", route: eventRoute }
            : undefined,
          metadata: {
            announcementId,
            orgId: input.ownerId,
          },
          tags: ["announcement"],
        },
        scope: { kind: "ORG", orgId: input.ownerId },
      });
      notifiedCount++;
    } catch (notifyError) {
      deps.logger.warn("announcement_notify_failed", {
        announcementId,
        humanId,
        error: describeError(notifyError),
      });
      failedCount++;
      if (firstError === undefined) firstError = notifyError;
    }
  }

  if (failedCount > 0) {
    reportSwallowed(deps.reportError, firstError, "notify", {
      announcementId,
      failedCount,
      notifiedCount,
    });
  }

  deps.logger.info("announcement_notifications_dispatched", {
    announcementId,
    eligibleHumans: humanIds.length,
    notifiedCount,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function sendAnnouncement(
  deps: SendAnnouncementDeps,
  rawInput: unknown,
): Promise<SendAnnouncementOutput> {
  const input = parseInput(sendAnnouncementInputSchema, rawInput);

  // Verified-email gate (security review F8): every announcements.* path
  // mails caller-written content, so an unverified account must not reach it.
  await ensureEmailVerified(deps.repos, input.actorHumanId);

  // ── Sanitize body HTML ────────────────────────────────────────────────
  // The client renders the prose doc to HTML before submitting, but we
  // never trust that string verbatim — a malicious authenticated organizer
  // could otherwise send arbitrary HTML (script tags, tracking pixels,
  // hidden phishing links). Strip everything outside the prose-editor's
  // expected tag/attr surface before persisting or dispatching.
  const bodyHtml = sanitizeAnnouncementHtml(input.bodyHtml);

  // ── RBAC: authorize based on owner type ───────────────────────────────
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  // ── Audience ownership ────────────────────────────────────────────────
  // Owner access alone is not enough: every event / tier / list the audience
  // names must belong to that owner (security review F4, 2026-09-29).
  await assertAudienceOwnedBy(
    deps.repos,
    { ownerType: input.ownerType, ownerId: input.ownerId },
    {
      audienceType: input.audienceType,
      audienceRef: input.audienceRef,
      audienceFilter: input.audienceFilter,
      excludedContactListId: input.excludedContactListId,
      eventId: input.eventId,
    },
  );

  // ── Idempotency guard ─────────────────────────────────────────────────
  const idempotencyKey =
    input.idempotencyKey ?? `announcement:${input.ownerId}:${Date.now()}`;

  const claimed = await deps.idempotency.begin(idempotencyKey, 300);
  if (!claimed) {
    const replay =
      await deps.idempotency.get<SendAnnouncementOutput>(idempotencyKey);
    if (replay) return replay;
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const now = deps.clock.now();

    // ── Count recipients for the preview field ─────────────────────
    const recipientCount =
      await deps.repos.announcements.countAudienceRecipients({
        ownerType: input.ownerType,
        orgId: input.ownerId,
        audienceType: input.audienceType,
        audienceRef: input.audienceRef,
        audienceFilter: input.audienceFilter ?? undefined,
        excludedContactListId: input.excludedContactListId,
      });

    // ── Recipient cap ─────────────────────────────────────────────────
    if (recipientCount > MAX_RECIPIENTS) {
      await deps.idempotency.fail(idempotencyKey).catch(() => {});
      throw {
        code: "invalid_input",
        message: `Audience has ${recipientCount.toLocaleString()} recipients, which exceeds the maximum of ${MAX_RECIPIENTS.toLocaleString()} per announcement`,
      } as const;
    }

    // ── Resolve physical address: prefer per-org, fall back to platform ─
    let resolvedPhysicalAddress: string | null =
      deps.senderPhysicalAddress ?? null;
    try {
      const org = await deps.repos.organizations.getById(input.ownerId);
      if (org?.physicalAddress) {
        resolvedPhysicalAddress = org.physicalAddress;
      }
    } catch (orgFetchError) {
      deps.logger.warn("announcement_org_fetch_for_address_failed", {
        orgId: input.ownerId,
        error: describeError(orgFetchError),
      });
      reportSwallowed(deps.reportError, orgFetchError, "org_fetch_for_address", {
        orgId: input.ownerId,
      });
    }

    // ── Persist announcement ──────────────────────────────────────────
    const announcement = await deps.repos.tx(async (tx) => {
      // ── Quota: enforce daily announcement limit for the org ────────
      await enforceQuota(tx, {
        subjectType: "ORG",
        subjectId: input.ownerId,
        kind: "ANNOUNCEMENTS_PER_DAY",
      });

      const record = await tx.announcements.create({
        orgId: input.ownerId,
        eventId: input.eventId ?? null,
        subject: input.subject,
        bodyDoc: input.bodyDoc,
        bodyHtml,
        audienceType: input.audienceType,
        audienceRef: input.audienceRef ?? null,
        audienceFilter: input.audienceFilter ?? null,
        excludedContactListId: input.excludedContactListId ?? null,
        recipientCount,
        sentAt: now,
        sentBy: input.actorHumanId,
      });

      // Audit log
      await tx.audit.log({
        entity: "announcement",
        entityId: record.id,
        action: "announcement.sent",
        data: {
          actorHumanId: input.actorHumanId,
          orgId: input.ownerId,
          subject: input.subject,
          audienceType: input.audienceType,
          audienceRef: input.audienceRef ?? null,
          audienceFilter: input.audienceFilter ?? null,
          excludedContactListId: input.excludedContactListId ?? null,
          recipientCount,
        },
      });

      // ── Quota: increment daily announcement count ─────────────────
      await incrementResourceUsage(tx, {
        subjectType: "ORG",
        subjectId: input.ownerId,
        kind: "ANNOUNCEMENTS_PER_DAY",
      });

      return record;
    });

    const result: SendAnnouncementOutput = {
      id: announcement.id,
      sentAt: announcement.sentAt!,
    };

    // ── Fetch recipients for dispatch ─────────────────────────────────
    let recipients: Awaited<
      ReturnType<typeof deps.repos.announcements.listAudienceRecipientEmails>
    > = [];
    if (deps.mailer || deps.notify) {
      try {
        recipients = await deps.repos.announcements.listAudienceRecipientEmails(
          {
            ownerType: input.ownerType,
            orgId: input.ownerId,
            audienceType: input.audienceType,
            audienceRef: input.audienceRef,
            audienceFilter: input.audienceFilter ?? undefined,
            excludedContactListId: input.excludedContactListId,
          },
        );
      } catch (fetchError) {
        deps.logger.error("announcement_recipient_fetch_failed", {
          announcementId: announcement.id,
          error: describeError(fetchError),
        });
        reportSwallowed(deps.reportError, fetchError, "recipient_fetch", {
          announcementId: announcement.id,
        });
      }
    }

    // ── Filter out recipients who opted out of announcement emails ───
    // Humans: respect GLOBAL / ORG notification preferences.
    // Anonymous (no humanId): respect the per-org suppression list.
    if (recipients.length > 0) {
      try {
        const humanIds = [
          ...new Set(
            recipients
              .map((r) => r.humanId)
              .filter((id): id is string => id != null),
          ),
        ];
        const anonEmails = recipients
          .filter((r) => r.humanId == null)
          .map((r) => r.email);

        const [prefMap, anonSuppressed] = await Promise.all([
          humanIds.length > 0
            ? deps.repos.notificationPrefs.batchReadAnnouncementEmailEnabled({
                humanIds,
                orgId: input.ownerId,
              })
            : Promise.resolve(new Map<string, boolean>()),
          anonEmails.length > 0
            ? deps.repos.announcements.getAnonymousSuppressedEmails({
                orgId: input.ownerId,
                emails: anonEmails,
              })
            : Promise.resolve(new Set<string>()),
        ]);

        const beforeCount = recipients.length;
        recipients = recipients.filter((r) => {
          if (r.humanId) {
            // Default to enabled when no overriding pref row exists.
            return prefMap.get(r.humanId) !== false;
          }
          return !anonSuppressed.has(r.email.toLowerCase());
        });

        if (recipients.length !== beforeCount) {
          deps.logger.info("announcement_recipients_filtered", {
            announcementId: announcement.id,
            beforeCount,
            afterCount: recipients.length,
            suppressedCount: beforeCount - recipients.length,
          });

          // Persist the actually-dispatched count so the announcement record
          // reflects the filtered set rather than the pre-filter preview.
          try {
            await deps.repos.announcements.updateRecipientCount(
              announcement.id,
              recipients.length,
            );
          } catch (countUpdateError) {
            deps.logger.warn("announcement_recipient_count_update_failed", {
              announcementId: announcement.id,
              error: describeError(countUpdateError),
            });
            reportSwallowed(
              deps.reportError,
              countUpdateError,
              "recipient_count_update",
              { announcementId: announcement.id },
            );
          }
        }
      } catch (filterError) {
        // Fail-closed: if the consent lookup fails (e.g. DB blip) we must NOT
        // fall back to the unfiltered set — that would send to humans/emails
        // who explicitly opted out, which is a consent/legal violation, not a
        // best-effort concern. The announcement record is already persisted,
        // so aborting dispatch here is safe and the send can be retried once
        // the dependency recovers. Logged with a stable, alertable event key.
        deps.logger.error("announcement_recipient_filter_failed", {
          announcementId: announcement.id,
          error: describeError(filterError),
        });
        throw {
          code: "transient",
          message: "announcement dispatch blocked: recipient consent filter failed",
        } as const;
      }
    }

    // ── Dispatch emails to audience ──────────────────────────────────
    if (deps.mailer && recipients.length > 0) {
      // CAN-SPAM fail-closed guard: every announcement email MUST carry a
      // working one-click opt-out (List-Unsubscribe header + visible footer
      // link). Those require both `publicAppUrl` and `unsubscribeSecret`.
      const canBuildUnsubscribeUrls =
        !!deps.publicAppUrl && !!deps.unsubscribeSecret;
      if (!canBuildUnsubscribeUrls) {
        if (deps.isProduction) {
          // In production, refuse to dispatch mail with no opt-out. The
          // announcement record is already persisted, so failing here is safe
          // and retryable once the missing config is supplied.
          deps.logger.error("announcement_unsubscribe_url_unavailable", {
            announcementId: announcement.id,
            hasPublicAppUrl: !!deps.publicAppUrl,
            hasUnsubscribeSecret: !!deps.unsubscribeSecret,
          });
          throw {
            code: "transient",
            message:
              "announcement dispatch blocked: unsubscribe URL unavailable (publicAppUrl/unsubscribeSecret missing)",
          } as const;
        }
        // Development carve-out: keep silent degradation (send without
        // opt-out headers) so local testing without the unsubscribe secret
        // still works. Never reached in any non-development environment.
        deps.logger.warn("announcement_unsubscribe_url_unavailable_dev", {
          announcementId: announcement.id,
        });
      }

      try {
        const BATCH_SIZE = 50;
        let sentCount = 0;
        let failedCount = 0;

        for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
          const batch = recipients.slice(i, i + BATCH_SIZE);
          const emails = batch.map((r) => {
            const headers: Record<string, string> = {};
            // URLs for the List-Unsubscribe header (RFC 2369 allows multiple,
            // comma-separated). Order: most-specific list/waitlist URL first,
            // then the broader org-level opt-out.
            const headerUrls: string[] = [];
            // The most-specific URL drives the visible CAN-SPAM footer link.
            let visibleUnsubUrl: string | null = null;

            const canBuildUrls = !!deps.publicAppUrl && !!deps.unsubscribeSecret;

            // Org-level unsubscribe — applies to EVERY audience type so all
            // recipients get a one-click opt-out (CAN-SPAM compliance).
            let orgUrl: string | null = null;
            if (canBuildUrls) {
              const orgToken = generateOrgUnsubscribeToken(
                deps.unsubscribeSecret!,
                input.ownerId,
                r.email,
              );
              orgUrl = `${deps.publicAppUrl}/unsubscribe?kind=org&orgId=${input.ownerId}&email=${encodeURIComponent(r.email)}&token=${orgToken}`;
            }

            // Contact-list-specific unsubscribe.
            if (r.inviteListId && canBuildUrls) {
              const token = generateUnsubscribeToken(
                deps.unsubscribeSecret!,
                r.inviteListId,
                r.email,
              );
              const listUrl = `${deps.publicAppUrl}/unsubscribe?listId=${r.inviteListId}&email=${encodeURIComponent(r.email)}&token=${token}`;
              headerUrls.push(listUrl);
              visibleUnsubUrl = listUrl;
            }

            // Waitlist-specific unsubscribe.
            if (r.waitlistEventId && canBuildUrls) {
              const token = generateWaitlistUnsubscribeToken(
                deps.unsubscribeSecret!,
                r.waitlistEventId,
                r.email,
              );
              const waitlistUrl = `${deps.publicAppUrl}/unsubscribe?kind=waitlist&eventId=${r.waitlistEventId}&email=${encodeURIComponent(r.email)}&token=${token}`;
              headerUrls.push(waitlistUrl);
              visibleUnsubUrl = waitlistUrl;
            }

            // Always append the org-level URL to the header set.
            if (orgUrl) {
              headerUrls.push(orgUrl);
              // Fall back to the org URL for the visible link when there is no
              // more-specific list/waitlist link.
              if (!visibleUnsubUrl) visibleUnsubUrl = orgUrl;
            }

            if (headerUrls.length > 0) {
              headers["List-Unsubscribe"] = headerUrls
                .map((u) => `<${u}>`)
                .join(", ");
              headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
            }

            // Append CAN-SPAM footer with visible unsubscribe link + physical address
            const html = buildEmailHtmlWithFooter(
              bodyHtml,
              visibleUnsubUrl,
              resolvedPhysicalAddress,
            );

            return {
              to: { to: r.email, name: r.name ?? undefined },
              subject: input.subject,
              html,
              metadata: {
                source: "announcement",
                announcementId: announcement.id,
                orgId: input.ownerId,
              },
              tags: ["announcement"],
              headers: Object.keys(headers).length > 0 ? headers : undefined,
            };
          });

          try {
            const batchResult = await deps.mailer.sendBatch(emails);
            sentCount += batchResult.results.filter((r) => r.success).length;
            failedCount += batchResult.results.filter((r) => !r.success).length;
          } catch (batchError) {
            failedCount += batch.length;
            deps.logger.error("announcement_batch_send_failed", {
              announcementId: announcement.id,
              batchIndex: i,
              error: describeError(batchError),
            });
            reportSwallowed(deps.reportError, batchError, "batch_send", {
              announcementId: announcement.id,
              batchIndex: i,
            });
          }
        }

        deps.logger.info("announcement_emails_dispatched", {
          announcementId: announcement.id,
          totalRecipients: recipients.length,
          sentCount,
          failedCount,
        });
      } catch (dispatchError) {
        // Email dispatch failure should not fail the announcement creation.
        // The record is already persisted; emails can be retried later.
        deps.logger.error("announcement_dispatch_failed", {
          announcementId: announcement.id,
          error: describeError(dispatchError),
        });
        reportSwallowed(deps.reportError, dispatchError, "dispatch", {
          announcementId: announcement.id,
        });
      }
    }

    // ── Dispatch in-app / push notifications ─────────────────────────
    if ((deps.notify || deps.enqueueNotifyJob) && recipients.length > 0) {
      const audienceHumanIds = [
        ...new Set(
          recipients
            .map((r) => r.humanId)
            .filter((id): id is string => id != null),
        ),
      ];
      // B2 (account squatting through guest checkout): every audience here
      // (ticket holders, contact lists, waitlists) reaches a Human through a
      // ticket or an address, and guest checkout attaches both BY EMAIL, so
      // an unverified account may be someone else's. In-app and push go only
      // to accounts that proved their inbox; the email above already went to
      // the address itself.
      //
      // A failed lookup sends no in-app or push (the safe side) and is
      // reported. Throwing here would fail the idempotency key after the
      // emails went out, and a retry would mail everyone again.
      let humanIds: string[] = [];
      if (audienceHumanIds.length > 0) {
        try {
          humanIds = await deps.repos.humans.listEmailVerifiedIds(
            audienceHumanIds,
          );
        } catch (verifiedError) {
          deps.logger.error("announcement_verified_lookup_failed", {
            announcementId: announcement.id,
            error: describeError(verifiedError),
          });
          reportSwallowed(deps.reportError, verifiedError, "verified_lookup", {
            announcementId: announcement.id,
          });
        }
      }

      if (humanIds.length > 0) {
        // Prefer background job when enqueueNotifyJob is available
        if (deps.enqueueNotifyJob) {
          try {
            await deps.enqueueNotifyJob({
              announcementId: announcement.id,
              orgId: input.ownerId,
              subject: input.subject,
              eventId: input.eventId ?? null,
              humanIds,
            });
            deps.logger.info("announcement_notify_job_enqueued", {
              announcementId: announcement.id,
              humanCount: humanIds.length,
            });
          } catch (enqueueError) {
            deps.logger.error("announcement_notify_enqueue_failed", {
              announcementId: announcement.id,
              error: describeError(enqueueError),
            });
            reportSwallowed(deps.reportError, enqueueError, "notify_enqueue", {
              announcementId: announcement.id,
            });
            // Fall through to inline dispatch if enqueue fails and notify is available
            if (deps.notify) {
              await dispatchNotificationsInline(
                deps,
                announcement.id,
                input,
                humanIds,
              );
            }
          }
        } else if (deps.notify) {
          await dispatchNotificationsInline(
            deps,
            announcement.id,
            input,
            humanIds,
          );
        }
      }
    }

    await deps.idempotency.commit(idempotencyKey, result);

    deps.logger.info("announcement_sent", {
      announcementId: announcement.id,
      orgId: input.ownerId,
      audienceType: input.audienceType,
    });

    return result;
  } catch (error) {
    await deps.idempotency.fail(idempotencyKey).catch(() => {});
    deps.logger.error("announcement_send_failed", {
      orgId: input.ownerId,
      error: describeError(error),
    });
    throw error;
  }
}
