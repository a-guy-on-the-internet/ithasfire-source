import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  EventInvitePauseDecision,
  EventInvitePauseOwner,
  EventInvitePauseReason,
} from "@th/ports/repos/event-invite-pauses";

import { clipUtf16WithEllipsis } from "../../../lib/clip-utf16";
import { describeError } from "../../../lib/io";
import {
  listOrgEditMembers,
  resolveHumanAdminSlug,
} from "../../booking-holds/notify-booking-hold-intents";
import { buildDirectInAppNotice } from "../../comms/direct-in-app";
import {
  invitePauseDecidedRenderer,
  invitePauseOpenedRenderer,
} from "../../comms/invite-pause-renderers";
import { inviteOptOutOwner, reportSwallowed } from "./_shared";

/**
 * In-app notices for the invite complaint auto-pause (W4). Owner ruling
 * 2026-10-07: tell the organiser in the app only ("Nah... just in app
 * notification"), no email. Staff decisions are told too (pro-social
 * principle 3: nobody gets silence).
 *
 * Recipients are the people who can send the invites (event edit rights):
 *  - org-owned: every OWNER/ADMIN/EDITOR member (ORG_EDIT_ROLES), paged and
 *    deduped by `listOrgEditMembers`, the rule the booking and lineup notices
 *    use for "the event's editors";
 *  - person-owned: that person. Like the lineup notices, not their delegates.
 *
 * The link: the pause notice and the review button live only in an event's
 * Invited guests panel (editor settings). Every notice deep-links there: the
 * event of the complaint that tripped the pause when known, else the event
 * of the owner's latest complaint that still exists and is still theirs.
 * Without one it falls back to the events list, with an honest label.
 *
 * BEST-EFFORT: callers run these AFTER the pause / decision transaction
 * commits. Neither function throws. Every failure is reported first
 * (guarded), then logged (guarded), and the pause or decision stands.
 */

