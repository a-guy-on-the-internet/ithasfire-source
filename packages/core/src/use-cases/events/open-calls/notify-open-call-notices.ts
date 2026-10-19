import { createHash, randomUUID } from "node:crypto";

import type { IdempotencyPort } from "@th/ports/idempotency";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { OpenCallFormRecord, OpenCallSubmissionRecord } from "@th/ports/repos/events";

import { describeError } from "../../../lib/io";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import { listOrgEditMembers } from "../../booking-holds/notify-booking-hold-intents";
import {
  DEFAULT_NOTIFICATION_LOCALE,
  type NotificationLocale,
  resolveNotificationLocale,
} from "../../comms/locale";
import type { NotifyInput, NotifyOutput } from "../../comms/notify";
import {
  buildOpenCallDroppedOutEmail,
  buildOpenCallGuestDuplicateEmail,
  buildOpenCallMessageEmail,
  buildOpenCallNotThisTimeEmail,
  buildOpenCallPickedEmail,
  buildOpenCallPulledEmail,
  buildOpenCallReceivedEmail,
  clipOpenCallMessagePreview,
  OPEN_CALL_DROPPED_OUT_VARIANT,
  OPEN_CALL_EMAIL_TEMPLATE_KEY,
  OPEN_CALL_MESSAGE_VARIANT,
  OPEN_CALL_NOT_THIS_TIME_VARIANT,
  OPEN_CALL_PICKED_VARIANT,
  OPEN_CALL_PULLED_VARIANT,
  OPEN_CALL_RECEIVED_VARIANT,
  openCallEmailText,
  type OpenCallEmailAudience,
  type OpenCallEmailContent,
} from "../../comms/open-call-renderers";
import {
  displayNameForCopy,
  normalizeBaseUrl,
  reportSafely,
  resolveHumanAdminSlug,
} from "../../event-humans/_shared/lineup-notice-support";
import type { NotifyApplicationMessagePostedFn } from "./_shared/application-thread";
import { loadOpenCallAnchor, type OpenCallAnchorContext } from "./_shared/open-call-anchor";
import type {
  OpenCallDroppedOutNotice,
  OpenCallNotThisTimeNotice,
  OpenCallPickedNotice,
  OpenCallPulledNotice,
} from "./_shared/open-call-decision";
import { deriveStatusToken, openCallStatusPath } from "./_shared/status-token";
import type { SubmitOpenCallApplicationOutput } from "./submit-open-call-application";

// ─────────────────────────────────────────────────────────────────────────────
// The open-call notifiers (spec 2026-10-05, step 7): what the core seams
// (`notifyOpenCallPicked`, `notifyOpenCallNotThisTime`,
// `notifyOpenCallDroppedOut`, `notifyApplicationMessagePosted`, and the
// step-8 `notifyOpenCallPulled`) call after their commit. Built once per
// composition root by `makeOpenCallNotices` (transport: makeOpenCallNotifier;
// jobs: step 8).
//
// ── Who hears what ────────────────────────────────────────────────────────
// APPLICANT side (picked, not this time, pulled, a message to the applicant):
//   - a person applying as themselves → that human, through notify()
//     (in-app + email to their verified address + push);
//   - an organisation → its OWNER/ADMIN/EDITOR members (ORG_EDIT_ROLES),
//     through notify(); with no such member left, the member who submitted
//     it (nobody gets silence, principle 3);
//   - a guest → the application's contact email, straight to the mailer
//     (no account, so no in-app row), in `resolveGuestNoticeLocale`'s
//     language, with the status link and its one-tap Drop out.
// The "application received" notice goes to the SUBMITTER only (the
// signed-in human, or the guest's address).
//
// ── No token through notify() (NFR-001) ───────────────────────────────────
// notify() STORES its payload and the rendered route, so a signed-in
// recipient's links are the hub (/my-applications), their lineups, or the
// organizer queue, never a status link. A guest's status link is DERIVED at
// send time from the submission id (`deriveStatusToken`, owner ruling
// 2026-10-07) inside the guest's email builder and handed straight to the
// mailer. No token appears in an idempotency key, a log line or a report.
// ORGANIZER side (dropped out, a message to the organizers): the people who
// can EDIT the call's event or series (owner ruling 2026-10-06, FR-014 as
// amended, Q43): an org owner's ORG_EDIT_ROLES members, or a person-owned
// event's / series' owner plus their HumanDelegates holding an edit role.
// SCANNER, VIEWER and FINANCE are never told. An ownerless anchor has no
// organizer side. The sender of a message is never told about it.
//
// ── Exactly once ──────────────────────────────────────────────────────────
// Every send claims a per-RECIPIENT ledger key in the idempotency store
// (`begin`, then `commit` kept OPEN_CALL_NOTICE_LEDGER_KEEP_SEC; `release`
// on failure so a retry can send). Applicant / organizer notices also commit
// a per-(submission, kind) SUMMARY key once every recipient is done:
// `openCallNoticeKey(kind, submissionId)`. A repeat call with the summary
// key settled is a no-op, and a partial failure leaves it unset, so
// re-calling sends only to whoever was missed. Step 8's job asks
// `openCallNoticeWasSent(idempotency, "not-this-time", submissionId)` and
// re-calls the notifier for any REJECTED PERFORM application without one
// (and the same for "received", from the submission id alone).
// Like the lineup notices (see the IdempotencyPort header), this ledger is
// the only record: switching the idempotency backend or purging its table
// drops it.
//
// ── Failures ──────────────────────────────────────────────────────────────
// A recipient whose send fails is logged at error and reported
// (`reportError`, ReporterPort convention) and the others still go out. A
// failure that reaches nobody (no web origin bound, the application gone)
// THROWS, so the seam's own swallow (`runOpenCallNotice`) reports it.
// ─────────────────────────────────────────────────────────────────────────────

