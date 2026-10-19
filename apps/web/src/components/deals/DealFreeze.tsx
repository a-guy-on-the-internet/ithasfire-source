"use client";

import {
  createContext,
  useContext,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Button, DateTime, useLocale } from "@th/ui";
import { Info, Lock } from "lucide-react";

import { joinNames, type TellCandidate } from "./deal-names";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// The frozen deal (freeze-the-deal FR-010, board option A): the notice before
// it freezes, the band once it has, and the footer while its terms change.
//
// `DealEditor` owns the phase and provides it here, so the resale clause
// (drawn in the editor's resale slot) reads the same phase: read-only while
// frozen, and while the frozen terms change it hands its edit to the
// editor's one "Save and tell them" instead of saving on its own.
// ─────────────────────────────────────────────────────────────────────────────

/** open = not frozen; frozen = read-only; changing = edits collecting. */
export type DealFreezePhase = "open" | "frozen" | "changing";

/** The resale clause's unsaved edit while the frozen terms change. */
export type ResalePending = {
  /** The share as saved and as typed, in words, for the "Not saved" row. */
  beforeText: string | null;
  afterText: string;
  /** Typed and readable: the save may send it. */
  valid: boolean;
};

export type DealFreezeContextValue = {
  phase: DealFreezePhase;
  saving: boolean;
  /** The resale clause reports its edit (null = nothing to save). */
  setResalePending: (pending: ResalePending | null) => void;
  /** The resale clause reports who receives the share (for "Saving tells …"). */
  setResaleRecipients: (recipients: readonly TellCandidate[]) => void;
  /** Sends the resale edit with `frozenChange: true`; set by the clause. */
  resaleSend: MutableRefObject<(() => Promise<void>) | null>;
};

const DealFreezeContext = createContext<DealFreezeContextValue | null>(null);

export function DealFreezeProvider({
  value,
  children,
}: {
  value: DealFreezeContextValue;
  children: ReactNode;
}) {
  return (
    <DealFreezeContext.Provider value={value}>
      {children}
    </DealFreezeContext.Provider>
  );
}

/** Null outside a `DealEditor` (an org default, a stand-alone clause). */
export function useDealFreeze(): DealFreezeContextValue | null {
  return useContext(DealFreezeContext);
}

/** Under the lede, before the deal freezes. */
export function FreezeNotice({ testIdBase }: { testIdBase: string }) {
  const { t } = useDealWords();
  return (
    <p className={styles.notice} data-testid={`${testIdBase}-freeze-notice`}>
      <Info size={16} strokeWidth={2} aria-hidden />
      <span>{t("deals.freeze.notice")}</span>
    </p>
  );
}

/** "Freeze the deal": the header's secondary action. */
export function FreezeAction({
  busy,
  onFreeze,
  testIdBase,
}: {
  busy: boolean;
  onFreeze: () => void;
  testIdBase: string;
}) {
  const { t } = useDealWords();
  return (
    <Button
      variant="secondary"
      size="$3"
      onPress={onFreeze}
      disabled={busy}
      testID={`${testIdBase}-freeze`}
    >
      <Lock size={16} strokeWidth={2} aria-hidden />
      {t("deals.freeze.action")}
    </Button>
  );
}

/**
 * The band under the header (board A-Frozen / A-Editing). Frozen: since
 * when and how, who a change would tell, and the way in. Changing: what
 * happens on save.
 */
