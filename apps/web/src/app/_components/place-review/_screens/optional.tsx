"use client";

import {
  Reveal,
  FieldLabel,
  ChipGroup,
  CharCountTextarea,
  DayOfWeekSelect,
} from "@th/ui";
import { YStack } from "tamagui";
import { INPUT_STYLE, MAX } from "../_shared/tokens";
import {
  EQUIPMENT_LABELS,
  PARKING_LABELS,
  BOOKER_LABELS,
  MERCH_LABELS,
  STAFF_LABELS,
  INDEPENDENT_LABELS,
  FOH_RATING_LABELS,
  SECURITY_LABELS,
} from "../_shared/labels";
import type { ScreenDef } from "../_shared/types";

// ─────────────────────────────────────────────────────────────────────────────
// Optional screens — the "keep going" section. Everything here is skippable.
// Conversational, one thought per screen. Each answer paints a richer picture.
// ─────────────────────────────────────────────────────────────────────────────

export const OPTIONAL_SCREENS: ScreenDef[] = [
  // ── Your draw ──────────────────────────────────────────────────────────
  {
    id: "draw",
    phase: "optional",
    question: "How many people did you bring?",
    helper:
      "Just the people who came specifically to see you — friends, fans, your mailing list. Best guess is fine.",
    render: (d, onChange) => (
      <input
        type="number"
        inputMode="numeric"
        enterKeyHint="done"
        min={0}
        aria-label="People you brought to the show"
        value={d.estimatedDraw}
        onChange={(e) => onChange({ estimatedDraw: e.target.value })}
        placeholder="Your draw"
        style={INPUT_STYLE}
      />
    ),
  },

  // ── Total attendance ──────────────────────────────────────────────────
  {
    id: "totalAttendance",
    phase: "optional",
    question: "How many people showed up total?",
    helper:
      "Everyone in the room — your people, walk-ins, regulars, bar crowd. Rough count is perfect.",
    render: (d, onChange) => (
      <input
        type="number"
        inputMode="numeric"
        enterKeyHint="done"
        min={0}
        aria-label="Total people at the show"
        value={d.totalAttendance}
        onChange={(e) => onChange({ totalAttendance: e.target.value })}
        placeholder="Total headcount"
        style={INPUT_STYLE}
      />
    ),
  },

  // ── When ───────────────────────────────────────────────────────────────
  {
    id: "dayOfWeek",
    phase: "optional",
    question: "When was the gig?",
    helper:
      "Tuesday crowds are different from Saturday crowds. A date or day helps us spot patterns.",
    render: (d, onChange) => (
      <YStack gap={16}>
        <DayOfWeekSelect
          value={d.dayOfWeek}
          onChange={(day) => onChange({ dayOfWeek: day })}
        />
        <div>
          <FieldLabel optional>Exact date</FieldLabel>
          <input
            type="date"
            aria-label="Gig date"
            value={d.gigDate}
            onChange={(e) => {
              onChange({ gigDate: e.target.value });
              // Auto-fill day of week from date
              if (e.target.value) {
                const date = new Date(e.target.value + "T12:00:00");
                if (!Number.isNaN(date.getTime())) {
                  onChange({
                    gigDate: e.target.value,
                    dayOfWeek: date.getDay(),
                  });
                }
              }
            }}
            enterKeyHint="done"
            style={INPUT_STYLE}
          />
        </div>
      </YStack>
    ),
  },

  // ── FOH / Sound engineer ──────────────────────────────────────────────
  {
    id: "foh",
    phase: "optional",
    question: "How was the sound engineer?",
    helper:
      "The person behind the board — not the speakers themselves. Did they care about your mix?",
    render: (d, onChange) => (
      <YStack gap={10}>
        <ChipGroup
          options={FOH_RATING_LABELS}
          value={d.fohRating}
          fillContainer
          onChange={(v) => onChange({ fohRating: v })}
        />
        <Reveal show={!!d.fohRating && d.fohRating !== "NO_ENGINEER"}>
          <div style={{ paddingTop: 4 }}>
            <CharCountTextarea
              value={d.fohDetail}
              onChange={(v) => onChange({ fohDetail: v })}
              placeholder="e.g. nailed the monitor mix, couldn't hear vocals…"
              maxLength={MAX.DETAIL}
              height={72}
            />
          </div>
        </Reveal>
      </YStack>
    ),
  },

  // ── Backline / stage equipment ────────────────────────────────────────
  {
    id: "equipment",
    phase: "optional",
    question: "What gear was waiting for you?",
    helper:
      "Amps, drums, monitors — what was already on stage when you showed up?",
    render: (d, onChange) => (
      <ChipGroup
        options={EQUIPMENT_LABELS}
        value={d.stageEquipment}
        fillContainer
        onChange={(v) => onChange({ stageEquipment: v })}
        detail={d.stageEquipmentDetail}
        onDetailChange={(v) => onChange({ stageEquipmentDetail: v })}
        detailPlaceholder="e.g. Fender Twin, no monitors, full drum kit…"
      />
    ),
  },

  // ── Load-in / parking ─────────────────────────────────────────────────
  {
    id: "parking",
    phase: "optional",
    question: "How was load-in and parking?",
    helper: "Gear is heavy. This matters more than people think.",
    render: (d, onChange) => (
      <ChipGroup
        options={PARKING_LABELS}
        value={d.parkingLoadIn}
        fillContainer
        onChange={(v) => onChange({ parkingLoadIn: v })}
        detail={d.parkingLoadInDetail}
        onDetailChange={(v) => onChange({ parkingLoadInDetail: v })}
        detailPlaceholder="e.g. rear loading dock, street only, long carry…"
      />
    ),
  },

  // ── Load-in time window ───────────────────────────────────────────────
  {
    id: "loadIn",
    phase: "optional",
    question: "What were the load-in hours?",
    helper:
      "Earliest you could get in, latest you had to be out. Helps artists plan their day.",
    render: (d, onChange) => (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <FieldLabel optional>Earliest load-in</FieldLabel>
          <input
            type="time"
            aria-label="Earliest load-in time"
            value={d.loadInEarliest}
            onChange={(e) => onChange({ loadInEarliest: e.target.value })}
            style={{ ...INPUT_STYLE, minHeight: 44, fontSize: 16 }}
          />
        </div>
        <div>
          <FieldLabel optional>Latest load-out</FieldLabel>
          <input
            type="time"
            aria-label="Latest load-out time"
            value={d.loadOutLatest}
            onChange={(e) => onChange({ loadOutLatest: e.target.value })}
            style={{ ...INPUT_STYLE, minHeight: 44, fontSize: 16 }}
          />
        </div>
      </div>
    ),
  },

  // ── Security ──────────────────────────────────────────────────────────
  {
    id: "security",
    phase: "optional",
    question: "Was there security?",
    helper: "Good to know for late-night gigs and gear safety.",
    validate: (d) => {
      const hasFrontDoor = !!d.securityFrontDoor;
      const hasLoadIn = !!d.securityLoadIn;
      if (hasFrontDoor !== hasLoadIn) {
        return "Please answer both security questions or leave both blank.";
      }
      return undefined;
    },
    autoAdvance: (d) => !!d.securityFrontDoor && !!d.securityLoadIn,
    render: (d, onChange) => (
      <YStack gap={16}>
        <div>
          <FieldLabel>At the front door</FieldLabel>
          <ChipGroup
            options={SECURITY_LABELS}
            value={d.securityFrontDoor}
            fillContainer
            onChange={(v) => onChange({ securityFrontDoor: v })}
          />
        </div>
        <div>
          <FieldLabel>Near gear / load-in area</FieldLabel>
          <ChipGroup
            options={SECURITY_LABELS}
            value={d.securityLoadIn}
            fillContainer
            onChange={(v) => onChange({ securityLoadIn: v })}
          />
        </div>
      </YStack>
    ),
  },

  // ── Booker ────────────────────────────────────────────────────────────
  {
    id: "booker",
    phase: "optional",
    question: "How was the person who booked you?",
    helper: "Responsive? Professional? Ghosted you after the gig?",
    render: (d, onChange) => (
      <ChipGroup
        options={BOOKER_LABELS}
        value={d.bookerRating}
        fillContainer
        onChange={(v) => onChange({ bookerRating: v })}
        detail={d.bookerRatingDetail}
        onDetailChange={(v) => onChange({ bookerRatingDetail: v })}
        detailPlaceholder="e.g. easy to work with, never replied…"
      />
    ),
  },

  // ── Merch ─────────────────────────────────────────────────────────────
  {
    id: "merch",
    phase: "optional",
    question: "Could you sell merch?",
    render: (d, onChange) => (
      <YStack gap={10}>
        <ChipGroup
          options={MERCH_LABELS}
          value={d.merchAllowed}
          fillContainer
          onChange={(v) => onChange({ merchAllowed: v })}
        />
        <Reveal show={d.merchAllowed === "ALLOWED_WITH_CUT"}>
          <div style={{ paddingTop: 4 }}>
            <FieldLabel helperText="What percentage did the place take?">
              The place&rsquo;s cut
            </FieldLabel>
            <input
              type="number"
              inputMode="numeric"
              enterKeyHint="done"
              min={0}
              max={100}
              aria-label="Merch cut percentage"
              value={d.merchCutPct}
              onChange={(e) => onChange({ merchCutPct: e.target.value })}
              placeholder="e.g. 15"
              style={{ ...INPUT_STYLE, maxWidth: 120 }}
            />
          </div>
        </Reveal>
      </YStack>
    ),
  },

  // ── Staff ─────────────────────────────────────────────────────────────
  {
    id: "staff",
    phase: "optional",
    question: "Did the staff have your back?",
    helper: "Sound tech, bartender, door person — did they help or hinder?",
    render: (d, onChange) => (
      <YStack gap={10}>
        <ChipGroup
          options={STAFF_LABELS}
          value={d.staffSupport}
          fillContainer
          onChange={(v) => onChange({ staffSupport: v })}
        />
        <Reveal show={!!d.staffSupport}>
          <div style={{ paddingTop: 4 }}>
            <CharCountTextarea
              value={d.staffSupportDetail}
              onChange={(v) => onChange({ staffSupportDetail: v })}
              placeholder="e.g. bartender was great, bouncer was a problem…"
              maxLength={MAX.DETAIL}
              height={72}
            />
          </div>
        </Reveal>
      </YStack>
    ),
  },

  // ── Independent ───────────────────────────────────────────────────────
  {
    id: "independent",
    phase: "optional",
    question: "Is this place independently run?",
    helper: "Helps artists find and support indie spots.",
    autoAdvance: true,
    render: (d, onChange) => (
      <ChipGroup
        options={INDEPENDENT_LABELS}
        value={d.independentVenue}
        fillContainer
        onChange={(v) => onChange({ independentVenue: v })}
      />
    ),
  },

  // ── Open comment ──────────────────────────────────────────────────────
  {
    id: "comment",
    phase: "optional",
    question: "Anything else artists should know?",
    helper:
      "The good, the bad, the weird. Your voice matters more than any checkbox.",
    render: (d, onChange) => (
      <CharCountTextarea
        value={d.comment}
        onChange={(v) => onChange({ comment: v })}
        placeholder="Green room vibe, parking tricks, the bartender who saved the night…"
        maxLength={MAX.COMMENT}
        height={120}
      />
    ),
  },
];
