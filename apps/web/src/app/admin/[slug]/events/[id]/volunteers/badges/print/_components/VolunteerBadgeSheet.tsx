"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Button, NextLinkAnchor, useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { PaperSheet } from "@/app/_print/PaperSheet";
import { PrintButton } from "@/app/_print/PrintButton";

import { isSameZonedDay, resolveDisplayTimeZone } from "@/app/_print/zoned-time";
import {
  chunkIntoRows,
  selectBadgeRecipients,
  type BadgeAssignment,
  type BadgeRecipient,
  type BadgeRoleRow,
  type BadgeSignupRow,
} from "./badge-sheet-helpers";
import "./volunteer-badge-sheet.css";

/**
 * THE VOLUNTEER BADGE SHEET — a roster-wide run of organizer-issued badges.
 *
 * ── The product boundary, which is the design and not a detail ────────────
 *
 * BADGES ARE ORGANIZER/VENUE-ISSUED. A badge is credential stock: it reads as
 * authorization at a door, so it comes from whoever is accountable there. That
 * is why this surface lives under `/admin/[slug]/events/[id]/volunteers/` and
 * needs no authorization change at all — org-edit roles (and a platform ADMIN
 * acting on a tenant) can already mint `kind: "print"` volunteer scan tokens.
 *
 * A VOLUNTEER GETS A QR, NOT A BADGE. The volunteer's own printable code —
 * "scan me in", for the volunteer whose phone is dead — is a separate, later
 * surface with its own tighter TTL ceiling (`computeSelfPrintTtlSeconds`).
 * Nothing in this file may be reachable by a volunteer for their own signup,
 * and nothing here should grow toward that: see the standing note on
 * `VolunteerScanTokenPort`.
 *
 * ── Data, and why the route is safe without a client gate ─────────────────
 *
 * `isPrintDocumentRoute` makes `AppChrome` return before `AppAuthGate`, and
 * `AdminShellFrame` drops the admin chrome for the same reason (a rail on a
 * sheet of badges is not a badge). So the client-side gates do NOT run here,
 * and safety is entirely a property of the DATA LAYER — exactly the warning in
 * `src/lib/print-route.ts`. Every read on this page is org-edit-gated
 * server-side:
 *
 *   - `events.getEventForEdit`   → `ensureActorCanEdit`
 *   - `volunteer.roles.list`     → org-edit roles on the event's org
 *   - `volunteer.signups.list`   → `requireOrgMembership(ORG_EDIT_ROLES)`
 *   - `volunteer.signups.mintScanToken` → owner OR org-edit, authorized BEFORE
 *     any state inspection, and it refuses a non-APPROVED signup outright.
 *
 * An operator with no claim on the event gets errors, not a document.
 *
 * ── Why issuing is an explicit act, not something a page load does ────────
 *
 * Minting writes an audit row per badge (`scan_token_minted`), which is the
 * ONLY place a printed credential's provenance is recorded — who issued it,
 * when, with what TTL. Auto-minting the whole roster on mount would fire that
 * on every refresh and twice per mount under React's StrictMode, turning the
 * one durable record of "these badges exist" into noise. So the roster loads
 * on arrival (a read), and the operator presses Issue (a write). It also reads
 * correctly: you are ISSUING credentials, not viewing a report.
 */

/** Badges per printed row. Paired with the 3-rows-per-page rule in the CSS. */
const BADGES_PER_ROW = 2;

/**
 * The Print control's test id, used as a FOCUS TARGET as well as a test hook.
 *
 * Issuing unmounts the button the operator just pressed and mounts Print in
 * its place, so focus lands on `<body>` and a keyboard or switch-control user
 * is dropped to the top of the document with no indication that anything
 * happened. Measured in a browser, not assumed. Same remedy, and the same
 * lookup-after-paint reason, as `UnifiedScanView`'s `dismissResult`: the
 * target does not exist until the render that replaces the pressed button.
 */
const PRINT_ACTION_TEST_ID = "volunteer-badges-print-action";