/** The ledger outlives any application (same as the lineup notices). */
export const OPEN_CALL_NOTICE_LEDGER_KEEP_SEC = 10 * 365 * 24 * 60 * 60;
/** A claim held longer than this is a dead sender's; the key frees itself. */
const CLAIM_TTL_SEC = 300;
/**
 * Message bursts (FR-015): a notified message to a side opens a window, and
 * further messages TO THE SAME SIDE inside it send no notice, UNTIL that
 * side writes back: the window is keyed by the recipient side's latest
 * message, so a reply starts a fresh one and the next message to them is
 * notified again (a normal back-and-forth never goes quiet). A message that
 * reached nobody frees the window. The notice links to the thread, which
 * shows every message. The comms layer has no coalescing of its own
 * (booking messages notify per message).
 */
export const OPEN_CALL_MESSAGE_BURST_WINDOW_SEC = 15 * 60;
/** Thread pages read to find the recipient side's latest message (100 each). */
const MESSAGE_SCAN_MAX_PAGES = 20;
/** "You've already applied" emails to one address for one call: one per hour. */
const GUEST_DUPLICATE_KEEP_SEC = 60 * 60;
/**
 * The signed-in applicant's list of their applications (spec: hub
 * "My applications", step 12), next to /my-lineups and /my-rsvps. Step 12
 * must serve this path, or change it here.
 */
export const OPEN_CALL_APPLICANT_HUB_PATH = "/my-applications";
/** Where a signed-in PERSON drops out: their lineups (FR-017, leaveEventLineup). */
const MY_LINEUPS_PATH = "/my-lineups";

/** The notice kinds the summary ledger records, per submission. */
export type OpenCallNoticeKind =
  | "received"
  | "picked"
  | `picked-more:${string}`
  | "not-this-time"
  | "pulled"
  | "dropped-out";

/** The per-(submission, kind) ledger key. */
export function openCallNoticeKey(kind: OpenCallNoticeKind, submissionId: string): string {
  return `open-call-notice:${kind}:${submissionId}`;
}

/**
 * Was this notice sent (every recipient done) for this submission? Step 8's
 * reconcile query. A settled key only: an in-flight claim is not "sent".
 */
export async function openCallNoticeWasSent(
  idempotency: IdempotencyPort,
  kind: OpenCallNoticeKind,
  submissionId: string,
): Promise<boolean> {
  return ledgerSettled(idempotency, openCallNoticeKey(kind, submissionId));
}

/**
 * THE ONE PLACE a guest's email language is chosen: the language they
 * applied in (`contactLocale`, stored at submit, owner ruling 2026-10-07),
 * else the platform default. Every guest email reads this.
 */
export function resolveGuestNoticeLocale(
  submission: Pick<OpenCallSubmissionRecord, "contactLocale">,
): NotificationLocale {
  return submission.contactLocale
    ? resolveNotificationLocale(submission.contactLocale)
    : DEFAULT_NOTIFICATION_LOCALE;
}

type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type OpenCallNoticeDeps = {
  repos: Pick<
    Repos,
    | "eventApplications"
    | "events"
    | "series"
    | "organizations"
    | "humans"
    | "humanDelegates"
    | "entityPages"
  >;
  /** notify() WITH the mailer bound, so its email leg sends. */
  notify: NotifyFn;
  /** For guests (no account). Null → guest emails fail and are reported. */
  mailer: MailerPort | null;
  idempotency: IdempotencyPort;
  /** Web origin for every link. Unset → nothing can be sent (throws). */
  publicAppUrl: string | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * The status-token key (HKDF of UNSUBSCRIBE_SECRET), to re-derive a
   * guest's status link at send time. Null or short → every GUEST email
   * fails (reported, ledger left open so a reconcile resends it once the
   * secret is set); signed-in notices are unaffected.
   */
  statusTokenSecret: string | null;
};

type SubmitNotice = SubmitOpenCallApplicationOutput["notice"];
/**
 * The submit result's notice, or just the ids (a reconcile re-sending
 * "received" from the submission alone).
 */
export type ReceivedNotice =
  | Extract<SubmitNotice, { kind: "guest_duplicate" }>
  | { kind: "application_received"; submissionId: string; formId: string };

export type OpenCallNotices = {
  notifyOpenCallApplicationReceived: (notice: ReceivedNotice) => Promise<void>;
  notifyOpenCallPicked: (notice: OpenCallPickedNotice) => Promise<void>;
  notifyOpenCallNotThisTime: (notice: OpenCallNotThisTimeNotice) => Promise<void>;
  notifyOpenCallPulled: (notice: OpenCallPulledNotice) => Promise<void>;
  notifyOpenCallDroppedOut: (notice: OpenCallDroppedOutNotice) => Promise<void>;
  notifyApplicationMessagePosted: NotifyApplicationMessagePostedFn;
};

