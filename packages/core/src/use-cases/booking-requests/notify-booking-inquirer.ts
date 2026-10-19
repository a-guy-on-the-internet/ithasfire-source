import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { isUnclaimedBookingInquiry } from "@th/ports/repos/booking-requests";

import { trimTrailingSlash } from "../../lib/url";
import type { NotifyBookingRequestMessageArgs } from "./notify-booking-request-message";

// ─────────────────────────────────────────────────────────────────────────────
// notifyBookingInquirer — deliver a venue's thread reply to an ANONYMOUS
// embed inquirer (booking-inquirer-outreach, 2026-09-05)
//
// THE BUG THIS FIXES: a venue replying in the thread of an anonymous embed
// inquiry reached NOBODY. `notifyBookingRequestMessage` resolves zero
// recipients for a sender with no humanId (it logs
// `…notify_message.anonymous_performer_skipped` and returns), so the venue
// typed into the void.
//
// THREE THINGS HAVE TO BE TRUE for the reply to land, and each one is a
// separate reason this use case exists rather than a tweak to the notifier:
//
//  1. The inquirer needs an identity. Minted LAZILY here — on the venue's
//     first reply — via `humans.ensureGuestHuman`, never at form-submit time:
//     the overwhelming majority of embed inquiries are never answered, and
//     minting a Human per submission would turn a public form into an
//     unauthenticated account-creation endpoint.
//
//  2. The email cannot ride notify(). `comms/channels/send-email.ts` hard
//     returns `skipped: "unverified"` unless `identity.emailVerified`, and a
//     shadow AuthUser is unverified by construction — so notify()'s email leg
//     can NEVER reach an inquirer. This sends through `MailerPort` directly,
//     the same precedent as `orders/send-ticket-issued-email.ts` and
//     `_shared/invite-email.ts` (rationale documented in
//     `orders/notify-buyer.ts`: "Email is left to the dedicated mailers").
//
//  3. Nothing here may endanger the venue's message. The message and its
//     `lastMessageAt` bump are ALREADY durably committed by
//     `postBookingRequestMessage` before its post-commit hook runs. This use
//     case therefore NEVER throws: every failure is logged at error and
//     reported through `ReporterPort` (house convention — warn is not
//     Sentry-captured), and it returns whatever record it has.
//
// IDEMPOTENCE. A second reply must not re-mint or re-flip: `ensureGuestHuman`
// is idempotent on `AuthUser.email` and reports `created: false` the second
// time (which is also the identity gate — see `attachShadowOwner`),
// `attachInquirerOwner` is a CAS that matches zero rows once the pair is set,
// the mailer carries a per-message `idempotencyKey`, and the thread root is a
// first-write-wins CAS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local-part prefix of the OUTREACH MARKER stored on the request. Greppable,
 * and the request + message ids make it unique. NOT sent as a Message-ID —
 * the provider replaces that (see the block in the send path).
 */
const MESSAGE_ID_PREFIX = "booking-inquiry";

/** Fallback venue label when the place row is gone (SetNull'd name). */
const PLACE_NAME_FALLBACK = "the place";

/**
 * Right-hand side of the marker when `publicAppUrl` will not parse. Only ever
 * reached on a misconfiguration, which is REPORTED — see {@link messageIdDomain}.
 */
const MESSAGE_ID_DOMAIN_FALLBACK = "ithasfire.com";

