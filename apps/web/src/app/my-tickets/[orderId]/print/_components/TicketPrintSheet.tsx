"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button, useFormatters, useTranslations } from "@th/ui";
import { formatOrderCode } from "@th/types/order-identifier";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { PaperSheet } from "@/app/_print/PaperSheet";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { PrintButton } from "@/app/_print/PrintButton";

import { selectPrintableTickets } from "@/lib/tickets/printable-tickets";
import "./ticket-sheet.css";

/**
 * THE PRINTABLE TICKET SHEET — three stubs to a Letter/A4 page.
 *
 * ── Data ──────────────────────────────────────────────────────────────────
 * Reuses the SAME ownership-checked reads the order page uses
 * (`orders.getMyOrder` + `orders.listMyOrderTickets`). Both resolve the actor
 * from the session server-side and answer ORDER_NOT_FOUND for an order that
 * isn't the caller's — a printed ticket is a bearer credential, so this route
 * gets no lookup of its own.
 *
 * ── What renders ──────────────────────────────────────────────────────────
 * Only tickets that pass `isPrintableTicket` — the same predicate that gates
 * the wallet buttons. If nothing passes, the sheet says so instead of printing
 * blank paper.
 */

/**
 * Order statuses where tickets have not been issued YET, as opposed to gone.
 * `PROCESSING` sits beside `PENDING` in `orderStatusSchema` (`@th/schema`) and
 * is written on the Stripe webhook path; both mean "come back shortly", which
 * is a different message from "these were refunded or transferred".
 */
const PRE_ISSUANCE_ORDER_STATUSES: readonly string[] = [
  "PENDING",
  "PROCESSING",
];

/** Normalises a date-ish value the API may hand back as a string or a Date. */
const toDate = (value: Date | string): Date =>
  typeof value === "string" ? new Date(value) : value;

// ── Field ───────────────────────────────────────────────────────────────────

type FieldProps = {
  label: string;
  value: string;
  sub?: string | null;
};

const Field = ({ label, value, sub }: FieldProps) => (
  <div className="th-ticket-field">
    <dt className="th-paper__label">{label}</dt>
    <dd className="th-paper__value">
      {value}
      {sub ? (
        <span className="th-paper__value--sub th-ticket-field__sub">{sub}</span>
      ) : null}
    </dd>
  </div>
);

// ── Notice (loading / empty / error) ────────────────────────────────────────

const Notice = ({
  title,
  body,
  testId,
}: {
  title: string;
  body: string;
  testId: string;
}) => (
  <div className="th-ticket-sheet__notice" data-testid={testId}>
    <h1 className="th-ticket-sheet__notice-title">{title}</h1>
    <p className="th-ticket-sheet__notice-body">{body}</p>
  </div>
);

// ── Main ────────────────────────────────────────────────────────────────────

