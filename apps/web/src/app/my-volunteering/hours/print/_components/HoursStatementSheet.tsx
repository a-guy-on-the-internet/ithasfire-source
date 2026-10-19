"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { Button, NextLinkAnchor, useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { PaperSheet } from "@/app/_print/PaperSheet";
import { PrintButton } from "@/app/_print/PrintButton";

import {
  commitmentRowKey,
  selectStatementShifts,
  sumCreditedHours,
  type Commitment,
  type StatementShift,
} from "../../../_components/my-volunteering-helpers";
import {
  countShiftsWithoutHours,
  deriveStatementPeriod,
} from "./hours-statement-helpers";
import "./hours-statement.css";

/**
 * THE VOLUNTEER HOURS STATEMENT — a printable record of checked-in shifts.
 *
 * Volunteers need hours letters for school service requirements, court-ordered
 * service, employer matching and grant reporting. Today an organiser produces
 * one by hand, if at all.
 *
 * ── Data ──────────────────────────────────────────────────────────────────
 * One read: `volunteer.signups.listMyCommitments`, an `authedProcedure` that
 * resolves the actor from the SESSION and never from input — a self-read, so
 * there is nothing here to point at another human. That matters more than
 * usual on this route: `isPrintDocumentRoute` makes `AppChrome` return before
 * `AppAuthGate`, so the client-side gate does not run and the ownership check
 * is entirely the data layer's (see the SECURITY NOTE in
 * `src/lib/print-route.ts`).
 *
 * ── What this document may and may not say ────────────────────────────────
 * It will be handed to a school registrar, a court officer or a grant
 * administrator, so it must not assert more than we know:
 *
 *  - CHECKED_IN rows ONLY. Those are the ones with a door scan behind them.
 *    An APPROVED shift is a schedule, not a record of work performed.
 *  - The words "verified", "certified" and "confirmed by" appear nowhere.
 *    Ithas Fire recorded a check-in; it did not audit the work.
 *  - No organisation is named where the record holds only an event title.
 *  - No signature line, no seal, no QR. A QR would imply a verification
 *    endpoint that does not exist.
 *  - A shift with no creditable hours still PRINTS (it happened) but shows a
 *    dash and is explained in a footnote, because a blank beside a total
 *    silently reads as 0.0.
 *
 * ── Why the figure cannot disagree with `/my-volunteering` ────────────────
 * Row selection and the sum both come from `my-volunteering-helpers`, the same
 * module the page's totals band uses — one `sumCreditedHours`, one
 * `isCreditableShift`. The band and the sheet differ only in the PERIOD they
 * cover (the band says "this year"; this sheet prints its range at the top),
 * which each states out loud.
 */

/**
 * Header/period/row dates: day-month-year, no weekday — a record, not a diary.
 *
 * ── One zone for the whole sheet, and it is NAMED ─────────────────────────
 *
 * Every date here renders in the VIEWER's zone, deliberately, even though
 * event-shift rows carry an `eventTimezone`. A record read months later by a
 * registrar must be internally consistent above all: if rows were formatted in
 * each venue's zone while the stated Period came from raw timestamps, a
 * late-night shift could print a date outside the period printed above it.
 *
 * Rows do not all carry a zone either: an occurrence row (a standing ask's
 * claimed dates) has the ask's zone only when the ask states one, and asks
 * made before asks had a zone do not. Mixing per-row zones with the viewer's
 * would print a sheet in several zones at once, so it uses one: the viewer's.
 *
 * So the sheet does what the ticket stub does about the same problem: rather
 * than silently pick a zone, it NAMES the one it used. The generation stamp
 * carries `timeZoneName: "short"` and the footer says the dates share it.
 * Paper cannot re-render when the reader is somewhere else, so a stated zone
 * turns a possible off-by-one into a checkable fact.
 */
const RECORD_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