/**
 * The roster page size. 200 is the server's hard ceiling
 * (`listVolunteerSignupsInputSchema`), so one page covers every event we have
 * ever seen; the continuation path below exists for the festival that does not.
 */
const ROSTER_PAGE_SIZE = 200;

/**
 * How many mints are in flight at once.
 *
 * Not unbounded: a 300-volunteer festival firing 300 simultaneous mutations
 * would open 300 audit-writing transactions against the API for a document
 * nobody is waiting on that hard. Small enough to be polite, large enough that
 * a typical roster issues in about a second.
 */
const MINT_CONCURRENCY = 8;

/** Date part of a shift window, in the VENUE's zone. */
const SHIFT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
};

const SHIFT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
};

/**
 * The END of a window names the zone, once per line.
 *
 * Every time on this badge is rendered in the VENUE's zone (`Event.timezone`),
 * which is the right choice for a document read while standing in the venue —
 * and a genuine improvement on the ticket stub, whose contract does not carry
 * a zone at all. Naming it anyway costs four characters and turns an
 * out-of-town volunteer's "wait, is that my time or theirs?" into a fact.
 */
const SHIFT_END_FORMAT: Intl.DateTimeFormatOptions = {
  ...SHIFT_TIME_FORMAT,
  timeZoneName: "short",
};

const ISSUED_STAMP_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

// ── Notice (loading / empty / manifest / error) ─────────────────────────────

/**
 * `role="status"` + `aria-live="polite"`: these branches swap IN PLACE with no
 * navigation and no focus move, so without an announcement a screen-reader
 * operator hears "Loading the volunteer roster" and then nothing at all when
 * the roster (or the failure) arrives below their reading position.
 */
const Notice = ({
  title,
  body,
  testId,
  extra,
  action,
}: {
  title: string;
  body: string;
  testId: string;
  extra?: ReactNode;
  action?: ReactNode;
}) => (
  <div
    className="th-badge-sheet__notice"
    data-testid={testId}
    role="status"
    aria-live="polite"
  >
    <h1 className="th-badge-sheet__notice-title">{title}</h1>
    <p className="th-badge-sheet__notice-body">{body}</p>
    {extra}
    {action}
  </div>
);

// ── One badge ───────────────────────────────────────────────────────────────

type BadgeProps = {
  recipient: BadgeRecipient;
  token: string;
  issuerName: string | null;
  eventTitle: string;
  venueLabel: string;
  labels: {
    designation: string;
    issuedBy: (issuer: string) => string;
    event: string;
    venue: string;
    roleUnknown: string;
    shiftUnassigned: string;
    scanAlt: (name: string) => string;
  };
  formatWindow: (assignment: BadgeAssignment) => string | null;
};