export const TicketPrintSheet = ({ orderId }: { orderId: string }) => {
  const t = useTranslations();
  const fmt = useFormatters();

  const orderQuery = trpc.orders.getMyOrder.useQuery(
    { orderId },
    { staleTime: 30_000 },
  );
  const ticketsQuery = trpc.orders.listMyOrderTickets.useQuery(
    { orderId },
    { staleTime: 30_000, enabled: !!orderQuery.data },
  );
  const sessionQuery = authClient.useSession();

  /**
   * Two pieces of post-hydration state, set in ONE effect because they exist
   * for the same reason: nothing derived from the clock or from the session
   * store may be read during the first render.
   *
   * `printedAt` — when this sheet was produced, stamped so door staff can
   * reason about stale paper (a ticket transferred after printing still fails
   * at the scanner; that is correct, the timestamp just makes it explainable).
   * A `new Date()` read during render differs between the server pass and
   * hydration.
   *
   * `hasMounted` — the guard for the SESSION read below. `holderName` derives
   * from `authClient.useSession()`, which reports `isPending: true` during the
   * server pass but can resolve SYNCHRONOUSLY on the client's first render
   * from its own store. The server therefore omitted the "Ticket holder"
   * field while the client's first render emitted it — an extra element at
   * hydration, which is the identical mechanism that took the volunteer hours
   * statement's whole tree down (`HoursStatementSheet`). This file already
   * guarded the clock for exactly this reason; the session half was missed.
   */
  const [printedAt, setPrintedAt] = useState<Date | null>(null);
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
    setPrintedAt(new Date());
  }, []);

  const order = orderQuery.data;

  /** Join ticket → order item (for `transferredAt`) → ticket-type name. */
  const printableTickets = useMemo(() => {
    if (!order || !ticketsQuery.data?.tickets) return [];
    const itemsById = new Map(order.items.map((item) => [item.id, item]));
    const enriched = ticketsQuery.data.tickets.map((ticket) => ({
      ...ticket,
      item: ticket.orderItemId
        ? (itemsById.get(ticket.orderItemId) ?? null)
        : null,
      ticketTypeName: ticket.ticketTypeId
        ? (order.ticketTypeNames[ticket.ticketTypeId] ?? null)
        : null,
    }));
    return selectPrintableTickets(enriched);
  }, [order, ticketsQuery.data]);

  const totalTickets = ticketsQuery.data?.tickets.length ?? 0;
  const isLoading = orderQuery.isLoading || (!!order && ticketsQuery.isLoading);

  const toolbar = (
    <>
      {/* `textDecoration: none` — globals.css underlines anchors, and an
          underlined label inside a bordered button reads as two affordances.
          Same idiom the mailto buttons on OrderDetail use. */}
      <Link
        href={`/my-tickets/${orderId}`}
        style={{ textDecoration: "none", width: "fit-content" }}
      >
        {/* `tabIndex={-1}` on the INNER button. Tamagui's Button renders a
            focusable span even under `tag="span"`, so the anchor and its own
            label were two consecutive tab stops with the identical accessible
            name "Back to order" — measured in a browser on the badge sheet,
            which shares this idiom, and fixed across all three documents on
            the print layer at once. The anchor is the real control; the span
            is its skin. */}
        <Button
          tag="span"
          variant="ghost"
          size="$3"
          minHeight={44}
          tabIndex={-1}
        >
          <ArrowLeft size={15} aria-hidden />
          {String(t("ticketPrint.backToOrder"))}
        </Button>
      </Link>
      <PrintButton
        label={String(t("ticketPrint.printAction"))}
        disabled={printableTickets.length === 0}
        data-testid="ticket-print-action"
      />
    </>
  );

  // ── Loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="ticket-print-sheet">
        <Notice
          testId="ticket-print-loading"
          title={String(t("ticketPrint.loadingTitle"))}
          body={String(t("ticketPrint.loadingBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Withheld until the email is verified (B2) ─────────────────────────────
  if (
    isEmailVerificationRequired(orderQuery.error) ||
    isEmailVerificationRequired(ticketsQuery.error)
  ) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="ticket-print-sheet">
        <EmailVerificationRequired
          context="printTickets"
          headingTag="h1"
          testId="ticket-print-verify-email"
        />
      </PaperSheet>
    );
  }

  // ── Not found / not yours ─────────────────────────────────────────────────
  if (orderQuery.error || !order) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="ticket-print-sheet">
        <Notice
          testId="ticket-print-not-found"
          title={String(t("ticketPrint.notFoundTitle"))}
          body={String(t("ticketPrint.notFoundBody"))}
        />
      </PaperSheet>
    );
  }

  // ── The TICKETS read failed ───────────────────────────────────────────────
  // Must be checked BEFORE the empty branch. A failed tickets query leaves
  // `printableTickets` empty while `order` is fine, so without this the buyer
  // reads a confident, specific and WRONG explanation — "transferred, refunded,
  // listed for resale or already scanned" — for tickets the order page one
  // click away is happily showing them. At a door that reads as "my tickets are
  // gone". Say what actually happened and let them retry.
  if (ticketsQuery.error) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="ticket-print-sheet">
        <Notice
          testId="ticket-print-tickets-error"
          title={String(t("ticketPrint.ticketsErrorTitle"))}
          body={String(t("ticketPrint.ticketsErrorBody"))}
        />
      </PaperSheet>
    );
  }

  // ── Nothing printable ─────────────────────────────────────────────────────
  if (printableTickets.length === 0) {
    return (
      <PaperSheet toolbar={toolbar} data-testid="ticket-print-sheet">
        <Notice
          testId="ticket-print-empty"
          title={String(t("ticketPrint.nothingToPrintTitle"))}
          body={String(
            t(
              // PROCESSING as well as PENDING: both are live pre-issuance
              // states written by the Stripe webhook path
              // (`finalize-from-payment-intent`), and an order in either has no
              // tickets YET — which is not the same story as tickets that were
              // refunded or given away.
              PRE_ISSUANCE_ORDER_STATUSES.includes(order.status)
                ? "ticketPrint.ticketsPendingBody"
                : "ticketPrint.nothingToPrintBody",
            ),
          )}
        />
      </PaperSheet>
    );
  }

  // ── The document ──────────────────────────────────────────────────────────

  const orderCode = formatOrderCode(order.id);
  const startsAt = order.eventStartsAt ? toDate(order.eventStartsAt) : null;
  const dateValue = startsAt
    ? fmt.dateTime(startsAt, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : String(t("orderDetail.dateTbd"));
  const timeSub = startsAt
    ? String(
        t("ticketPrint.startsAt", {
          time: fmt.dateTime(startsAt, {
            hour: "numeric",
            minute: "2-digit",
            // `timeZoneName` is not decoration. This renders in the VIEWER's
            // zone, not the venue's, because `getMyOrder` does not return
            // `Event.timezone` (the column exists; the contract doesn't carry
            // it). On screen that self-corrects — the page re-renders wherever
            // you are. Paper does not: a buyer who prints in Chicago and flies
            // to Nashville carries a stale hour with nothing to check it
            // against, on the highest-stakes field of the stub. Naming the zone
            // turns a silent wrong answer into a visibly checkable one. We do
            // NOT invent a venue zone; when the contract carries one, drop this
            // and print venue-local time.
            timeZoneName: "short",
          }),
        }),
      )
    : null;
  /**
   * `hasMounted &&` is the hydration guard, not defensive noise: without it
   * the server pass (session pending → null → field omitted) and the client's
   * first render (store resolved synchronously → field emitted) disagree about
   * the DOM, and React tears the tree down and rebuilds it. See the
   * `hasMounted` comment above. Null until mounted, so the field simply
   * appears once — the same lifetime `printedAt` already had.
   */
  const holderName = hasMounted
    ? sessionQuery.data?.user?.name?.trim() ||
      sessionQuery.data?.user?.email ||
      null
    : null;

  /**
   * Sheet meta: order code · N-of-M · print time. Built as a list so the
   * timestamp segment (null until the mount effect runs) drops out WITH its
   * separator rather than leaving a dangling `·`.
   */
  const metaSegments: { key: string; text: string }[] = [
    // NOT mono. "Order DB21B2C3" is a label-plus-value PHRASE, not raw machine
    // data — setting the whole thing in the system mono stack next to two
    // Montserrat segments read as a ransom note on the printed sheet. The bare
    // code in each tear column IS raw data and stays mono; the meta line is
    // already uppercase, letterspaced and tabular, which carries the code fine.
    {
      key: "order",
      text: String(t("ticketPrint.sheetOrder", { code: orderCode })),
    },
    {
      key: "count",
      // "3 of 6 tickets" parses as "ticket 3 of 6" — exactly the wrong reading
      // on a stub that IS one of several, and nobody can hover a sheet of paper
      // for clarification. So: say the plain count when the whole order is on
      // the sheet, and say "Showing N of M" only when some tickets were held
      // back (transferred / refunded / scanned), where the phrasing is
      // unmistakably about the sheet rather than about this stub.
      text: String(
        printableTickets.length === totalTickets
          ? t("ticketPrint.sheetTicketCount", { total: totalTickets })
          : t("ticketPrint.sheetShowingCount", {
              printable: printableTickets.length,
              total: totalTickets,
            }),
      ),
    },
    ...(printedAt
      ? [
          {
            key: "printed",
            text: String(
              t("ticketPrint.sheetPrinted", {
                timestamp: fmt.dateTime(printedAt, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                }),
              }),
            ),
          },
        ]
      : []),
  ];

  return (
    <PaperSheet toolbar={toolbar} data-testid="ticket-print-sheet">
      <h1 className="th-paper__sr">
        {String(t("ticketPrint.documentTitle", { event: order.eventName }))}
      </h1>

      <header className="th-ticket-sheet__header">
        {/* The wordmark is an <img>, not a background: replaced content always
            prints, even with Chrome's "Background graphics" default of off.
            A raw <img> rather than next/image on purpose — this is a 477px
            static brand asset that has to rasterise at PRINT resolution
            (34mm at 300dpi ≈ 402px), and the optimizer's viewport-derived
            srcset has no idea a printer exists. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- print asset; must not be viewport-optimized */}
        <img
          className="th-ticket-sheet__wordmark"
          src="/brand/ithasfire-wordmark-black.png"
          alt="Ithas Fire"
          width={477}
          height={80}
        />
        <p className="th-ticket-sheet__meta" data-testid="ticket-print-meta">
          {metaSegments.map((segment, index) => (
            <span key={segment.key}>
              {index > 0 ? (
                <span className="th-ticket-sheet__meta-sep" aria-hidden>
                  ·
                </span>
              ) : null}
              <span>{segment.text}</span>
            </span>
          ))}
        </p>
      </header>
      <hr className="th-paper__rule" />

      <ol className="th-ticket-sheet__stubs">
        {printableTickets.map((ticket, index) => (
          <li key={ticket.id}>
            {index > 0 ? (
              <div className="th-ticket-cut" aria-hidden>
                {/* U+2702 + U+FE0E: the variation selector pins the TEXT
                    presentation so the glyph prints as a hairline scissor
                    rather than a colour emoji. */}
                <span className="th-ticket-cut__glyph">{"✂︎"}</span>
                <span className="th-ticket-cut__rule" />
              </div>
            ) : null}

            <article
              className="th-ticket-stub"
              data-testid={`ticket-print-stub-${ticket.id}`}
            >
              {/* 1 — Scan block */}
              <div className="th-ticket-stub__scan">
                <div className="th-ticket-qr">
                  {/* The code is printed verbatim directly below, so the image
                      carries no information a reader loses — decorative.

                      Raw <img>, never next/image: the source is an SVG served
                      by a `no-store`, per-ticket route, and the optimizer
                      neither optimizes SVG nor should be asked to cache a
                      bearer credential. The SVG carries a viewBox
                      (`scalable: true`), so CSS alone sizes it to 32mm without
                      touching the route's `cellSize`. */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- per-ticket no-store SVG; sized in CSS for print */}
                  <img
                    className="th-ticket-qr__img"
                    src={`/tickets/qr/${encodeURIComponent(ticket.code)}`}
                    alt=""
                  />
                </div>
                <p className="th-ticket-stub__code th-paper__mono">
                  {ticket.code}
                </p>
              </div>

              {/* 2 — Body */}
              <div className="th-ticket-stub__body">
                <p className="th-ticket-stub__kicker">
                  {ticket.ticketTypeName ?? String(t("orderDetail.ticket"))}
                </p>
                <h2 className="th-ticket-stub__title">{order.eventName}</h2>
                <dl className="th-ticket-stub__fields">
                  <Field
                    label={String(t("ticketPrint.fieldDate"))}
                    value={dateValue}
                    sub={timeSub}
                  />
                  <Field
                    label={String(t("ticketPrint.fieldVenue"))}
                    value={
                      order.eventVenue ?? String(t("ticketPrint.venueTbd"))
                    }
                  />
                  {holderName ? (
                    <Field
                      label={String(t("ticketPrint.fieldHolder"))}
                      value={holderName}
                    />
                  ) : null}
                  {order.organiserName ? (
                    <Field
                      label={String(t("ticketPrint.fieldPresentedBy"))}
                      value={order.organiserName}
                    />
                  ) : null}
                </dl>
              </div>

              {/* 3 — Tear-off */}
              <div className="th-ticket-stub__tear">
                <div>
                  <p className="th-paper__label">
                    {String(t("ticketPrint.tearOrder"))}
                  </p>
                  <p className="th-paper__value th-paper__mono th-ticket-stub__tear-value">
                    {orderCode}
                  </p>
                </div>
                <div>
                  <p className="th-paper__label">
                    {String(t("ticketPrint.tearAdmits"))}
                  </p>
                  <p className="th-paper__value th-ticket-stub__tear-value">
                    {String(
                      t("ticketPrint.tearAdmitsValue", {
                        type:
                          ticket.ticketTypeName ??
                          String(t("orderDetail.ticket")),
                      }),
                    )}
                  </p>
                </div>
                <div>
                  <p className="th-paper__label">
                    {String(t("ticketPrint.tearDoorInitial"))}
                  </p>
                  <div className="th-ticket-stub__initial" aria-hidden />
                </div>
              </div>
            </article>
          </li>
        ))}
      </ol>

      <p className="th-ticket-sheet__footer">
        {String(t("ticketPrint.footerNote"))}
      </p>

      {/* Screen-only pointer at the browser affordance that actually makes the
          PDF — there is no server-side generation and there is not meant to be. */}
      <p className="th-ticket-sheet__hint" data-print-hide>
        {String(t("ticketPrint.savePdfHint"))}
      </p>
    </PaperSheet>
  );
};

TicketPrintSheet.displayName = "TicketPrintSheet";