/** The generation stamp — a real instant, so it names its zone. */
const STAMP_FORMAT: Intl.DateTimeFormatOptions = {
  ...RECORD_DATE_FORMAT,
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

/**
 * TWO fraction digits, fixed — "4.00", not "4" and not "4.0".
 *
 * Not a style choice. `creditedHours` (`packages/types/src/volunteer-hours.ts`)
 * rounds EVERY row to 2dp before anything sums it, and says why: "rounding
 * before SUM is what keeps an org total equal to the sum of the per-event
 * export rows." So 2dp is the exact, lossless precision of the underlying
 * value — printing it can never round anything.
 *
 * One decimal shipped first and was wrong in a way that matters here: a 5.25
 * hour shift printed as "5.3", so a reader adding the column by hand got a
 * different answer from the total underneath it. On a document handed to a
 * registrar or a court officer, a column that does not add up is the whole
 * document's credibility. Caught by rendering a multi-row sheet in a browser;
 * the one-shift seed account could never show it.
 *
 * Fixed (not just maximum) digits because the column is right-aligned: with a
 * variable count, "5.25" and "3.5" align on their last character and the
 * decimal points do not line up.
 */
const HOURS_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

// ── Notice (loading / signed-out / empty / error) ───────────────────────────

/**
 * `aria-live="polite"` because these branches SWAP IN PLACE with no navigation
 * and no focus move: a screen-reader user hears "Preparing your statement" and
 * then, when the data lands, nothing at all — the document simply replaces the
 * notice below their reading position. Announcing the region politely means
 * the arrival (or the failure) is reported without interrupting.
 *
 * `role="status"` carries the same semantics for older AT that predates
 * `aria-live` on a generic container.
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
  /** Optional affordance — a print route has no chrome to fall back on. */
  action?: ReactNode;
}) => (
  <div
    className="th-hours-sheet__notice"
    data-testid={testId}
    role="status"
    aria-live="polite"
  >
    <h1 className="th-hours-sheet__notice-title">{title}</h1>
    <p className="th-hours-sheet__notice-body">{body}</p>
    {action}
  </div>
);

// ── Document field (Volunteer, Period) ──────────────────────────────────────

const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="th-hours-field">
    <dt className="th-paper__label">{label}</dt>
    <dd className="th-paper__value">{value}</dd>
  </div>
);

// ── Main ────────────────────────────────────────────────────────────────────