export function makeOpenCallNotices(deps: OpenCallNoticeDeps): OpenCallNotices {
  return {
    notifyOpenCallApplicationReceived: (notice) => sendReceived(deps, notice),
    notifyOpenCallPicked: (notice) => sendPicked(deps, notice),
    notifyOpenCallNotThisTime: (notice) => sendNotThisTime(deps, notice),
    notifyOpenCallPulled: (notice) => sendPulled(deps, notice),
    notifyOpenCallDroppedOut: (notice) => sendDroppedOut(deps, notice),
    notifyApplicationMessagePosted: (input) => sendMessagePosted(deps, input),
  };
}

// ── Recipients ───────────────────────────────────────────────────────────────

type Recipient =
  | { kind: "human"; humanId: string }
  | { kind: "email"; email: string; name: string | null };

type ApplicantKind = "person" | "org" | "guest";

interface ApplicantSide {
  kind: ApplicantKind;
  recipients: Recipient[];
  /** The org's name for its members' copy; null otherwise. */
  orgName: string | null;
}

function recipientId(recipient: Recipient): string {
  return recipient.kind === "human"
    ? recipient.humanId
    : `email-${sha256(recipient.email.trim().toLowerCase()).slice(0, 32)}`;
}

function guestRecipient(submission: OpenCallSubmissionRecord): Recipient[] {
  const email = submission.contactEmail?.trim();
  if (!email) return [];
  return [{ kind: "email", email, name: displayNameForCopy(submission.guestName) }];
}

async function applicantSide(
  deps: OpenCallNoticeDeps,
  submission: OpenCallSubmissionRecord,
  exclude: ReadonlySet<string> = new Set(),
): Promise<ApplicantSide> {
  if (submission.applyingAsOrgId) {
    const orgId = submission.applyingAsOrgId;
    const org = await deps.repos.organizations.getById(orgId);
    const members = await listOrgEditMembers(deps, orgId);
    // No edit member left at all: the member who submitted it, so the act
    // still hears (an org application never has a contact email; submit
    // writes one only for guests). That submitter may have LEFT the org:
    // deliberate, nobody gets silence and nobody else is left to tell (they
    // can no longer act on it, actsForOpenCallOrg). An excluded member is
    // the sender, not an absence.
    const humanIds =
      members.length > 0 ? members : submission.humanId ? [submission.humanId] : [];
    return {
      kind: "org",
      recipients: humanIds
        .filter((id) => !exclude.has(id))
        .map((humanId): Recipient => ({ kind: "human", humanId })),
      orgName: displayNameForCopy(org?.name ?? null),
    };
  }
  if (submission.humanId) {
    return {
      kind: "person",
      recipients: exclude.has(submission.humanId)
        ? []
        : [{ kind: "human", humanId: submission.humanId }],
      orgName: null,
    };
  }
  return { kind: "guest", recipients: guestRecipient(submission), orgName: null };
}

/** The anchor's owner as (orgId, humanId); both null for an ownerless one. */
function anchorOwner(anchor: OpenCallAnchorContext): { orgId: string | null; humanId: string | null } {
  if (anchor.kind === "event") {
    return { orgId: anchor.event.orgId ?? null, humanId: anchor.event.humanId ?? null };
  }
  if (anchor.series.ownerScope === "ORGANIZATION") return { orgId: anchor.series.ownerId, humanId: null };
  if (anchor.series.ownerScope === "HUMAN") return { orgId: null, humanId: anchor.series.ownerId };
  return { orgId: null, humanId: null };
}

/** A person's HumanDelegates holding an edit role, paged. */
async function listEditDelegates(deps: OpenCallNoticeDeps, principalId: string): Promise<string[]> {
  const out: string[] = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const page = await deps.repos.humanDelegates.listDelegates({ principalId, limit, offset });
    for (const item of page.items) {
      if (ORG_EDIT_ROLES.includes(item.role) && !out.includes(item.humanId)) out.push(item.humanId);
    }
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return out;
}

interface OrganizerSide {
  humanIds: string[];
  /** The call's applications queue, opened at this application. */
  queueUrl: string;
}

/**
 * The people with edit rights on the call's anchor (module header), and the
 * queue link. The admin URL is the owner's admin slug (org slug, else id;
 * a person's `@username` / `@page` / `@id`). Step 11 must serve
 * `/admin/<slug>/events/<eventId>/open-call` and
 * `/admin/<slug>/series/<seriesId>/open-call`, or change them here.
 */
async function organizerSide(
  deps: OpenCallNoticeDeps,
  anchor: OpenCallAnchorContext,
  baseUrl: string,
  submissionId: string,
): Promise<OrganizerSide> {
  const owner = anchorOwner(anchor);
  let slug: string;
  let humanIds: string[];
  if (owner.orgId) {
    const org = await deps.repos.organizations.getById(owner.orgId);
    slug = encodeURIComponent(org?.slug || owner.orgId);
    humanIds = await listOrgEditMembers(deps, owner.orgId);
  } else if (owner.humanId) {
    slug = await resolveHumanAdminSlug(deps.repos, owner.humanId);
    humanIds = [owner.humanId, ...(await listEditDelegates(deps, owner.humanId))].filter(
      (id, i, all) => all.indexOf(id) === i,
    );
  } else {
    return { humanIds: [], queueUrl: `${baseUrl}/` };
  }
  const path =
    anchor.kind === "event"
      ? `events/${anchor.event.id}/open-call`
      : `series/${anchor.series.id}/open-call`;
  return {
    humanIds,
    queueUrl: `${baseUrl}/admin/${slug}/${path}?application=${encodeURIComponent(submissionId)}`,
  };
}

