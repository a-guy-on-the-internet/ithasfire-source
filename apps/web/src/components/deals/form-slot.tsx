"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from "react";

import { Info } from "lucide-react";

import {
  INITIAL_FORM_SLOT,
  type FormSlotAction,
  type FormSlotState,
} from "./deal-form-state";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// One form open at a time, and where focus goes around it.
//
// The deal has several small editors (a preset, a clause, the rest, a cost).
// Only one is open at once, so the page never shows several bare Save /
// Cancel buttons; while one is open, the buttons that open the others are
// disabled. The state itself (and the fingerprint snapshot each form is
// opened against) is the pure reducer in `deal-form-state.ts`, owned by
// `DealEditor`; this file hands it to the rows and moves focus around it.
// ─────────────────────────────────────────────────────────────────────────────

type Slot = {
  state: FormSlotState;
  dispatch: Dispatch<FormSlotAction>;
  /** The deal's fingerprint as last read: what a form opening snapshots. */
  liveFingerprint: string | null;
};

const DealFormSlot = createContext<Slot>({
  state: INITIAL_FORM_SLOT,
  dispatch: () => undefined,
  liveFingerprint: null,
});

export function DealFormSlotProvider({
  state,
  dispatch,
  liveFingerprint,
  children,
}: Slot & { children: ReactNode }) {
  const value = useMemo(
    () => ({ state, dispatch, liveFingerprint }),
    [state, dispatch, liveFingerprint],
  );
  return (
    <DealFormSlot.Provider value={value}>{children}</DealFormSlot.Provider>
  );
}

/** The whole slot: DealBody reads it to release a form whose row went away. */
export function useDealFormSlot() {
  const { state, dispatch } = useContext(DealFormSlot);
  return { state, dispatch };
}

/**
 * Inside an open form when the deal changed under it. With `now` (what the
 * row says now, "40% of the pool"), the form was re-seeded with the latest
 * values. Empty `now` is a form for something not saved yet (a new clause,
 * a new cost, a preset): it keeps what the user typed, and the latest deal
 * is the one drawn around it on the page.
 */
export function ChangedNotice({ now }: { now: string }) {
  const { t } = useDealWords();
  return (
    <p className={styles.notice} role="status" data-testid="deal-form-changed">
      <Info size={16} strokeWidth={2} aria-hidden />
      <span>
        {now
          ? t("deals.changedWhileOpen", { now })
          : t("deals.changedWhileOpenKept")}
      </span>
    </p>
  );
}

/** Opens any form by key (a new clause opens as its payee is picked). */
export function useOpenDealForm() {
  const { dispatch, liveFingerprint } = useContext(DealFormSlot);
  return (key: string) =>
    dispatch({ type: "open", key, fingerprint: liveFingerprint });
}

/** The key of the open form, or null. */
export function useCurrentDealForm(): string | null {
  return useContext(DealFormSlot).state.key;
}

/** Closes whatever form is open. */
export function useCloseDealForms() {
  const { dispatch } = useContext(DealFormSlot);
  return () => dispatch({ type: "close" });
}

/** The open form's remount seed and whether the deal changed under it. */
export function useOpenFormFreshness() {
  const { state } = useContext(DealFormSlot);
  return { seed: state.seed, changed: state.changed };
}

/** The form called `key`: whether it is open, whether another one is, and the controls. */
export function useDealForm(key: string) {
  const { state, dispatch, liveFingerprint } = useContext(DealFormSlot);
  const isOpen = state.key === key;
  return {
    isOpen,
    /** Another form is open: whatever would open this one waits. */
    blocked: state.key !== null && !isOpen,
    /** Remount the form's fields when this changes (fresh values after a change). */
    seed: isOpen ? state.seed : 0,
    /** The deal changed under the open form, which now shows the fresh values. */
    changed: isOpen && state.changed,
    openForm: () =>
      dispatch({ type: "open", key, fingerprint: liveFingerprint }),
    closeForm: () => dispatch({ type: "close", key }),
  };
}

const FIRST_FIELD = [
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[role="radio"][aria-checked="true"]',
].join(", ");

/** Moves focus to the first field of a form when it mounts. */
export function useFocusFirstField(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FIRST_FIELD)?.focus();
  }, [ref]);
}

/**
 * Focuses what `find` returns once React has painted the next state (a form
 * that just closed, a row that just went away), falling back in order.
 */
export function focusSoon(
  ...finders: Array<() => HTMLElement | null | undefined>
) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (const find of finders) {
        const el = find();
        if (el) {
          el.focus();
          return;
        }
      }
    }),
  );
}

/** An element by its exact `data-testid`. */
export function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="${CSS.escape(testId)}"]`,
  );
}
