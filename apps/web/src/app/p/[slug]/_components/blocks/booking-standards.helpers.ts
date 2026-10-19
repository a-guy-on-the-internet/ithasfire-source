/**
 * Pure helpers for the booking-request form's "What {place} expects" rail and
 * the per-field markers (venue-booking-standards spec, FR-005 / FR-010,
 * boards S1 + S2 combined, T1).
 *
 * THE RULE IS CORE'S. "Is this field satisfied?" and "which REQUIRED items are
 * unmet?" come from core's client-safe leaves — `standard-fields.ts`
 * (`isFieldSatisfied`, the field catalogue) and `resolve-booking-standards.ts`
 * (`unmetRequiredStandards`, the exact function the server's STANDARDS_UNMET
 * gate runs). Both leaves have type-only imports (a core test pins that), so
 * importing them here ships no zod / sanitize-html to the browser. Nothing in
 * this file re-implements either rule; it only shapes their answers for the
 * rail, and a test runs both sides over the same inputs.
 *
 * The payload these helpers evaluate is the BUILT payload's shape (contract 1
 * in standard-fields.ts): `pitchStandardsPayload` / `spaceStandardsPayload`
 * in `request-to-play-form.helpers.ts` produce it live, field by field, and
 * the submit gate re-runs the check over the real builder's output.
 */

import {
  unmetRequiredStandards,
  type EffectiveBookingPitchExample,
  type EffectiveBookingStandard,
} from "@th/core/use-cases/booking-standards/resolve-booking-standards";
import {
  fieldAppliesToIntent,
  fieldCanBeRequired,
  isFieldSatisfied,
  isKnownBookingStandardField,
  type BookingStandardsPayload,
} from "@th/core/use-cases/booking-standards/standard-fields";
import type { BookingIntent } from "@th/types/repos/booking-requests";
import type { BookingStandardField } from "@th/types/repos/booking-standards";

export type { BookingStandardField, BookingStandardsPayload };

/** One (calendar, intent)'s resolved list as `places.getBookingOptions` sends it. */
export type BookingStandardsList = {
  standards: EffectiveBookingStandard[];
  examples: EffectiveBookingPitchExample[];
};

/** Intent-keyed; an intent the calendar does not take is absent. */
export type BookingStandardsByIntent = Partial<
  Record<BookingIntent, BookingStandardsList>
>;

/**
 * The list the form shows for `intent`, routed the way the server routes the
 * request: the chosen calendar's own resolved list, else (no calendar — a
 * pre-hierarchy place, or a double that predates FR-004) the place-wide list
 * the create gate holds an unrouted request to. Null when neither carries one.
 */
export function resolveStandardsList(args: {
  calendar: { standards?: BookingStandardsByIntent } | null | undefined;
  placeStandards: BookingStandardsByIntent | null | undefined;
  intent: BookingIntent;
}): BookingStandardsList | null {
  const { calendar, placeStandards, intent } = args;
  return calendar?.standards?.[intent] ?? placeStandards?.[intent] ?? null;
}

/** Renders a platform i18n key; place entries never pass through it. */
export type StandardsTranslate = (key: string) => string;

/** A KNOWN field the form has: it gets a tick, a marker and a line. */
export type StandardsChecklistItem = {
  field: BookingStandardField;
  /** The place's wording (or the platform copy, rendered). */
  label: string;
  hint: string | null;
  /** REQUIRED as the server enforces it: place-set, and a field that can be. */
  required: boolean;
  satisfied: boolean;
};

/** A CUSTOM line (V6): guidance only, never counted, never blocking. */
export type StandardsCustomLine = { label: string; hint: string | null };

export type StandardsExample = {
  /** Stable within one list (examples have no id on the wire). */
  key: string;
  source: "place" | "platform";
  title: string;
  body: string;
};

export type StandardsChecklist = {
  items: StandardsChecklistItem[];
  customLines: StandardsCustomLine[];
  /** Satisfied known items. */
  done: number;
  /** Known items (required + suggested). Custom lines never count (FR-005). */
  total: number;
  /** Items whose REQUIRED-ness blocks Send right now (V1). */
  unmetRequired: StandardsChecklistItem[];
  /** Place examples first, then the platform's — the wire's own order. */
  examples: StandardsExample[];
};

function standardText(
  standard: EffectiveBookingStandard,
  translate: StandardsTranslate,
): { label: string; hint: string | null } {
  if (standard.source === "platform") {
    return {
      label: translate(standard.labelKey),
      hint: standard.hintKey ? translate(standard.hintKey) : null,
    };
  }
  return { label: standard.label, hint: standard.hint };
}

