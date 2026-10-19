import { nanoid } from "nanoid";

import type { ProseMirrorDoc } from "@th/schema";

import {
  toDateTimeLocalValue,
  toIsoInTimeZone,
} from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";

/**
 * Pure validation + diff assembly for the public propose-mode edit surface
 * (community-managed-event-listings spec FR-006/FR-007). The form initializes
 * from `eventSuggestions.getBaseForEvent` and submits ONLY the fields whose
 * normalized value differs from that base — an untouched form produces an
 * empty diff and the submit action stays disabled (the server also rejects
 * empty diffs with EDIT_SUGGESTION_INVALID_FIELDS).
 *
 * Comparison rules mirror the server's conflict semantics
 * (core `suggestion-fields.ts`):
 * - startsAt/endsAt compare by UTC instant (the datetime-local inputs are
 *   wall-clock values in the SELECTED timezone, so a timezone change alone
 *   moves the instants and legitimately produces a schedule diff).
 * - `content` compares the extracted rich-text doc by structural JSON
 *   equality (the rebuilt EventBody envelope always differs — fresh block
 *   ids — so the DOC is the unit of change, mirroring how the owned builder
 *   round-trips body content).
 * - The address + geo fields travel as ONE group (a venue move is a single
 *   semantic change; the server conflict-checks the group as a whole).
 *
 * Kept free of React (and of the TipTap-heavy prose-utils module) so it can
 * be unit-tested directly.
 */

export type ProposeGeo = {
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
};

/** Whitelisted current values returned by `getBaseForEvent` (`base`). */
export type ProposeBaseFields = {
  title: string;
  content: unknown;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  addressText: string | null;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  categoryId: string | null;
  heroImageId: string | null;
  ageLimit: number | null;
};

export type ProposeEditsFormValues = {
  title: string;
  /** `datetime-local` strings ("YYYY-MM-DDTHH:mm") in `timezone`. */
  startsAtLocal: string;
  endsAtLocal: string;
  /** IANA timezone id the local datetimes are interpreted in. */
  timezone: string;
  /** Freeform address text as shown in the input. */
  addressText: string;
  /**
   * Geocode of a freshly picked autocomplete suggestion, or null. Typing in
   * the address input clears it (the text and the pin must never drift), so
   * non-null means "the user picked a place this session".
   */
  geo: ProposeGeo | null;
  /** Category id, or "" for none. */
  categoryId: string;
  /** Raw age-limit input ("" = not set). */
  ageLimitRaw: string;
  /** Current editor doc (never null — an empty doc when blank). */
  bodyDoc: ProseMirrorDoc;
  /** Currently selected hero image id (attached or freshly uploaded). */
  heroImageId: string | null;
};

export type ProposeErrorKey =
  | "titleRequired"
  | "startsRequired"
  | "endsRequired"
  | "endsBeforeStarts"
  | "locationPickRequired"
  | "countryMissing"
  | "ageLimitInvalid";

export type ProposeFieldErrors = Partial<
  Record<
    "title" | "startsAt" | "endsAt" | "location" | "ageLimit",
    ProposeErrorKey
  >
>;

export type ProposeDiffResult = {
  errors: ProposeFieldErrors;
  /**
   * The whitelisted field diff to submit — ONLY changed fields, in the exact
   * shape `eventSuggestions.submit` accepts. Empty object = nothing changed.
   * Fields with a validation error contribute no diff entry.
   */
  fields: Record<string, unknown>;
};

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;
const AGE_LIMIT_RE = /^\d{1,2}$/;

/** Structural deep-equality for JSON-shaped values (docs, EventBody). */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => jsonDeepEqual(item, b[index]));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null
  ) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    // Keys with undefined values are treated as absent (Json round-trips
    // drop them anyway — mirrors the server's deepEqual).
    const aKeys = Object.keys(aRecord).filter(
      (key) => aRecord[key] !== undefined,
    );
    const bKeys = Object.keys(bRecord).filter(
      (key) => bRecord[key] !== undefined,
    );
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => jsonDeepEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

