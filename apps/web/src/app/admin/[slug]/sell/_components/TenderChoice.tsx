"use client";

import { useId } from "react";
import { XStack, YStack } from "tamagui";
import { Badge, Button, StyledSelect, Text, TextInput } from "@th/ui";
import type { StyledSelectOption } from "@th/ui";
import { Banknote, CreditCard, Gift } from "lucide-react";

import { formatCents } from "@/lib/format";
import { PoliteRegion, SupportNotice } from "./SaleStates";
import { looksLikeEmail } from "./sell-quote";

export type ReaderOption = {
  id: string;
  label: string;
  status: "online" | "offline" | null;
  busy: boolean | null;
};

function TenderTile({
  title,
  amountLabel,
  description,
  icon,
  disabled,
  onPress,
  testId,
  children,
}: {
  title: string;
  /** The total this tender charges, from the quote ("$47.72", "$0"). */
  amountLabel: string;
  description: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onPress: () => void;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    // A REAL <button> via `tag`, not a div wearing role="button". Native
    // buttons already fire on Enter and Space, already leave the tab order
    // when disabled, and already announce correctly — which removes the
    // hand-rolled keydown handler that (a) Tamagui's view props don't type and
    // (b) swallowed Space from anything nested inside it.
    <YStack
      tag="button"
      // No `type="button"`: Tamagui's view props don't accept it, and no
      // tender tile sits inside a <form>, so there is no implicit submit.
      // Basis 0, not content: three equal tiles in one row on a desktop,
      // one per row on a phone. A content basis let the card tile's longer
      // caption push Comp onto a row of its own.
      flexGrow={1}
      flexShrink={1}
      // "0%", not 0: Tamagui drops a numeric 0 basis and emits `auto`.
      flexBasis="0%"
      minWidth={200}
      alignItems="stretch"
      gap="$2"
      padding="$4"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor={disabled ? "$surfaceMuted" : "$background"}
      opacity={disabled ? 0.55 : 1}
      cursor={disabled ? "not-allowed" : "pointer"}
      // No figure to read out when there's no total: "Card — Tax can't…",
      // not "Card, — — Tax can't…".
      aria-label={
        amountLabel === "—"
          ? `${title} — ${description}`
          : `${title}, ${amountLabel} — ${description}`
      }
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      hoverStyle={disabled ? undefined : { backgroundColor: "$surfaceOverlay" }}
      focusStyle={{
        outlineWidth: 2,
        outlineColor: "$accent",
        outlineStyle: "solid",
        outlineOffset: 2,
      }}
      data-testid={testId}
    >
      {/* Each line sets its own alignment: a <button> centres text by
          default, and the tiles read left-aligned. */}
      <XStack gap="$2" alignItems="center">
        {icon}
        <Text variant="body" weight="bold" textAlign="left">
          {title}
        </Text>
      </XStack>
      <Text
        variant="h4"
        weight="black"
        textAlign="left"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {amountLabel}
      </Text>
      <Text variant="caption" tone="muted" textAlign="left">
        {description}
      </Text>
      {children}
    </YStack>
  );
}

const TENDER_NAME = { card: "Card", cash: "Cash", comp: "Comp" } as const;

/**
 * How are they paying?
 *
 * A FORK, NOT A DROPDOWN. Tender is the highest-stakes choice of the night and
 * it is made under time pressure with someone waiting, so all three options are
 * visible at once with no menu to open — each with ITS OWN total, because the
 * two differ: a card carries the platform and processing fees online checkout
 * charges, cash carries the tax and neither fee (owner ruling 2026-10-08).
 * Every number comes from the server's quote.
 *
 * Three, not four. A "scan to pay on your phone" tender was designed and cut:
 * it is card-not-present (worse rates, chargeback liability), slower than a tap,
 * and it depends on the customer having data in a room where nobody does. Tap to
 * Pay in the scanner app already covers the no-hardware case at card-present
 * rates.
 *
 * Comp is a tender here rather than a separate page, because giving someone the
 * guest list at a door IS a payment decision.
 *
 * The buyer's email sits ABOVE the tiles and is always shown (owner pick E1):
 * it applies to all three, the receipt and ticket go to it, and a field the
 * operator has to open first is a field nobody fills at a busy door.
 *
 * If every reader is offline the card tile disables itself and cash stays
 * available. The door does not stop because the venue's wifi did.
 *
 * With no quote (the tax lookup can't answer) only Comp is open: a comp
 * charges no tax, so it is the one sale that doesn't need a rate.
 *
 * After a sale attempt that got NO answer, or that the server says is still
 * being processed, the email, Back to cart and the other tenders lock. The
 * sale may have gone through; pressing the same tender again replays it
 * safely, while a changed email, cart or tender would be a different sale
 * under the same key.
 */