const Badge = ({
  recipient,
  token,
  issuerName,
  eventTitle,
  venueLabel,
  labels,
  formatWindow,
}: BadgeProps) => (
  <article className="th-badge" data-testid={`volunteer-badge-${recipient.humanId}`}>
    <div className="th-badge__head">
      <p className="th-badge__designation">{labels.designation}</p>
      {issuerName ? (
        <p className="th-badge__issuer">{labels.issuedBy(issuerName)}</p>
      ) : null}
    </div>
    <hr className="th-badge__rule" />

    <h2 className="th-badge__name">{recipient.name}</h2>

    <ul className="th-badge__assignments">
      {recipient.assignments.map((assignment) => {
        const window = formatWindow(assignment);
        return (
          <li key={assignment.signupId}>
            <p className="th-badge__role">
              {assignment.roleName ?? labels.roleUnknown}
            </p>
            <p className="th-badge__shift">{window ?? labels.shiftUnassigned}</p>
          </li>
        );
      })}
    </ul>

    <div className="th-badge__foot">
      <dl className="th-badge__where">
        <div className="th-badge__field">
          <dt className="th-paper__label">{labels.event}</dt>
          <dd className="th-badge__field-value">{eventTitle}</dd>
        </div>
        <div className="th-badge__field">
          <dt className="th-paper__label">{labels.venue}</dt>
          <dd className="th-badge__field-value">{venueLabel}</dd>
        </div>
      </dl>

      {/*
        The scan block. Rendered as SVG CONTENT rather than a hosted image on
        purpose: `/tickets/qr/[code]` only accepts `[A-Za-z0-9_-]{4,128}` and a
        signed volunteer token is a ~290-character JWT, so that route cannot
        serve this payload — and asking a `no-store` endpoint to render a
        bearer credential per badge would be the wrong shape anyway.

        Colours are qrcode.react's defaults (#000 on #FFF), deliberately NOT
        overridden with theme tokens: a badge QR must print dark-on-white even
        when the operator's ACCOUNT theme is dark, and the surrounding panel is
        already pinned to `--print-paper` with `print-color-adjust: exact`.
        The SVG's own background rect is CONTENT, so it survives Chrome's
        "Background graphics: off" default whatever the panel does.

        Level "M", not the ticket route's "H": there is no logo excavation to
        recover from here, and a long JWT at "H" would push the symbol past 80
        modules — at 28mm that is a module too small to scan reliably. No flame
        mark, for the same reason.
      */}
      <div className="th-badge-qr">
        <QRCodeSVG
          className="th-badge-qr__svg"
          value={token}
          level="M"
          role="img"
          aria-label={labels.scanAlt(recipient.name)}
        />
      </div>
    </div>
  </article>
);

// ── Main ────────────────────────────────────────────────────────────────────

type IssueState =
  | { phase: "idle" }
  | { phase: "issuing"; done: number; total: number }
  | { phase: "issued"; tokens: Map<string, string>; failed: BadgeRecipient[] };