/** True when the doc has no meaningful content (blank or empty paragraphs). */
export function isEmptyRichTextDoc(doc: ProseMirrorDoc | null): boolean {
  if (!doc || typeof doc !== "object") return true;
  const content = (doc as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return true;
  return content.every((node) => {
    if (!node || typeof node !== "object") return true;
    const record = node as { type?: unknown; content?: unknown };
    if (record.type !== "paragraph") return false;
    return !Array.isArray(record.content) || record.content.length === 0;
  });
}

/**
 * Extract the first rich-text doc from an EventBody Json — mirrors the owned
 * EventBuilder's load path (v1 sections first, then the legacy flat-blocks
 * shape). Null when the body has no rich-text block.
 */
export function extractRichTextDoc(content: unknown): ProseMirrorDoc | null {
  if (!content || typeof content !== "object") return null;
  const body = content as Record<string, unknown>;

  if (Array.isArray(body.sections)) {
    for (const section of body.sections) {
      if (!section || typeof section !== "object") continue;
      const layout = (section as Record<string, unknown>).layout;
      if (!layout || typeof layout !== "object") continue;
      const columns = (layout as Record<string, unknown>).columns;
      if (!Array.isArray(columns)) continue;
      for (const column of columns) {
        if (!column || typeof column !== "object") continue;
        const blocks = (column as Record<string, unknown>).blocks;
        const doc = findRichTextDoc(blocks);
        if (doc) return doc;
      }
    }
    return null;
  }

  return findRichTextDoc(body.blocks);
}

function findRichTextDoc(blocks: unknown): ProseMirrorDoc | null {
  if (!Array.isArray(blocks)) return null;
  const rtBlock = blocks.find(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "richText",
  );
  if (rtBlock && typeof rtBlock === "object" && "doc" in rtBlock) {
    return (rtBlock as { doc: ProseMirrorDoc }).doc ?? null;
  }
  return null;
}

/**
 * Rebuild the full EventBody with the edited doc swapped into the block the
 * base doc came from, PRESERVING every other block (images, embeds) and the
 * body envelope — a text-only edit must never destroy sibling blocks. When
 * the base has no body (or no rich-text block to replace), a fresh
 * single-richText legacy body is produced (the same shape the owned builder
 * and the community-listing create form emit).
 */
export function buildProposedContent(
  baseContent: unknown,
  doc: ProseMirrorDoc,
): unknown {
  if (baseContent && typeof baseContent === "object") {
    const clone = JSON.parse(JSON.stringify(baseContent)) as Record<
      string,
      unknown
    >;

    if (Array.isArray(clone.sections)) {
      for (const section of clone.sections) {
        if (!section || typeof section !== "object") continue;
        const layout = (section as Record<string, unknown>).layout;
        if (!layout || typeof layout !== "object") continue;
        const columns = (layout as Record<string, unknown>).columns;
        if (!Array.isArray(columns)) continue;
        for (const column of columns) {
          if (!column || typeof column !== "object") continue;
          const blocks = (column as Record<string, unknown>).blocks;
          if (replaceRichTextDoc(blocks, doc)) return clone;
        }
      }
      // v1 body without a rich-text block: APPEND a fresh one into the first
      // section's first column, preserving the envelope and every sibling
      // block (images/embeds) — falling back to a fresh legacy body here
      // would silently destroy them.
      if (appendRichTextToFirstColumn(clone.sections, doc)) return clone;
      // No usable section/column to append into — fall through to a fresh
      // body rather than guessing at the layout shape.
    } else if (Array.isArray(clone.blocks)) {
      if (replaceRichTextDoc(clone.blocks, doc)) return clone;
      clone.blocks = [
        ...clone.blocks,
        { id: nanoid(), type: "richText", doc },
      ];
      return clone;
    }
  }

  return {
    layoutId: "default",
    blocks: [{ id: nanoid(), type: "richText", doc }],
  };
}

/**
 * Append a new richText block to the FIRST section's FIRST column (mutating
 * the passed clone). Returns false when no section exposes a usable
 * `layout.columns[0].blocks` array.
 */
function appendRichTextToFirstColumn(
  sections: unknown[],
  doc: ProseMirrorDoc,
): boolean {
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const layout = (section as Record<string, unknown>).layout;
    if (!layout || typeof layout !== "object") continue;
    const columns = (layout as Record<string, unknown>).columns;
    if (!Array.isArray(columns)) continue;
    for (const column of columns) {
      if (!column || typeof column !== "object") continue;
      const columnRecord = column as Record<string, unknown>;
      if (!Array.isArray(columnRecord.blocks)) continue;
      columnRecord.blocks = [
        ...columnRecord.blocks,
        { id: nanoid(), type: "richText", doc },
      ];
      return true;
    }
  }
  return false;
}