export type InvitePauseNotificationDeps = {
  repos: Pick<Repos, "organizations" | "humans"> &
    Partial<
      Pick<Repos, "notifications" | "entityPages" | "eventInvitePauses" | "events">
    >;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/** Staff notes are up to 2000 chars; the notice quotes a readable part. */
export const INVITE_PAUSE_NOTE_PREVIEW_MAX = 280;
const ORG_NAME_MAX = 200;

const USE_CASE = "events.invitePauseNotifications";

type Notice = "opened" | "decided";

type Audience = {
  humanIds: string[];
  /** Org name for the copy; null for a person (they are the reader). */
  organiserName: string | null;
  /** `/admin/<slug>`, the slug rule web's admin routes use. */
  adminBase: string;
};

type Link = { actionRoute: string; linksToEvent: boolean };

function ownerLog(owner: EventInvitePauseOwner): Record<string, string> {
  return owner.kind === "ORG"
    ? { ownerKind: "ORG", orgId: owner.orgId }
    : { ownerKind: "HUMAN", humanOwnerId: owner.humanId };
}

/**
 * Report FIRST, then log, each in its own guard: a throwing logger or
 * reporter must never stop the remaining recipients, and Sentry must hear
 * about the failure even when the logger is the thing that broke.
 */
function makeSwallow(
  deps: InvitePauseNotificationDeps,
  notice: Notice,
  pauseId: string,
  owner: EventInvitePauseOwner,
) {
  return (stage: string, error: unknown, extra: Record<string, unknown> = {}) => {
    reportSwallowed(deps.reportError, error, {
      tags: { useCase: USE_CASE, notice, channel: stage },
      extra: { pauseId, ...ownerLog(owner), ...extra },
    });
    try {
      deps.logger?.error(`${USE_CASE}.${stage}`, {
        notice,
        pauseId,
        ...ownerLog(owner),
        ...extra,
        err: error,
        error: describeError(error),
      });
    } catch {
      // Logging is best-effort.
    }
  };
}

async function resolveAudience(
  repos: InvitePauseNotificationDeps["repos"],
  owner: EventInvitePauseOwner,
): Promise<Audience> {
  if (owner.kind === "ORG") {
    const org = await repos.organizations.getById(owner.orgId);
    const name = org?.name?.trim();
    return {
      humanIds: await listOrgEditMembers({ repos }, owner.orgId),
      organiserName: name ? clipUtf16WithEllipsis(name, ORG_NAME_MAX) : null,
      // Mirrors web `toOrgAdminSlug`: slug, else the raw id.
      adminBase: `/admin/${encodeURIComponent(org?.slug || owner.orgId)}`,
    };
  }
  if (!repos.entityPages) {
    throw new Error("invite_pause_notice_entity_pages_missing");
  }
  const slug = await resolveHumanAdminSlug(
    { repos: { humans: repos.humans, entityPages: repos.entityPages } },
    owner.humanId,
  );
  return {
    humanIds: [owner.humanId],
    organiserName: null,
    adminBase: `/admin/${slug}`,
  };
}

function sameOwner(a: EventInvitePauseOwner, b: EventInvitePauseOwner): boolean {
  return a.kind === "ORG"
    ? b.kind === "ORG" && a.orgId === b.orgId
    : b.kind === "HUMAN" && a.humanId === b.humanId;
}

/**
 * The event to deep-link: `known` (already checked by the caller) else the
 * owner's latest complaint event, if it still exists and is still theirs.
 * A failed lookup is reported and degrades to the events list.
 */
async function resolveLinkEventId(
  deps: InvitePauseNotificationDeps,
  owner: EventInvitePauseOwner,
  known: string | null,
  swallow: ReturnType<typeof makeSwallow>,
): Promise<string | null> {
  if (known) return known;
  const { eventInvitePauses, events } = deps.repos;
  if (!eventInvitePauses || !events) return null;
  try {
    const eventId = await eventInvitePauses.getLatestComplaintEventId(owner);
    if (!eventId) return null;
    const event = await events.getById(eventId);
    const eventOwner = event ? inviteOptOutOwner(event) : null;
    return eventOwner && sameOwner(owner, eventOwner) ? eventId : null;
  } catch (error) {
    swallow("link_lookup_failed", error);
    return null;
  }
}

/** The Invited guests panel sits in the editor's Settings section. */
function linkFor(adminBase: string, eventId: string | null): Link {
  return eventId
    ? {
        actionRoute: `${adminBase}/events/${encodeURIComponent(eventId)}/edit?section=settings`,
        linksToEvent: true,
      }
    : { actionRoute: `${adminBase}/events`, linksToEvent: false };
}

async function deliver(
  deps: InvitePauseNotificationDeps,
  notice: Notice,
  pauseId: string,
  owner: EventInvitePauseOwner,
  knownEventId: string | null,
  build: (audience: Audience, link: Link) => ReturnType<typeof buildDirectInAppNotice>,
): Promise<number> {
  const swallow = makeSwallow(deps, notice, pauseId, owner);

  const notifications = deps.repos.notifications;
  if (!notifications) {
    swallow("repo_missing", new Error("invite_pause_notice_repo_missing"));
    return 0;
  }

  let audience: Audience;
  let rendered: ReturnType<typeof buildDirectInAppNotice>;
  try {
    audience = await resolveAudience(deps.repos, owner);
    const eventId = await resolveLinkEventId(deps, owner, knownEventId, swallow);
    rendered = build(audience, linkFor(audience.adminBase, eventId));
  } catch (error) {
    swallow("prepare_failed", error);
    return 0;
  }

  let sent = 0;
  for (const humanId of audience.humanIds) {
    try {
      await notifications.create({
        humanId,
        title: rendered.title,
        body: rendered.body,
        kind: rendered.kind,
        metadata: { pauseId, variant: rendered.variant },
        tags: ["invites", "invite-pause"],
        action: rendered.action,
        template: rendered.template,
      });
      sent += 1;
    } catch (error) {
      // One recipient's failure never stops the rest.
      swallow("create_failed", error, { humanId });
    }
  }
  try {
    deps.logger?.info("invite_pause_notice_sent", {
      notice,
      pauseId,
      ...ownerLog(owner),
      recipients: audience.humanIds.length,
      sent,
    });
  } catch {
    // Logging is best-effort.
  }
  return sent;
}

/**
 * A pause just OPENED (this call opened it: never on a replay or when the
 * organiser was already paused). Returns how many rows were written.
 */
export async function notifyInvitePauseOpened(
  deps: InvitePauseNotificationDeps,
  input: {
    pauseId: string;
    owner: EventInvitePauseOwner;
    /** The tripping complaint's event, already checked to be the owner's. */
    eventId: string | null;
    reason: EventInvitePauseReason;
    complaintCount: number;
    recipientCount: number;
    windowDays: number;
  },
): Promise<number> {
  try {
    return await deliver(
      deps,
      "opened",
      input.pauseId,
      input.owner,
      input.eventId,
      (audience, link) =>
        buildDirectInAppNotice(
          deps,
          invitePauseOpenedRenderer,
          {
            pauseId: input.pauseId,
            ownerKind: input.owner.kind,
            organiserName: audience.organiserName,
            reason: input.reason,
            complaintCount: input.complaintCount,
            recipientCount: input.recipientCount,
            windowDays: input.windowDays,
            actionRoute: link.actionRoute,
            linksToEvent: link.linksToEvent,
          },
          { useCase: USE_CASE },
        ),
    );
  } catch (error) {
    reportSwallowed(deps.reportError, error, {
      tags: { useCase: USE_CASE, notice: "opened", channel: "unexpected" },
      extra: { pauseId: input.pauseId },
    });
    return 0;
  }
}

/**
 * Staff LIFTED or KEPT the pause. A KEEP quotes the staff note (clipped to
 * {@link INVITE_PAUSE_NOTE_PREVIEW_MAX}).
 */
export async function notifyInvitePauseDecided(
  deps: InvitePauseNotificationDeps,
  input: {
    pauseId: string;
    owner: EventInvitePauseOwner;
    decision: EventInvitePauseDecision;
    note: string | null;
  },
): Promise<number> {
  try {
    const note = input.note?.trim()
      ? clipUtf16WithEllipsis(input.note.trim(), INVITE_PAUSE_NOTE_PREVIEW_MAX)
      : null;
    return await deliver(
      deps,
      "decided",
      input.pauseId,
      input.owner,
      null,
      (audience, link) =>
        buildDirectInAppNotice(
          deps,
          invitePauseDecidedRenderer,
          {
            pauseId: input.pauseId,
            ownerKind: input.owner.kind,
            organiserName: audience.organiserName,
            decision: input.decision,
            note,
            actionRoute: link.actionRoute,
            linksToEvent: link.linksToEvent,
          },
          { useCase: USE_CASE },
        ),
    );
  } catch (error) {
    reportSwallowed(deps.reportError, error, {
      tags: { useCase: USE_CASE, notice: "decided", channel: "unexpected" },
      extra: { pauseId: input.pauseId },
    });
    return 0;
  }
}
