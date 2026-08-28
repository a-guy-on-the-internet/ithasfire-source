/**
 * What (if anything) goes BELOW the fold of a result state — decided once,
 * purely, and consumed by both the panel and the "⌄ MORE" affordance.
 *
 * ## Why this is a module and not two `if`s in a component
 *
 * It was two `if`s in a component, and they disagreed. `ToneResultState`
 * derived "is there detail?" from `!!children` while the host passed a
 * `<ResultDetail/>` element unconditionally and let that component return
 * `null`. A React element is truthy whether or not it renders anything, so the
 * affordance was permanently on: a `surface`-coloured band and a 44pt
 * "⌄ MORE" row appeared on INVALID, REFUNDED, VOID, LISTED, UNREADABLE,
 * NO MATCH, TAMPERED, WRONG SHOW, NEEDS SIGNAL and CAN'T VERIFY — ten of the
 * eleven states — cutting a cream stripe into the full-bleed fill and pointing
 * at nothing.
 *
 * The fix is not "remember to keep the two in sync". It is one exported
 * predicate that the host evaluates ONCE and hands to both consumers, so
 * there is no second copy to drift.
 *
 * PURE. No `expo-*`, no `react-native` — same testability split as
 * `offline-resolve.ts` vs `offline-scan-fallback.ts`.
 */

export type ResultDetailInput = {
  /** Result discriminator (`ticket` | `volunteer` | `wrong_event` | …). */
  kind: string;
  /** True for exactly one outcome: a ticket whose status is literally VALID. */
  admittable: boolean;
  /**
   * Whether the STATE carries the primary action itself. False on the scan
   * screen (the control rail owns ADMIT / CHECK IN — FR-007), true for an
   * `inline` host such as the manual-search screen, which has no rail.
   */
  showAdmitAction: boolean;
  /** `result.status` for tickets; ignored otherwise. */
  status?: string | null;
  /** Pre-formatted local time of a prior scan, or null when there is none. */
  scannedAtLabel?: string | null;
  /** Other VALID tickets on the same order (local manifest read). */
  sameOrderCount?: number;
  /** False when the host wired no bulk-admit handler. */
  canBulkAdmit?: boolean;
  /** `alsoVolunteering` candidates carried on a ticket result. */
  alsoVolunteeringCount?: number;
};

export type ResultDetailPlan = {
  /**
   * The ONE answer. `ToneResultState` renders its detail band and its
   * "⌄ MORE" affordance if and only if this is true.
   */
  hasDetail: boolean;
  /** Render the in-panel ADMIT button (inline hosts only). */
  showAdmitAction: boolean;
  /** Render "Already scanned at <time>". */
  showScanHistory: boolean;
  /** Render the same-order bulk block; 0 means no block. */
  bulkCount: number;
  /** Render the "Also volunteering" block; 0 means no block. */
  alsoVolunteeringCount: number;
};

const EMPTY: ResultDetailPlan = {
  hasDetail: false,
  showAdmitAction: false,
  showScanHistory: false,
  bulkCount: 0,
  alsoVolunteeringCount: 0,
};

export function planResultDetail(input: ResultDetailInput): ResultDetailPlan {
  /**
   * A volunteer result ALWAYS has detail: the candidate row (role, shift,
   * scan-window note, check-in time), any `alsoHoldsTicket` rows, and — on an
   * inline host — the check-in action itself. Even the empty case renders
   * "No eligible signups for this event.", which is information the operator
   * needs and cannot get anywhere else on the screen.
   */
  if (input.kind === "volunteer") {
    return {
      ...EMPTY,
      hasDetail: true,
      showAdmitAction: input.showAdmitAction,
    };
  }

  if (input.kind !== "ticket") return EMPTY;

  const showAdmitAction = input.showAdmitAction && input.admittable;
  const bulkCount =
    input.admittable && input.canBulkAdmit ? (input.sameOrderCount ?? 0) : 0;
  const alsoVolunteeringCount = input.alsoVolunteeringCount ?? 0;
  const showScanHistory = input.status === "SCANNED" && !!input.scannedAtLabel;

  return {
    hasDetail:
      showAdmitAction ||
      bulkCount > 0 ||
      alsoVolunteeringCount > 0 ||
      showScanHistory,
    showAdmitAction,
    showScanHistory,
    bulkCount,
    alsoVolunteeringCount,
  };
}