/** The applicant as organizers see them: the org, the person, or the guest. */
async function applicantName(
  deps: OpenCallNoticeDeps,
  submission: OpenCallSubmissionRecord,
): Promise<string | null> {
  if (submission.applyingAsOrgId) {
    const org = await deps.repos.organizations.getById(submission.applyingAsOrgId);
    return displayNameForCopy(org?.name ?? null);
  }
  if (submission.humanId) {
    const human = await deps.repos.humans.getById(submission.humanId);
    return displayNameForCopy(human?.name ?? null);
  }
  return displayNameForCopy(submission.guestName);
}

// ── Links ────────────────────────────────────────────────────────────────────

interface ApplicantLinks {
  /** The application: the hub for a signed-in applicant; a guest's status page. */
  actionUrl: string;
  /** Where to drop out, or null when there is none. */
  dropOutUrl: string | null;
  /** Guests only (Q34). */
  makePageUrl: string | null;
}

/**
 * A SIGNED-IN applicant's links: safe to store (no token). A person drops
 * out from their lineups (leaveEventLineup); an org's edit members from the
 * hub (owner ruling 2026-10-07: any ORG_EDIT_ROLES member may drop out).
 */
function signedInLinks(baseUrl: string, kind: "person" | "org"): ApplicantLinks {
  const hub = `${baseUrl}${OPEN_CALL_APPLICANT_HUB_PATH}`;
  return {
    actionUrl: hub,
    dropOutUrl: kind === "person" ? `${baseUrl}${MY_LINEUPS_PATH}` : hub,
    makePageUrl: null,
  };
}

/**
 * A GUEST's links, with the status page re-derived from the submission id.
 * Call only inside a guest email builder (the result goes to the mailer,
 * never to notify()). Throws without a usable secret, which fails that one
 * delivery (reported, retried by a reconcile).
 */
function guestLinks(
  deps: OpenCallNoticeDeps,
  baseUrl: string,
  submission: OpenCallSubmissionRecord,
  form: Pick<OpenCallFormRecord, "publicId">,
): ApplicantLinks {
  if (!deps.statusTokenSecret) {
    throw new Error("open-call notices: no status-token secret bound — guest link not built");
  }
  const { token } = deriveStatusToken(deps.statusTokenSecret, submission.id);
  const statusUrl = `${baseUrl}${openCallStatusPath(form.publicId, token)}`;
  const email = submission.contactEmail?.trim();
  return {
    actionUrl: statusUrl,
    dropOutUrl: statusUrl,
    makePageUrl: email
      ? `${baseUrl}/sign-up?email=${encodeURIComponent(email)}&src=open-call`
      : `${baseUrl}/sign-up?src=open-call`,
  };
}

function requireBaseUrl(deps: OpenCallNoticeDeps): string {
  const baseUrl = normalizeBaseUrl(deps.publicAppUrl);
  if (!baseUrl) {
    throw new Error("open-call notices: publicAppUrl unset — no notice can carry a link");
  }
  return baseUrl;
}

async function loadSubmission(
  deps: OpenCallNoticeDeps,
  formId: string,
  submissionId: string,
): Promise<{ form: OpenCallFormRecord; submission: OpenCallSubmissionRecord }> {
  const form = await deps.repos.eventApplications.getOpenCallById(formId);
  const submission = await deps.repos.eventApplications.getOpenCallSubmissionById(submissionId);
  if (!form || !submission || submission.formId !== form.id) {
    throw new Error(`open-call notices: application ${submissionId} not found on call ${formId}`);
  }
  return { form, submission };
}

// ── Dates ────────────────────────────────────────────────────────────────────

type NoticeDate = { startsAtIso: string; timezone: string | null };

async function datesOfEvents(
  deps: OpenCallNoticeDeps,
  eventIds: readonly string[],
): Promise<NoticeDate[]> {
  const out: Array<NoticeDate & { at: number }> = [];
  for (const eventId of new Set(eventIds)) {
    const event = await deps.repos.events.getById(eventId);
    if (!event) continue;
    out.push({
      startsAtIso: event.startsAt.toISOString(),
      timezone: event.timezone ?? null,
      at: event.startsAt.getTime(),
    });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...d }) => d);
}

/**
 * The dates a pick puts the act on. Event call: the dates the applicant
 * chose on a multi-date event, else the event's start (one shared lineup,
 * FR-016). Series call: the nights picked (on a retry, only the new ones).
 */
async function pickedDates(
  deps: OpenCallNoticeDeps,
  form: OpenCallFormRecord,
  submission: OpenCallSubmissionRecord,
  notice: OpenCallPickedNotice,
): Promise<NoticeDate[]> {
  if (form.eventId) {
    const event = await deps.repos.events.getById(form.eventId);
    const timezone = event?.timezone ?? null;
    if (submission.dateChoices.length > 0) {
      return submission.dateChoices.map((c) => ({ startsAtIso: c.startsAt.toISOString(), timezone }));
    }
    return event ? [{ startsAtIso: event.startsAt.toISOString(), timezone }] : [];
  }
  return datesOfEvents(deps, notice.firstPick ? notice.eventIds : notice.addedEventIds);
}

