// ─────────────────────────────────────────────────────────────────────────────
// The deal's one open form, as plain state (no React), so it can be tested.
//
// Only one small editor (a preset, a clause, the rest, a cost) is open at a
// time. When it opens, it records the deal FINGERPRINT it was opened against;
// every save sends that snapshot as `expectedDealFingerprint`, never the
// fingerprint of whatever read arrived since. So a save can only overwrite
// the deal the form showed.
//
// When the live fingerprint moves past the snapshot while the form is open
// (another admin saved, or our own save was refused as a conflict), the form
// is told it changed and the snapshot moves on: the next save overwrites
// only what is now on screen. A form that edits a saved row (a clause, the
// rest, a cost) is re-seeded from the fresh values. A form for something not
// saved yet (a new clause, a new cost, a preset) keeps what the user typed:
// there is no stored row to re-seed it from, and the fresh deal is drawn
// beside it on the page. When the row that owns the open form disappears,
// or the deal stops being editable, the slot is released.
// ─────────────────────────────────────────────────────────────────────────────

export type FormSlotState = {
  /** The open form's key, or null. */
  key: string | null;
  /** The deal fingerprint the open form's values came from. */
  fingerprint: string | null;
  /** Bumped whenever the open form must remount with fresh values. */
  seed: number;
  /** The form was re-seeded because the deal changed under it. */
  changed: boolean;
  /**
   * The fingerprint our own save replaced, while the read still shows it:
   * between a save landing and its refetch arriving, the live read is one
   * step behind the snapshot, and that is not someone else's change.
   */
  replaced: string | null;
};

export const INITIAL_FORM_SLOT: FormSlotState = {
  key: null,
  fingerprint: null,
  seed: 0,
  changed: false,
  replaced: null,
};

export type FormSlotAction =
  /** Open `key` against the deal as read now. */
  | { type: "open"; key: string; fingerprint: string | null }
  /** Close `key` (or whatever is open, without a key). */
  | { type: "close"; key?: string }
  /** Our own save landed: the deal is now `fingerprint`, as the form shows. */
  | { type: "saved"; fingerprint: string }
  /** The deal changed under the open form: re-seed it from `fingerprint`. */
  | { type: "refreshed"; fingerprint: string | null }
  /** Release the slot when its owner is not among the rendered rows. */
  | { type: "prune"; liveKeys: readonly string[] };

const closed = (state: FormSlotState): FormSlotState => ({
  key: null,
  fingerprint: null,
  seed: state.seed,
  changed: false,
  replaced: null,
});

export function formSlotReducer(
  state: FormSlotState,
  action: FormSlotAction,
): FormSlotState {
  switch (action.type) {
    case "open":
      return {
        key: action.key,
        fingerprint: action.fingerprint,
        seed: state.seed + 1,
        changed: false,
        replaced: null,
      };
    case "close":
      if (action.key !== undefined && action.key !== state.key) return state;
      return state.key === null ? state : closed(state);
    case "saved":
      return state.key === null
        ? state
        : {
            ...state,
            fingerprint: action.fingerprint,
            replaced: state.fingerprint,
          };
    case "refreshed":
      if (state.key === null) return state;
      return {
        ...state,
        fingerprint: action.fingerprint,
        // A form for something not saved yet keeps its fields (same seed, so
        // it does not remount); a saved row's form remounts with fresh values.
        seed: keepsInputOnChange(state.key) ? state.seed : state.seed + 1,
        changed: true,
        replaced: null,
      };
    case "prune":
      return releasedKey(state, action.liveKeys) === null
        ? state
        : closed(state);
  }
}

/**
 * The live deal moved past the open form's snapshot. `live` is undefined
 * while no read has settled: unknown is never "changed". Nor is the read
 * still showing the deal our own save just replaced.
 */
export function isStale(
  state: FormSlotState,
  live: string | null | undefined,
): boolean {
  if (state.key === null || live === undefined) return false;
  if (state.replaced !== null && live === state.replaced) return false;
  return state.fingerprint !== live;
}

/** What a save sends as `expectedDealFingerprint`. */
export function expectedFingerprint(
  state: FormSlotState,
  live: string | null | undefined,
): string | null {
  return state.key !== null ? state.fingerprint : (live ?? null);
}

/** The open key, when nothing rendered owns it any more; else null. */
export function releasedKey(
  state: FormSlotState,
  liveKeys: readonly string[],
): string | null {
  return state.key !== null && !liveKeys.includes(state.key) ? state.key : null;
}

/**
 * A cost form's key: the deduction's id, so removing an earlier cost never
 * moves an open form onto a different one. "new" for a cost not yet saved.
 */
export function costFormKey(
  sectionTestId: string,
  deductionId: string | null | undefined,
): string {
  return `cost:${sectionTestId}:${deductionId ?? "new"}`;
}

/** A preset's form key (the preset picker's buttons). */
export function presetFormKey(testIdBase: string, preset: string): string {
  return `preset:${testIdBase}-presets:${preset}`;
}

/**
 * A form for something the deal does not hold yet: a new clause, a new cost,
 * a preset. Its values are the user's alone, so a change to the deal under it
 * keeps them instead of re-seeding (see the file header).
 */
export function keepsInputOnChange(key: string): boolean {
  if (key.startsWith("preset:")) return true;
  if (key.startsWith("cost:")) return key.endsWith(":new");
  return key.startsWith("clause:") && key.includes("-clause-new-");
}

/**
 * The form keys still live when the read is not a deal: the empty state
 * (no deal yet) draws only the preset picker; a booking-owned deal, a refusal
 * or a failed read draws no form at all. Anything else open is released.
 */
export function liveKeysWithoutDeal(
  outcome: "NO_DEAL" | "OWNED_BY_BOOKING" | "NO_TERMS" | "NOT_ALLOWED" | "ERROR",
  testIdBase: string,
  presets: readonly string[],
  editable: boolean,
): string[] {
  if (outcome !== "NO_DEAL" || !editable) return [];
  return presets.map((p) => presetFormKey(testIdBase, p));
}

/** Which section a released form lived in: where focus goes when it closes. */
export function sectionOfKey(key: string): "clauses" | "costs" | "presets" {
  if (key.startsWith("cost:")) return "costs";
  if (key.startsWith("preset:")) return "presets";
  return "clauses";
}
