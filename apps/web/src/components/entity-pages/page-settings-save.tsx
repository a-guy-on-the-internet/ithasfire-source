"use client";

/**
 * One Save for the entity-page editor's settings.
 *
 * The settings disclosure holds two independent forms — Profile
 * (`PageFieldsEditor` → `updatePage`) and Theme (`PageThemeEditor` →
 * `updatePageTheme`) — each of which used to carry its own Save button inside
 * the collapsed panel. So saving meant: notice the panel, open it, find the
 * right subsection, press the right button. Blocks are not part of this: the
 * canvas persists immediately through `managePageBlocks`.
 *
 * Each form registers what it can do here; the toolbar renders a single Save
 * that commits every dirty one. The forms keep owning their own validation —
 * a form that must not be saved yet (a slug already taken) registers
 * `blocked`, and the toolbar refuses to fire.
 *
 * ── Ownership-safe cleanup ──────────────────────────────────────────────────
 * Entries are keyed by a caller-supplied static id, so a StrictMode remount or
 * a route transition can run the OUTGOING instance's cleanup after the
 * INCOMING one's setup. Cleanup therefore removes an entry only while the
 * departing instance still owns it (same discipline as
 * `navigation/page-primary-action.ts`, and for the same reason).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type PageSettingsSaveEntry = {
  /** Stable, unique per form — "profile", "theme". */
  id: string;
  /** Has unsaved input. A clean form is skipped, not failed. */
  isDirty: boolean;
  /** Its mutation is in flight. */
  isPending: boolean;
  /**
   * Cannot be saved as it stands (failing validation the form owns, e.g. a
   * slug that is already taken). Distinct from `!isDirty`: the toolbar shows
   * an enabled-looking Save for a dirty form and refuses a blocked one.
   */
  blocked?: boolean;
  /**
   * Commit. The form still owns its own success/error reporting; a host that
   * needs to SEQUENCE this against another mutation (the venue settings route
   * saves the place first) may return a promise and await it via
   * {@link PageSettingsSaveState.saveAll}.
   */
  save: () => void | Promise<void>;
};

type Registration = PageSettingsSaveEntry & { owner: symbol };

type ContextValue = {
  register: (entry: Registration) => void;
  unregister: (id: string, owner: symbol) => void;
  entries: readonly PageSettingsSaveEntry[];
};

const PageSettingsSaveContext = createContext<ContextValue | null>(null);

export function PageSettingsSaveProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<readonly Registration[]>([]);

  const register = useCallback((entry: Registration) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx === -1) return [...prev, entry];
      const existing = prev[idx];
      // Cheap bail-out: re-registering identical state on every keystroke of an
      // unrelated field would re-render the toolbar for nothing.
      if (
        existing.isDirty === entry.isDirty &&
        existing.isPending === entry.isPending &&
        existing.blocked === entry.blocked &&
        existing.owner === entry.owner &&
        existing.save === entry.save
      ) {
        return prev;
      }
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  }, []);

  const unregister = useCallback((id: string, owner: symbol) => {
    setEntries((prev) => {
      const existing = prev.find((e) => e.id === id);
      // A stale instance's cleanup must never drop the live registration.
      if (!existing || existing.owner !== owner) return prev;
      return prev.filter((e) => e.id !== id);
    });
  }, []);

  const value = useMemo<ContextValue>(
    () => ({ register, unregister, entries }),
    [register, unregister, entries],
  );

  return (
    <PageSettingsSaveContext.Provider value={value}>
      {children}
    </PageSettingsSaveContext.Provider>
  );
}

/**
 * Publish this form's save. A no-op outside a provider, so the two editors
 * stay renderable on their own (Storybook, unit tests, any future host).
 */
export function useRegisterPageSettingsSave(entry: PageSettingsSaveEntry): void {
  const ctx = useContext(PageSettingsSaveContext);

  // The callback identity changes on every keystroke in these forms (it closes
  // over the field values), so hold it in a ref and register a stable wrapper.
  // Otherwise every character typed would re-register and re-render the
  // toolbar.
  const saveRef = useRef(entry.save);
  saveRef.current = entry.save;

  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current === null) {
    ownerRef.current = Symbol("page-settings-save");
  }
  const owner = ownerRef.current;

  const stableSave = useRef<() => void | Promise<void>>(() =>
    saveRef.current(),
  );

  const { register, unregister } = ctx ?? {};
  const { id, isDirty, isPending, blocked } = entry;

  useEffect(() => {
    if (!register || !unregister) return;
    register({
      id,
      isDirty,
      isPending,
      blocked,
      owner,
      save: stableSave.current,
    });
    return () => unregister(id, owner);
  }, [register, unregister, id, isDirty, isPending, blocked, owner]);
}

/**
 * Outcome of ONE registered form's save. Mirrors `PromiseSettledResult` so a
 * rejected form reads the same whether it threw synchronously or rejected.
 */
export type PageSettingsSaveOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown };

/** Keyed by entry id. Only ATTEMPTED forms appear — clean and blocked ones are skipped, not failed. */
export type PageSettingsSaveResults = Record<string, PageSettingsSaveOutcome>;

export type PageSettingsSaveState = {
  /** At least one form has unsaved input. */
  isDirty: boolean;
  /** At least one save is in flight. */
  isPending: boolean;
  /** A dirty form is failing its own validation — Save must not fire. */
  isBlocked: boolean;
  /**
   * Commit every dirty, unblocked form. SETTLED, not fail-fast: every form is
   * attempted even if an earlier one rejects, and the resolved record says
   * WHICH one failed. The returned promise itself never rejects, so the
   * existing fire-and-forget toolbar call site can keep ignoring it.
   */
  saveAll: () => Promise<PageSettingsSaveResults>;
};

/** Aggregate state for the toolbar's single Save. */
export function usePageSettingsSave(): PageSettingsSaveState {
  const ctx = useContext(PageSettingsSaveContext);
  const entries = ctx?.entries;

  return useMemo(() => {
    const list = entries ?? [];
    const dirty = list.filter((e) => e.isDirty);
    return {
      isDirty: dirty.length > 0,
      isPending: list.some((e) => e.isPending),
      isBlocked: dirty.some((e) => e.blocked === true),
      saveAll: async () => {
        const attempted = dirty.filter((e) => e.blocked !== true);
        // The async wrapper runs `save()` SYNCHRONOUSLY (nothing is awaited
        // before it), so every form is fired in the same tick the toolbar was
        // pressed — as it was when this was a plain for-loop — and a form that
        // throws synchronously becomes a rejection instead of unwinding the
        // loop and skipping the rest.
        const settled = await Promise.allSettled(
          attempted.map(async (entry) => entry.save()),
        );
        const results: PageSettingsSaveResults = {};
        attempted.forEach((entry, i) => {
          const outcome = settled[i]!;
          results[entry.id] =
            outcome.status === "fulfilled"
              ? { status: "fulfilled" }
              : { status: "rejected", reason: outcome.reason };
        });
        return results;
      },
    };
  }, [entries]);
}
