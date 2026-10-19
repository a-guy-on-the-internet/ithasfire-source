/**
 * The builder's "unsaved changes" signal is DERIVED: a snapshot of the
 * edit-form fields now, compared to the snapshot taken when the event
 * loaded or last saved. Nothing stores "dirty".
 *
 * Only fields that ride the Save button are in the snapshot. Ticket types,
 * the lineup and similar sections save through their own controls.
 */
export type BuilderSnapshotFields = {
  title: string;
  startsAt: string | undefined;
  endsAt: string | undefined;
  location: unknown;
  locationMode: string;
  placeId: string | null;
  /** Only an organizer-touched placement is sent, so only that counts. */
  placement: unknown;
  visibilityMode: string;
  visibilityRadius: number | null;
  visibilityLabel: string;
  addressRevealPreset: string;
  addressRevealAt: string;
  eventTimezone: string;
  communityCategoryId: string | null;
  heroStaged: boolean;
  heroRemoved: boolean;
  recurrenceEnabled: boolean;
  recurrenceConfig: unknown;
};

/**
 * Attrs the editor rewrites from the server after load, not from the
 * organiser: `ProseEditor` re-resolves image and audio URLs (presigned, minted
 * fresh on every read) and the audio transcode state, and dispatches those
 * as ordinary transactions, so they reach `onChange`. They are not edits.
 * An image's `src` is only server-synced when it has an `imageId` to resolve.
 */
const SERVER_SYNCED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  imageBlock: ["src"],
  audioBlock: [
    "sourceUrl",
    "hlsPlaylistUrl",
    "status",
    "uploadStartedAt",
    "waveformPeaks",
  ],
};

function canonicalAttrs(
  nodeType: unknown,
  attrs: unknown,
): Record<string, unknown> | undefined {
  if (attrs === null || typeof attrs !== "object" || Array.isArray(attrs)) {
    return undefined;
  }
  const record = attrs as Record<string, unknown>;
  const synced =
    typeof nodeType === "string" ? SERVER_SYNCED_ATTRS[nodeType] : undefined;
  const skipSynced =
    synced !== undefined && (nodeType !== "imageBlock" || Boolean(record.imageId));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    // TipTap fills absent attrs with null defaults; absent and null match.
    if (value === null || value === undefined) continue;
    if (skipSynced && synced?.includes(key)) continue;
    out[key] = canonicalize(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sorted keys, null attrs dropped, server-synced attrs left out. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "attrs") {
      const attrs = canonicalAttrs(record.type, record.attrs);
      if (attrs) out.attrs = attrs;
    } else {
      out[key] = canonicalize(record[key]);
    }
  }
  return out;
}

/**
 * The description body as the dirty check compares it, serialized on its
 * own (it is the largest value, and a title keystroke should not
 * re-serialize it). Canonical: the stored JSON and the editor's output differ
 * in key order and in null defaults, and the editor rewrites server-synced
 * attrs after load (see `SERVER_SYNCED_ATTRS`). None of that is an edit.
 * Only the comparison uses this; Save sends the body as it is.
 */
export function snapshotBody(bodyContent: unknown): string {
  return JSON.stringify(canonicalize(bodyContent ?? null));
}

/**
 * The doc the description editor was last mounted with, and the same doc as
 * the editor normalised it (`ProseEditor`'s `onReady`).
 *
 * TipTap fills defaults into a stored doc when it mounts, and every
 * `onChange` after that emits the normalised shape. `snapshotBody` already
 * ignores null defaults and key order; this covers a default with a value.
 * Compared without it, typing a character and deleting it would leave the
 * body different from its stored form for good.
 */
export type EditorSeed = { raw: string; normalized: string };

/**
 * The body as the dirty check compares it: the editor's normalised form while
 * the body is still exactly the doc the editor was seeded with, the body
 * itself once the editor has emitted an edit.
 */
export function comparableBody(raw: string, seed: EditorSeed | null): string {
  return seed?.raw === raw ? seed.normalized : raw;
}

/**
 * The body baseline once the editor reports its normalised doc. A baseline
 * still holding the raw seed moves to the normalised form; one that was
 * edited or saved since is left alone.
 */
export function rebaseBodyOnEditorSeed(
  bodyBaseline: string | null,
  seed: EditorSeed,
): string | null {
  return bodyBaseline === seed.raw ? seed.normalized : bodyBaseline;
}

export function buildBuilderSnapshot(fields: BuilderSnapshotFields): string {
  return JSON.stringify(fields);
}

/**
 * The fields baseline after a successful save: what the save SENT, taken when
 * it was sent (edits typed while it was in flight stay unsaved), with the
 * staged and removed hero image cleared, because the save consumed both.
 */
export function savedFieldsSnapshot(sent: BuilderSnapshotFields): string {
  return buildBuilderSnapshot({
    ...sent,
    heroStaged: false,
    heroRemoved: false,
  });
}

/**
 * The fields baseline at load. Visibility is the HYDRATED value, not what the
 * form holds now: the place's address ceiling (`clampToCeiling` in the
 * builder) lowers a stored visibility the place no longer allows once its
 * privacy read lands, which can be before or after this baseline is taken.
 * Pinning the stored value makes that clamp read as an unsaved change every
 * time, which is what it is: Save would send a different visibility.
 */
export function loadedFieldsSnapshot(
  fields: BuilderSnapshotFields,
  hydratedVisibility: { mode: string; radius: number | null },
): string {
  return buildBuilderSnapshot({
    ...fields,
    visibilityMode: hydratedVisibility.mode,
    visibilityRadius: hydratedVisibility.radius,
  });
}

/** A form snapshot: the Save-button fields and the body, serialized apart. */
export type BuilderSnapshot = { fields: string; body: string };

/** Dirty = a baseline exists, and the form differs from it. */
export function hasUnsavedChanges(
  baseline: { fields: string | null; body: string | null },
  current: BuilderSnapshot,
): boolean {
  if (baseline.fields === null || baseline.body === null) return false;
  return baseline.fields !== current.fields || baseline.body !== current.body;
}