export const HoursStatementSheet = () => {
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
   * `authClient.useSession()` reports `isPending: true` during the server
   * pass but can resolve SYNCHRONOUSLY on the client's very first render from
   * its own store. Branching on it directly made the server emit the loading
   * notice while the client's first render emitted the signed-out one, which
   * is a genuine hydration failure — React threw "the server rendered text
   * didn't match" and regenerated the whole tree. Caught by loading the route
   * in a browser; no unit test can see it, because the component never renders
   * twice there.
   *
   * So the first client render is pinned to the same branch the server took
   * (loading), and the session-dependent branches only run once we are past
   * hydration. `/my-volunteering` does not need this only because
   * `AppAuthGate` owns its signed-out story — a print route bypasses that gate
   * (`isPrintDocumentRoute`), so this document handles it itself and pays the
   * hydration cost that comes with it.
   *
   * `generatedAt` rides the same effect for the same class of reason: a
   * `new Date()` read during render differs between the server pass and
   * hydration. It stays null until mounted and every consumer drops out rather
   * than printing a placeholder.
   */
  const [hasMounted, setHasMounted] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);
  useEffect(() => {
    setHasMounted(true);
    setGeneratedAt(new Date());
  }, []);

  const rows = useMemo<Commitment[]>(
    () => commitmentsQuery.data ?? [],
    [commitmentsQuery.data],
  );

  const shifts = useMemo<StatementShift[]>(
    () => selectStatementShifts(rows),
    [rows],
  );

  const totalHours = useMemo(
    () => sumCreditedHours(shifts.map((shift) => shift.row)),
    [shifts],
  );

  const period = useMemo(() => deriveStatementPeriod(shifts), [shifts]);
  const shiftsWithoutHours = countShiftsWithoutHours(shifts);

  const generatedText = generatedAt
    ? fmt.dateTime(generatedAt, STAMP_FORMAT)
    : null;

  const volunteerName =
    sessionQuery.data?.user?.name?.trim() ||
    sessionQuery.data?.user?.email ||
    null;

  const toolbar = (
    <>
      {/* `textDecoration: none` — globals.css underlines anchors, and an
          underlined label inside a bordered button reads as two affordances.
          Same idiom the ticket sheet's toolbar uses. */}
      <NextLinkAnchor
        href="/my-volunteering"
        style={{ textDecoration: "none", width: "fit-content" }}
      >
        {/* `tabIndex={-1}` on the INNER button. Tamagui's Button renders a
            focusable span even under `tag="span"`, so the anchor and its own
            label were two consecutive tab stops with the identical accessible
            name "Back to my volunteering" — measured in a browser on the badge
            sheet, which shares this idiom, and fixed across all three
            documents on the print layer at once. The anchor is the real
            control; the span is its skin. */}
        <Button
          tag="span"
          variant="ghost"
          size="$3"
          minHeight={44}
          tabIndex={-1}
        >
          <ArrowLeft size={15} aria-hidden />
          {String(t("hoursStatement.backToVolunteering"))}
        </Button>
      </NextLinkAnchor>
      <PrintButton
        label={String(t("hoursStatement.printAction"))}
        disabled={shifts.length === 0}
        data-testid="hours-statement-print-action"
      />
    </>
  );

  // ── Loading ───────────────────────────────────────────────────────────────
  // FIRST, and `!hasMounted` is the first term on purpose: this is the branch
  // the server pass takes, so pinning the client's first render to it is what
  // keeps hydration honest. Every session-dependent branch below runs only
  // after the effect has fired. See the `hasMounted` comment above.
  if (!hasMounted || !sessionResolved || commitmentsQuery.isLoading) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="hours-statement-sheet">
        <Notice
          testId="hours-statement-loading"
          title={String(t("hoursStatement.loadingTitle"))}
          body={String(t("hoursStatement.loadingBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Signed out ────────────────────────────────────────────────────────────
  // This route bypasses `AppAuthGate` (see the header comment), so the
  // signed-out case has to be handled here or the page spins forever on a
  // query that is disabled without a session.
  if (!isSignedIn) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="hours-statement-sheet">
        <Notice
          testId="hours-statement-signed-out"
          title={String(t("hoursStatement.signedOutTitle"))}
          body={String(t("hoursStatement.signedOutBody"))}
          /*
            Telling someone to sign in on a route that has NO CHROME — no
            navbar, no account menu, nothing — is a dead end: the only way
            forward is to type a URL. `redirect_url` (the first key
            `readRedirectParam` accepts) brings them straight back to the
            statement afterwards instead of dumping them on the home page.
          */
          action={
            <NextLinkAnchor
              href={`/sign-in?redirect_url=${encodeURIComponent(
                "/my-volunteering/hours/print",
              )}`}
              style={{ textDecoration: "none", width: "fit-content" }}
            >
              {/* `tabIndex={-1}` for the same reason as the toolbar's back
                  link above: the anchor is the control, the button is its
                  skin, and two tab stops sharing the name "Sign in" is a
                  worse dead end than usual on a route with no chrome. */}
              <Button
                tag="span"
                variant="primary"
                size="$3"
                minHeight={44}
                tabIndex={-1}
              >
                {String(t("hoursStatement.signedOutAction"))}
              </Button>
            </NextLinkAnchor>
          }
        />
      </PaperSheet>
    );
  }

  // ── Read failed ───────────────────────────────────────────────────────────
  // Checked BEFORE the empty branch: a failed read leaves `shifts` empty, and
  // telling a volunteer "you have no recorded shifts" when we simply could not
  // fetch them is a specific, confident and wrong claim about their record.
  if (commitmentsQuery.error) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="hours-statement-sheet">
        <Notice
          testId="hours-statement-error"
          title={String(t("hoursStatement.errorTitle"))}
          body={String(t("hoursStatement.errorBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Nothing to state ──────────────────────────────────────────────────────
  // The entry point on `/my-volunteering` is gated on the same predicate, so
  // this is reachable only by URL — but a statement asserting nothing is worse
  // than no statement, so it must never print blank paper.
  if (shifts.length === 0) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="hours-statement-sheet">
        <Notice
          testId="hours-statement-empty"
          title={String(t("hoursStatement.emptyTitle"))}
          body={String(t("hoursStatement.emptyBody"))}
        />
      </PaperSheet>
    );
  }

  // ── The document ──────────────────────────────────────────────────────────

  const periodText = period
    ? period.singleDay
      ? fmt.dateTime(new Date(period.startMs), RECORD_DATE_FORMAT)
      : String(
          t("hoursStatement.periodRange", {
            start: fmt.dateTime(new Date(period.startMs), RECORD_DATE_FORMAT),
            end: fmt.dateTime(new Date(period.endMs), RECORD_DATE_FORMAT),
          }),
        )
    : null;

  const colDate = String(t("hoursStatement.colDate"));
  const colActivity = String(t("hoursStatement.colActivity"));
  const colRole = String(t("hoursStatement.colRole"));
  const colHours = String(t("hoursStatement.colHours"));

  return (
    <PaperSheet toolbar={toolbar} data-testid="hours-statement-sheet">
      <header className="th-hours-sheet__header">
        {/* The wordmark is an <img>, not a background: replaced content always
            prints, even with Chrome's "Background graphics" default of off.
            A raw <img> rather than next/image on purpose — this is a static
            brand asset that has to rasterise at PRINT resolution (34mm at
            300dpi ≈ 402px), and the optimizer's viewport-derived srcset has no
            idea a printer exists. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- print asset; must not be viewport-optimized */}
        <img
          className="th-hours-sheet__wordmark"
          src="/brand/ithasfire-wordmark-black.png"
          alt="Ithas Fire"
          width={477}
          height={80}
        />
        {generatedText ? (
          <p
            className="th-hours-sheet__stamp"
            data-testid="hours-statement-stamp"
          >
            {String(
              t("hoursStatement.generatedAt", { timestamp: generatedText }),
            )}
          </p>
        ) : null}
      </header>
      <hr className="th-paper__rule" />

      <h1 className="th-hours-sheet__title">
        {String(t("hoursStatement.documentTitle"))}
      </h1>

      <dl className="th-hours-sheet__fields">
        {volunteerName ? (
          <Field
            label={String(t("hoursStatement.fieldVolunteer"))}
            value={volunteerName}
          />
        ) : null}
        {periodText ? (
          <Field
            label={String(t("hoursStatement.fieldPeriod"))}
            value={periodText}
          />
        ) : null}
      </dl>

      {/*
        A real <table>, not a CSS grid: this is a genuine tabular record, and a
        <thead> is the one construct the browser repeats at the top of every
        printed page. The explicit ARIA roles are not redundant decoration —
        the narrow-screen rules in `hours-statement.css` re-declare these
        elements to `display: block`, which strips the implicit table
        semantics; the roles put them back for assistive technology on a phone.
      */}
      <table
        className="th-hours-table"
        role="table"
        data-testid="hours-statement-table"
      >
        <caption className="th-paper__sr">
          {String(t("hoursStatement.tableCaption"))}
        </caption>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">
              {colDate}
            </th>
            <th role="columnheader" scope="col">
              {colActivity}
            </th>
            <th role="columnheader" scope="col">
              {colRole}
            </th>
            <th role="columnheader" scope="col">
              {colHours}
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {/*
            `commitmentRowKey` — `claimId ?? signupId`, NOT `signupId`. A
            standing volunteer's parent signup emits one row per claimed
            occurrence, so `signupId` repeats across every date they worked.
            Keying on it would hand React duplicate keys and drop rows for the
            weekly regulars — the people with the most hours and the most
            reason to need this document. An undercount here is not a
            rendering glitch; it is a wrong number on a statement someone
            submits to a registrar.
          */}
          {shifts.map(({ row, workedAtMs, hours }) => (
            <tr
              role="row"
              key={commitmentRowKey(row)}
              data-testid={`hours-statement-row-${commitmentRowKey(row)}`}
            >
              {/* `--exact` (and its `nowrap`) only when this really is a date.
                  The "not recorded" fallback is a sentence and must wrap. */}
              <td
                role="cell"
                data-label={colDate}
                className={
                  workedAtMs === null
                    ? "th-hours-row__date"
                    : "th-hours-row__date th-hours-row__date--exact"
                }
              >
                {workedAtMs === null
                  ? String(t("hoursStatement.dateUnknown"))
                  : fmt.dateTime(new Date(workedAtMs), RECORD_DATE_FORMAT)}
              </td>
              {/* The record holds an event title or an ask title — never an
                  organisation. We print what it holds and invent nothing. */}
              <td role="cell" data-label={colActivity}>
                <span className="th-hours-row__title">{row.title}</span>
              </td>
              <td role="cell" data-label={colRole}>
                {row.roleName}
                {row.shiftLabel ? (
                  <span className="th-hours-row__sub">{row.shiftLabel}</span>
                ) : null}
              </td>
              <td role="cell" data-label={colHours}>
                {hours === null ? (
                  <>
                    {/* Neutral marker, and it must never be read as 0.0 —
                        hence the screen-reader text beside it and the
                        footnote below the table. */}
                    <span className="th-hours-row__nohours" aria-hidden>
                      &mdash;
                    </span>
                    <span className="th-paper__sr">
                      {String(t("hoursStatement.noHoursRecorded"))}
                    </span>
                  </>
                ) : (
                  <span className="th-hours-row__hours">
                    {fmt.number(hours, HOURS_FORMAT)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="th-hours-total" data-testid="hours-statement-total">
        <p className="th-hours-total__label">
          {String(t("hoursStatement.totalHoursLabel"))}
        </p>
        <p
          className="th-hours-total__value"
          data-testid="hours-statement-total-hours"
        >
          {fmt.number(totalHours, HOURS_FORMAT)}
        </p>
        {/*
          The shift count AND the period, beside the figure they describe.
          The period is also in the page-1 header, but a weekly regular is one
          row per worked date, so this sheet runs to several pages and the
          total lands on the last one — where the header is long gone and paper
          cannot be scrolled back up. A reader meeting "236.25" with no range
          near it cannot tell it from the "12.75 hours this year" the
          volunteer's own page shows. Two numbers both labelled hours, nothing
          distinguishing them, is exactly the failure this feature exists to
          stop; the scope has to travel with the figure.
        */}
        <p
          className="th-hours-total__shifts"
          data-testid="hours-statement-total-shifts"
        >
          {String(
            periodText
              ? t("hoursStatement.totalScope", {
                  shifts: String(
                    t("hoursStatement.totalShifts", { count: shifts.length }),
                  ),
                  period: periodText,
                })
              : t("hoursStatement.totalShifts", { count: shifts.length }),
          )}
        </p>
      </div>
      <hr className="th-hours-sheet__close" />

      {shiftsWithoutHours > 0 ? (
        <p
          className="th-hours-sheet__footnote"
          data-testid="hours-statement-footnote"
        >
          {String(
            t("hoursStatement.footnoteNoHours", { count: shiftsWithoutHours }),
          )}
        </p>
      ) : null}

      {/* Plain and factual. What this document is, and when it was made. */}
      <p className="th-hours-sheet__footer">
        {String(t("hoursStatement.footerNote"))}
        {generatedText
          ? ` ${String(t("hoursStatement.footerGenerated", { timestamp: generatedText }))}`
          : null}
      </p>

      {/* Screen-only pointer at the browser affordance that actually makes the
          PDF — there is no server-side generation and there is not meant to be. */}
      <p className="th-hours-sheet__hint" data-print-hide>
        {String(t("hoursStatement.savePdfHint"))}
      </p>
    </PaperSheet>
  );
};

HoursStatementSheet.displayName = "HoursStatementSheet";
