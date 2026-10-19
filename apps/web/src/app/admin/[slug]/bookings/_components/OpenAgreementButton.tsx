"use client";

import { Button, NextLinkAnchor } from "@th/ui";
import { FileText } from "lucide-react";

import { adminAgreementHref } from "@/lib/agreement-routes";

/**
 * The route from an accepted request to the thing accepting it CREATED.
 *
 * Rendered from the COLLAPSED row (and the mobile card), not only inside the
 * expanded detail: before this existed, the agreement was reachable only by
 * noticing the row had moved tabs, finding it again, and expanding it — three
 * steps nobody had a reason to know about.
 *
 * NESTED-INTERACTIVE HAZARD, handled here once. `NextLinkAnchor` is the
 * control and carries the accessible name; the Tamagui `Button` inside it is
 * decoration. A `styled(Button)` with `tag="span"` still emits
 * `role="button" tabindex="0"`, so without `aria-hidden` AND `tabIndex={-1}`
 * this ships a button nested inside a link (ARIA forbids interactive
 * descendants of a link), two tab stops on one rectangle, and the label
 * announced twice for a single destination. Both attributes are load-bearing:
 * an `aria-hidden` node that still takes focus is a keyboard stop that
 * announces nothing at all.
 *
 * Two forms:
 * - `compact` — the in-TABLE form. The labelled button is ~197px wide while
 *   the actions cell renders 94–151px at desktop widths, and the cell is
 *   `nowrap`, so the label clips mid-word. The table therefore gets the square
 *   icon, named for assistive tech and titled for the pointer, under a noun
 *   column header.
 * - `fullWidth` — the MOBILE CARD form. At 320px inside the admin shell a card
 *   has ~178px of content; the icon+label button is ~197px and hangs past the
 *   card border. Stretching it and dropping the icon fits the label and reads
 *   as a card action.
 *
 * `nameSuffix` IS NOT DECORATION. The visible label is the same three words on
 * every accepted row, so a screen reader's links list otherwise reads as N
 * indistinguishable "Open agreement" entries with no way to tell which booking
 * each one opens. Callers pass the COUNTERPARTY — the act on a venue-side row,
 * the organizer on the act-side one — which is the only thing that differs
 * between them. It rides the pointer `title` too: the compact form is an
 * icon-only square, and "which agreement?" is the same question a mouse user
 * has.
 */
export function OpenAgreementButton({
  slug,
  agreementId,
  label,
  nameSuffix,
  testID,
  compact = false,
  fullWidth = false,
}: {
  /**
   * Admin slug of the shell this button is rendered in. The agreement opens
   * INSIDE that shell (`/admin/{slug}/bookings/agreement/{id}`), so the
   * venue never leaves its booking to finish the terms.
   */
  slug: string;
  agreementId: string;
  label: string;
  /** Counterparty name, appended to the accessible name to keep rows distinct. */
  nameSuffix?: string | null;
  testID: string;
  compact?: boolean;
  fullWidth?: boolean;
}) {
  const accessibleName = nameSuffix ? `${label} — ${nameSuffix}` : label;
  const link = (
    <NextLinkAnchor
      href={adminAgreementHref(slug, agreementId)}
      aria-label={accessibleName}
      style={fullWidth ? { width: "100%" } : undefined}
    >
      <Button
        tag="span"
        variant="secondary"
        size="$2"
        icon={compact}
        width={fullWidth ? "100%" : undefined}
        aria-hidden
        tabIndex={-1}
        testID={testID}
      >
        {fullWidth ? null : <FileText size={13} strokeWidth={2} aria-hidden />}
        {compact ? null : label}
      </Button>
    </NextLinkAnchor>
  );
  // `title` lives on a wrapper because NextLinkAnchor's prop type (Tamagui's
  // Anchor) has no `title`; a tooltip resolves from the nearest titled
  // ancestor, so the hover text still reads on the icon-only form.
  return compact ? (
    <span title={accessibleName} style={{ display: "inline-flex" }}>
      {link}
    </span>
  ) : (
    link
  );
}
