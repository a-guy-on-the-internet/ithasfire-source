"use client";

import { useId } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslations } from "@th/ui";

import {
  BORDER_SUBTLE,
  SURFACE,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  sectionLabelStyle,
} from "./embed-theme";
import type { EmbedTicketCode } from "./embed-tickets";

/** Rendered QR edge. The order page draws 140; the door gets a little more. */
const QR_SIZE = 160;
/** The white pad around the QR: its quiet zone. */
const QR_PAD = 10;
/** One ticket block is never narrower than its padded QR plus its own padding. */
const BLOCK_MIN_WIDTH = QR_SIZE + QR_PAD * 2 + 28;

const MONO = "var(--font-mono, monospace)";

/**
 * "Your tickets": every ticket of the order the server just confirmed, each
 * with the QR the door scans and its code as text. Shown on the embed's
 * confirmation and on a redirect payment's return.
 *
 * Renders nothing without tickets (an older API, or codes the server
 * withheld): the email carries them, and an empty heading would promise
 * something the screen does not have.
 */
export function EmbedTickets({ tickets }: { tickets: EmbedTicketCode[] }) {
  const t = useTranslations();
  const headingId = useId();
  if (tickets.length === 0) return null;
  const total = tickets.length;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="embed-tickets"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <h4 id={headingId} style={sectionLabelStyle}>
        {String(t("checkout.embedTicketsHeading"))}
      </h4>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: TEXT_MUTED }}>
        {String(
          t(
            total > 1
              ? "checkout.embedTicketsShowAtDoorMany"
              : "checkout.embedTicketsShowAtDoorOne",
          ),
        )}
      </p>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          // One column at phone width; side by side once two blocks fit.
          gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${BLOCK_MIN_WIDTH}px), 1fr))`,
          gap: 8,
        }}
      >
        {tickets.map((ticket, index) => {
          const name =
            ticket.ticketTypeName ??
            String(t("checkout.embedTicketsFallbackName"));
          // The seat label is printed as the server sends it ("Balcony ·
          // Q5": section and seat), with no prefix of ours.
          const seat = ticket.seatLabel;
          const typeName = ticket.ticketTypeName;
          const described = String(
            typeName
              ? seat
                ? t("checkout.embedTicketsQrLabelSeat", { name: typeName, seat })
                : t("checkout.embedTicketsQrLabel", { name: typeName })
              : seat
                ? t("checkout.embedTicketsQrLabelUnnamedSeat", { seat })
                : t("checkout.embedTicketsQrLabelUnnamed"),
          );
          // Two tickets of one type would otherwise share a name.
          const qrLabel =
            total > 1
              ? String(
                  t("checkout.embedTicketsQrLabelNth", {
                    label: described,
                    n: index + 1,
                    total,
                  }),
                )
              : described;
          return (
            <li
              key={ticket.code}
              data-testid="embed-ticket"
              style={{
                border: `1px solid ${BORDER_SUBTLE}`,
                background: SURFACE,
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 10,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minWidth: 0,
                  maxWidth: "100%",
                }}
              >
                {total > 1 && (
                  <p
                    style={{
                      margin: 0,
                      fontFamily: MONO,
                      fontSize: 11,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: TEXT_CAPTION,
                    }}
                  >
                    {String(
                      t("checkout.embedTicketsCount", { n: index + 1, total }),
                    )}
                  </p>
                )}
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 700,
                    color: TEXT,
                    overflowWrap: "anywhere",
                  }}
                >
                  {name}
                </p>
                {ticket.seatLabel && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      color: TEXT_MUTED,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {ticket.seatLabel}
                  </p>
                )}
              </div>

              <div
                role="img"
                aria-label={qrLabel}
                style={{
                  // Literal white is REQUIRED: a QR needs a true-white quiet
                  // zone for the door's scanner to lock on. It must not
                  // follow the host page's theme (same rule as OrderDetail).
                  background: "white",
                  padding: QR_PAD,
                  lineHeight: 0,
                  flexShrink: 0,
                }}
              >
                <QRCodeSVG
                  aria-hidden="true"
                  value={ticket.code}
                  size={QR_SIZE}
                  level="H"
                  includeMargin={false}
                  imageSettings={{
                    src: "/brand/hearth-flame-mark-orange.png",
                    height: 34,
                    // 34 × the compact mark's aspect (651/1032), as the
                    // order page does: qrcode.react stretches to these.
                    width: 21.4,
                    excavate: true,
                  }}
                />
              </div>

              <p
                data-testid="embed-ticket-code"
                style={{
                  margin: 0,
                  maxWidth: "100%",
                  fontFamily: MONO,
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: TEXT,
                  overflowWrap: "anywhere",
                  userSelect: "all",
                }}
              >
                {ticket.code}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