/**
 * Whether the server would treat `standard` as REQUIRED — the same three
 * conditions `unmetRequiredStandards` filters on, minus "unsatisfied".
 */
function isEnforcedRequired(standard: EffectiveBookingStandard): boolean {
  return (
    standard.source !== "platform" &&
    standard.requirement === "REQUIRED" &&
    fieldCanBeRequired(standard.field)
  );
}

/**
 * The rail's model for one list and one payload.
 *
 * - Unknown fields (a newer API) and fields this intent's form lacks are
 *   dropped: they would render a tick nobody can earn. The resolver already
 *   drops the latter; this is the client's own guard.
 * - A field listed twice keeps its first entry.
 * - `unmetRequired` is core's `unmetRequiredStandards` over the same list
 *   and payload, mapped onto the items — so the rail, the inline errors and
 *   the server can only disagree if they were fed different payloads.
 */
export function buildStandardsChecklist(args: {
  list: BookingStandardsList;
  intent: BookingIntent;
  payload: BookingStandardsPayload;
  translate: StandardsTranslate;
}): StandardsChecklist {
  const { list, intent, payload, translate } = args;
  const items: StandardsChecklistItem[] = [];
  const customLines: StandardsCustomLine[] = [];
  const seen = new Set<BookingStandardField>();

  for (const standard of list.standards) {
    if (!isKnownBookingStandardField(standard.field)) continue;
    if (!fieldAppliesToIntent(standard.field, intent)) continue;
    const text = standardText(standard, translate);
    if (standard.field === "CUSTOM") {
      if (text.label.trim().length > 0) customLines.push(text);
      continue;
    }
    if (seen.has(standard.field)) continue;
    seen.add(standard.field);
    items.push({
      field: standard.field,
      label: text.label,
      hint: text.hint,
      required: isEnforcedRequired(standard),
      satisfied: isFieldSatisfied(standard.field, payload),
    });
  }

  const unmetFields = new Set(
    unmetRequiredStandards(list.standards, payload).map((s) => s.field),
  );
  const unmetRequired = items.filter(
    (item) => item.required && unmetFields.has(item.field),
  );

  const examples: StandardsExample[] = list.examples.map((example, index) =>
    example.source === "platform"
      ? {
          key: `platform-${index}`,
          source: "platform",
          title: translate(example.titleKey),
          body: translate(example.bodyKey),
        }
      : {
          key: `place-${index}`,
          source: "place",
          title: example.title,
          body: example.body,
        },
  );

  return {
    items,
    customLines,
    done: items.filter((item) => item.satisfied).length,
    total: items.length,
    unmetRequired,
    examples,
  };
}

/**
 * The REQUIRED items a BUILT payload leaves unmet — the submit gate (V1).
 * Core's function, the server's function; the list is the same one the rail
 * renders.
 */
export function unmetRequiredFields(
  list: BookingStandardsList | null,
  payload: BookingStandardsPayload,
): BookingStandardField[] {
  if (!list) return [];
  return unmetRequiredStandards(list.standards, payload).map((s) => s.field);
}

/**
 * A place label as it sits inside a sentence ending in a period: "A link to
 * your music." — never "…music..".
 */
export function labelForSentence(label: string): string {
  return label.trim().replace(/[.!?。]+$/u, "");
}

/* ── Pitch outline (FR-010, board T1) ─────────────────────────────────────── */

/**
 * One bracketed prompt: "[Who you are, in a line]". Single line, no nested
 * brackets, at least one non-space character inside.
 */
const OUTLINE_BRACKET_RE = /\[[^\][\n]*[^\][\n\s][^\][\n]*\]/g;

/**
 * How many bracketed prompts are still in the message — the live "5 brackets
 * left" hint. A HINT: it never blocks Send, and the server knows nothing
 * about outlines (a pitch still holding prompts is sent as written).
 */
export function countOutlineBrackets(message: string): number {
  return message.match(OUTLINE_BRACKET_RE)?.length ?? 0;
}

/**
 * The selection range of the first prompt in `message`, so the reader can type
 * straight over it after the outline drops in. Null when none is left.
 */
export function firstOutlineBracketRange(
  message: string,
): { start: number; end: number } | null {
  const match = new RegExp(OUTLINE_BRACKET_RE.source).exec(message);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** "Start from an outline" shows only while the message is empty (FR-010). */
export function shouldOfferOutline(message: string): boolean {
  return message.trim().length === 0;
}

/** The outline text as the catalog holds it, normalised to one prompt per line. */
export function normaliseOutline(outline: string): string {
  return outline
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