// ── Delivery ─────────────────────────────────────────────────────────────────

interface Delivery {
  variant: string;
  /**
   * The notify() payload for a SIGNED-IN recipient (renderer schema). Stored
   * by notify(): never a token. Null when the notice has no signed-in leg.
   */
  payload: unknown;
  /**
   * The email for an address recipient (a guest), built at send time in the
   * given locale. The ONLY place a status link may appear. Null when the
   * notice has no address leg.
   */
  email: ((locale: NotificationLocale) => OpenCallEmailContent) | null;
  tags: string[];
  metadata: Record<string, string>;
  /** The language of a guest's email (`resolveGuestNoticeLocale`). */
  guestLocale: NotificationLocale;
}

type DeliveryOutcome = "sent" | "already" | "held" | "failed";

async function ledgerSettled(idempotency: IdempotencyPort, key: string): Promise<boolean> {
  if (idempotency.status) return (await idempotency.status(key)) === "succeeded";
  return (await idempotency.get(key)) !== null;
}

function reportRecipientFailure(
  deps: OpenCallNoticeDeps,
  error: unknown,
  context: { kind: string; reason: string; key: string; recipientId: string },
): void {
  deps.logger?.error("open_call.notice_recipient_failed", {
    ...context,
    err: error,
    error: describeError(error),
  });
  reportSafely(deps.reportError, error, {
    tags: { useCase: "openCallNotices", kind: context.kind, reason: context.reason },
    extra: { key: context.key, recipientId: context.recipientId },
  });
}

interface DeliverOptions {
  keepSec?: number;
  /** The report reason when the send fails (default "send_failed"). */
  failureReason?: string;
}

async function deliverTo(
  deps: OpenCallNoticeDeps,
  baseKey: string,
  kind: string,
  recipient: Recipient,
  delivery: Delivery,
  options: DeliverOptions = {},
): Promise<DeliveryOutcome> {
  const keepSec = options.keepSec ?? OPEN_CALL_NOTICE_LEDGER_KEEP_SEC;
  const rid = recipientId(recipient);
  const key = `${baseKey}:${rid}`;
  const claim = randomUUID();
  if (!(await deps.idempotency.begin(key, CLAIM_TTL_SEC, claim))) {
    return (await ledgerSettled(deps.idempotency, key)) ? "already" : "held";
  }
  try {
    if (recipient.kind === "human") {
      if (delivery.payload === null) throw new Error(`open-call notice ${kind}: no signed-in payload`);
      await deps.notify({
        humanId: recipient.humanId,
        variant: delivery.variant,
        payload: delivery.payload,
        idempotencyKey: key,
        actor: { type: "system" },
      });
    } else {
      if (!delivery.email) throw new Error(`open-call notice ${kind}: no email for an address`);
      if (!deps.mailer) throw new Error("open-call notices: no mailer bound — guest email not sent");
      const content = delivery.email(delivery.guestLocale);
      const sent = await deps.mailer.send({
        to: { to: recipient.email, ...(recipient.name ? { name: recipient.name } : {}) },
        subject: content.subject,
        text: openCallEmailText(content),
        template: { key: OPEN_CALL_EMAIL_TEMPLATE_KEY, variables: content },
        localization: { locale: content.locale },
        // Its own key: the mail adapter claims through the SAME idempotency
        // port, and our claim on `key` is still live (see notify.ts).
        idempotencyKey: `${key}:mail`,
        tags: delivery.tags,
        metadata: delivery.metadata,
      });
      if (!sent.result.success) {
        throw new Error(`open-call notices: mailer refused (${sent.result.errorCode ?? "unknown"})`);
      }
    }
  } catch (error) {
    try {
      await deps.idempotency.release(key, claim);
    } catch (releaseError) {
      // The claim lapses on its own after CLAIM_TTL_SEC; until then a retry
      // to this recipient reads "held". Reported, never thrown.
      reportRecipientFailure(deps, releaseError, {
        kind,
        reason: "claim_release_failed",
        key,
        recipientId: rid,
      });
    }
    reportRecipientFailure(deps, error, {
      kind,
      reason: options.failureReason ?? "send_failed",
      key,
      recipientId: rid,
    });
    return "failed";
  }
  try {
    await deps.idempotency.commit(key, { sentAt: new Date().toISOString() }, keepSec);
  } catch (error) {
    // Sent, but the ledger write failed: the claim lapses and a retry could
    // send a second copy. Reported; the notice itself went out.
    reportRecipientFailure(deps, error, { kind, reason: "ledger_commit_failed", key, recipientId: rid });
  }
  return "sent";
}

/**
 * One notice to a list of recipients, recorded once under the summary key
 * when nobody is left to tell (module header, "Exactly once").
 */
