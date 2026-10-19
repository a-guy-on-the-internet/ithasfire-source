"use client";

import { XStack, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";
import { Mail } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// "What actually happens when you press Send" — the venue-facing explainer that
// mounts inside the thread of an ANONYMOUS (unclaimed) embed inquiry.
//
// WHY IT EXISTS. The venue's conversation with an unclaimed inquirer is a
// RELAY, not a chat: the message is stored on the request and then mailed to
// the submitted `contactEmail` (booking-inquirer-outreach,
// `notify-booking-inquirer.ts`). Without this line the composer is
// indistinguishable from the owned-request one, and the two facts a venue
// needs are both invisible — that their words leave the platform as an email,
// and that the answer will NOT come back into this thread. There is no inbound
// email ingestion; the reply rides the `Reply-To` we set to the organization's
// contact address.
//
// ONLY THE VENUE SIDE EVER SEES THIS. The performer half of an unclaimed
// inquiry is refused by `thread-access.ts` until the inquiry is claimed, so
// there is no reader on the other side to explain anything to.
//
// TWO STATES, ONE BOX. When our mail to this inquirer has hard-bounced or drawn
// a complaint the relay is broken, and inviting another message without saying
// so is the whole defect this guards against. The failed copy deliberately does
// NOT re-raise the alarm in danger/warning hues: `BookingInquirerUndeliverable`
// already renders that notice higher in the same panel, and a second red box
// for the same fact reads as two failures. This one states the CONSEQUENCE for
// the composer directly beneath it and points back at the notice.
// ─────────────────────────────────────────────────────────────────────────────

export interface BookingInquirerEmailRelayNoteProps {
  /** The submitted contact name — who the relay is aimed at. */
  contactName: string;
  /** The submitted contact address the relay mails. */
  contactEmail: string;
  /**
   * True once `inquirerEmailUndeliverable{At,Status}` is stamped. The cause
   * (bounce vs complaint) is deliberately NOT taken here: the distinction and
   * its next step belong to the notice above, and repeating it would give one
   * fact two voices that can drift.
   */
  undeliverable: boolean;
  testIdBase: string;
}

export function BookingInquirerEmailRelayNote({
  contactName,
  contactEmail,
  undeliverable,
  testIdBase,
}: BookingInquirerEmailRelayNoteProps) {
  const t = useTranslations();
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surface"
      minWidth={0}
      data-testid={`${testIdBase}-email-relay`}
    >
      {/* TOP-aligned like the undeliverable notice: at 320px the label wraps
          and a centred icon would float between its two lines. */}
      <XStack gap="$2" alignItems="flex-start" minWidth={0}>
        <Mail
          size={14}
          aria-hidden
          style={{ opacity: 0.7, flexShrink: 0, marginTop: 1 }}
        />
        <Text variant="overline" tone="muted" minWidth={0}>
          {String(
            t(
              undeliverable
                ? "admin.bkWsVenThreadRelayFailedLabel"
                : "admin.bkWsVenThreadRelayLabel",
            ),
          )}
        </Text>
      </XStack>
      <Text variant="bodySmall" style={{ overflowWrap: "anywhere" }}>
        {String(
          t(
            undeliverable
              ? "admin.bkWsVenThreadRelayFailedBody"
              : "admin.bkWsVenThreadRelayBody",
            { name: contactName, email: contactEmail },
          ),
        )}
      </Text>
    </YStack>
  );
}