export function TenderChoice({
  cardTotalCents,
  cashTotalCents,
  currency,
  ticketCount,
  eventTitle,
  readers,
  selectedReaderId,
  onSelectReader,
  buyerEmail,
  onBuyerEmailChange,
  cashTotalChanged,
  lockedTender,
  lockReason,
  mayAlreadyBeRecorded,
  onCheckTill,
  onCard,
  onCash,
  onComp,
  onBack,
  busy,
}: {
  /** The quote's card total, or null when a card can't take this cart ($0). */
  cardTotalCents: number | null;
  /**
   * The quote's cash total: ticket + tax, no fees. Null when there is no
   * quote because tax can't be worked out: then only Comp is open.
   */
  cashTotalCents: number | null;
  currency: string;
  ticketCount: number;
  eventTitle: string;
  readers: ReaderOption[];
  selectedReaderId: string | null;
  onSelectReader: (id: string) => void;
  buyerEmail: string;
  onBuyerEmailChange: (value: string) => void;
  /**
   * True after a cash sale was refused because the cash total moved since the
   * quote; `cashTotalCents` is then the server's new figure.
   */
  cashTotalChanged: boolean;
  /**
   * The tender whose last attempt is unresolved, or null. While set, the
   * email can't change, Back to cart is off, and only this tender can be
   * pressed again (its replay finds the stored sale, never a second one).
   */
  lockedTender: "card" | "cash" | "comp" | null;
  /**
   * Why it is locked: `no-answer`, no response came back; `processing`, the
   * server says an attempt under this key is still running.
   */
  lockReason: "no-answer" | "processing" | null;
  /**
   * The server said this sale's key may already hold a sale (an earlier
   * attempt whose answer was lost). The operator checks before going on.
   */
  mayAlreadyBeRecorded: boolean;
  /** To the ring-up screen with Cash taken tonight open. */
  onCheckTill: () => void;
  onCard: () => void;
  onCash: () => void;
  onComp: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  const emailId = useId();
  const emailHelpId = useId();
  const emailTyped = buyerEmail.trim() !== "";
  // A light check for obvious typos only; the server validates the address.
  const emailInvalid = emailTyped && !looksLikeEmail(buyerEmail);
  const blocked = busy || emailInvalid || mayAlreadyBeRecorded;
  const noQuote = cashTotalCents === null;
  const lockedOut = (tender: "card" | "cash" | "comp") =>
    lockedTender !== null && lockedTender !== tender;

  const selectedReader =
    readers.find((r) => r.id === selectedReaderId) ?? readers[0] ?? null;
  // A reader whose status lookup failed reads "Unknown", not "Offline" — and
  // Unknown is still worth dispatching to, because the lookup failing says
  // nothing about the device. Only a confirmed `offline` blocks the tile.
  const anyReachable = readers.some((r) => r.status !== "offline");
  const cardDisabled =
    cardTotalCents === null ||
    readers.length === 0 ||
    !anyReachable ||
    blocked ||
    lockedOut("card");

  const readerOptions: StyledSelectOption[] = readers.map((reader) => ({
    value: reader.id,
    label:
      reader.status === "offline"
        ? `${reader.label} — offline`
        : reader.busy
          ? `${reader.label} — in use`
          : reader.label,
  }));

  const taxDown = "Tax can’t be worked out right now. A comp still works.";
  const cardDescription = noQuote
    ? taxDown
    : cardTotalCents === null
      ? "Nothing to charge to a card. Take it as cash."
      : readers.length === 0
        ? "No readers paired. Pair one under Card readers."
        : !anyReachable
          ? "Every reader is offline. Cash still works."
          : "Tap, insert or swipe on a reader.";

  return (
    <YStack gap="$4" data-testid="sell-tender">
      <YStack gap="$1">
        <Text variant="h3" weight="bold" textTransform="uppercase">
          Take payment
        </Text>
        <Text variant="bodySmall" tone="muted">
          {ticketCount} {ticketCount === 1 ? "ticket" : "tickets"} · {eventTitle}
        </Text>
      </YStack>

      <YStack gap="$2">
        <Text tag="label" variant="overline" tone="muted" htmlFor={emailId}>
          Buyer email (optional)
        </Text>
        <TextInput
          id={emailId}
          type="email"
          name="buyer-email"
          autoComplete="off"
          inputMode="email"
          autoCapitalize="none"
          value={buyerEmail}
          onChangeText={onBuyerEmailChange}
          placeholder="name@example.com"
          status={emailInvalid ? "error" : undefined}
          aria-describedby={emailHelpId}
          aria-invalid={emailInvalid || undefined}
          // Locked after an attempt with no answer: the email is part of
          // the sale the server may already hold.
          disabled={busy || lockedTender !== null}
          fullWidth
          testId="sell-buyer-email"
        />
        <Text
          id={emailHelpId}
          variant="caption"
          tone={emailInvalid ? "error" : "muted"}
        >
          {emailInvalid
            ? "That doesn’t look like an email address. Fix it or clear it to take payment."
            : "We send their ticket and an itemised receipt. No account, no marketing."}
        </Text>
      </YStack>

      <PoliteRegion>
        {mayAlreadyBeRecorded ? (
          <SupportNotice testId="sell-may-be-recorded">
            This sale may already be recorded. Check Cash taken tonight, or
            the event&rsquo;s orders for a card sale. If it isn&rsquo;t
            there, clear the sale and ring it up again.
          </SupportNotice>
        ) : lockedTender !== null && lockReason === "processing" ? (
          <SupportNotice testId="sell-still-processing">
            Still being processed. Wait a moment, then press{" "}
            {TENDER_NAME[lockedTender]} again.
          </SupportNotice>
        ) : lockedTender !== null ? (
          <SupportNotice testId="sell-no-answer">
            No answer came back about that sale. Press{" "}
            {TENDER_NAME[lockedTender]} again: if it went through,
            you&rsquo;ll see that sale, not a second one.
          </SupportNotice>
        ) : cashTotalChanged && cashTotalCents !== null ? (
          <SupportNotice testId="sell-cash-total-changed">
            The cash total changed since the quote. Take{" "}
            {formatCents(cashTotalCents, currency)}.
          </SupportNotice>
        ) : null}
      </PoliteRegion>
      {mayAlreadyBeRecorded ? (
        <XStack>
          <Button
            variant="secondary"
            size="$3"
            minHeight={44}
            onPress={onCheckTill}
            data-testid="sell-check-till"
          >
            See Cash taken tonight
          </Button>
        </XStack>
      ) : null}

      <XStack gap="$3" flexWrap="wrap">
        <TenderTile
          title="Card"
          amountLabel={
            cardTotalCents === null ? "—" : formatCents(cardTotalCents, currency)
          }
          description={cardDescription}
          icon={<CreditCard size={20} aria-hidden="true" />}
          disabled={cardDisabled}
          onPress={onCard}
          testId="tender-card"
        >
          {selectedReader && readers.length <= 1 ? (
            <XStack gap="$2" alignItems="center" paddingTop="$2">
              <Text variant="caption" weight="bold">
                {selectedReader.label}
              </Text>
              <Badge
                tone={
                  selectedReader.status === "offline"
                    ? "danger"
                    : selectedReader.busy
                      ? "warning"
                      : selectedReader.status === "online"
                        ? "success"
                        : "neutral"
                }
              >
                {selectedReader.status === "offline"
                  ? "Offline"
                  : selectedReader.busy
                    ? "In use"
                    : selectedReader.status === "online"
                      ? "Online"
                      : "Unknown"}
              </Badge>
            </XStack>
          ) : null}
        </TenderTile>

        <TenderTile
          title="Cash"
          amountLabel={
            cashTotalCents === null ? "—" : formatCents(cashTotalCents, currency)
          }
          description={noQuote ? taxDown : "No platform or processing fee."}
          icon={<Banknote size={20} aria-hidden="true" />}
          disabled={noQuote || blocked || lockedOut("cash")}
          onPress={onCash}
          testId="tender-cash"
        />

        <TenderTile
          title="Comp"
          amountLabel={formatCents(0, currency)}
          description="Guest list. No fee, no tax."
          icon={<Gift size={20} aria-hidden="true" />}
          disabled={blocked || lockedOut("comp")}
          onPress={onComp}
          testId="tender-comp"
        />
      </XStack>

      {/*
        The reader picker lives OUTSIDE the Card tile, not inside it.
        `TenderTile` is a `role="button"` container whose keydown handler
        `preventDefault()`s and fires `onPress` on Enter or Space — and
        `StyledSelect` only stops `pointerdown`/`mousedown`, never `keydown`.
        So a select nested in the tile meant that tabbing to it and pressing
        Space to OPEN it instead swallowed the key and started a real card
        sale, dispatched to whichever reader was already chosen rather than
        the one the operator was about to pick. (Nesting a combobox inside
        role="button" is also invalid ARIA and hides the select from several
        screen readers.)
      */}
      {readers.length > 1 ? (
        <YStack gap="$2" maxWidth={320}>
          <Text variant="caption" tone="muted">
            Card reader
          </Text>
          <StyledSelect
            value={selectedReader?.id ?? ""}
            onChange={onSelectReader}
            options={readerOptions}
            ariaLabel="Card reader"
            fullWidth
          />
        </YStack>
      ) : null}

      <XStack>
        <Button
          variant="ghost"
          size="$3"
          onPress={onBack}
          // An unresolved attempt keeps its key; the cart is part of it.
          disabled={busy || lockedTender !== null}
          data-testid="sell-back-to-cart"
        >
          Back to cart
        </Button>
      </XStack>
    </YStack>
  );
}
