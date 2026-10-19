"use client";

import { useEffect, useRef, useState } from "react";
import { Spinner, useTranslations } from "@th/ui";

import type { PaidStatus } from "./embed-payment-status";
import { CHECK_AGAIN_REST_MS } from "./embed-request-timeouts";
import {
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  TEXT_ON_BRAND,
  primaryButtonStyle,
} from "./embed-theme";

/** A payment Stripe says went through, for an order the server has not confirmed. */
export type EmbedPaidUnconfirmed = {
  /** What Stripe's browser side said of the payment. */
  stripeSaid: PaidStatus;
  onCheckAgain: () => void;
  /** The server is being asked again. */
  checking: boolean;
  /** The last ask came back without a confirmation. */
  stillUnconfirmed: boolean;
  /**
   * The server refused in a way asking again cannot change: there is no
   * "Check again", and who to write to comes first.
   */
  final: boolean;
};

/**
 * What the embed shows over a payment that is not settled. All but the first
 * are TERMINAL screens with no way to buy again (a second checkout could be
 * a second charge):
 *
 * - "verifying": "Confirming your payment…" while a Stripe redirect return
 *   is checked (see `useEmbedRedirectReturn`).
 * - "unverified": nobody could confirm a redirect payment either way.
 * - "paid-unconfirmed": Stripe says the payment went through (or is with the
 *   bank) and the server has not confirmed the order, on a redirect return
 *   or on the payment step. It says exactly that, never "Order confirmed"
 *   and never "you were not charged", and offers to ask the server again,
 *   unless the server's refusal is final. Even then it does not say the
 *   tickets will not come: the Stripe webhook can still finalize the order.
 */
export function EmbedRedirectReturnScreen({
  state,
  supportEmail,
  paid,
}: {
  state: "verifying" | "unverified" | "paid-unconfirmed";
  supportEmail: string;
  /** Read only on "paid-unconfirmed". */
  paid?: EmbedPaidUnconfirmed;
}) {
  const t = useTranslations();
  if (state === "paid-unconfirmed" && paid) {
    return <PaidUnconfirmed paid={paid} supportEmail={supportEmail} t={t} />;
  }
  return (
    <div
      className="th-embed-fade-in"
      style={{
        display: "flex",
        minHeight: 240,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      {state === "verifying" ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Spinner />
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: TEXT }}>
            Confirming your payment…
          </p>
        </div>
      ) : (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <p
            style={{
              margin: 0,
              maxWidth: 320,
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.6,
              color: TEXT,
            }}
          >
            We couldn&rsquo;t confirm your payment. Check your email for a
            confirmation before trying again.
          </p>
          <p
            style={{
              margin: 0,
              maxWidth: 320,
              fontSize: 12,
              lineHeight: 1.6,
              color: TEXT_MUTED,
            }}
          >
            A second checkout could charge you twice.
          </p>
          <p
            style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: TEXT_CAPTION }}
          >
            Need help?{" "}
            <a
              href={`mailto:${supportEmail}`}
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              {supportEmail}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

function PaidUnconfirmed({
  paid,
  supportEmail,
  t,
}: {
  paid: EmbedPaidUnconfirmed;
  supportEmail: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { stripeSaid, onCheckAgain, checking, stillUnconfirmed, final } = paid;
  // A payment still with the bank has no ticket in anyone's email yet, so
  // the title, the body and the contact line are all picked by this.
  const paidInFull = stripeSaid === "succeeded";

  // Entering this screen unmounts the checkout while focus is on its Pay
  // button, which would drop focus to the page body. It goes to the title.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // "Check again" rests for a moment after every ask that came back without
  // a confirmation (the one that opened this screen included): each press is
  // a call against a budget of 20 a minute, and an answer rarely changes
  // within a second.
  const [resting, setResting] = useState(true);
  useEffect(() => {
    if (checking) {
      setResting(true);
      return;
    }
    const timer = window.setTimeout(
      () => setResting(false),
      CHECK_AGAIN_REST_MS,
    );
    return () => window.clearTimeout(timer);
  }, [checking]);
  const held = checking || resting;

  const body = (
    <p
      style={{
        margin: 0,
        maxWidth: 320,
        fontSize: 12,
        lineHeight: 1.6,
        color: TEXT_MUTED,
      }}
    >
      {String(
        t(
          paidInFull
            ? "checkout.embedUnconfirmedBody"
            : "checkout.embedClearingUnconfirmedBody",
        ),
      )}
    </p>
  );
  const contact = (
    <p
      style={{
        margin: 0,
        maxWidth: 320,
        fontSize: 12,
        lineHeight: 1.6,
        color: final ? TEXT : TEXT_CAPTION,
        overflowWrap: "anywhere",
      }}
    >
      {String(
        t(
          paidInFull
            ? "checkout.embedUnconfirmedContact"
            : "checkout.embedClearingUnconfirmedContact",
        ),
      )}{" "}
      <a
        href={`mailto:${supportEmail}`}
        style={{ color: "inherit", textDecoration: "underline" }}
      >
        {supportEmail}
      </a>
    </p>
  );

  return (
    <div
      className="th-embed-fade-in"
      style={{
        display: "flex",
        minHeight: 240,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
        }}
      >
        <h2
          ref={titleRef}
          tabIndex={-1}
          style={{
            margin: 0,
            maxWidth: 320,
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.6,
            color: TEXT,
            // Focused by script so focus is not lost, never by Tab
            // (`tabIndex={-1}`): a focus ring here would mark a heading as
            // if it were a control.
            outline: "none",
          }}
        >
          {String(
            t(
              paidInFull
                ? "checkout.embedPaidUnconfirmedTitle"
                : "checkout.embedClearingUnconfirmedTitle",
            ),
          )}
        </h2>
        {/* With nothing left to press, who to write to is what the buyer
            can do, so it comes first. */}
        {final ? (
          <>
            {contact}
            {body}
          </>
        ) : (
          <>
            {body}
            {contact}
          </>
        )}
      </div>
      {!final && (
        <>
          {/* `aria-disabled` and a no-op press, not `disabled`: the button
              keeps focus while the server is asked and while it rests. */}
          <button
            type="button"
            onClick={held ? undefined : onCheckAgain}
            aria-disabled={held || undefined}
            style={{
              ...primaryButtonStyle,
              maxWidth: 320,
              ...(held ? { opacity: 0.4, cursor: "not-allowed" } : {}),
            }}
          >
            {checking && <Spinner size="sm" indicatorColor={TEXT_ON_BRAND} />}
            {String(t("checkout.embedCheckAgain"))}
          </button>
          {/* Always in the page: a screen reader announces text arriving in
              a region it knows. "Checking…" while the server is asked, then
              what came of it. */}
          <p
            role="status"
            style={{
              margin: 0,
              minHeight: 20,
              maxWidth: 320,
              fontSize: 12,
              lineHeight: 1.6,
              color: TEXT_MUTED,
            }}
          >
            {checking
              ? String(t("checkout.embedCheckingAgain"))
              : stillUnconfirmed
                ? String(t("checkout.embedStillUnconfirmed"))
                : null}
          </p>
        </>
      )}
    </div>
  );
}
