"use client";

import { useEffect, useRef } from "react";
import { XStack, YStack } from "tamagui";
import { Button, NextLinkAnchor, Text } from "@th/ui";

import {
  createEventOutcomeCopy,
  type CreateEventFromBookingOutcome,
} from "./create-event-from-booking";

/**
 * Success state for "Create event from this booking" — rendered by
 * FinalizeDialog on `/agreements/{id}` and by `CreateEventFromBookingAction`
 * inside the venue inbox's conversation. Covers the created-but-not-finalized
 * variants (`lines_unconfirmed` / `payee_not_ready` / `requester_owned`) and
 * `alreadyLinked`; the fully-finalized path in the dialog toasts and routes
 * straight into the event editor instead.
 *
 * `requester_owned` renders NO Open-event link: the draft lives in the
 * requester's admin, which the venue cannot open, and `eventHref` here is
 * derived from the VENUE's admin slug — a link would 404 or 403. What it
 * offers instead, when the caller can build one, is `threadHref`: the
 * booking's conversation in the venue's inbox, which IS the venue's next
 * place to go. The inbox omits it (the notice already sits in that thread).
 *
 * a11y: role="status" announces the outcome; focus moves to the one link on
 * mount so keyboard users land on the next sensible action after the create
 * button they pressed disappears — or to the notice itself when there is no
 * link to land on.
 */
export function CreateEventOutcomeNotice({
  outcome,
  eventHref,
  threadHref,
}: {
  outcome: CreateEventFromBookingOutcome;
  eventHref: string;
  /** The booking's conversation in the venue's inbox — `requester_owned` only. */
  threadHref?: string | null;
}) {
  const { title, detail } = createEventOutcomeCopy(outcome);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const requesterOwned = outcome.finalizeBlocked === "requester_owned";
  const offersLink = !requesterOwned || Boolean(threadHref);

  useEffect(() => {
    (linkRef.current ?? noticeRef.current)?.focus();
  }, []);

  return (
    <YStack
      ref={noticeRef}
      gap="$2"
      padding="$3"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
      role="status"
      tabIndex={offersLink ? undefined : -1}
      testID="ba-create-event-outcome"
    >
      <Text variant="bodySmall" weight="bold">
        {title}
      </Text>
      {detail ? (
        <Text variant="caption" tone="muted">
          {detail}
        </Text>
      ) : null}
      {!requesterOwned ? (
        <XStack>
          <NextLinkAnchor
            ref={linkRef}
            href={eventHref}
            style={{ textDecoration: "none" }}
          >
            <Button tag="span" variant="outlined" size="$2" testID="ba-create-event-open">
              Open event
            </Button>
          </NextLinkAnchor>
        </XStack>
      ) : threadHref ? (
        <XStack>
          <NextLinkAnchor
            ref={linkRef}
            href={threadHref}
            style={{ textDecoration: "none" }}
          >
            <Button
              tag="span"
              variant="outlined"
              size="$2"
              testID="ba-create-event-open-thread"
            >
              Open the conversation
            </Button>
          </NextLinkAnchor>
        </XStack>
      ) : null}
    </YStack>
  );
}