async function fanOut(
  deps: OpenCallNoticeDeps,
  kind: OpenCallNoticeKind,
  submissionId: string,
  recipients: Recipient[],
  delivery: (recipient: Recipient) => Delivery,
  options: DeliverOptions = {},
): Promise<void> {
  const summaryKey = openCallNoticeKey(kind, submissionId);
  if (await ledgerSettled(deps.idempotency, summaryKey)) return;
  if (recipients.length === 0) {
    // Nobody to tell (an ownerless anchor, a guest without an address).
    // Recorded so a reconcile does not retry forever, and reported.
    reportRecipientFailure(deps, new Error(`open-call notice ${kind}: no recipient`), {
      kind,
      reason: "no_recipient",
      key: summaryKey,
      recipientId: "none",
    });
  }
  let unfinished = 0;
  for (const recipient of recipients) {
    const outcome = await deliverTo(deps, summaryKey, kind, recipient, delivery(recipient), options);
    if (outcome === "failed" || outcome === "held") unfinished += 1;
  }
  if (unfinished > 0) return;
  await deps.idempotency.commit(
    summaryKey,
    { sentAt: new Date().toISOString(), recipients: recipients.length },
    OPEN_CALL_NOTICE_LEDGER_KEEP_SEC,
  );
}

/** Shared Delivery fields for an applicant-side notice. */
function applicantDelivery(
  submission: OpenCallSubmissionRecord,
  formId: string,
  variant: string,
  tag: string,
): Pick<Delivery, "variant" | "tags" | "metadata" | "guestLocale"> {
  return {
    variant,
    tags: ["open-call", tag],
    metadata: { submissionId: submission.id, formId },
    guestLocale: resolveGuestNoticeLocale(submission),
  };
}

/**
 * The applicant-side Delivery for one recipient: a signed-in payload with
 * hub links, or a guest email whose links are re-derived at send time.
 */
function applicantNotice<P>(
  deps: OpenCallNoticeDeps,
  baseUrl: string,
  side: ApplicantSide,
  submission: OpenCallSubmissionRecord,
  form: OpenCallFormRecord,
  recipient: Recipient,
  shared: Pick<Delivery, "variant" | "tags" | "metadata" | "guestLocale">,
  build: (links: ApplicantLinks) => P,
  email: (payload: P, locale: NotificationLocale, audience: OpenCallEmailAudience) => OpenCallEmailContent,
): Delivery {
  if (recipient.kind === "human") {
    const payload = build(signedInLinks(baseUrl, side.kind === "org" ? "org" : "person"));
    return { ...shared, payload, email: null };
  }
  return {
    ...shared,
    payload: null,
    email: (locale) => email(build(guestLinks(deps, baseUrl, submission, form)), locale, "guest"),
  };
}

// ── The notices ──────────────────────────────────────────────────────────────

async function sendReceived(deps: OpenCallNoticeDeps, notice: ReceivedNotice): Promise<void> {
  const baseUrl = requireBaseUrl(deps);
  if (notice.kind === "guest_duplicate") {
    // FR-011's enumeration split: the one email to that address. No
    // submission to key on: keyed by call + address, kept an hour.
    const content = (locale: NotificationLocale) =>
      buildOpenCallGuestDuplicateEmail(
        { callTitle: notice.title, callUrl: `${baseUrl}/call/${encodeURIComponent(notice.publicId)}` },
        locale,
      );
    await deliverTo(
      deps,
      `open-call-notice:guest-duplicate:${notice.publicId}`,
      "guest-duplicate",
      { kind: "email", email: notice.contactEmail, name: null },
      {
        variant: "",
        payload: null,
        email: content,
        tags: ["open-call", "guest-duplicate"],
        metadata: {},
        // No submission to read a language from.
        guestLocale: DEFAULT_NOTIFICATION_LOCALE,
      },
      { keepSec: GUEST_DUPLICATE_KEEP_SEC },
    );
    return;
  }
  const { form, submission } = await loadSubmission(deps, notice.formId, notice.submissionId);
  const anchor = await loadOpenCallAnchor(deps.repos, form);
  const callTitle = anchor.kind === "event" ? anchor.event.title : anchor.series.name;
  // The SUBMITTER only (the guest's address, or the signed-in human).
  const recipients: Recipient[] = submission.humanId
    ? [{ kind: "human", humanId: submission.humanId }]
    : guestRecipient(submission);
  const side: ApplicantSide = {
    kind: submission.applyingAsOrgId ? "org" : submission.humanId ? "person" : "guest",
    recipients,
    orgName: null,
  };
  const shared = applicantDelivery(submission, form.id, OPEN_CALL_RECEIVED_VARIANT, "received");
  await fanOut(
    deps,
    "received",
    submission.id,
    recipients,
    (recipient) =>
      applicantNotice(
        deps,
        baseUrl,
        side,
        submission,
        form,
        recipient,
        shared,
        (links) => ({
          submissionId: submission.id,
          formId: form.id,
          callTitle,
          actionUrl: links.actionUrl,
        }),
        buildOpenCallReceivedEmail,
      ),
    // Its own reason: a guest who never gets this email has no way into
    // their application until a reconcile resends it.
    { failureReason: "application_received_failed" },
  );
}

