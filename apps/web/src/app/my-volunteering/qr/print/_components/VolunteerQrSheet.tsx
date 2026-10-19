"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Button, NextLinkAnchor, useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { PaperSheet } from "@/app/_print/PaperSheet";
import { PrintButton } from "@/app/_print/PrintButton";
import { isSameZonedDay, resolveDisplayTimeZone } from "@/app/_print/zoned-time";

import type { Commitment } from "../../../_components/my-volunteering-helpers";
import {
  resolveQrSubject,
  selectQrSubjects,
  type QrShift,
} from "./volunteer-qr-helpers";
import "./volunteer-qr-sheet.css";

/**
 * THE VOLUNTEER'S OWN CHECK-IN CODE — one code, one page.
 *
 * ── A QR IS NOT A BADGE ───────────────────────────────────────────────────
 *
 * The counterpart document, `/admin/[slug]/events/[id]/volunteers/badges/print`,
 * produces BADGES: venue-issued credential stock, printed by whoever is
 * accountable at the door, six to a sheet, cut out and worn.
 *
 * This is not that, and it must never read as that. It is "scan me in" on
 * paper, for the volunteer whose phone is dead — the same human+event
 * assertion they already carry in the app. It admits nobody by itself: an
 * org-edit/scan-role operator still has to resolve it and check them in
 * (`resolveVolunteerSignupByToken`). So this sheet carries NO issuer line, NO
 * credential designation, no cut frame and no lanyard framing, and it says out
 * loud on the paper that a coordinator has to scan it. Do not grow this path
 * toward issuance; see the standing note on `VolunteerScanTokenPort`.
 *
 * The backend already draws the line: a self-minted `print` token gets a
 * tighter TTL ceiling than an organizer's (`computeSelfPrintTtlSeconds`,
 * min(organizer term, 14 days)) precisely because an organizer's sheet goes
 * printer → door while a volunteer's lives in a bag.
 *
 * ── Data, and why the route is safe without a client gate ─────────────────
 *
 * One read: `volunteer.signups.listMyCommitments`, an `authedProcedure` that
 * resolves the actor from the SESSION and never from input — a self-read, so
 * there is nothing here to point at another human. That matters more than
 * usual: `isPrintDocumentRoute` makes `AppChrome` return before `AppAuthGate`,
 * so the client-side gate does not run and ownership is entirely the data
 * layer's (see the SECURITY NOTE in `src/lib/print-route.ts`). The mint is
 * gated the same way — `mintVolunteerScanToken` authorizes BEFORE it inspects
 * any state, and a non-owner gets SIGNUP_NOT_FOUND rather than a token.
 *
 * ── Why minting is an explicit act ────────────────────────────────────────
 *
 * Established on the badge sheet, and it holds here for the same reason: every
 * mint writes a `scan_token_minted` audit row, which is the only record of a
 * printed credential's provenance. Auto-minting on mount would fire it on every
 * refresh and twice per mount under React's StrictMode, turning the one durable
 * record into noise.
 */

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
 * Every time on this sheet renders in the VENUE's zone
 * (`VolunteerCommitmentRecord.eventTimezone`) — the right choice for paper
 * carried to the venue. Where that is null the format falls back to the
 * viewer's zone, and naming the zone is what keeps the difference checkable:
 * paper cannot re-render when the reader is somewhere else.
 */
const SHIFT_END_FORMAT: Intl.DateTimeFormatOptions = {
  ...SHIFT_TIME_FORMAT,
  timeZoneName: "short",
};

const STAMP_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/**
 * The Print control's test id, and the focus target once a code exists.
 * Creating the code unmounts the button just pressed, so without this a
 * keyboard or switch-control user is dropped to the top of the document.
 * Same remedy as the badge sheet, for the same measured reason.
 */
const PRINT_ACTION_TEST_ID = "volunteer-qr-print-action";

// ── Notice (loading / signed-out / empty / error) ───────────────────────────

