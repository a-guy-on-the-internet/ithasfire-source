"use client";

import { Reveal, ChipGroup, TagMultiSelect } from "@th/ui";
import { YStack } from "tamagui";
import { INPUT_STYLE } from "../_shared/tokens";
import {
  PAYOUT_RANGES,
  PROMOTION_LABELS,
  SOUND_LABELS,
  AUDIENCE_LABELS,
  PLAY_AGAIN_LABELS,
  DEFAULT_GENRE_TAGS,
} from "../_shared/labels";
import type { ScreenDef } from "../_shared/types";
import { isGenreTagAllowed } from "../_shared/genre-filter";
import { TrustLine } from "../_primitives/TrustLine";
import { PlaceAutocomplete } from "../_primitives/PlaceAutocomplete";
import { PaymentMethodChips } from "../_primitives/PaymentMethodChips";

// ─────────────────────────────────────────────────────────────────────────────
// Core screens — the essential stuff. Every question earns its place here.
// Keep it conversational: one thought per screen, friend asking follow-ups.
// ─────────────────────────────────────────────────────────────────────────────

export const CORE_SCREENS: ScreenDef[] = [
  // ── 0. Venue ──────────────────────────────────────────────────────────
  {
    id: "venue",
    phase: "core",
    question: "Where did you play?",
    helper: "Start typing — we'll find it. If it's not listed, you can add it.",
    required: true,
    validate: (d) => {
      if (!d.placeName && !d.placeId) return "We need the place name";
      if (!d.placeId && d.placeName && !d.placeCity)
        return "Which city is this in?";
      return undefined;
    },
    render: (d, onChange, error) => (
      <YStack gap={16}>
        <TrustLine>
          <strong style={{ color: "#FFFFFF", fontWeight: 800 }}>
            100% anonymous.
          </strong>{" "}
          Your identity is never attached to your review.
        </TrustLine>
        <PlaceAutocomplete
          placeName={d.placeName}
          placeCity={d.placeCity}
          placeCountry={d.placeCountry}
          placeState={d.placeState}
          placeId={d.placeId}
          onSelect={(id, name, city) =>
            onChange({ placeId: id, placeName: name, placeCity: city })
          }
          onCustom={(patch) => onChange({ placeId: "", ...patch })}
          error={error}
        />
      </YStack>
    ),
  },

  // ── 1. Payout ─────────────────────────────────────────────────────────
  {
    id: "payout",
    phase: "core",
    question: "How much did they pay you?",
    helper:
      "This is anonymous — the place can't see who said what. Helps other artists know what to expect.",
    required: false,
    render: (d, onChange) => (
      <YStack gap={12}>
        <ChipGroup
          options={PAYOUT_RANGES}
          value={d.payoutRange}
          fillContainer
          onChange={(v) => {
            onChange({
              payoutRange: v,
              ...(v !== "SPECIFIC" ? { payoutCents: "" } : {}),
            });
          }}
        />
        <Reveal show={d.payoutRange === "SPECIFIC"}>
          <div style={{ paddingTop: 4 }}>
            <input
              type="number"
              inputMode="numeric"
              enterKeyHint="done"
              min={0}
              aria-label="Exact payout amount in dollars"
              value={d.payoutCents}
              onChange={(e) => onChange({ payoutCents: e.target.value })}
              placeholder="Amount in dollars…"
              style={INPUT_STYLE}
            />
          </div>
        </Reveal>
      </YStack>
    ),
  },

  // ── 2. Payment method ─────────────────────────────────────────────────
  {
    id: "paymentMethod",
    phase: "core",
    question: "How were you paid?",
    helper: "If it was a mix, pick all that apply.",
    required: true,
    validate: (d) => {
      if (d.paymentMethods.length === 0) return "Pick at least one";
      if (d.paymentMethods.includes("OTHER") && !d.paymentMethodOther.trim())
        return "Tell us about that payment method";
      return undefined;
    },
    render: (d, onChange, error) => (
      <PaymentMethodChips
        values={d.paymentMethods}
        onChange={(vs) => onChange({ paymentMethods: vs })}
        otherValue={d.paymentMethodOther}
        onOtherChange={(v) => onChange({ paymentMethodOther: v })}
        detail={d.paymentMethodDetail}
        onDetailChange={(v) => onChange({ paymentMethodDetail: v })}
        error={!!error}
      />
    ),
  },

  // ── 3. Promotion ──────────────────────────────────────────────────────
  {
    id: "promotion",
    phase: "core",
    question: "Did the place help get people there?",
    helper: "Social posts, marquee, email list — or were you on your own?",
    required: true,
    validate: (d) => (!d.venuePromoted ? "Pick one" : undefined),
    render: (d, onChange) => (
      <ChipGroup
        options={PROMOTION_LABELS}
        value={d.venuePromoted}
        fillContainer
        onChange={(v) => onChange({ venuePromoted: v })}
        detail={d.venuePromotedDetail}
        onDetailChange={(v) => onChange({ venuePromotedDetail: v })}
        detailPlaceholder="What did they do? (optional)"
      />
    ),
  },

  // ── 4. Sound ──────────────────────────────────────────────────────────
  {
    id: "sound",
    phase: "core",
    question: "How was the PA / sound system?",
    helper:
      "The house system — speakers, monitors, the room sound. Not the engineer (we'll ask that next).",
    required: true,
    validate: (d) => (!d.soundQuality ? "Pick one" : undefined),
    render: (d, onChange) => (
      <ChipGroup
        options={SOUND_LABELS}
        value={d.soundQuality}
        fillContainer
        onChange={(v) => onChange({ soundQuality: v })}
        detail={d.soundQualityDetail}
        onDetailChange={(v) => onChange({ soundQualityDetail: v })}
        detailPlaceholder="Monitors? PA quality? Room acoustics?"
      />
    ),
  },

  // ── 5. Audience ───────────────────────────────────────────────────────
  {
    id: "audience",
    phase: "core",
    question: "Was it your crowd?",
    helper: "Playing folk to a metal crowd? We want to know.",
    required: true,
    validate: (d) => (!d.audienceFit ? "Pick one" : undefined),
    render: (d, onChange) => (
      <ChipGroup
        options={AUDIENCE_LABELS}
        value={d.audienceFit}
        fillContainer
        onChange={(v) => onChange({ audienceFit: v })}
        detail={d.audienceFitDetail}
        onDetailChange={(v) => onChange({ audienceFitDetail: v })}
        detailPlaceholder="e.g. mostly regulars, walk-ins, empty room…"
      />
    ),
  },

  // ── 6. Play again ─────────────────────────────────────────────────────
  {
    id: "playAgain",
    phase: "core",
    question: "Would you play here again?",
    helper: "Gut check. No wrong answer.",
    required: true,
    validate: (d) => (!d.wouldPlayAgain ? "Pick one" : undefined),
    render: (d, onChange) => (
      <ChipGroup
        options={PLAY_AGAIN_LABELS}
        value={d.wouldPlayAgain}
        fillContainer
        onChange={(v) => onChange({ wouldPlayAgain: v })}
        detail={d.wouldPlayAgainDetail}
        onDetailChange={(v) => onChange({ wouldPlayAgainDetail: v })}
        detailPlaceholder="Why or why not?"
      />
    ),
  },

  // ── 7. Genre ──────────────────────────────────────────────────────────
  // Conditionally shown by buildScreensForJobs when humanJobs includes a
  // GENRE_JOBS member (currently only MUSICIAN).
  {
    id: "genre",
    phase: "core",
    question: "What kind of music do you play?",
    helper: "Pick what fits. Add your own if we're missing something.",
    required: false,
    render: (d, onChange) => (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <TagMultiSelect
          availableTags={DEFAULT_GENRE_TAGS}
          inputName="review-genre-search"
          value={d.genreTags}
          onChange={(tags) => {
            const safe = tags.filter(
              (t) =>
                DEFAULT_GENRE_TAGS.some(
                  (dt) => dt.toLowerCase() === t.toLowerCase(),
                ) || isGenreTagAllowed(t),
            );
            onChange({ genreTags: safe });
          }}
          placeholder="Search or add a genre…"
        />
      </div>
    ),
  },
];