async function sendPicked(deps: OpenCallNoticeDeps, notice: OpenCallPickedNotice): Promise<void> {
  const baseUrl = requireBaseUrl(deps);
  const { form, submission } = await loadSubmission(deps, notice.formId, notice.submissionId);
  const side = await applicantSide(deps, submission);
  const dates = await pickedDates(deps, form, submission, notice);
  const kind: OpenCallNoticeKind = notice.firstPick
    ? "picked"
    : `picked-more:${sha256([...notice.addedEventIds].sort().join(",")).slice(0, 16)}`;
  const shared = applicantDelivery(submission, form.id, OPEN_CALL_PICKED_VARIANT, "picked");
  await fanOut(deps, kind, notice.submissionId, side.recipients, (recipient) =>
    applicantNotice(
      deps,
      baseUrl,
      side,
      submission,
      form,
      recipient,
      shared,
      (links) => ({
        submissionId: notice.submissionId,
        formId: notice.formId,
        callTitle: notice.title,
        // The org's members read "<org> is on the lineup".
        actName: recipient.kind === "human" ? side.orgName : null,
        firstPick: notice.firstPick,
        dates,
        payKind: form.payKind,
        payDetails: form.payDetails,
        actionUrl: links.actionUrl,
        dropOutUrl: links.dropOutUrl,
        makePageUrl: links.makePageUrl,
      }),
      buildOpenCallPickedEmail,
    ),
  );
}

async function sendNotThisTime(
  deps: OpenCallNoticeDeps,
  notice: OpenCallNotThisTimeNotice,
): Promise<void> {
  const baseUrl = requireBaseUrl(deps);
  const { form, submission } = await loadSubmission(deps, notice.formId, notice.submissionId);
  const side = await applicantSide(deps, submission);
  // The note as stored is the source of truth (a close sweep sends none).
  const note = submission.decisionReason?.trim() || notice.decisionReason?.trim() || null;
  const shared = applicantDelivery(submission, form.id, OPEN_CALL_NOT_THIS_TIME_VARIANT, "not-this-time");
  await fanOut(deps, "not-this-time", notice.submissionId, side.recipients, (recipient) =>
    applicantNotice(
      deps,
      baseUrl,
      side,
      submission,
      form,
      recipient,
      shared,
      (links) => ({
        submissionId: notice.submissionId,
        formId: notice.formId,
        callTitle: notice.title,
        actName: recipient.kind === "human" ? side.orgName : null,
        note,
        actionUrl: links.actionUrl,
      }),
      (payload, locale) => buildOpenCallNotThisTimeEmail(payload, locale),
    ),
  );
}

async function sendPulled(deps: OpenCallNoticeDeps, notice: OpenCallPulledNotice): Promise<void> {
  const baseUrl = requireBaseUrl(deps);
  const { form, submission } = await loadSubmission(deps, notice.formId, notice.submissionId);
  const side = await applicantSide(deps, submission);
  const shared = applicantDelivery(submission, form.id, OPEN_CALL_PULLED_VARIANT, "pulled");
  await fanOut(deps, "pulled", notice.submissionId, side.recipients, (recipient) =>
    applicantNotice(
      deps,
      baseUrl,
      side,
      submission,
      form,
      recipient,
      shared,
      (links) => ({
        submissionId: notice.submissionId,
        formId: notice.formId,
        callTitle: notice.title,
        actionUrl: links.actionUrl,
      }),
      (payload, locale) => buildOpenCallPulledEmail(payload, locale),
    ),
  );
}

async function sendDroppedOut(
  deps: OpenCallNoticeDeps,
  notice: OpenCallDroppedOutNotice,
): Promise<void> {
  const baseUrl = requireBaseUrl(deps);
  const { form, submission } = await loadSubmission(deps, notice.formId, notice.submissionId);
  const anchor = await loadOpenCallAnchor(deps.repos, form);
  const side = await organizerSide(deps, anchor, baseUrl, submission.id);
  // Never the act itself (the submitter may also be an editor).
  const humanIds = side.humanIds.filter((id) => id !== submission.humanId);
  const payload = {
    submissionId: notice.submissionId,
    formId: notice.formId,
    callTitle: anchor.kind === "event" ? anchor.event.title : anchor.series.name,
    actName: await applicantName(deps, submission),
    dates: await datesOfEvents(deps, notice.removedEventIds),
    actionUrl: side.queueUrl,
  };
  // ONE notice per editor per drop out (owner ruling 2026-10-01).
  await fanOut(
    deps,
    "dropped-out",
    notice.submissionId,
    humanIds.map((humanId) => ({ kind: "human", humanId })),
    () => ({
      variant: OPEN_CALL_DROPPED_OUT_VARIANT,
      payload,
      email: null,
      tags: ["open-call", "dropped-out"],
      metadata: { submissionId: notice.submissionId, formId: notice.formId },
      guestLocale: DEFAULT_NOTIFICATION_LOCALE,
    }),
  );
}

/**
 * The id of the latest message the RECIPIENT side wrote before `messageId`
 * ("none" when they have not written), or null when `messageId` is not
 * found within MESSAGE_SCAN_MAX_PAGES (then no coalescing: notify).
 */
async function recipientSideLatestMessage(
  deps: OpenCallNoticeDeps,
  submissionId: string,
  messageId: string,
  recipientSide: string,
): Promise<string | null> {
  let latest = "none";
  let cursor: string | null = null;
  for (let page = 0; page < MESSAGE_SCAN_MAX_PAGES; page += 1) {
    const { items, nextCursor } = await deps.repos.eventApplications.listApplicationMessages({
      submissionId,
      cursor,
      limit: 100,
    });
    for (const message of items) {
      if (message.id === messageId) return latest;
      if (message.authorSide === recipientSide) latest = message.id;
    }
    if (!nextCursor) return null;
    cursor = nextCursor;
  }
  return null;
}

