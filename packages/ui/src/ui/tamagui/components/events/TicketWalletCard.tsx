import { memo } from "react";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { XStack, YStack, styled, type GetProps } from "tamagui";

import { Link } from "../navigation/Link";
import { Text } from "../typography/Text";
import { Icon } from "../utility/Icon";
import { DateBlock } from "./DateBlock";

/**
 * TicketWalletCard — a row in the attendee's wallet.
 *
 * The wallet reads as a **stack of tickets**, not a list of links, and the
 * `DateBlock` is what does that: it is the same torn-off date column the ticket
 * stub and the browse card carry, so the three are visibly one object at three
 * sizes. A generic card with icon-and-label meta rows loses that entirely.
 *
 * **The wallet's only job is getting to the code fast.** Upcoming tickets show
 * the QR glyph as the affordance; nothing else competes with it.
 *
 * **Spent tickets stay in the wallet.** People come back looking for proof they
 * attended. A spent ticket mutes its title and swaps the QR glyph for a status
 * badge — it is not removed, and it is not dimmed: a low-opacity card reads as
 * broken rather than as spent (the same reasoning that keeps sold-out event
 * cards at full contrast).
 *
 * Sort upcoming first, soonest at the top. Nobody opens a wallet to find last
 * year.
 */

const WalletFrame = styled(XStack, {
  name: "TicketWalletCard",
  position: "relative",
  alignItems: "center",
  // The row wraps rather than crushing its body. At 320px a fixed three-column
  // row squeezed the title to ~90px — "Soma Warehouse Rave" rendered as
  // "[STRI…" and the meta broke mid-word. The affordance drops to its own line
  // instead. Nothing is hidden at any width; the columns re-flow.
  flexWrap: "wrap",
  gap: "$4",
  padding: "$4",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  // Line work goes accent on hover — the sanctioned hover for a bordered
  // surface. No opacity fades on interactive elements.
  hoverStyle: { borderColor: "$borderColorHover" },
});

export interface TicketWalletCardProps
  extends Omit<GetProps<typeof WalletFrame>, "children"> {
  /** Short month label, e.g. "Aug". */
  month: string;
  /** Day of month, e.g. "15" / "02". */
  day: string;
  /** Short weekday label, e.g. "Sat". */
  weekday?: string;
  eventTitle: string;
  /**
   * The meta line's parts, in order. Falsy entries are dropped, and the rest
   * are joined with a middot — so a missing venue closes the gap instead of
   * leaving a stranded separator.
   */
  meta?: Array<string | null | undefined | false>;
  /** Where the row leads — the ticket, not the event. */
  href: string;
  /** Accessible name for the link. Defaults to the event title. */
  linkLabel?: string;
  /**
   * The ticket is spent — past, refunded, cancelled. Mutes the title.
   *
   * It does NOT dim or remove the row: people come back to the wallet looking
   * for proof they attended, and a low-opacity card reads as broken rather
   * than as spent (the same reasoning that keeps sold-out event cards at full
   * contrast).
   */
  spent?: boolean;
  /**
   * Replaces the QR glyph in the third column — a status badge for anything
   * that is not a live, scannable ticket.
   *
   * The third column holds ONE thing. A QR glyph beside a "Refunded" badge
   * invites someone to present a ticket that will not scan.
   */
  badge?: ReactNode;
  /** Accessible name on the QR affordance, e.g. "Show ticket". */
  qrLabel?: string;
  /**
   * Quiet actions that are not the primary destination — "View event", "Rate
   * this show". Rendered beneath the meta line, inside the body column, and
   * above the row's stretched link so they stay real buttons rather than
   * controls nested inside an anchor.
   */
  actions?: ReactNode;
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const TicketWalletCard = memo<TicketWalletCardProps>(
  function TicketWalletCard({
    month,
    day,
    weekday,
    eventTitle,
    meta,
    href,
    linkLabel,
    spent = false,
    badge,
    qrLabel = "Show ticket",
    actions,
    testId,
    ...rest
  }) {
    const metaLine = (meta ?? []).filter(Boolean).join(" · ");

    return (
      <WalletFrame
        {...(testId ? (isWeb ? { "data-testid": testId } : { testID: testId }) : {})}
        {...rest}
      >
        <DateBlock month={month} day={day} weekday={weekday} paddingVertical="$2" />

        {/*
          A basis floor, not just `minWidth: 0`. A flex item holding text needs
          a width it will not shrink below or its siblings win every time —
          this is what stops the DateBlock and the badge starving the title.
        */}
        <YStack flexGrow={1} flexShrink={1} flexBasis={200} minWidth={0} gap={2}>
          {/*
            The TITLE is the link, not the card.
            A card-wide anchor would make every action inside it a control
            nested in a link — invalid, and it forces the `stopPropagation`
            dance the previous implementation needed. Instead the anchor
            stretches over the row via an absolutely-positioned ::after (web
            only), so the whole row stays clickable while the actions remain
            real buttons sitting above it.

            `Link` rather than a raw anchor: it routes internal hrefs through
            next/link, so the wallet keeps client-side navigation instead of a
            full document load on every row tap.
          */}
          <Link
            href={href}
            aria-label={linkLabel ?? eventTitle}
            className="th-wallet-link"
            textDecorationLine="none"
            color="inherit"
            minWidth={0}
            // The overlay is a ::after, which Tamagui has no prop for — the
            // rule lives in globals.css on the class above.
            {...({ style: { position: "static" } } as Record<string, unknown>)}
          >
            <Text
              variant="h5"
              weight="bold"
              truncate
              tone={spent ? "muted" : "default"}
              textTransform="uppercase"
              letterSpacing={0.2}
            >
              {eventTitle}
            </Text>
          </Link>

          {metaLine ? (
            <Text variant="overline" fontSize={11.5} letterSpacing={1.4} tone="muted">
              {metaLine}
            </Text>
          ) : null}

          {/*
            Secondary actions sit UNDER the meta, inside the body column —
            never in the third column beside the affordance.

            They were in that column first, and it starved the title: with two
            buttons and a badge to the right of it, "Soma Warehouse Rave"
            rendered as "[STRIPE] SOM…" on a 1440px viewport. The event name is
            the thing someone scans the wallet for, so it gets the width and
            the actions wrap beneath.

            `zIndex` lifts them above the title's stretched-link overlay so
            they stay clickable.
          */}
          {actions ? (
            <XStack
              gap="$2"
              alignItems="center"
              flexWrap="wrap"
              marginTop="$2"
              position="relative"
              zIndex={1}
            >
              {actions}
            </XStack>
          ) : null}
        </YStack>

        {/* Third column: the affordance. One thing, never two. */}
        <XStack alignItems="center" position="relative" zIndex={1}>
          {badge ?? <Icon name="qr" size="xl" label={qrLabel} />}
        </XStack>
      </WalletFrame>
    );
  },
);