/**
 * `role="status"` + `aria-live="polite"`: these branches swap IN PLACE with no
 * navigation and no focus move, so without an announcement a screen-reader
 * user hears "Preparing your code" and then nothing at all when it arrives
 * below their reading position.
 */
const Notice = ({
  title,
  body,
  testId,
  action,
}: {
  title: string;
  body: string;
  testId: string;
  action?: ReactNode;
}) => (
  <div
    className="th-qr-sheet__notice"
    data-testid={testId}
    role="status"
    aria-live="polite"
  >
    <h1 className="th-qr-sheet__notice-title">{title}</h1>
    <p className="th-qr-sheet__notice-body">{body}</p>
    {action}
  </div>
);

const Field = ({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) => (
  <div className={className ? `th-qr-field ${className}` : "th-qr-field"}>
    <dt className="th-paper__label">{label}</dt>
    <dd>{children}</dd>
  </div>
);

// ── Main ────────────────────────────────────────────────────────────────────

type MintState =
  | { phase: "idle" }
  | { phase: "minting" }
  | { phase: "ready"; token: string }
  | { phase: "failed" };

export const VolunteerQrSheet = ({ eventId }: { eventId: string | null }) => {
  const t = useTranslations();
  const fmt = useFormatters();

  const sessionQuery = authClient.useSession();
  const sessionResolved = !sessionQuery.isPending;
  const isSignedIn = Boolean(sessionQuery.data?.user);

  const commitmentsQuery = trpc.volunteer.signups.listMyCommitments.useQuery(
    undefined,
    { enabled: isSignedIn, staleTime: 30_000 },
  );

  /**
   * `hasMounted` — the hydration guard, and it is load-bearing.
   *
   * `authClient.useSession()` reports `isPending: true` during the server pass
   * but can resolve SYNCHRONOUSLY on the client's first render from its own
   * store. Branching on it directly made the server emit one notice while the
   * client's first render emitted another — a genuine hydration failure that
   * took the hours statement's whole tree down and was invisible to every unit
   * test, because a component never renders twice there. So the first client
   * render is pinned to the branch the server took.
   *
   * `mintedAt` rides the same effect for the same class of reason: a
   * `new Date()` read during render differs between the two passes.
   */
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);

  const [mint, setMint] = useState<MintState>({ phase: "idle" });
  const [mintedAt, setMintedAt] = useState<Date | null>(null);
  /** Guards a double-click in the same tick, which state alone cannot. */
  const mintingRef = useRef(false);

  const mintPhase = mint.phase;
  useEffect(() => {
    if (mintPhase !== "ready") return;
    if (typeof document === "undefined") return;
    document
      .querySelector<HTMLElement>(`[data-testid="${PRINT_ACTION_TEST_ID}"]`)
      ?.focus?.();
  }, [mintPhase]);

  const rows = useMemo<Commitment[]>(
    () => commitmentsQuery.data ?? [],
    [commitmentsQuery.data],
  );
  const subjects = useMemo(() => selectQrSubjects(rows), [rows]);
  const subject = useMemo(
    () => resolveQrSubject(subjects, eventId),
    [subjects, eventId],
  );

  const timeZone = useMemo(
    () => resolveDisplayTimeZone(subject?.timeZone),
    [subject?.timeZone],
  );

  const volunteerName =
    sessionQuery.data?.user?.name?.trim() ||
    sessionQuery.data?.user?.email ||
    null;

  const formatWindow = useCallback(
    (shift: QrShift): string | null => {
      const { startsAt, endsAt } = shift;
      if (!startsAt || !endsAt) return null;
      const start = fmt.dateTime(startsAt, { ...SHIFT_TIME_FORMAT, timeZone });
      const end = fmt.dateTime(endsAt, { ...SHIFT_END_FORMAT, timeZone });
      const startDate = fmt.dateTime(startsAt, {
        ...SHIFT_DATE_FORMAT,
        timeZone,
      });
      // An overnight load-out is ordinary in this domain, and a sheet reading
      // "5:00 PM – 2:00 AM" under a single date is wrong about the day.
      if (isSameZonedDay(startsAt, endsAt, timeZone)) {
        return String(
          t("volunteerQr.shiftWindow", { date: startDate, start, end }),
        );
      }
      const endDate = fmt.dateTime(endsAt, { ...SHIFT_DATE_FORMAT, timeZone });
      return String(
        t("volunteerQr.shiftWindowOvernight", {
          startDate,
          start,
          endDate,
          end,
        }),
      );
    },
    [fmt, t, timeZone],
  );

  const mintScanToken = trpc.volunteer.signups.mintScanToken.useMutation();
  const mintAsync = mintScanToken.mutateAsync;

  const runMint = useCallback(async () => {
    if (mintingRef.current) return;
    if (!subject) return;
    mintingRef.current = true;
    setMint({ phase: "minting" });
    try {
      const result = await mintAsync({
        signupId: subject.mintSignupId,
        kind: "print",
      });
      setMintedAt(new Date());
      setMint({ phase: "ready", token: result.token });
    } catch {
      // No fallback and no partial state: a sheet whose scan panel is empty is
      // worse than no sheet, because the volunteer only finds out at the door.
      setMint({ phase: "failed" });
    } finally {
      mintingRef.current = false;
    }
  }, [mintAsync, subject]);

  const toolbar = (
    <>
      {/* `textDecoration: none` — globals.css underlines anchors, and an
          underlined label inside a bordered button reads as two affordances.
          `tabIndex={-1}` on the inner button: Tamagui's Button renders a
          focusable span even under `tag="span"`, so the anchor and its own
          label would otherwise be two tab stops with the same accessible
          name. Same fix as the other three documents on this layer. */}
      <NextLinkAnchor
        href="/my-volunteering"
        style={{ textDecoration: "none", width: "fit-content" }}
      >
        <Button
          tag="span"
          variant="ghost"
          size="$3"
          minHeight={44}
          tabIndex={-1}
        >
          <ArrowLeft size={15} aria-hidden />
          {String(t("volunteerQr.backToVolunteering"))}
        </Button>
      </NextLinkAnchor>
      {/* Exactly one primary at a time: Create until the code exists, Print
          once it does. Printing a sheet with an empty scan panel would hand a
          volunteer paper that does nothing at a door, so Print does not exist
          as an affordance beforehand. */}
      {mint.phase === "ready" ? (
        <PrintButton
          label={String(t("volunteerQr.printAction"))}
          data-testid={PRINT_ACTION_TEST_ID}
        />
      ) : (
        <Button
          variant="primary"
          size="$3"
          minHeight={44}
          onPress={() => void runMint()}
          disabled={mint.phase === "minting" || !subject}
          data-testid="volunteer-qr-create-action"
        >
          {String(
            mint.phase === "minting"
              ? t("volunteerQr.creatingAction")
              : t("volunteerQr.createAction"),
          )}
        </Button>
      )}
    </>
  );

  // ── Loading ───────────────────────────────────────────────────────────────
  // `!hasMounted` FIRST, so the client's first render takes the branch the
  // server took. Every session-dependent branch below runs only after that.
  if (!hasMounted || !sessionResolved || commitmentsQuery.isLoading) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
        <Notice
          testId="volunteer-qr-loading"
          title={String(t("volunteerQr.loadingTitle"))}
          body={String(t("volunteerQr.loadingBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Signed out ────────────────────────────────────────────────────────────
  // This route bypasses `AppAuthGate`, so the signed-out case is handled here
  // or the page spins forever on a query that is disabled without a session.
  if (!isSignedIn) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
        <Notice
          testId="volunteer-qr-signed-out"
          title={String(t("volunteerQr.signedOutTitle"))}
          body={String(t("volunteerQr.signedOutBody"))}
          /*
            Telling someone to sign in on a route with NO CHROME — no navbar,
            no account menu — is a dead end: the only way forward is typing a
            URL. `redirect_url` (the first key `readRedirectParam` accepts)
            brings them back to this code afterwards.
          */
          action={
            <NextLinkAnchor
              href={`/sign-in?redirect_url=${encodeURIComponent(
                eventId
                  ? `/my-volunteering/qr/print?event=${eventId}`
                  : "/my-volunteering/qr/print",
              )}`}
              style={{ textDecoration: "none", width: "fit-content" }}
            >
              <Button
                tag="span"
                variant="primary"
                size="$3"
                minHeight={44}
                tabIndex={-1}
              >
                {String(t("volunteerQr.signedOutAction"))}
              </Button>
            </NextLinkAnchor>
          }
        />
      </PaperSheet>
    );
  }

  // ── Read failed ───────────────────────────────────────────────────────────
  // Checked BEFORE the empty branch: a failed read leaves `subjects` empty, and
  // telling a volunteer "you have no approved shifts" when we simply could not
  // fetch them is a specific, confident and wrong claim about their own record
  // — one they might act on by not turning up.
  if (commitmentsQuery.error) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
        <Notice
          testId="volunteer-qr-error"
          title={String(t("volunteerQr.errorTitle"))}
          body={String(t("volunteerQr.errorBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Nothing to print a code for ───────────────────────────────────────────
  // Two distinct stories, because they need different actions: a link that
  // named an event the volunteer has no approved shift at is a broken link,
  // while an empty roster is simply "not yet".
  if (!subject) {
    const targeted = Boolean(eventId) && subjects.length > 0;
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
        <Notice
          testId={
            targeted ? "volunteer-qr-wrong-event" : "volunteer-qr-empty"
          }
          title={String(
            t(
              targeted
                ? "volunteerQr.wrongEventTitle"
                : "volunteerQr.emptyTitle",
            ),
          )}
          body={String(
            t(
              targeted ? "volunteerQr.wrongEventBody" : "volunteerQr.emptyBody",
            ),
          )}
        />
      </PaperSheet>
    );
  }

  // ── Mint failed ───────────────────────────────────────────────────────────
  if (mint.phase === "failed") {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
        <Notice
          testId="volunteer-qr-failed"
          title={String(t("volunteerQr.failedTitle"))}
          body={String(t("volunteerQr.failedBody"))}
          action={
            <Button
              variant="primary"
              size="$3"
              minHeight={44}
              onPress={() => setMint({ phase: "idle" })}
              data-testid="volunteer-qr-retry-action"
            >
              {String(t("volunteerQr.retryAction"))}
            </Button>
          }
        />
      </PaperSheet>
    );
  }

  // ── Not yet created ───────────────────────────────────────────────────────
  if (mint.phase !== "ready") {
    return (
      <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
        <Notice
          testId={
            mint.phase === "minting"
              ? "volunteer-qr-minting"
              : "volunteer-qr-manifest"
          }
          title={String(
            mint.phase === "minting"
              ? t("volunteerQr.creatingTitle")
              : t("volunteerQr.manifestTitle", { event: subject.eventTitle }),
          )}
          body={String(
            mint.phase === "minting"
              ? t("volunteerQr.creatingBody")
              : t("volunteerQr.manifestBody"),
          )}
        />
      </PaperSheet>
    );
  }

  // ── The document ──────────────────────────────────────────────────────────

  const stampText = mintedAt ? fmt.dateTime(mintedAt, STAMP_FORMAT) : null;

  return (
    <PaperSheet toolbar={toolbar} data-testid="volunteer-qr-sheet">
      <header className="th-qr-sheet__header">
        {/* The wordmark is an <img>, not a background: replaced content always
            prints, even with Chrome's "Background graphics" default of off. A
            raw <img> rather than next/image on purpose — a static brand asset
            that has to rasterise at PRINT resolution (34mm at 300dpi ≈ 402px),
            and the optimizer's viewport-derived srcset has no idea a printer
            exists. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- print asset; must not be viewport-optimized */}
        <img
          className="th-qr-sheet__wordmark"
          src="/brand/ithasfire-wordmark-black.png"
          alt="Ithas Fire"
          width={477}
          height={80}
        />
        {stampText ? (
          <p className="th-qr-sheet__stamp" data-testid="volunteer-qr-stamp">
            {String(t("volunteerQr.createdAt", { timestamp: stampText }))}
          </p>
        ) : null}
      </header>
      <hr className="th-paper__rule" />

      {/* A DESCRIPTION of the paper, not a designation on a credential. */}
      <h1 className="th-qr-sheet__title">
        {String(t("volunteerQr.documentTitle"))}
      </h1>
      {volunteerName ? (
        <p className="th-qr-sheet__name">{volunteerName}</p>
      ) : null}

      <div className="th-qr-sheet__scan">
        <div className="th-qr-code">
          {/*
            Rendered as SVG CONTENT rather than a hosted image: `/tickets/qr/
            [code]` only accepts `[A-Za-z0-9_-]{4,128}` and this payload is a
            382-character JWT, so that route cannot serve it — and it exists
            for ticket emails, which is why it is not being changed.

            Colours are qrcode.react's defaults (#000 on #FFF), deliberately
            NOT themed: this must print dark-on-white even when the volunteer's
            ACCOUNT theme is dark. The SVG's own background rect is CONTENT, so
            it survives Chrome's "Background graphics: off" default whatever
            the surrounding panel does.
          */}
          <QRCodeSVG
            className="th-qr-code__svg"
            value={mint.token}
            level="M"
            role="img"
            aria-label={String(t("volunteerQr.codeAlt"))}
          />
        </div>
      </div>

      <dl className="th-qr-sheet__facts" data-testid="volunteer-qr-facts">
        <Field label={String(t("volunteerQr.fieldRole"))}>
          {subject.shifts.map((shift) => (
            <p key={shift.key} className="th-qr-field__value th-qr-shift">
              {shift.roleName}
              {shift.shiftLabel ? (
                <span className="th-qr-field__sub">{shift.shiftLabel}</span>
              ) : null}
            </p>
          ))}
        </Field>

        <Field label={String(t("volunteerQr.fieldWhen"))}>
          {subject.shifts.map((shift) => {
            const window = formatWindow(shift);
            return (
              <p key={shift.key} className="th-qr-field__value th-qr-shift">
                {window ?? String(t("volunteerQr.windowUnknown"))}
              </p>
            );
          })}
        </Field>

        <Field label={String(t("volunteerQr.fieldWhere"))}>
          <p className="th-qr-field__value">
            {subject.addressText ?? String(t("volunteerQr.whereUnknown"))}
          </p>
        </Field>

        <Field
          label={String(t("volunteerQr.fieldEvent"))}
          className="th-qr-sheet__event"
        >
          <p className="th-qr-field__value">{subject.eventTitle}</p>
        </Field>
      </dl>

      {/*
        The sentence that keeps this from being a badge, and the one thing on
        the page a door needs to read the same way the volunteer does. Body
        size, not fine print.
      */}
      <p className="th-qr-sheet__note" data-testid="volunteer-qr-note">
        {String(t("volunteerQr.admitsNobodyNote"))}
      </p>

      <p className="th-qr-sheet__footer">
        {String(t("volunteerQr.footerNote"))}
        {stampText
          ? ` ${String(t("volunteerQr.footerCreated", { timestamp: stampText }))}`
          : null}
      </p>

      {/* Screen-only pointer at the browser affordance that actually makes the
          PDF — there is no server-side generation and there is not meant to be. */}
      <p className="th-qr-sheet__hint" data-print-hide>
        {String(t("volunteerQr.savePdfHint"))}
      </p>
    </PaperSheet>
  );
};

VolunteerQrSheet.displayName = "VolunteerQrSheet";