export function FrozenBand({
  phase,
  frozenAt,
  frozenByName,
  frozenAutomatically,
  timeZone,
  tellNames,
  onChange,
  busy,
  children,
  testIdBase,
}: {
  phase: "frozen" | "changing";
  frozenAt: Date;
  /** Who froze it, when known. */
  frozenByName: string | null;
  frozenAutomatically: boolean;
  /** The event's zone; null until the history read lands (date only then). */
  timeZone: string | null;
  tellNames: readonly string[];
  /** "Change the frozen terms"; absent for someone who may not edit. */
  onChange?: () => void;
  busy: boolean;
  /** Under the band's text: a conflict notice, a failed save. */
  children?: ReactNode;
  testIdBase: string;
}) {
  const { t } = useDealWords();
  const locale = useLocale();
  const testId = `${testIdBase}-frozen`;

  if (phase === "changing") {
    return (
      <div
        className={`${styles.frozenBand} ${styles.frozenBandChanging}`}
        role="region"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        data-phase="changing"
      >
        <div className={styles.frozenBandText}>
          <Lock size={20} strokeWidth={2} aria-hidden />
          <div className={styles.frozenBandWords}>
            <span
              id={`${testId}-title`}
              className={styles.overline}
              // Focus lands here on entering the change when no row has an Edit.
              tabIndex={-1}
              data-testid={`${testId}-title`}
            >
              {t("deals.freeze.changingTitle")}
            </span>
            <span className={styles.frozenBandBody}>
              {t("deals.freeze.changingBody")}
            </span>
            {children}
          </div>
        </div>
      </div>
    );
  }

  const date = timeZone
    ? DateTime.format(frozenAt, "date", { timeZone, locale })
    : null;
  const title = !date
    ? t("deals.freeze.frozen")
    : frozenAutomatically
      ? t("deals.freeze.frozenSinceAuto", { date })
      : frozenByName
        ? t("deals.freeze.frozenSinceBy", { date, name: frozenByName })
        : t("deals.freeze.frozenSince", { date });
  const body = onChange
    ? tellNames.length > 0
      ? t("deals.freeze.frozenBody", { names: joinNames(tellNames, locale) })
      : t("deals.freeze.frozenBodyNobody")
    : t("deals.freeze.frozenReadOnly");

  return (
    <div
      className={styles.frozenBand}
      role="region"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
      data-phase="frozen"
    >
      <div className={styles.frozenBandText}>
        <Lock size={20} strokeWidth={2} aria-hidden />
        <div className={styles.frozenBandWords}>
          <span id={`${testId}-title`} className={styles.overline}>
            {title}
          </span>
          <span className={styles.frozenBandBody}>{body}</span>
          {children}
        </div>
      </div>
      {onChange ? (
        <div className={styles.frozenBandAction}>
          <Button
            variant="primary"
            size="$3"
            // The label wraps at 320 (see `.frozenBandAction`); let the
            // button grow with it instead of clipping at the $3 height.
            height="auto"
            minHeight={36}
            paddingVertical="$2"
            onPress={onChange}
            disabled={busy}
            testID={`${testId}-change`}
          >
            {t("deals.freeze.change")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The commit point while the frozen terms change (board A-Editing): how many
 * lines, who is told, and the two ways out.
 */
export function ChangeFooter({
  count,
  tellNames,
  canSave,
  busy,
  onSave,
  onDiscard,
  testIdBase,
}: {
  count: number;
  tellNames: readonly string[];
  canSave: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  testIdBase: string;
}) {
  const { t } = useDealWords();
  const locale = useLocale();
  const testId = `${testIdBase}-change-footer`;
  return (
    <div className={styles.changeFooter} data-testid={testId}>
      <p className={styles.changeFooterText} aria-live="polite">
        <strong>
          {count === 0
            ? t("deals.freeze.footerNone")
            : count === 1
              ? t("deals.freeze.footerOne")
              : t("deals.freeze.footerMany", { count })}
        </strong>{" "}
        {count === 0
          ? t("deals.freeze.footerNoneHint")
          : tellNames.length > 0
            ? t("deals.freeze.footerTells", {
                names: joinNames(tellNames, locale),
              })
            : t("deals.freeze.footerTellsNobody")}
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="$3"
          onPress={onSave}
          disabled={busy || !canSave}
          testID={`${testId}-save`}
        >
          {t("deals.freeze.save")}
        </Button>
        <Button
          variant="ghost"
          size="$3"
          onPress={onDiscard}
          disabled={busy}
          testID={`${testId}-discard`}
        >
          {t("deals.freeze.discard")}
        </Button>
      </div>
    </div>
  );
}

/** "Not saved": the overline on a row changed in this edit. */
export function NotSaved({ testId }: { testId?: string }) {
  const { t } = useDealWords();
  return (
    <span className={styles.notSaved} data-testid={testId}>
      {t("deals.freeze.notSaved")}
    </span>
  );
}
