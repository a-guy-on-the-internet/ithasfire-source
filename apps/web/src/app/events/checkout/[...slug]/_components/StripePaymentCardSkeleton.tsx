"use client";

import { useEffect, useState } from "react";

import { useTranslations } from "@th/ui";

import { SkeletonLine } from "./SkeletonLine";
import { BORDER_SUBTLE, fgAlpha, srOnlyStyle } from "./checkout-tokens";

/** One labelled field: its mono-scale label bar over its input well. */
const FieldSkeleton = ({ labelWidth }: { labelWidth: number }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <SkeletonLine width={labelWidth} height={10} />
    <div style={{ height: 48, border: BORDER_SUBTLE }} />
  </div>
);

/**
 * Stands in for `StripePaymentCard` while its chunk downloads.
 *
 * Mirrors the mounted card — express-pay bar, the "or" rule, the method tabs,
 * the card fields, the optional-details panel and the pay button — so arriving
 * at the real form reads as a substitution rather than as something appearing
 * in an empty box. Strict Swiss: `radius: 0`, the same 1px ink borders the real
 * inputs wear, no shadows.
 *
 * The pay button ends up at the bottom of the reserved slot, where the real one
 * lands, because the optional-details panel above it takes the leftover height.
 * Everything above the button is an approximation whose exact row count moves
 * with the payment methods enabled on the account; the button's position is
 * not.
 *
 * ## Why there is no `aria-busy`
 *
 * `aria-busy="true"` tells assistive tech to WITHHOLD live-region updates until
 * it flips to false. Nothing here ever flips it — this element is unmounted,
 * not updated — so a live region carrying it is born busy, dies busy, and the
 * label below is likely never spoken. It is the one attribute that turns this
 * region off.
 *
 * Nor does it belong on `.checkout-payment-slot` or the `<section>`: those
 * outlive the skeleton, so `aria-busy` there would also be permanently true —
 * and `StripePaymentCard` renders a `FormErrorBanner` (`role="alert"`, see
 * `@th/ui`) INSIDE the slot, so a stuck `aria-busy` would suppress payment
 * error announcements on a money surface. A completion announcement would need
 * a string this catalogue does not have; `common.loading` is reused here
 * precisely so no new key is introduced.
 */
export const StripePaymentCardSkeleton = () => {
  const t = useTranslations();

  // Fill the live region one commit AFTER mounting it. A `role="status"` that
  // is inserted with its text already in place is not reliably announced —
  // assistive tech has to have the region in the accessibility tree before the
  // change happens. Mounting empty and then filling makes the label arrive as
  // a mutation INTO a live region rather than the insertion OF one.
  const [announced, setAnnounced] = useState(false);
  useEffect(() => setAnnounced(true), []);

  return (
    <div role="status"
      // `flex: 1 0 auto` inside `.checkout-payment-slot`, which is a column
      // flex container: the skeleton grows into whatever height that
      // breakpoint reserves, and never shrinks below its own content. The
      // reserved value lives in checkout.css so it can be media-queried; the
      // skeleton deliberately does not know it.
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        flex: "1 0 auto",
      }}
    >
      <span style={srOnlyStyle}>
        {announced ? String(t("common.loading")) : ""}
      </span>

      {/* Express pay (Link / Apple Pay / Google Pay / Amazon Pay). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <SkeletonLine block width="100%" height={48} />
        <SkeletonLine block width="100%" height={48} />
      </div>

      {/* The "or" rule between express pay and the method tabs. */}
      <div style={{ height: 1, background: fgAlpha(20) }} />

      {/* Payment-method tabs: card, wallet, bank, pay-later. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 8,
        }}
      >
        <div style={{ height: 70, border: BORDER_SUBTLE }} />
        <div style={{ height: 70, border: BORDER_SUBTLE }} />
        <div style={{ height: 70, border: BORDER_SUBTLE }} />
        <div style={{ height: 70, border: BORDER_SUBTLE }} />
      </div>

      {/* Card number + expiry + security code, then country + postal. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 1fr",
            gap: 14,
          }}
        >
          <FieldSkeleton labelWidth={92} />
          <FieldSkeleton labelWidth={86} />
          <FieldSkeleton labelWidth={80} />
        </div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
        >
          <FieldSkeleton labelWidth={56} />
          <FieldSkeleton labelWidth={62} />
        </div>
      </div>

      {/* Optional "save my details" panel. `flex: 1` so it, and not the gap
          above the pay button, absorbs whatever the reserved height leaves
          over — this is the block whose real height actually varies. */}
      <div
        style={{
          flex: 1,
          border: BORDER_SUBTLE,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <SkeletonLine width={196} height={12} />
        <FieldSkeleton labelWidth={44} />
        <FieldSkeleton labelWidth={104} />
      </div>

      {/* Pay button, landing where the real one does. */}
      <SkeletonLine block width="100%" height={54} />
    </div>
  );
};

StripePaymentCardSkeleton.displayName = "StripePaymentCardSkeleton";
