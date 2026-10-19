"use client";

import { CharCountTextarea } from "@th/ui";
import { YStack } from "tamagui";

import { RatingScale } from "./_primitives/RatingScale";
import { MAX } from "./_shared/tokens";
import type { AttendeeFormData, ScreenDef } from "./_shared/types";

// ─────────────────────────────────────────────────────────────────────────────
// Screen flow (attendee-reviews FR-001/002/008):
//   CORE      1. overall   — required
//             2. sound     — why-we-ask helper
//             3. organization
//   OPTIONAL  4. venue comfort  (skippable)
//             5. value for money (skippable)
//             6. open text       (honesty helper — private, unattributed)
//
// Calm-honest (FR-008): identical flow regardless of sentiment, no "tell us
// privately instead" interception, no incentives. One question per screen.
// ─────────────────────────────────────────────────────────────────────────────

type T = (key: string) => unknown;

/** A single 1-5 rating screen. `advance` is wired for gentle auto-advance. */
function ratingScreen(
  id: string,
  phase: "core" | "optional",
  field: keyof Pick<
    AttendeeFormData,
    | "overallRating"
    | "soundQuality"
    | "organization"
    | "venueComfort"
    | "valueForMoney"
  >,
  t: T,
  opts: { required?: boolean; autoAdvance?: boolean } = {},
): ScreenDef {
  const question = String(t(`attendeeReview.form.${id}.q`));
  const helper = String(t(`attendeeReview.form.${id}.helper`));
  const lowLabel = String(t("attendeeReview.rating.low"));
  const highLabel = String(t("attendeeReview.rating.high"));

  return {
    id,
    phase,
    question,
    helper,
    required: opts.required,
    validate: opts.required
      ? (d) =>
          d[field] >= 1
            ? undefined
            : String(t("attendeeReview.validation.pickRating"))
      : undefined,
    render: (d, onChange, advance) => (
      <RatingScale
        value={d[field]}
        onChange={(v) => onChange({ [field]: v } as Partial<AttendeeFormData>)}
        onCommit={opts.autoAdvance ? () => advance() : undefined}
        lowLabel={lowLabel}
        highLabel={highLabel}
        ariaLabel={question}
        testIdBase={`attendee-${id}`}
      />
    ),
  };
}

export function buildAttendeeScreens(t: T): ScreenDef[] {
  return [
    // 1. Overall — required.
    ratingScreen("overall", "core", "overallRating", t, {
      required: true,
      autoAdvance: true,
    }),

    // 2. Sound.
    ratingScreen("sound", "core", "soundQuality", t, { autoAdvance: true }),

    // 3. Organization / smoothness.
    ratingScreen("organization", "core", "organization", t, {
      autoAdvance: true,
    }),

    // 4. Venue comfort — optional, skippable.
    ratingScreen("venueComfort", "optional", "venueComfort", t, {
      autoAdvance: true,
    }),

    // 5. Value for money — optional, skippable.
    ratingScreen("value", "optional", "valueForMoney", t, {
      autoAdvance: true,
    }),

    // 6. Open text — optional, private to the organizer, unattributed.
    {
      id: "text",
      phase: "optional",
      question: String(t("attendeeReview.form.text.q")),
      helper: String(t("attendeeReview.form.text.helper")),
      render: (d, onChange) => (
        <YStack gap={12}>
          <CharCountTextarea
            value={d.text}
            onChange={(v) => onChange({ text: v })}
            placeholder={String(t("attendeeReview.form.text.placeholder"))}
            maxLength={MAX.TEXT}
            minHeight={140}
            testIdBase="attendee-text"
          />
        </YStack>
      ),
    },
  ];
}
