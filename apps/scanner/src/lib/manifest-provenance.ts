/**
 * FR-001 — the offline provenance badge's label (design §3).
 *
 * PURE, so the wording ladder can be asserted at every threshold instead of
 * being discovered at a door.
 *
 * ## The invariant the badge exists for
 *
 * It appears on EVERY offline-resolved state — including wrong-event-resolved-
 * locally and "can't verify offline". A result with no chip is a server
 * result. That is the badge's whole value: the operator never has to wonder
 * which kind of answer they are looking at.
 *
 * ## Relative, until relative stops meaning anything
 *
 * `31 hr old` is noise; the DATE is the decision, because a manifest from
 * yesterday means the wrong door. So at 24h the wording switches to an
 * absolute local timestamp AND the chip escalates to the inverted style. One
 * escalation step, tied to one threshold, so it means something when it fires.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

export type ManifestProvenanceLabel = {
  /** The visual string — a telegram, e.g. `OFFLINE · 7 MIN OLD`. */
  text: string;
  /**
   * `inverted` only at ≥24h / unknown age. See the docblock: one escalation,
   * one threshold.
   */
  variant: "outlined" | "inverted";
  /** Screen-reader SENTENCE. Read first, because it qualifies the verdict. */
  announce: string;
};

const localStamp = (epochMs: number): string => {
  const d = new Date(epochMs);
  const month = MONTHS[d.getMonth()] ?? "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${d.getDate()}, ${hh}:${mm}`;
};

export function formatManifestProvenance(args: {
  /** `provenance.manifestAgeMs` — null when the age is unknown. */
  ageMs: number | null;
  /** `provenance.manifestSyncedAt` — epoch ms, null when unknown. */
  syncedAt: number | null;
  /**
   * FR-004. When true the chip appends `· CONFIRM MANUALLY`, which is the
   * VISIBLE half of the 10-minute staleness gate — without it the operator
   * just notices that express "randomly stopped working". Wired in build
   * step 4; the formatter owns the wording either way.
   */
  confirmManually?: boolean;
}): ManifestProvenanceLabel {
  const { ageMs, syncedAt } = args;

  const base: {
    text: string;
    variant: "outlined" | "inverted";
    spoken: string;
  } =
    ageMs === null || ageMs >= DAY_MS
      ? syncedAt === null
        ? {
            text: "OFFLINE · SYNC UNKNOWN",
            variant: "inverted",
            spoken: "Local manifest sync time unknown.",
          }
        : {
            text: `OFFLINE · SYNCED ${localStamp(syncedAt)}`,
            variant: "inverted",
            spoken: `Local manifest synced ${localStamp(syncedAt)}.`,
          }
      : ageMs < MINUTE_MS
        ? {
            // "0 min old" reads as broken.
            text: "OFFLINE · JUST SYNCED",
            variant: "outlined",
            spoken: "Local manifest synced just now.",
          }
        : ageMs < HOUR_MS
          ? (() => {
              const mins = Math.floor(ageMs / MINUTE_MS);
              return {
                text: `OFFLINE · ${mins} MIN OLD`,
                variant: "outlined" as const,
                spoken: `Local manifest synced ${mins} minute${mins === 1 ? "" : "s"} ago.`,
              };
            })()
          : (() => {
              const hrs = Math.floor(ageMs / HOUR_MS);
              return {
                text: `OFFLINE · ${hrs} HR OLD`,
                variant: "outlined" as const,
                spoken: `Local manifest synced ${hrs} hour${hrs === 1 ? "" : "s"} ago.`,
              };
            })();

  const text = args.confirmManually
    ? `${base.text} · CONFIRM MANUALLY`
    : base.text;

  return {
    text,
    variant: base.variant,
    // Provenance FIRST — it qualifies everything after it.
    announce: `Offline result. ${base.spoken}`,
  };
}