export const VolunteerBadgeSheet = ({
  slug,
  eventId,
}: {
  slug: string;
  eventId: string;
}) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const eventQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { staleTime: 60_000 },
  );
  const rolesQuery = trpc.volunteer.roles.list.useQuery(
    { eventId },
    { staleTime: 30_000 },
  );
  const signupsQuery = trpc.volunteer.signups.list.useQuery(
    { eventId, status: "APPROVED", limit: ROSTER_PAGE_SIZE, offset: 0 },
    { staleTime: 30_000 },
  );

  /**
   * `hasMounted` — the hydration guard, and it is load-bearing on this layer.
   *
   * The hours statement's whole tree was torn down and rebuilt because the
   * server pass and the client's first render disagreed about which branch to
   * take. `issuedAt` has the same shape of problem for a different reason: a
   * `new Date()` read during render differs between the two passes. Both stay
   * null until the effect runs, and every consumer drops out rather than
   * printing a placeholder.
   */
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);

  const [issue, setIssue] = useState<IssueState>({ phase: "idle" });
  const [issuedAt, setIssuedAt] = useState<Date | null>(null);
  /** Guards a double-click in the same tick, which state alone cannot. */
  const issuingRef = useRef(false);

  // Give the keyboard somewhere to land once the badges exist — see
  // PRINT_ACTION_TEST_ID. Runs only on the transition INTO `issued`, so it
  // cannot steal focus from someone reading the sheet afterwards.
  const issuePhase = issue.phase;
  useEffect(() => {
    if (issuePhase !== "issued") return;
    if (typeof document === "undefined") return;
    document
      .querySelector<HTMLElement>(`[data-testid="${PRINT_ACTION_TEST_ID}"]`)
      ?.focus?.();
  }, [issuePhase]);

  // ── Roster continuation ──────────────────────────────────────────────────
  // The first page is a normal React Query read (it owns loading/error/empty).
  // Only an event with more than 200 approved signups needs more, and a badge
  // run that silently stopped at 200 would leave a volunteer at a door with no
  // credential and no explanation — so the tail is fetched too.
  const [extraSignups, setExtraSignups] = useState<BadgeSignupRow[]>([]);
  const [rosterError, setRosterError] = useState(false);
  const firstPage = signupsQuery.data;
  const rosterTotal = firstPage?.pageInfo?.total ?? firstPage?.items.length ?? 0;

  useEffect(() => {
    if (!firstPage) return;
    if (rosterTotal <= firstPage.items.length) return;

    let cancelled = false;
    setRosterError(false);
    void (async () => {
      const rest: BadgeSignupRow[] = [];
      try {
        for (
          let offset = firstPage.items.length;
          offset < rosterTotal;
          offset += ROSTER_PAGE_SIZE
        ) {
          const page = await utils.volunteer.signups.list.fetch({
            eventId,
            status: "APPROVED",
            limit: ROSTER_PAGE_SIZE,
            offset,
          });
          if (cancelled) return;
          if (page.items.length === 0) break;
          rest.push(...(page.items as BadgeSignupRow[]));
        }
        if (!cancelled) setExtraSignups(rest);
      } catch {
        // Reported through the normal error branch below rather than swallowed
        // into a short roster: an incomplete badge run must never look complete.
        if (!cancelled) setRosterError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, firstPage, rosterTotal, utils]);

  const allSignups = useMemo<BadgeSignupRow[]>(
    () => [...((firstPage?.items ?? []) as BadgeSignupRow[]), ...extraSignups],
    [firstPage, extraSignups],
  );
  const rosterComplete = !firstPage || allSignups.length >= rosterTotal;

  const roles = useMemo<BadgeRoleRow[]>(
    () => (rolesQuery.data ?? []) as BadgeRoleRow[],
    [rolesQuery.data],
  );

  const { recipients, unissuableCount } = useMemo(
    () => selectBadgeRecipients(allSignups, roles),
    [allSignups, roles],
  );

  const event = eventQuery.data;
  const timeZone = useMemo(
    () => resolveDisplayTimeZone(event?.timezone),
    [event?.timezone],
  );

  const eventTitle = event?.title ?? "";
  const venueLabel =
    event?.place?.name ??
    event?.locationLabel ??
    event?.addressText ??
    event?.locality ??
    String(t("volunteerBadges.venueTbd"));

  /**
   * The ISSUER — the admin workspace the operator is standing in.
   *
   * `getEventForEdit` returns owner IDs, not names, and the badge needs the
   * name: "Issued by East Side Collective" is the line that makes this venue
   * stock rather than something anyone could run off. `useCurrentAdminOwner`
   * is the same resolution every other admin surface uses (including the slug
   * normalisation for `@handle` workspaces), so the issuer on the paper cannot
   * disagree with the workspace name in the rail.
   */
  const { currentOwner } = useCurrentAdminOwner(slug);
  const issuerName = currentOwner
    ? currentOwner.kind === "org"
      ? currentOwner.orgName
      : currentOwner.humanName
    : null;

  // ── Shift window formatting ──────────────────────────────────────────────

  const formatWindow = useCallback(
    (assignment: BadgeAssignment): string | null => {
      const { startsAt, endsAt } = assignment;
      if (!startsAt || !endsAt) return null;
      const start = fmt.dateTime(startsAt, { ...SHIFT_TIME_FORMAT, timeZone });
      const end = fmt.dateTime(endsAt, { ...SHIFT_END_FORMAT, timeZone });
      const startDate = fmt.dateTime(startsAt, {
        ...SHIFT_DATE_FORMAT,
        timeZone,
      });
      // An overnight load-out shift is ordinary in this domain, and a badge
      // reading "5:00 PM – 2:00 AM" under a single date is wrong about which
      // day the volunteer is expected.
      if (isSameZonedDay(startsAt, endsAt, timeZone)) {
        return String(
          t("volunteerBadges.shiftWindow", { date: startDate, start, end }),
        );
      }
      const endDate = fmt.dateTime(endsAt, { ...SHIFT_DATE_FORMAT, timeZone });
      return String(
        t("volunteerBadges.shiftWindowOvernight", {
          startDate,
          start,
          endDate,
          end,
        }),
      );
    },
    [fmt, t, timeZone],
  );

  // ── Issue ────────────────────────────────────────────────────────────────

  const mintScanToken = trpc.volunteer.signups.mintScanToken.useMutation();
  const mintAsync = mintScanToken.mutateAsync;

  const runIssue = useCallback(async () => {
    if (issuingRef.current) return;
    if (recipients.length === 0) return;
    issuingRef.current = true;
    setIssue({ phase: "issuing", done: 0, total: recipients.length });

    const tokens = new Map<string, string>();
    const failed: BadgeRecipient[] = [];
    let done = 0;

    try {
      for (let i = 0; i < recipients.length; i += MINT_CONCURRENCY) {
        const wave = recipients.slice(i, i + MINT_CONCURRENCY);
        const results = await Promise.allSettled(
          wave.map((recipient) =>
            mintAsync({ signupId: recipient.mintSignupId, kind: "print" }),
          ),
        );
        // Indexed against `wave`, never searched: `Promise.allSettled`
        // guarantees positional correspondence with its input, and matching a
        // token to the wrong volunteer is the one bug on this page that
        // produces a credential in someone else's name.
        results.forEach((result, index) => {
          const recipient = wave[index];
          if (result.status === "fulfilled") {
            tokens.set(recipient.humanId, result.value.token);
          } else {
            // A per-recipient failure must not abort the run: on a show night
            // one bad row cannot be allowed to cost the other fifty-nine their
            // badges. Collected and named on screen instead.
            failed.push(recipient);
          }
        });
        done += wave.length;
        setIssue({ phase: "issuing", done, total: recipients.length });
      }
    } finally {
      issuingRef.current = false;
    }

    setIssuedAt(new Date());
    setIssue({ phase: "issued", tokens, failed });
  }, [mintAsync, recipients]);

  // ── Toolbar ──────────────────────────────────────────────────────────────

  const backHref = `/admin/${slug}/events/${eventId}/volunteers/signups`;
  const issued = issue.phase === "issued";
  const issuedBadges = issued
    ? recipients.filter((recipient) => issue.tokens.has(recipient.humanId))
    : [];

  const toolbar = (
    <>
      {/* `textDecoration: none` — globals.css underlines anchors, and an
          underlined label inside a bordered button reads as two affordances.
          Same idiom the other two sheets' toolbars use. */}
      <NextLinkAnchor
        href={backHref}
        style={{ textDecoration: "none", width: "fit-content" }}
      >
        {/*
          `tabIndex={-1}` on the INNER button. Tamagui's Button renders a
          focusable span even under `tag="span"`, so the anchor and its own
          label were two consecutive tab stops with the identical accessible
          name "Back to signups" — measured in a browser, not assumed. The
          anchor is the real control; the span is its skin.
        */}
        <Button
          tag="span"
          variant="ghost"
          size="$3"
          minHeight={44}
          tabIndex={-1}
        >
          <ArrowLeft size={15} aria-hidden />
          {String(t("volunteerBadges.backToSignups"))}
        </Button>
      </NextLinkAnchor>
      {/* Exactly one primary at a time: Issue until the badges exist, Print
          once they do. Printing a sheet whose scan panels are empty would hand
          out credential stock that admits nobody, so Print does not exist as
          an affordance before issuing. */}
      {issued ? (
        <PrintButton
          label={String(t("volunteerBadges.printAction"))}
          disabled={issuedBadges.length === 0}
          data-testid={PRINT_ACTION_TEST_ID}
        />
      ) : (
        <Button
          variant="primary"
          size="$3"
          minHeight={44}
          onPress={() => void runIssue()}
          disabled={
            issue.phase === "issuing" ||
            recipients.length === 0 ||
            !rosterComplete
          }
          data-testid="volunteer-badges-issue-action"
        >
          {String(
            issue.phase === "issuing"
              ? t("volunteerBadges.issuingAction")
              : t("volunteerBadges.issueAction", { count: recipients.length }),
          )}
        </Button>
      )}
    </>
  );

  // ── Loading ──────────────────────────────────────────────────────────────
  // `!hasMounted` first, so the client's first render takes the same branch
  // the server pass took.
  const isLoading =
    !hasMounted ||
    eventQuery.isLoading ||
    rolesQuery.isLoading ||
    signupsQuery.isLoading ||
    !rosterComplete;

  if (isLoading && !rosterError) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-badge-sheet">
        <Notice
          testId="volunteer-badges-loading"
          title={String(t("volunteerBadges.loadingTitle"))}
          body={String(t("volunteerBadges.loadingBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Read failed ──────────────────────────────────────────────────────────
  // Checked BEFORE the empty branch. A failed read leaves the roster empty,
  // and telling an organizer "no approved volunteers" when we simply could not
  // fetch them is a specific, confident and wrong claim — the kind that gets
  // acted on at 6pm by not printing badges for people who are on their way.
  if (
    eventQuery.error ||
    rolesQuery.error ||
    signupsQuery.error ||
    rosterError
  ) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-badge-sheet">
        <Notice
          testId="volunteer-badges-error"
          title={String(t("volunteerBadges.errorTitle"))}
          body={String(t("volunteerBadges.errorBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Nobody to issue to ───────────────────────────────────────────────────
  if (recipients.length === 0) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-badge-sheet">
        <Notice
          testId="volunteer-badges-empty"
          title={String(t("volunteerBadges.emptyTitle"))}
          body={String(t("volunteerBadges.emptyBody"))}
          extra={
            unissuableCount > 0 ? (
              <p className="th-badge-sheet__notice-body">
                {String(
                  t("volunteerBadges.manifestUnissuable", {
                    count: unissuableCount,
                  }),
                )}{" "}
                {String(t("volunteerBadges.manifestUnissuableHint"))}
              </p>
            ) : null
          }
        />
      </PaperSheet>
    );
  }

  // ── Manifest / issuing ───────────────────────────────────────────────────
  if (issue.phase !== "issued") {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-badge-sheet">
        <Notice
          testId={
            issue.phase === "issuing"
              ? "volunteer-badges-issuing"
              : "volunteer-badges-manifest"
          }
          title={String(
            issue.phase === "issuing"
              ? t("volunteerBadges.issuingTitle")
              : t("volunteerBadges.manifestTitle", { count: recipients.length }),
          )}
          body={String(
            issue.phase === "issuing"
              ? t("volunteerBadges.issuingBody", {
                  done: issue.done,
                  total: issue.total,
                })
              : t("volunteerBadges.manifestBody", {
                  issuer:
                    issuerName ?? String(t("volunteerBadges.issuerFallback")),
                }),
          )}
          extra={
            unissuableCount > 0 && issue.phase === "idle" ? (
              <p className="th-badge-sheet__notice-body">
                {String(
                  t("volunteerBadges.manifestUnissuable", {
                    count: unissuableCount,
                  }),
                )}{" "}
                {String(t("volunteerBadges.manifestUnissuableHint"))}
              </p>
            ) : null
          }
        />
      </PaperSheet>
    );
  }

  // ── Every mint failed ────────────────────────────────────────────────────
  if (issuedBadges.length === 0) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-badge-sheet">
        <Notice
          testId="volunteer-badges-issue-failed"
          title={String(t("volunteerBadges.issueFailedTitle"))}
          body={String(t("volunteerBadges.issueFailedBody"))}
          action={
            <Button
              variant="primary"
              size="$3"
              minHeight={44}
              onPress={() => {
                setIssue({ phase: "idle" });
                setIssuedAt(null);
              }}
              data-testid="volunteer-badges-retry-action"
            >
              {String(t("volunteerBadges.retryAction"))}
            </Button>
          }
        />
      </PaperSheet>
    );
  }

  // ── The document ─────────────────────────────────────────────────────────

  const rows = chunkIntoRows(issuedBadges, BADGES_PER_ROW);
  const issuedText = issuedAt
    ? fmt.dateTime(issuedAt, ISSUED_STAMP_FORMAT)
    : null;

  const labels = {
    designation: String(t("volunteerBadges.designation")),
    issuedBy: (issuer: string) =>
      String(t("volunteerBadges.issuedBy", { issuer })),
    event: String(t("volunteerBadges.fieldEvent")),
    venue: String(t("volunteerBadges.fieldVenue")),
    roleUnknown: String(t("volunteerBadges.roleUnknown")),
    shiftUnassigned: String(t("volunteerBadges.shiftUnassigned")),
    scanAlt: (name: string) =>
      String(t("volunteerBadges.scanAlt", { name })),
  };

  const metaSegments: { key: string; text: string }[] = [
    { key: "event", text: eventTitle },
    {
      key: "count",
      text: String(
        t("volunteerBadges.metaBadgeCount", { count: issuedBadges.length }),
      ),
    },
    ...(issuedText
      ? [
          {
            key: "issued",
            text: String(
              t("volunteerBadges.metaIssued", { timestamp: issuedText }),
            ),
          },
        ]
      : []),
  ];

  return (
    <PaperSheet toolbar={toolbar} data-testid="volunteer-badge-sheet">
      <h1 className="th-paper__sr">
        {String(t("volunteerBadges.documentTitle", { event: eventTitle }))}
      </h1>

      <header className="th-badge-sheet__header">
        {/* The wordmark is an <img>, not a background: replaced content always
            prints, even with Chrome's "Background graphics" default of off. A
            raw <img> rather than next/image on purpose — a static brand asset
            that has to rasterise at PRINT resolution (34mm at 300dpi ≈ 402px),
            and the optimizer's viewport-derived srcset has no idea a printer
            exists. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- print asset; must not be viewport-optimized */}
        <img
          className="th-badge-sheet__wordmark"
          src="/brand/ithasfire-wordmark-black.png"
          alt="Ithas Fire"
          width={477}
          height={80}
        />
        <p className="th-badge-sheet__meta" data-testid="volunteer-badges-meta">
          {metaSegments.map((segment, index) => (
            <span key={segment.key}>
              {index > 0 ? (
                <span className="th-badge-sheet__meta-sep" aria-hidden>
                  ·
                </span>
              ) : null}
              <span>{segment.text}</span>
            </span>
          ))}
        </p>
      </header>
      <hr className="th-paper__rule" />

      <div className="th-badge-sheet__run" data-testid="volunteer-badges-run">
        {rows.map((row) => (
          <div className="th-badge-row" key={row[0].humanId}>
            {row.map((recipient) => (
              <Badge
                key={recipient.humanId}
                recipient={recipient}
                token={issue.tokens.get(recipient.humanId) ?? ""}
                issuerName={issuerName}
                eventTitle={eventTitle}
                venueLabel={venueLabel}
                labels={labels}
                formatWindow={formatWindow}
              />
            ))}
          </div>
        ))}
      </div>

      <p className="th-badge-sheet__footer">
        {String(t("volunteerBadges.footerNote"))}
      </p>

      {/* Screen-only. The paper is credential stock and carries no operational
          error text — but the operator has to know the stack in their hand is
          short, or the only place a missing badge surfaces is the door. */}
      {issue.failed.length > 0 ? (
        <div
          className="th-badge-sheet__warning"
          data-print-hide
          role="alert"
          data-testid="volunteer-badges-partial"
        >
          <p className="th-badge-sheet__warning-title">
            {String(t("volunteerBadges.partialTitle"))}
          </p>
          <p>
            {String(
              t("volunteerBadges.partialBody", { count: issue.failed.length }),
            )}
          </p>
          <ul className="th-badge-sheet__warning-list">
            {issue.failed.map((recipient) => (
              <li key={recipient.humanId}>{recipient.name}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Screen-only pointer at the browser affordance that actually makes the
          PDF — there is no server-side generation and there is not meant to be. */}
      <p className="th-badge-sheet__hint" data-print-hide>
        {String(t("volunteerBadges.savePdfHint"))}
      </p>
    </PaperSheet>
  );
};

VolunteerBadgeSheet.displayName = "VolunteerBadgeSheet";