function replaceRichTextDoc(blocks: unknown, doc: ProseMirrorDoc): boolean {
  if (!Array.isArray(blocks)) return false;
  const rtBlock = blocks.find(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "richText",
  );
  if (!rtBlock) return false;
  (rtBlock as Record<string, unknown>).doc = doc;
  return true;
}

function instant(value: string): number {
  return Date.parse(value);
}

/**
 * Validate the propose form against its base and assemble the changed-fields
 * diff. See the module doc for comparison semantics.
 */
export function computeProposeDiff(
  base: ProposeBaseFields,
  values: ProposeEditsFormValues,
  /**
   * The body-diff baseline. The ProseEditor (TipTap) NORMALIZES its doc on
   * mount (fills default attrs like `textAlign: null`, rebuilds the envelope),
   * so `values.bodyDoc` never structurally equals the RAW stored
   * `base.content` even when the user never touched the editor — diffing
   * against the raw doc would flag `content` changed on every submission.
   *
   * The form therefore captures the editor's FIRST emitted (mount-normalized)
   * doc and passes it here as the baseline: an untouched body compares equal
   * to it and produces no diff, while a genuine edit still differs. When
   * `undefined` (the editor hasn't emitted yet, or in unit tests that exercise
   * the raw-doc path), the baseline falls back to the doc extracted from
   * `base.content`. The rebuild + empty-body semantics are unchanged; only the
   * "did the doc change?" comparison uses this normalized baseline.
   */
  baseBodyDocOverride?: ProseMirrorDoc,
): ProposeDiffResult {
  const errors: ProposeFieldErrors = {};
  const fields: Record<string, unknown> = {};

  // ── title ────────────────────────────────────────────────────────────────
  const title = values.title.trim();
  if (!title) {
    errors.title = "titleRequired";
  } else if (title !== base.title) {
    fields.title = title;
  }

  // ── schedule (startsAt / endsAt / timezone) ──────────────────────────────
  if (!values.startsAtLocal) {
    errors.startsAt = "startsRequired";
  }
  if (!values.endsAtLocal) {
    // endsAt cannot be CLEARED by a suggestion (non-nullable in the
    // whitelist schema) — emptying the field on an event that has one is an
    // error, while an event without an end simply stays end-less.
    if (base.endsAt !== null) {
      errors.endsAt = "endsRequired";
    }
  } else if (
    values.startsAtLocal &&
    // Equal-length "YYYY-MM-DDTHH:mm" strings compare chronologically.
    values.endsAtLocal <= values.startsAtLocal
  ) {
    errors.endsAt = "endsBeforeStarts";
  }

  // UNTOUCHED short-circuit, string level: a `datetime-local` string carries
  // no offset, so a wall clock inside a fall-back's repeated hour names two
  // instants and `toIsoInTimeZone` has to pick one (the earlier). Instant math
  // alone would therefore emit a phantom ±1h schedule diff from an untouched
  // form. When the timezone is unchanged and the local input string still
  // equals the base instant rendered into that timezone, the bound is
  // untouched BY CONSTRUCTION — never diff it.
  //
  // Until 2026-08-11 this guard also covered a much wider window:
  // `toIsoInTimeZone` probed the zone once and was an hour wrong for ANY
  // reading on the far side of a transition. That is fixed at the source (it
  // now brackets the transition), so this is back to guarding only the
  // irreducible ambiguous hour. Keep it: the ambiguity is a property of the
  // wire format and cannot be resolved downstream.
  const startsUntouched =
    values.timezone === base.timezone &&
    values.startsAtLocal === toDateTimeLocalValue(base.startsAt, base.timezone);
  const endsUntouched =
    values.timezone === base.timezone &&
    (base.endsAt === null
      ? values.endsAtLocal === ""
      : values.endsAtLocal ===
        toDateTimeLocalValue(base.endsAt, base.timezone));

  if (!errors.startsAt && values.startsAtLocal && !startsUntouched) {
    const startsIso = toIsoInTimeZone(values.startsAtLocal, values.timezone);
    if (instant(startsIso) !== instant(base.startsAt)) {
      fields.startsAt = startsIso;
    }
  }
  if (!errors.endsAt && values.endsAtLocal && !endsUntouched) {
    const endsIso = toIsoInTimeZone(values.endsAtLocal, values.timezone);
    if (base.endsAt === null || instant(endsIso) !== instant(base.endsAt)) {
      fields.endsAt = endsIso;
    }
  }
  if (values.timezone !== base.timezone) {
    fields.timezone = values.timezone;
  }

  // ── location (address + geo travel as ONE group) ─────────────────────────
  const addressText = values.addressText.trim();
  const baseAddressText = base.addressText ?? "";
  if (values.geo) {
    const geo = values.geo;
    if (!geo.countryCode || !COUNTRY_CODE_RE.test(geo.countryCode)) {
      errors.location = "countryMissing";
    } else {
      const proposedGeo = {
        addressText: addressText || null,
        countryCode: geo.countryCode.toUpperCase(),
        region: geo.region?.trim() || null,
        locality: geo.locality?.trim() || null,
        postalCode: geo.postalCode?.trim() || null,
        lat: geo.lat,
        lng: geo.lng,
      };
      const unchanged =
        proposedGeo.addressText === base.addressText &&
        proposedGeo.countryCode === base.countryCode &&
        proposedGeo.region === base.region &&
        proposedGeo.locality === base.locality &&
        proposedGeo.postalCode === base.postalCode &&
        proposedGeo.lat === base.lat &&
        proposedGeo.lng === base.lng;
      if (!unchanged) {
        Object.assign(fields, proposedGeo);
      }
    }
  } else if (addressText !== baseAddressText) {
    // Typed but never picked a suggestion — the text and the pin would
    // drift apart, so a fresh pick is required to propose a move.
    errors.location = "locationPickRequired";
  }

  // ── category ─────────────────────────────────────────────────────────────
  const categoryId = values.categoryId || null;
  if (categoryId !== base.categoryId) {
    fields.categoryId = categoryId;
  }

  // ── age limit ────────────────────────────────────────────────────────────
  const ageRaw = values.ageLimitRaw.trim();
  if (ageRaw && !AGE_LIMIT_RE.test(ageRaw)) {
    errors.ageLimit = "ageLimitInvalid";
  } else {
    const ageLimit = ageRaw ? Number.parseInt(ageRaw, 10) : null;
    if (ageLimit !== base.ageLimit) {
      fields.ageLimit = ageLimit;
    }
  }

  // ── body content ─────────────────────────────────────────────────────────
  // Diff against the mount-normalized baseline when the editor has supplied
  // one (see `baseBodyDocOverride`); otherwise fall back to the raw stored doc.
  // The rebuild still swaps into `base.content` so sibling image/embed blocks
  // and the body envelope are preserved.
  const baseDoc =
    baseBodyDocOverride !== undefined
      ? baseBodyDocOverride
      : extractRichTextDoc(base.content);
  const baseEmpty = baseDoc === null || isEmptyRichTextDoc(baseDoc);
  const nextEmpty = isEmptyRichTextDoc(values.bodyDoc);
  const docChanged =
    baseDoc === null
      ? !nextEmpty
      : baseEmpty && nextEmpty
        ? false
        : !jsonDeepEqual(baseDoc, values.bodyDoc);
  if (docChanged) {
    fields.content = buildProposedContent(base.content, values.bodyDoc);
  }

  // ── hero image ───────────────────────────────────────────────────────────
  if (values.heroImageId !== base.heroImageId) {
    fields.heroImageId = values.heroImageId;
  }

  return { errors, fields };
}
