import { z } from "zod";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { eventEmailImageUrl, eventPublicUrl } from "../../lib/public-urls";
import { fail } from "@th/errors";
import { sanitizeSubject } from "../comms/channels/send-email";
import { sanitizeOrganizerEmailDoc } from "../../lib/sanitize-organizer-email-doc";

export const sendWaitlistConfirmationEmailInputSchema = z.object({
  eventId: z.string().uuid(),
  /** Email of the waitlist entrant. */
  recipientEmail: z.string().email(),
  /** Public app base URL (e.g. https://ithasfire.com). */
  publicAppUrl: z.string().url(),
});

export const sendWaitlistConfirmationEmailOutputSchema = z.object({
  ok: z.literal(true),
  eventId: z.string().uuid(),
  recipientEmail: z.string().email(),
});

export type SendWaitlistConfirmationEmailInput = z.infer<
  typeof sendWaitlistConfirmationEmailInputSchema
>;
export type SendWaitlistConfirmationEmailOutput = z.infer<
  typeof sendWaitlistConfirmationEmailOutputSchema
>;

export type SendWaitlistConfirmationEmailDeps = {
  repos: Pick<Repos, "events">;
  mailer: MailerPort;
  logger?: LoggerPort;
};

export async function sendWaitlistConfirmationEmail(
  deps: SendWaitlistConfirmationEmailDeps,
  rawInput: unknown,
): Promise<SendWaitlistConfirmationEmailOutput> {
  const input = parseInput(sendWaitlistConfirmationEmailInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "sendWaitlistConfirmationEmail",
  });

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (!event.waitlistEmailEnabled) {
    logger?.info("sendWaitlistConfirmationEmail.skipped", {
      eventId: event.id,
      reason: "waitlist_email_disabled",
    });
    return sendWaitlistConfirmationEmailOutputSchema.parse({
      ok: true,
      eventId: event.id,
      recipientEmail: input.recipientEmail,
    });
  }

  const publicAppUrl = input.publicAppUrl.replace(/\/+$/, "");
  // BOTH previous branches were dead: there is no `/e/:slug` route in the web
  // app (no `app/e` segment, no rewrite), and `/events/{id}` 404s because the
  // public route resolves by slug / slug history only. One slug-based builder
  // now; null (no slug) means the email simply omits the link.
  const eventUrl = eventPublicUrl({
    baseUrl: input.publicAppUrl,
    slug: event.slug,
  });

  // Determine the organizer's contact email for reply-to.
  let organizerContactEmail: string | null = null;
  if (event.orgId) {
    // Future: look up org contact email. For now leave null.
    organizerContactEmail = null;
  }

  // Use custom subject or let the template default handle it. This path
  // calls `mailer.send()` directly (not `sendEmail()`/`notify()`), so it
  // must apply the same header-injection defense-in-depth sanitizer those
  // paths get for free.
  const customSubject = sanitizeSubject(event.waitlistEmailSubject);

  // Build template variables.
  const variables: Record<string, unknown> = {
    eventTitle: event.title,
    eventDateISO: event.startsAt.toISOString(),
    // The template renders the date in this zone, not the server's (UTC).
    timezone: event.timezone,
    eventUrl,
    // An event with no poster gets the generated Date Stub rather than an
    // empty image slot — see `eventEmailImageUrl`.
    heroImageUrl: eventEmailImageUrl({
      baseUrl: input.publicAppUrl,
      event: {
        id: event.id,
        slug: event.slug,
        title: event.title,
        startsAt: event.startsAt,
        timezone: event.timezone,
        updatedAt: event.updatedAt ?? null,
        heroImageUrl: event.heroImageUrl ?? null,
        venueName: event.locationLabel ?? null,
      },
    }),
    // The recipient is whoever was typed into an anonymous form, so the
    // organiser's body is rebuilt from a whitelist: no links, no attrs, no
    // markup beyond bold/italic/strike/headings/lists (F8).
    organizerMessageDoc: sanitizeOrganizerEmailDoc(event.waitlistEmailBody),
    organizerContactEmail,
  };

  await deps.mailer.send({
    to: { to: input.recipientEmail },
    ...(organizerContactEmail ? { replyTo: organizerContactEmail } : {}),
    ...(customSubject ? { subject: customSubject } : {}),
    template: {
      key: "event.waitlist_joined",
      variables,
    },
    idempotencyKey: `waitlist-joined:${event.id}:${input.recipientEmail}`,
  });

  logger?.info("sendWaitlistConfirmationEmail.sent", {
    eventId: event.id,
    recipientEmail: input.recipientEmail,
  });

  return sendWaitlistConfirmationEmailOutputSchema.parse({
    ok: true,
    eventId: event.id,
    recipientEmail: input.recipientEmail,
  });
}