async function sendMessagePosted(
  deps: OpenCallNoticeDeps,
  input: Parameters<NotifyApplicationMessagePostedFn>[0],
): Promise<void> {
  const baseUrl = requireBaseUrl(deps);
  const { form, submission } = await loadSubmission(deps, input.formId, input.submissionId);
  const preview = clipOpenCallMessagePreview(input.body);
  if (preview.length === 0) return;

  // Burst rule (OPEN_CALL_MESSAGE_BURST_WINDOW_SEC). The window key names
  // the recipient side's latest message, so their reply opens a new window.
  // The window is committed (kept for the window) once this message reached
  // someone, recording which message opened it: a retry of THAT message
  // passes (its per-recipient keys dedupe), any other message inside the
  // window is coalesced. Reaching nobody releases it. A message that finds
  // the window still IN FLIGHT (not yet settled) is not coalesced.
  const latest = await recipientSideLatestMessage(
    deps,
    submission.id,
    input.messageId,
    input.recipientSide,
  );
  const windowKey =
    latest === null
      ? null
      : `open-call-notice:message-window:${submission.id}:${input.recipientSide}:${latest}`;
  const windowClaim = randomUUID();
  const windowOwned =
    windowKey !== null && (await deps.idempotency.begin(windowKey, CLAIM_TTL_SEC, windowClaim));
  if (windowKey && !windowOwned) {
    // Coalesce only behind a SETTLED window (a message that reached someone).
    // A window still in flight may yet reach nobody and be released, so a
    // concurrent message goes through: its per-recipient keys stop a double
    // send, and at worst the burst gets one extra notice.
    const opener = await deps.idempotency.get<{ messageId?: string }>(windowKey);
    if (opener !== null && opener.messageId !== input.messageId) {
      deps.logger?.info("open_call.message_notice_coalesced", {
        submissionId: submission.id,
        messageId: input.messageId,
        recipientSide: input.recipientSide,
      });
      return;
    }
  }
  const outcomes: DeliveryOutcome[] = [];
  try {
    const anchor = await loadOpenCallAnchor(deps.repos, form);
    const callTitle = anchor.kind === "event" ? anchor.event.title : anchor.series.name;
    const exclude = new Set(input.authorHumanId ? [input.authorHumanId] : []);
    let recipients: Recipient[];
    let side: ApplicantSide | null = null;
    let queueUrl: string | null = null;
    let authorName: string | null = null;
    if (input.recipientSide === "APPLICANT") {
      side = await applicantSide(deps, submission, exclude);
      recipients = side.recipients;
    } else {
      const organizers = await organizerSide(deps, anchor, baseUrl, submission.id);
      // Never the sender; and never the applicant, even through a token.
      if (submission.humanId) exclude.add(submission.humanId);
      recipients = organizers.humanIds
        .filter((id) => !exclude.has(id))
        .map((humanId) => ({ kind: "human", humanId }));
      queueUrl = organizers.queueUrl;
      authorName = await applicantName(deps, submission);
    }
    const shared = {
      variant: OPEN_CALL_MESSAGE_VARIANT,
      tags: ["open-call", "message"],
      metadata: { submissionId: submission.id, formId: form.id, messageId: input.messageId },
      guestLocale: resolveGuestNoticeLocale(submission),
    };
    const build = (actionUrl: string) => ({
      submissionId: submission.id,
      formId: form.id,
      messageId: input.messageId,
      callTitle,
      recipientSide: input.recipientSide,
      authorName,
      preview,
      actionUrl,
    });
    const baseKey = `open-call-notice:message:${input.messageId}`;
    for (const recipient of recipients) {
      const delivery: Delivery =
        side !== null
          ? applicantNotice(
              deps,
              baseUrl,
              side,
              submission,
              form,
              recipient,
              shared,
              (links) => build(links.actionUrl),
              (payload, locale) => buildOpenCallMessageEmail(payload, locale),
            )
          : { ...shared, payload: build(queueUrl ?? `${baseUrl}/`), email: null };
      outcomes.push(await deliverTo(deps, baseKey, "message", recipient, delivery));
    }
  } finally {
    if (windowKey && windowOwned) {
      await settleMessageWindow(deps, windowKey, windowClaim, input.messageId, outcomes);
    }
  }
}

/**
 * Keep the window only when the message reached someone AND nobody failed;
 * free it otherwise. A recipient whose notify failed would otherwise miss
 * every follow-up inside the window too (no reconcile covers messages), so
 * a partial failure lets the next message go out to everyone, at the cost of
 * one extra notice for those already reached.
 */
async function settleMessageWindow(
  deps: OpenCallNoticeDeps,
  windowKey: string,
  claim: string,
  messageId: string,
  outcomes: readonly DeliveryOutcome[],
): Promise<void> {
  try {
    if (
      outcomes.some((o) => o === "sent" || o === "already") &&
      !outcomes.some((o) => o === "failed")
    ) {
      await deps.idempotency.commit(windowKey, { messageId }, OPEN_CALL_MESSAGE_BURST_WINDOW_SEC);
    } else {
      await deps.idempotency.release(windowKey, claim);
    }
  } catch (error) {
    // Worst case the claim lapses after CLAIM_TTL_SEC: a message inside that
    // span is coalesced, or one after it is notified. Reported, not thrown.
    reportRecipientFailure(deps, error, {
      kind: "message",
      reason: "message_window_settle_failed",
      key: windowKey,
      recipientId: "window",
    });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