export type NotifyBookingInquirerDeps = {
  repos: Pick<
    Repos,
    | "bookingRequests"
    | "bookingRequestMessages"
    | "humans"
    | "places"
    | "organizations"
  >;
  /** Optional at the type level; missing at send time is a reported failure. */
  mailer?: MailerPort;
  /** Required for the Message-ID domain. Missing is a reported failure. */
  publicAppUrl?: string | null;
  logger?: LoggerPort;
  /** Deliberate-swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
};

/**
 * Reachability pass for the PERFORMER side of a thread message.
 *
 * Returns the FRESH booking-request record (flipped to shadow-owned when this
 * call did the flip) so the caller can hand the notifier an up-to-date row;
 * returns `null` when this path does not apply or when it failed. Never
 * throws.
 */
export async function notifyBookingInquirer(
  deps: NotifyBookingInquirerDeps,
  args: NotifyBookingRequestMessageArgs,
): Promise<BookingRequestRecord | null> {
  const logger = deps.logger?.child({ useCase: "notifyBookingInquirer" });
  const { bookingRequest, message, recipientSide } = args;

  // Applicability, cheapest first — all read off the snapshot the caller
  // already has. Only a VENUE-authored message on a TO_VENUE thread can be
  // headed for an anonymous inquirer.
  if (recipientSide !== "PERFORMER") return null;
  if (message.authorSide !== "VENUE") return null;
  if (bookingRequest.direction !== "TO_VENUE") return null;
  if (!isUnclaimedBookingInquiry(bookingRequest)) return null;

  try {
    // Re-read: `bookingRequest` is the pre-transaction snapshot the post use
    // case loaded, so a concurrent claim (or a previous reply's flip) may
    // already have moved the row. Every decision below is made on the fresh
    // row.
    const fresh = await deps.repos.bookingRequests.getById(bookingRequest.id);
    if (!fresh || fresh.direction !== "TO_VENUE") return null;
    if (!isUnclaimedBookingInquiry(fresh)) {
      // Claimed between the venue's post and now — the ordinary notify()
      // pipeline owns this recipient from here.
      return fresh;
    }
    // Narrowing for the compiler; `isUnclaimedBookingInquiry` already proved
    // both are non-null.
    const contactEmail = fresh.contactEmail;
    const contactName = fresh.contactName;
    if (contactEmail === null || contactName === null) return fresh;

    // DELIVERY IS THE FEATURE; THE OWNER PAIR IS AN OPTIMISATION — so the
    // flip gets its OWN catch and can never gate the send.
    //
    // The post-commit hook fires EXACTLY ONCE per message and nothing retries
    // it, and the mailer's `idempotencyKey` cannot rescue a `send` that never
    // happened. So before this catch existed, a connection reset or a P1001
    // anywhere in the mint/flip dropped that venue reply PERMANENTLY — the
    // precise failure this use case was written to end. The
    // `duplicate_open_request` branch inside already encoded the right
    // principle ("a dedupe collision is never a reason to drop a venue's
    // reply"); this generalises it to every failure mode, including a failed
    // mint, after which the row simply stays anonymous.
    let attached: BookingRequestRecord | null = null;
    try {
      attached = await attachShadowOwner(deps, logger, fresh, {
        contactEmail,
        contactName,
      });
    } catch (error) {
      logger?.error("booking_requests.notify_inquirer.attach_owner_failed", {
        bookingRequestId: fresh.id,
        err: error,
      });
      report(deps, error, {
        bookingRequestId: fresh.id,
        messageId: message.id,
        step: "attach_owner",
      });
    }

    await sendInquirerEmail(
      deps,
      logger,
      attached ?? fresh,
      message,
      contactEmail,
    );

    return attached ?? fresh;
  } catch (error) {
    // The venue's message is already committed — swallow, but keep the
    // failure visible (log at error AND report; warn is not Sentry-captured).
    logger?.error("booking_requests.notify_inquirer_failed", {
      bookingRequestId: bookingRequest.id,
      messageId: message.id,
      err: error,
    });
    report(deps, error, {
      bookingRequestId: bookingRequest.id,
      messageId: message.id,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadow identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint the inquirer's shadow Human and attach it to the request.
 *
 * Returns the flipped record, or `null` when nothing was flipped — which is a
 * NORMAL outcome, not a failure: the address already resolved to an existing
 * Human (see the gate below), or an earlier reply already flipped it. The
 * email is sent either way.
 *
 * MAY THROW, and that is safe: the caller wraps this call in its own catch and
 * sends the venue's reply regardless (see the call site). Nothing in here is
 * allowed to become a reason the inquirer never hears back.
 */
async function attachShadowOwner(
  deps: NotifyBookingInquirerDeps,
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  contact: { contactEmail: string; contactName: string },
): Promise<BookingRequestRecord | null> {
  // NO `name` ON THE ENSURE CALL. `ensureGuestHuman`'s adapter OVERWRITES an
  // existing Human's display name when one is passed, and BOTH the name and
  // the address here come from an unauthenticated public embed form — so
  // passing it would let anyone rename a real account's Human row by typing
  // that account's email into a booking form. The name is applied only on the
  // create branch, below.
  const ensured = await deps.repos.humans.ensureGuestHuman({
    email: contact.contactEmail,
  });

  // FAIL-CLOSED IDENTITY GATE — THE TEST IS `ensured.created`, NOTHING ELSE.
  //
  // The contact address was typed into an unauthenticated public form and
  // nobody has proved control of that mailbox; only the invite-to-claim token
  // does that (embed spec FR-007). So attach ONLY to a Human this very call
  // minted. If the address already resolved to an existing Human, a stranger
  // could otherwise plant an authored-by-them booking request inside that
  // person's account: it would surface in their sent-pitches inbox
  // (`list-booking-requests` scope "performer"), it would occupy their
  // "BookingRequest_open_pair_key" slot at that place and make their OWN
  // request fail `duplicate_open_request`, and `notifyBookingRequestMessage`
  // would start mailing them about it.
  //
  // DO NOT REPLACE THIS WITH A "is the existing Human real?" HEURISTIC. Every
  // candidate signal in this codebase is wrong:
  //   - `listAuthAccounts(humanId).length > 0` (what this used to test) misses
  //     MAGIC-LINK accounts entirely. `magicLink()` is mounted in
  //     `apps/api/src/auth/better-auth.ts` with NO `disableSignUp`, and Better
  //     Auth's verify handler does `createUser({ emailVerified: true })` +
  //     `createSession` without ever writing an `account` row. A fully
  //     loginable, verified user therefore has ZERO AuthAccount rows and read
  //     as a shadow. Passkey-only accounts have the same shape.
  //   - `emailVerified` is no proxy either: `requireEmailVerification` is
  //     false, so an unverified real account signs in normally.
  // Minting is the only signal we own end to end.
  //
  // COST OF BEING WRONG-CLOSED: nothing that matters. The reply is emailed
  // either way — delivering it was the entire point of this use case — and the
  // row simply stays anonymous, which every other surface already handles. It
  // does make the flip effectively one-shot: if `attachInquirerOwner` fails
  // after a successful mint, a later reply sees `created: false` and will not
  // retry. Accepted; mail delivery, not the owner pair, is the feature.
  if (!ensured.created) {
    // REPORT AT MOST ONCE PER THREAD. `created` is false on EVERY reply after
    // the first, so an unguarded report here fires a Sentry event per venue
    // message. Two distinct doors reach that:
    //
    //  1. The first reply minted this shadow and attached it, so the row
    //     already carries exactly this owner — the ordinary idempotent path.
    //  2. The first reply minted this shadow but the attach LOST — a
    //     `duplicate_open_request` collision, or a transient failure the
    //     caller now swallows — leaving the owner pair null forever. `created`
    //     is false from then on and the owner check below can never match, so
    //     this used to re-fire on EVERY subsequent reply, and under a label
    //     ("existing human") that sent triage hunting an impersonation signal
    //     that does not exist: the existing Human is OUR OWN shadow from the
    //     earlier mint. That cause is already reported once, as
    //     `attach_owner_duplicate` / `attach_owner`.
    //
    // `inquirerEmailMessageId` is the discriminator: the FIRST send on this
    // thread stamps it, so a non-null root means an earlier reply already went
    // through this branch (or through the mint ahead of it) and said its
    // piece. The label is `not_created` rather than `existing_human` because
    // this call cannot prove which door it came through — see the residual
    // case below.
    const alreadyAttachedToThisShadow =
      request.performerOwnerType === "human" &&
      request.performerOwnerId === ensured.humanId;
    const alreadyMailedThisThread = request.inquirerEmailMessageId !== null;
    if (!alreadyAttachedToThisShadow && !alreadyMailedThisThread) {
      // This one IS news, and COUNTABLE rather than merely logged. On a thread
      // we have never mailed, `created: false` means the address already
      // resolved to a Human before we ever touched it: an address with an
      // account, typed into an unauthenticated public embed form — the shape
      // of both an honest typo and a deliberate impersonation attempt.
      // `info`/`warn` are not Sentry-captured (CLAUDE.md), so report as well
      // as log.
      //
      // RESIDUAL: if an earlier reply minted the shadow and then FAILED to
      // send (no root stamped), the next reply reports our own shadow under
      // this label. That send failure is itself reported, the over-report is
      // bounded to one thread, and erring loud is the right direction for an
      // impersonation-shaped signal.
      logger?.error(
        "booking_requests.notify_inquirer.flip_skipped_not_created",
        { bookingRequestId: request.id },
      );
      report(deps, new Error("booking_inquirer_flip_skipped_not_created"), {
        bookingRequestId: request.id,
        step: "flip_skipped_not_created",
      });
    }
    return null;
  }

  // Best-effort display name for a Human we just minted (no pre-existing value
  // to clobber). A failure here must not cost the venue their email.
  try {
    await deps.repos.humans.update(ensured.humanId, {
      name: contact.contactName,
    });
  } catch (error) {
    logger?.error("booking_requests.notify_inquirer.shadow_name_failed", {
      bookingRequestId: request.id,
      err: error,
    });
    report(deps, error, { bookingRequestId: request.id, step: "shadow_name" });
  }

  try {
    const flipped = await deps.repos.bookingRequests.attachInquirerOwner({
      id: request.id,
      performerOwnerType: "human",
      performerOwnerId: ensured.humanId,
    });
    if (flipped) {
      logger?.info("booking_requests.notify_inquirer.shadow_attached", {
        bookingRequestId: request.id,
        humanId: ensured.humanId,
      });
    }
    return flipped;
  } catch (error) {
    // The one expected domain failure: this shadow already holds an open
    // request at the same place, so the flip violates the SQL-only partial
    // unique "BookingRequest_open_pair_key". The reply still goes out — a
    // dedupe collision is never a reason to drop a venue's message — and the
    // row simply stays anonymous, which every other surface still handles.
    if (isDuplicateOpenRequest(error)) {
      logger?.error("booking_requests.notify_inquirer.flip_duplicate_open", {
        bookingRequestId: request.id,
        humanId: ensured.humanId,
      });
      report(deps, error, {
        bookingRequestId: request.id,
        step: "attach_owner_duplicate",
      });
      return null;
    }
    throw error;
  }
}

function isDuplicateOpenRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "duplicate_open_request"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The email
// ─────────────────────────────────────────────────────────────────────────────

async function sendInquirerEmail(
  deps: NotifyBookingInquirerDeps,
  logger: LoggerPort | undefined,
  request: BookingRequestRecord,
  message: NotifyBookingRequestMessageArgs["message"],
  contactEmail: string,
): Promise<void> {
  if (!deps.mailer) {
    throw new Error("booking_inquirer_mailer_not_configured");
  }
  if (!deps.publicAppUrl) {
    throw new Error("booking_inquirer_public_app_url_missing");
  }

  const placeId = request.direction === "TO_VENUE" ? request.placeId : null;
  const place = placeId ? await deps.repos.places.getById(placeId) : null;
  const placeName =
    request.placeName?.trim() || place?.name?.trim() || PLACE_NAME_FALLBACK;

  // Reply-To: the venue's OWN public address, so a plain reply lands with the
  // venue rather than in our unattended mailbox. There is deliberately no
  // inbound ingestion in this scope, so when no such address exists we send NO
  // Reply-To and the template drops the "just reply" line — never invite a
  // reply we cannot route.
  const replyToEmail = await resolveVenueReplyTo(deps, place?.orgIdsWithAccess);

  // An OUTREACH MARKER, not a Message-ID — read the next comment before
  // reusing it as one. Deterministic in the message id so a retry reuses it.
  const domain = messageIdDomain(deps, logger, deps.publicAppUrl);
  const messageId = `${MESSAGE_ID_PREFIX}.${request.id}.${message.id}@${domain}`;

  // NO THREADING HEADERS. This is not an oversight — it is the measured
  // behaviour of the provider, and re-adding them would restore a silent bug.
  //
  // VERIFIED 2026-09-08 by sending through Resend to a real Gmail account and
  // reading the delivered MIME: a caller-supplied `Message-Id` is DISCARDED
  // and replaced with the provider's own
  // (`<010001a083139ef2-…-000000@email.amazonses.com>` — Resend sends via SES).
  // So the id we mint is never the id that lands in anyone's mailbox, and an
  // `In-Reply-To`/`References` built from it points at a message that does not
  // exist anywhere. The probe pair arrived in Gmail as TWO SEPARATE THREADS.
  //
  // Emitting them anyway was worse than emitting nothing: a dangling
  // `In-Reply-To` is a threading instruction clients cannot satisfy, and the
  // code logged `threaded: true` while nothing was threaded. What actually
  // groups these messages today is the STABLE SUBJECT (`registry.ts` keeps it
  // free of anything that varies between sends) plus a constant From/To pair.
  //
  // The durable fix, if threading is ever worth more than this: capture the
  // PROVIDER's message id — the `email.sent` Resend webhook, which we already
  // receive at `/webhooks/resend` for bounces — persist that as the root, and
  // reference it. That requires a non-restricted API key or the webhook
  // payload to carry the RFC id; the dev key is send-only, so it was not
  // settled here.

  await deps.mailer.send({
    to: { to: contactEmail },
    ...(replyToEmail ? { replyTo: { to: replyToEmail } } : {}),
    template: {
      key: "booking.thread_message",
      variables: {
        placeName,
        messageBody: message.body,
        replyToEmail,
      },
    },
    // DELIBERATELY NO List-Unsubscribe: this is transactional mail inside a
    // conversation the recipient started, not marketing.
    idempotencyKey: `booking-inquirer-message:${message.id}`,
  });

  // First send stamps the marker. First-write-wins CAS, so two concurrent
  // replies cannot leave it oscillating. Its ONE job is to record "this row
  // was mailed", which is what scopes the bounce/complaint fan-in
  // (`markInquirerEmailUndeliverable` matches on `inquirerEmailMessageId IS
  // NOT NULL`). It is NOT a Message-ID and must not be used as one.
  if (!request.inquirerEmailMessageId) {
    await deps.repos.bookingRequests.setInquirerEmailMessageId({
      id: request.id,
      messageId,
    });
  }

  logger?.info("booking_requests.notify_inquirer.email_sent", {
    bookingRequestId: request.id,
    // No `threaded` field on purpose: it used to report Boolean(root) and was
    // true on every reply after the first, while nothing was ever threaded.
    hasReplyTo: Boolean(replyToEmail),
  });
}


/**
 * The thread row id embedded in a stored root Message-ID, or `null` when it
 * does not parse. Parses the LOCAL PART only — `<prefix>.<requestId>.<rowId>` —
 * so a root emitted under a previous `publicAppUrl` still resolves.
 */
function rootThreadMessageId(request: BookingRequestRecord): string | null {
  const root = request.inquirerEmailMessageId;
  if (!root) return null;
  const localPart = root.split("@")[0] ?? "";
  const prefix = `${MESSAGE_ID_PREFIX}.${request.id}.`;
  if (!localPart.startsWith(prefix)) return null;
  return localPart.slice(prefix.length) || null;
}

/**
 * The venue's public Reply-To. Org-owned places use the owning org's
 * `Organization.contactEmail` (already the platform's Reply-To convention for
 * org-originated mail). A directly human-owned venue has no equivalent public
 * address, so it gets none — see the caller.
 */
async function resolveVenueReplyTo(
  deps: NotifyBookingInquirerDeps,
  orgIds: readonly string[] | undefined,
): Promise<string | null> {
  for (const orgId of orgIds ?? []) {
    const org = await deps.repos.organizations.getById(orgId);
    const email = org?.contactEmail?.trim();
    if (email) return email;
  }
  return null;
}

/** Host of the public app — the RFC 5322 right-hand side of the Message-ID. */
function messageIdDomain(
  deps: NotifyBookingInquirerDeps,
  logger: LoggerPort | undefined,
  publicAppUrl: string,
): string {
  try {
    // `hostname`, NOT `host`: `host` carries the PORT, and a colon is not
    // legal in a Message-ID's domain (RFC 5322 `id-right`). Verified against a
    // real SMTP send on 2026-09-06 — a local `PUBLIC_APP_URL` of
    // http://localhost:3000 emitted `<...@localhost:3000>`, which a stricter
    // MTA than Mailpit may reject or rewrite, silently breaking threading.
    return new URL(trimTrailingSlash(publicAppUrl)).hostname;
  } catch (error) {
    // A malformed base URL must not cost the email; a syntactically valid
    // constant still threads correctly (clients treat msg-ids as opaque).
    // But it MUST be visible: left silent, a misconfigured PUBLIC_APP_URL
    // threads every inquirer email under a foreign domain forever and nothing
    // ever says so. Swallow + report is the house convention (CLAUDE.md).
    logger?.error("booking_requests.notify_inquirer.public_app_url_invalid", {
      err: error,
    });
    report(deps, error, { step: "message_id_domain" });
    return MESSAGE_ID_DOMAIN_FALLBACK;
  }
}

function report(
  deps: NotifyBookingInquirerDeps,
  error: unknown,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "notifyBookingInquirer" },
      extra,
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never turn a
    // swallow back into a failure.
  }
}
