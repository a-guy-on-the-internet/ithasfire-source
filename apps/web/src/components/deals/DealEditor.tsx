"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, NextLinkAnchor, Spinner, useNotify } from "@th/ui";
import { ArrowRight, Info, Pencil } from "lucide-react";

import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import { AgreementTag, ClauseRow, clauseTestId } from "./ClauseRow";
import { DealCalculator } from "./DealCalculator";
import {
  DealChanges,
  useDealChangesFirstPage,
  type DealChangesPage,
} from "./DealChanges";
import {
  ChangeFooter,
  DealFreezeProvider,
  FreezeAction,
  FreezeNotice,
  FrozenBand,
  NotSaved,
  type DealFreezeContextValue,
  type DealFreezePhase,
  type ResalePending,
} from "./DealFreeze";
import { namesToTell, type TellCandidate } from "./deal-names";
import { useViewerHuman } from "./use-viewer-human";
import {
  draftChangeCount,
  draftClauses,
  draftDeductions,
  emptyDraft,
  isDraftId,
  stripDraftIds,
  withClauses,
  withDeductions,
  withDraftIds,
  withRemainder,
  type ChangeDraft,
} from "./deal-change-draft";
import {
  NOT_EDITABLE_KEYS,
  classifyDealReadError,
  classifyDealWriteError,
  classifyResaleWriteError,
} from "./deal-errors";
import {
  DEAL_PRESETS,
  clauseAgreementOf,
  clauseInputOf,
  clauseInputsOf,
  clausesWrite,
  currentPresetOf,
  deductionInputsOf,
  isPartyRef,
  nameOfPayeeId,
  nameOfRef,
  presetCandidates,
  presetDefaults,
  presetWrite,
  refKey,
  refOfPayee,
  refOfPayeeId,
  remainderRefOf,
  restPaidPerOrder,
  sameRef,
  showsSettledDirectlyNote,
  visibleClauses,
  type DealClauseInput,
  type DealDeductionInput,
  type DealPayeeRef,
  type DealPerson,
  type DealRead,
  type DealTarget,
  type DealWrite,
} from "./deal-model";
import {
  INITIAL_FORM_SLOT,
  costFormKey,
  expectedFingerprint,
  formSlotReducer,
  isStale,
  liveKeysWithoutDeal,
  presetFormKey,
  releasedKey,
  sectionOfKey,
} from "./deal-form-state";
import {
  ChangedNotice,
  DealFormSlotProvider,
  byTestId,
  focusSoon,
  useDealForm,
  useFocusFirstField,
  useCloseDealForms,
  useDealFormSlot,
  useOpenDealForm,
} from "./form-slot";
import { OffTheTop } from "./OffTheTop";
import { PayeePicker } from "./PayeePicker";
import { PresetPicker } from "./PresetPicker";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

export type DealEditorProps = {
  /** Which terms this deal is: a booking agreement, an event, or an org's default. */
  target: DealTarget;
  /**
   * Who the terms are between, named. The first is who takes the rest when
   * the deal names nobody yet. EVENT: the event's owner; ORG_DEFAULT: the
   * org; BOOKING_AGREEMENT: both parties, the place's side first.
   */
  parties: DealPerson[];
  /** Acts the picker offers first: the bill, or the event's lineup. */
  suggestions?: DealPerson[];
  /** Where "this night's deal lives in its booking" links to. */
  agreementHref?: (agreementId: string) => string;
  /** Beside the title: a status badge, an "Agreement page" link. */
  headerAside?: ReactNode;
  /** Under the title: the date / guarantee / parties strip of the host page. */
  headerDetail?: ReactNode;
  /**
   * After "Off the top": the resale clause (`<ResaleClause>`, board RC1).
   * Also drawn in the no-deal-yet and booked-event states. Empty renders nothing.
   */
  resaleSlot?: ReactNode;
  /**
   * After a save lands and the deal is re-read: the host refreshes its own
   * reads of the same terms (the agreement's lines, the splits editor).
   */
  onSaved?: () => void;
  /**
   * A guarantee already on file outside the deal (the agreement header, while
   * no deal sets it). Fills Guarantee, Guarantee + % and Versus until the deal
   * has a clause for the act, so picking one doesn't ask for it again.
   */
  presetGuaranteeCents?: number | null;
  testIdBase?: string;
};

/** A clause for someone just picked: a percentage of the pool, numbers still blank. */
const NEW_CLAUSE: Omit<DealClauseInput, "payee"> = {
  amountType: "PERCENT",
  amountCents: null,
  percent: null,
  basis: "NET_POOL",
  resolution: null,
};

const defaultAgreementHref = (agreementId: string) =>
  `/agreements/${agreementId}`;

/**
 * "The deal" (deal-terms-and-settlement FR-003, canvas boards A1 / P1): the
 * preset picker, the clauses in plain words, the costs off the top and the
 * calculator, for any target. Reads with `deals.getTermsDeal`, writes the
 * whole deal with `deals.setTermsDeal`, projects with
 * `deals.projectTermsDeal`. It owns its reads and writes, so a host only
 * says WHICH deal and who the parties are.
 *
 * Payees agree their own line elsewhere: there is deliberately no agree /
 * decline control here (the NET_POOL consent gap must close first).
 */
export function DealEditor({
  target,
  parties,
  suggestions = [],
  agreementHref = defaultAgreementHref,
  headerAside,
  headerDetail,
  resaleSlot,
  onSaved,
  presetGuaranteeCents = null,
  testIdBase = "deal",
}: DealEditorProps) {
  const { t } = useDealWords();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [slot, dispatchSlot] = useReducer(formSlotReducer, INITIAL_FORM_SLOT);
  // A save is in flight from the moment it is sent until its refetch has
  // landed and the form closed (`done`). The mutation alone stops being
  // pending when the write returns, which left a gap in which Save could
  // fire again against a read one step behind. The ref answers in the same
  // tick as a double press; the state redraws the buttons.
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const setSavingBoth = useCallback((next: boolean) => {
    savingRef.current = next;
    setSaving(next);
  }, []);

  const read = trpc.deals.getTermsDeal.useQuery(
    { target },
    { retry: false, meta: { silent: true } },
  );
  // The deal's fingerprint as last read. Undefined while no read has
  // settled; null when there is no deal yet (the empty state).
  const liveFingerprint: string | null | undefined = read.data
    ? read.data.dealFingerprint
    : read.error
      ? null
      : undefined;

  // Someone changed the deal under the open form (or our save was refused as
  // a conflict and the refetch brought the new deal): re-seed that form from
  // the fresh values, say so, and move its snapshot on.
  useEffect(() => {
    if (isStale(slot, liveFingerprint)) {
      dispatchSlot({ type: "refreshed", fingerprint: liveFingerprint ?? null });
    }
  }, [slot, liveFingerprint]);
  const mutation = trpc.deals.setTermsDeal.useMutation({
    retry: false,
    meta: { silent: true },
  });

  // ── The freeze (freeze-the-deal FR-010, board option A) ─────────────────
  // Frozen: rows read-only until "Change the frozen terms". Changing: row
  // edits collect in `draft`; "Save and tell them" sends ONE write with
  // `frozenChange: true` (and the resale clause's own, when it changed).
  const dealFreeze = read.data?.dealFreeze ?? null;
  const frozen = !!dealFreeze?.dealFrozenAt;
  const [draft, setDraft] = useState<ChangeDraft | null>(null);
  const [resalePending, setResalePending] = useState<ResalePending | null>(
    null,
  );
  const [resaleRecipients, setResaleRecipients] = useState<
    readonly TellCandidate[]
  >([]);
  const resaleSend = useRef<(() => Promise<void>) | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  // Someone else saved the deal while this change was open: the page now
  // shows their version under what was typed here.
  const [changedUnder, setChangedUnder] = useState(false);
  // How many of this change's edits were to lines someone else took off
  // meanwhile: dropped from the change, and the band says how many.
  const [droppedUnder, setDroppedUnder] = useState(0);
  const phase: DealFreezePhase = !frozen
    ? "open"
    : draft
      ? "changing"
      : "frozen";
  const changes = useDealChangesFirstPage(
    frozen ? (dealFreeze?.eventId ?? null) : null,
  );
  useEffect(() => {
    if (!frozen && draft) setDraft(null);
  }, [frozen, draft]);
  useEffect(() => {
    // Mid-save the read trails our own write: not someone else's change.
    if (!draft || !read.data || saving) return;
    const live = read.data.dealFingerprint;
    if (live !== draft.base) {
      // Re-base on theirs. An edit to a line they took off has nothing left
      // to apply to: drop it, and count it so the band can say so.
      const clauseIds = new Set(
        clauseInputsOf(read.data).flatMap((c) => (c.id ? [c.id] : [])),
      );
      const costIds = new Set(
        deductionInputsOf(read.data).flatMap((d) => (d.id ? [d.id] : [])),
      );
      const keep = <T,>(edits: Readonly<Record<string, T>>, ids: Set<string>) =>
        Object.fromEntries(Object.entries(edits).filter(([id]) => ids.has(id)));
      const clauses = keep(draft.clauses, clauseIds);
      const deductions = keep(draft.deductions, costIds);
      const dropped =
        Object.keys(draft.clauses).length -
        Object.keys(clauses).length +
        Object.keys(draft.deductions).length -
        Object.keys(deductions).length;
      setDraft({ ...draft, base: live, clauses, deductions });
      setChangedUnder(true);
      if (dropped > 0) setDroppedUnder((n) => n + dropped);
    }
  }, [draft, read.data, saving]);
  const freezeMutation = trpc.deals.freezeEventDeal.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const busy = mutation.isPending || saving || freezeMutation.isPending;
  const canFreeze =
    !!read.data &&
    target.kind !== "ORG_DEFAULT" &&
    !!dealFreeze &&
    !frozen &&
    read.data.mayEdit &&
    read.data.visibility === "FULL";
  const freeze = () => {
    if (!dealFreeze || freezeMutation.isPending) return;
    setWriteError(null);
    freezeMutation.mutate(
      { eventId: dealFreeze.eventId },
      {
        onSuccess: () => {
          void Promise.all([
            utils.deals.getTermsDeal.invalidate({ target }),
            utils.deals.listDealChanges.invalidate({
              eventId: dealFreeze.eventId,
            }),
            utils.deals.getResaleClause.invalidate({ target }),
          ]).then(() =>
            toast.success({
              id: `${testIdBase}-frozen`,
              title: t("deals.freeze.frozenToast"),
            }),
          );
        },
        onError: (err) => setWriteError(formatErrorMessage(err, t)),
      },
    );
  };
  const enterChange = () => {
    if (!read.data) return;
    dispatchSlot({ type: "close" });
    setChangeError(null);
    setChangedUnder(false);
    setDroppedUnder(0);
    setDraft(emptyDraft(read.data.dealFingerprint));
    // Into the change: the first row's Edit, else the band's title.
    focusSoon(
      () =>
        byTestId(`${testIdBase}-clause-list`)?.querySelector<HTMLElement>(
          '[data-testid$="-edit"]',
        ),
      () => byTestId(`${testIdBase}-frozen-title`),
    );
  };
  /** Back on the band's way in, once the change is saved or dropped. */
  const focusChangeButton = () =>
    focusSoon(() => byTestId(`${testIdBase}-frozen-change`));
  const discardChange = () => {
    dispatchSlot({ type: "close" });
    setDraft(null);
    setChangeError(null);
    setChangedUnder(false);
    setDroppedUnder(0);
    focusChangeButton();
  };
  /** One frozen change: the terms (when they changed), then the resale share. */
  // `tellsNobody`: no one but the actor is on the deal, so the notice
  // reaches nobody and the toast must not say it did.
  const saveChange = async (deal: DealWrite | null, tellsNobody = false) => {
    if (!draft || savingRef.current) return;
    setSavingBoth(true);
    setChangeError(null);
    let savedFingerprint: string | null = null;
    const baseAtSend = draft.base;
    if (deal) {
      try {
        const out = await mutation.mutateAsync({
          target,
          deal,
          // The deal this change was opened (or last re-based) against: a
          // save over someone else's newer change is refused, not applied.
          expectedDealFingerprint: draft.base,
          frozenChange: true,
        });
        savedFingerprint = out.dealFingerprint;
        // Our own save moved the deal: not someone else's change.
        setDraft({ ...draft, base: savedFingerprint });
      } catch (err) {
        setSavingBoth(false);
        const failure = classifyDealWriteError(err);
        if (failure.kind === "CONFLICT") {
          // Someone else saved first: load theirs; this change stays open
          // over it (the band says so) and can be saved again.
          setChangedUnder(true);
          void utils.deals.getTermsDeal.invalidate({ target });
          void utils.deals.projectTermsDeal.invalidate();
          return;
        }
        setChangeError(
          failure.kind === "OTHER"
            ? formatErrorMessage(err, t)
            : t(failure.key),
        );
        return;
      }
    }
    let resaleError: string | null = null;
    let resaleSaved = false;
    if (resalePending && resaleSend.current) {
      try {
        await resaleSend.current();
        resaleSaved = true;
      } catch (err) {
        const failure = classifyResaleWriteError(err);
        resaleError =
          failure.kind === "OTHER"
            ? formatErrorMessage(err, t)
            : t(failure.key);
      }
    }
    // The terms are saved (or had nothing to save): leave the change, or,
    // when only the resale share failed, stay in it with the terms cleared.
    if (resaleError) {
      if (deal) setDraft(emptyDraft(savedFingerprint));
      setChangeError(
        deal
          ? t("deals.freeze.resaleFailedAfterTerms", { reason: resaleError })
          : resaleError,
      );
    } else {
      setDraft(null);
      setChangedUnder(false);
      setDroppedUnder(0);
      focusChangeButton();
    }
    try {
      await Promise.all([
        utils.deals.getTermsDeal.invalidate({ target }),
        utils.deals.projectTermsDeal.invalidate(),
        utils.deals.getResaleClause.invalidate({ target }),
        dealFreeze
          ? utils.deals.listDealChanges.invalidate({
              eventId: dealFreeze.eventId,
            })
          : Promise.resolve(),
      ]);
    } catch {
      // A failed re-read is not a failed save: the page re-reads on its own.
    } finally {
      setSavingBoth(false);
    }
    if (!resaleError) {
      onSaved?.();
      // The deal's fingerprint is unmoved and no resale share was sent: the
      // server recorded no change and told nobody (FR-005).
      const termsMoved = !!deal && savedFingerprint !== baseAtSend;
      toast.success({
        id: `${testIdBase}-change-saved`,
        title: t(
          !(termsMoved || resaleSaved)
            ? "deals.freeze.savedNothingToast"
            : tellsNobody
              ? "deals.freeze.savedToastNobody"
              : "deals.freeze.savedToast",
        ),
      });
    }
  };
  const freezeContext = useMemo<DealFreezeContextValue>(
    () => ({
      phase,
      saving,
      setResalePending,
      setResaleRecipients,
      resaleSend,
    }),
    [phase, saving],
  );

  const write = useCallback(
    (deal: DealWrite, done: () => void) => {
      if (mutation.isPending || savingRef.current) return;
      setSavingBoth(true);
      setWriteError(null);
      mutation.mutate(
        {
          target,
          deal,
          // The deal the open form was opened against (its snapshot), never a
          // read that arrived since: a save over a deal someone else changed
          // is refused (deal_terms_changed), not applied.
          expectedDealFingerprint: expectedFingerprint(slot, liveFingerprint),
        },
        {
          onSuccess: (out) => {
            // Our own write moved the fingerprint; the open form shows it.
            dispatchSlot({ type: "saved", fingerprint: out.dealFingerprint });
            void Promise.all([
              utils.deals.getTermsDeal.invalidate({ target }),
              utils.deals.projectTermsDeal.invalidate(),
            ])
              .then(() => {
                done();
                onSaved?.();
                toast.success({
                  id: `${testIdBase}-saved`,
                  title: t("deals.savedToast"),
                });
              })
              .finally(() => setSavingBoth(false));
          },
          onError: (err) => {
            setSavingBoth(false);
            const failure = classifyDealWriteError(err);
            if (failure.kind === "CONFLICT") {
              void utils.deals.getTermsDeal.invalidate({ target });
              void utils.deals.projectTermsDeal.invalidate();
            }
            setWriteError(
              failure.kind === "OTHER"
                ? formatErrorMessage(err, t)
                : t(failure.key),
            );
          },
        },
      );
    },
    [
      mutation,
      slot,
      liveFingerprint,
      target,
      t,
      testIdBase,
      toast,
      utils,
      onSaved,
      setSavingBoth,
    ],
  );

  // Outside a deal (no deal yet, the booking's deal, a refusal, a failed
  // read) only the empty state's preset picker can hold the form slot.
  // Anything else still open — a clause form when a refetch says the deal
  // is gone, say — is released, or the picker would stay blocked by it.
  const readOutcome =
    read.error || (!read.isLoading && !read.data)
      ? classifyDealReadError(read.error)
      : null;
  const outsideKind = readOutcome?.kind ?? null;
  const emptyEditable = parties.length > 0;
  useEffect(() => {
    if (outsideKind === null) return;
    const live = liveKeysWithoutDeal(
      outsideKind,
      testIdBase,
      DEAL_PRESETS,
      emptyEditable,
    );
    if (releasedKey(slot, live) !== null) {
      dispatchSlot({ type: "prune", liveKeys: live });
    }
  }, [outsideKind, slot, testIdBase, emptyEditable]);

  const header = (
    <div className={styles.presets}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h3 className={styles.title}>{t("deals.title")}</h3>
        </div>
        {headerAside}
        {canFreeze ? (
          <FreezeAction busy={busy} onFreeze={freeze} testIdBase={testIdBase} />
        ) : null}
      </div>
      {headerDetail ?? <p className={styles.lede}>{t("deals.lede")}</p>}
      {canFreeze ? <FreezeNotice testIdBase={testIdBase} /> : null}
    </div>
  );

  const wrap = (node: ReactNode) => (
    <DealFormSlotProvider
      state={slot}
      dispatch={dispatchSlot}
      liveFingerprint={liveFingerprint ?? null}
    >
      <DealFreezeProvider value={freezeContext}>{node}</DealFreezeProvider>
    </DealFormSlotProvider>
  );

  const errorBanner = writeError ? (
    <div
      className={`${styles.block} ${styles.blockDanger}`}
      role="alert"
      data-testid={`${testIdBase}-write-error`}
    >
      <p className={`${styles.blockBody} ${styles.dangerText}`}>{writeError}</p>
    </div>
  ) : null;

  if (read.isLoading) {
    return wrap(
      <div className={styles.root} data-testid={testIdBase} aria-busy>
        {header}
        <div className={styles.actions}>
          <Spinner size="sm" />
          <span className={styles.hint}>{t("deals.loading")}</span>
        </div>
      </div>,
    );
  }

  if (read.error || !read.data) {
    const outcome = readOutcome ?? classifyDealReadError(read.error);
    if (outcome.kind === "NO_TERMS") {
      return wrap(
        <div
          className={styles.root}
          data-testid={testIdBase}
          data-state="no-terms"
        >
          {header}
          <div className={styles.block} data-testid={`${testIdBase}-no-terms`}>
            <p className={styles.blockTitle}>{t("deals.noTerms.title")}</p>
            <p className={styles.blockBody}>{t("deals.noTerms.body")}</p>
          </div>
          {resaleSlotOf(resaleSlot, testIdBase)}
        </div>,
      );
    }
    if (outcome.kind === "NO_DEAL") {
      return wrap(
        <div
          className={styles.root}
          data-testid={testIdBase}
          data-state="empty"
        >
          {header}
          <div className={styles.block} data-testid={`${testIdBase}-empty`}>
            <p className={styles.blockTitle}>{t("deals.empty.title")}</p>
            <p className={styles.blockBody}>
              {t(
                target.kind === "ORG_DEFAULT"
                  ? "deals.empty.bodyDefault"
                  : "deals.empty.bodyEvent",
              )}
            </p>
          </div>
          {errorBanner}
          <PresetPicker
            current={null}
            defaultsFor={(p) =>
              presetDefaults(
                p,
                null,
                parties,
                presetCandidates([], suggestions, parties),
                presetGuaranteeCents,
              )
            }
            people={dedupePeople([...parties, ...suggestions])}
            parties={parties}
            editable={emptyEditable}
            busy={busy}
            onApply={(values, done) => write(presetWrite(values, null), done)}
            testIdBase={testIdBase}
          />
          {resaleSlotOf(resaleSlot, testIdBase)}
        </div>,
      );
    }
    if (outcome.kind === "OWNED_BY_BOOKING") {
      return wrap(
        <div
          className={styles.root}
          data-testid={testIdBase}
          data-state="booking"
        >
          {header}
          <div className={styles.block} data-testid={`${testIdBase}-booking`}>
            <p className={styles.blockTitle}>{t("deals.booking.title")}</p>
            <p className={styles.blockBody}>{t("deals.booking.body")}</p>
            <NextLinkAnchor
              className={styles.link}
              href={agreementHref(outcome.agreementId)}
              data-testid={`${testIdBase}-booking-link`}
            >
              {t("deals.booking.link")}
              <ArrowRight size={16} strokeWidth={2.5} aria-hidden />
            </NextLinkAnchor>
          </div>
          {resaleSlotOf(resaleSlot, testIdBase)}
        </div>,
      );
    }
    return wrap(
      <div className={styles.root} data-testid={testIdBase} data-state="error">
        {header}
        <div className={`${styles.block} ${styles.blockDanger}`} role="status">
          <p className={styles.blockTitle}>
            {outcome.kind === "NOT_ALLOWED"
              ? t("deals.notAllowed.title")
              : t("deals.readFailed.title")}
          </p>
          <p className={styles.blockBody}>
            {outcome.kind === "NOT_ALLOWED"
              ? t("deals.notAllowed.body")
              : t("deals.readFailed.body")}
          </p>
          {outcome.kind === "ERROR" ? (
            <div>
              <Button
                variant="secondary"
                size="$2"
                onPress={() => void read.refetch()}
                disabled={read.isFetching}
                testID={`${testIdBase}-retry`}
              >
                {t("deals.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>,
    );
  }

  return wrap(
    <DealBody
      read={read.data}
      target={target}
      parties={parties}
      suggestions={suggestions}
      header={header}
      errorBanner={errorBanner}
      resaleSlot={resaleSlot}
      busy={busy}
      write={write}
      presetGuaranteeCents={presetGuaranteeCents}
      testIdBase={testIdBase}
      freeze={
        frozen && dealFreeze?.dealFrozenAt
          ? {
              phase: phase === "changing" ? "changing" : "frozen",
              frozenAt: dealFreeze.dealFrozenAt,
              frozenAutomatically: dealFreeze.dealFrozenByHumanId === null,
              frozenByName: changes.data?.event.frozenBy?.name ?? null,
              timeZone: changes.data?.event.timezone ?? null,
              changes: changes.data ?? null,
              draft,
              setDraft,
              enterChange,
              discardChange,
              saveChange: (deal, tellsNobody) =>
                void saveChange(deal, tellsNobody),
              changeError,
              changedUnder,
              droppedUnder,
              resalePending,
              resaleRecipients,
            }
          : null
      }
    />,
  );
}

/** What DealBody needs to draw a frozen deal; null when it is not frozen. */
type FreezeView = {
  phase: "frozen" | "changing";
  frozenAt: Date;
  frozenAutomatically: boolean;
  frozenByName: string | null;
  timeZone: string | null;
  changes: DealChangesPage | null;
  draft: ChangeDraft | null;
  setDraft: (next: ChangeDraft | null) => void;
  enterChange: () => void;
  discardChange: () => void;
  saveChange: (deal: DealWrite | null, tellsNobody: boolean) => void;
  changeError: string | null;
  changedUnder: boolean;
  droppedUnder: number;
  resalePending: ResalePending | null;
  resaleRecipients: readonly TellCandidate[];
};

/**
 * The resale clause's place (board RC1: after Off the top). Also drawn with no
 * ticket-sales deal or terms yet and on a booked event: the clause is its own
 * terms row, readable and writable without the deal around it.
 */
function resaleSlotOf(resaleSlot: ReactNode, testIdBase: string): ReactNode {
  return (
    <div className={styles.slot} data-testid={`${testIdBase}-resale-slot`}>
      {resaleSlot}
    </div>
  );
}

function dedupePeople(list: readonly DealPerson[]): DealPerson[] {
  const seen = new Set<string>();
  const out: DealPerson[] = [];
  for (const p of list) {
    const key = refKey(p.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function DealBody({
  read,
  target,
  parties,
  suggestions,
  header,
  errorBanner,
  resaleSlot,
  busy,
  write,
  presetGuaranteeCents,
  testIdBase,
  freeze,
}: {
  read: DealRead;
  target: DealTarget;
  parties: DealPerson[];
  suggestions: DealPerson[];
  header: ReactNode;
  errorBanner: ReactNode;
  resaleSlot: ReactNode;
  busy: boolean;
  write: (deal: DealWrite, done: () => void) => void;
  presetGuaranteeCents: number | null;
  testIdBase: string;
  freeze: FreezeView | null;
}) {
  const { t } = useDealWords();
  const viewer = useViewerHuman();
  const [newPerson, setNewPerson] = useState<DealPerson | null>(null);
  const { state: slotState, dispatch: dispatchSlotAction } = useDealFormSlot();
  const restForm = useDealForm("rest");
  // Not a form: only asks whether one is open, so a pick waits for it.
  const pickerSlot = useDealForm("picker");
  const openForm = useOpenDealForm();
  const closeAnyForm = useCloseDealForms();
  const clauseListId = `${testIdBase}-clause-list`;
  const focusRestEdit = () =>
    focusSoon(() => byTestId(`${testIdBase}-rest-edit`));
  // After a removal: the row now at the same place, else the section heading.
  const focusAfterRemoval = (index: number) =>
    focusSoon(
      () => {
        const rows = byTestId(clauseListId)?.querySelectorAll<HTMLElement>(
          ":scope > [data-deal-row]",
        );
        return rows?.[index]?.querySelector<HTMLElement>(
          '[data-testid$="-edit"]',
        );
      },
      () => byTestId(`${testIdBase}-clauses-title`),
    );

  const full = read.visibility === "FULL";
  const editable = read.mayEdit && full;
  // Frozen: nothing edits until "Change the frozen terms"; then rows edit
  // into the draft (freeze-the-deal FR-010).
  const draft = freeze?.phase === "changing" ? freeze.draft : null;
  const changing = draft !== null;
  const rowsEditable = editable && (!freeze || changing);
  const unnamed = t("deals.unnamed");

  // Everyone the deal can name, with the best name we have for each.
  const dealPeople: DealPerson[] = useMemo(
    () =>
      read.payees.map((p) => ({
        ref: refOfPayee(p),
        name:
          p.displayName ??
          nameOfRef([], [...parties, ...suggestions], refOfPayee(p), unnamed),
      })),
    [read.payees, parties, suggestions, unnamed],
  );
  // Everyone picked on this page: a payee added during a frozen change is
  // not in the read until the change is saved, and still needs its name.
  const [picked, setPicked] = useState<readonly DealPerson[]>([]);
  const people = useMemo(
    () =>
      dedupePeople([
        ...parties,
        ...dealPeople,
        ...suggestions,
        ...(newPerson ? [newPerson] : []),
        ...picked,
      ]),
    [parties, dealPeople, suggestions, newPerson, picked],
  );
  const nameOfId = useCallback(
    (payeeId: string, extra?: DealRead["payees"]) =>
      nameOfPayeeId(
        [...read.payees, ...(extra ?? [])],
        people,
        payeeId,
        unnamed,
      ),
    [read.payees, people, unnamed],
  );
  const nameOf = useCallback(
    (ref: DealPayeeRef) => nameOfRef(read.payees, people, ref, unnamed),
    [read.payees, people, unnamed],
  );

  const liveRemainder = remainderRefOf(read, parties);
  const liveClauses = clauseInputsOf(read);
  const liveDeductions = deductionInputsOf(read);
  // While the frozen terms change: the live deal with the draft laid over it.
  const remainder = draft?.remainder ?? liveRemainder;
  const clauses = draft ? draftClauses(liveClauses, draft) : liveClauses;
  const deductions = draft
    ? draftDeductions(liveDeductions, draft)
    : liveDeductions;
  const shown = visibleClauses(read);

  // A deal that stops being editable under an open form (the terms were sent
  // for review, the viewer lost the role) takes its forms with it, including
  // a new clause that was never saved.
  useEffect(() => {
    if (!rowsEditable) setNewPerson(null);
  }, [rowsEditable]);

  // Every form key a rendered row owns. An open key outside this list
  // belongs to a row that went away (removed here, or by someone else and
  // brought in by a refetch) or to a deal that is no longer editable:
  // release the slot so nothing stays locked, and put focus on that
  // section's heading. The write banner stays.
  const rowFormKeys = [
    ...shown.flatMap((c) => {
      const ref = refOfPayeeId(read.payees, c.payeeId);
      return ref
        ? [`clause:${clauseTestId(testIdBase, clauseInputOf(c, ref))}`]
        : [];
    }),
    ...(newPerson
      ? [
          `clause:${clauseTestId(testIdBase, { ...NEW_CLAUSE, payee: newPerson.ref })}`,
        ]
      : []),
    ...(draft?.addedClauses ?? []).map(
      (c) => `clause:${clauseTestId(testIdBase, c)}`,
    ),
    ...(full && remainder ? ["rest"] : []),
    ...deductions.map((d) => costFormKey(`${testIdBase}-costs`, d.id)),
    costFormKey(`${testIdBase}-costs`, null),
    ...DEAL_PRESETS.map((p) => presetFormKey(testIdBase, p)),
  ];
  const liveFormKeys = rowsEditable ? rowFormKeys : [];
  const liveFormKeysJoined = liveFormKeys.join("|");
  useEffect(() => {
    const gone = releasedKey(slotState, liveFormKeysJoined.split("|"));
    if (gone === null) return;
    dispatchSlotAction({
      type: "prune",
      liveKeys: liveFormKeysJoined.split("|"),
    });
    const section = sectionOfKey(gone);
    focusSoon(() =>
      byTestId(
        section === "costs"
          ? `${testIdBase}-costs-title`
          : section === "presets"
            ? `${testIdBase}-presets`
            : `${testIdBase}-clauses-title`,
      ),
    );
  }, [slotState, liveFormKeysJoined, dispatchSlotAction, testIdBase]);

  const writeClauses = (
    nextClauses: DealClauseInput[],
    done: () => void,
    nextRest = remainder,
  ) => {
    if (!nextRest) return;
    if (draft && freeze) {
      // Collected, not sent: "Save and tell them" sends the lot.
      freeze.setDraft(
        withRemainder(
          withClauses(draft, liveClauses, nextClauses),
          liveRemainder,
          nextRest,
        ),
      );
      done();
      return;
    }
    write(
      clausesWrite({ clauses: nextClauses, deductions, remainder: nextRest }),
      done,
    );
  };
  const writeDeductions = (next: DealDeductionInput[], done: () => void) => {
    if (!remainder) return;
    if (draft && freeze) {
      freeze.setDraft(withDeductions(draft, liveDeductions, withDraftIds(next)));
      done();
      return;
    }
    write(clausesWrite({ clauses, deductions: next, remainder }), done);
  };

  // ── The frozen deal's band, footer and history ──────────────────────────
  const termsChangeCount = draft
    ? draftChangeCount(draft, {
        clauses: liveClauses,
        deductions: liveDeductions,
        remainder: liveRemainder,
      })
    : 0;
  const resaleChanged = changing && !!freeze?.resalePending;
  const changeCount = termsChangeCount + (resaleChanged ? 1 : 0);
  // Everyone the change notice reaches: each payee on the deal before or
  // after it, less whoever makes the change (the notice skips them).
  const asCandidate = (ref: DealPayeeRef): TellCandidate => ({
    kind: ref.kind,
    id: ref.id,
    name: nameOf(ref),
  });
  const tellNames = namesToTell(
    [
      ...[...liveClauses, ...clauses].map((c) => asCandidate(c.payee)),
      ...[...liveDeductions, ...deductions].map((d) =>
        asCandidate(d.creditedPayee),
      ),
      ...(liveRemainder ? [asCandidate(liveRemainder)] : []),
      ...(remainder ? [asCandidate(remainder)] : []),
      ...(freeze?.resaleRecipients ?? []),
    ],
    viewer,
  );
  const saveFrozenChange = () => {
    if (!freeze || !draft) return;
    freeze.saveChange(
      termsChangeCount > 0 && remainder
        ? clausesWrite({
            clauses,
            deductions: stripDraftIds(deductions),
            remainder,
          })
        : null,
      tellNames.length === 0,
    );
  };
  const draftClauseOf = (id: string | undefined | null) =>
    draft && id ? draft.clauses[id] : undefined;
  const liveCostById = new Map(
    liveDeductions.flatMap((d) => (d.id ? [[d.id, d] as const] : [])),
  );
  const removedCosts = draft
    ? liveDeductions.filter((d) => d.id && draft.deductions[d.id] === null)
    : [];

  const metaOf = (ref: DealPayeeRef): string => {
    const kind =
      ref.kind === "org" ? t("deals.kindGroup") : t("deals.kindPerson");
    const source = isPartyRef(parties, ref)
      ? t("deals.sourceParty")
      : suggestions.find((s) => sameRef(s.ref, ref))?.source === "lineup"
        ? t("deals.sourceLineup")
        : suggestions.some((s) => sameRef(s.ref, ref))
          ? t("deals.sourceBill")
          : t("deals.sourcePayee");
    return `${kind} · ${source}`;
  };
  const askedHint = (ref: DealPayeeRef) =>
    isPartyRef(parties, ref)
      ? null
      : t("deals.willBeAsked", { name: nameOf(ref) });

  // Only when a row on screen says "Settled directly" (the calculator agrees).
  const anySettledDirectly = showsSettledDirectlyNote(
    read,
    full && !!remainder,
  );
  // The rest holder's per-order line (derived by every write) means the rest
  // is paid as tickets sell; without one, it waits for settlement.
  const restLineIds = new Set(
    read.clauses
      .filter((c) => c.role === "REMAINDER_PER_ORDER")
      .map((c) => c.id),
  );
  const restIsPaidPerOrder = restPaidPerOrder(read);
  const remainderCredited =
    !!remainder && deductions.some((d) => sameRef(d.creditedPayee, remainder));
  const drift =
    read.perOrderPercentTotal !== null &&
    read.perOrderPercentTotal !== 100 &&
    shown.length > 0;

  const restOptions = parties;

  return (
    <div
      className={styles.root}
      data-testid={testIdBase}
      data-state={editable ? "editable" : "read-only"}
    >
      {header}

      {freeze ? (
        <FrozenBand
          phase={freeze.phase}
          frozenAt={freeze.frozenAt}
          frozenByName={freeze.frozenByName}
          frozenAutomatically={freeze.frozenAutomatically}
          timeZone={freeze.timeZone}
          tellNames={tellNames}
          onChange={editable ? freeze.enterChange : undefined}
          busy={busy}
          testIdBase={testIdBase}
        >
          {changing && freeze.changedUnder ? (
            <p
              className={styles.notice}
              role="status"
              data-testid={`${testIdBase}-changed-under`}
            >
              <Info size={16} strokeWidth={2} aria-hidden />
              <span>
                {freeze.droppedUnder === 0
                  ? t("deals.freeze.changedUnder")
                  : freeze.droppedUnder === 1
                    ? t("deals.freeze.changedUnderDroppedOne")
                    : t("deals.freeze.changedUnderDroppedMany", {
                        count: freeze.droppedUnder,
                      })}
              </span>
            </p>
          ) : null}
          {changing && freeze.changeError ? (
            <p
              className={`${styles.blockBody} ${styles.dangerText}`}
              role="alert"
              data-testid={`${testIdBase}-change-error`}
            >
              {freeze.changeError}
            </p>
          ) : null}
        </FrozenBand>
      ) : null}

      {read.notEditableReason ? (
        <p className={styles.notice} data-testid={`${testIdBase}-read-only`}>
          <Info size={16} strokeWidth={2} aria-hidden />
          <span>{t(NOT_EDITABLE_KEYS[read.notEditableReason])}</span>
        </p>
      ) : null}
      {!full ? (
        <p className={styles.notice}>
          <Info size={16} strokeWidth={2} aria-hidden />
          <span>{t("deals.ownLineHint")}</span>
        </p>
      ) : null}

      {errorBanner}

      {editable && !freeze ? (
        <PresetPicker
          current={currentPresetOf(read)}
          defaultsFor={(p) =>
            presetDefaults(
              p,
              read,
              parties,
              presetCandidates(dealPeople, suggestions, parties),
              presetGuaranteeCents,
            )
          }
          people={people}
          parties={
            parties.length > 0
              ? parties
              : dealPeople.filter((p) => sameRef(p.ref, remainder))
          }
          editable={editable}
          busy={busy}
          onApply={(values, done) => write(presetWrite(values, read), done)}
          testIdBase={testIdBase}
        />
      ) : null}

      <section
        className={styles.presets}
        aria-labelledby={`${testIdBase}-clauses-title`}
      >
        <div className={styles.sectionHead}>
          <h4
            id={`${testIdBase}-clauses-title`}
            className={styles.sectionTitle}
            tabIndex={-1}
            data-testid={`${testIdBase}-clauses-title`}
          >
            {t("deals.clauses")}
          </h4>
          {full ? (
            <span className={styles.hint}>
              {t(
                target.kind === "EVENT"
                  ? "deals.clausesHintEvent"
                  : target.kind === "ORG_DEFAULT"
                    ? "deals.clausesHintDefault"
                    : "deals.clausesHint",
              )}
            </span>
          ) : null}
        </div>

        {shown.length === 0 && !newPerson && !remainder ? (
          <p className={styles.hint}>{t("deals.noClauses")}</p>
        ) : null}

        <ul className={styles.list} data-testid={clauseListId}>
          {shown.map((c, index) => {
            const ref = refOfPayeeId(read.payees, c.payeeId);
            if (!ref) return null;
            const name = nameOfId(c.payeeId);
            const input = clauseInputOf(c, ref);
            // While the frozen terms change: this row's edit, if any.
            const edit = draftClauseOf(c.id);
            return (
              <ClauseRow
                key={c.id}
                clause={edit ?? input}
                name={name}
                meta={metaOf(ref)}
                agreement={clauseAgreementOf(c)}
                stage1={c.stage1}
                editable={rowsEditable}
                unsaved={
                  edit === null
                    ? { was: input, removed: true }
                    : edit
                      ? { was: input }
                      : null
                }
                busy={busy}
                askedHint={askedHint(ref)}
                onSave={(next, done) =>
                  writeClauses(
                    clauses.map((x) => (x.id === c.id ? next : x)),
                    done,
                  )
                }
                onRemove={() =>
                  writeClauses(
                    clauses.filter((x) => x.id !== c.id),
                    () => {
                      closeAnyForm();
                      focusAfterRemoval(index);
                    },
                  )
                }
                testIdBase={testIdBase}
              />
            );
          })}

          {(draft?.addedClauses ?? []).map((c, index) => (
            <ClauseRow
              key={`added-${index}-${refKey(c.payee)}`}
              clause={c}
              name={nameOf(c.payee)}
              meta={metaOf(c.payee)}
              agreement={null}
              stage1={null}
              editable={rowsEditable}
              unsaved={{ was: null }}
              busy={busy}
              askedHint={askedHint(c.payee)}
              onSave={(next, done) =>
                writeClauses(
                  clauses.map((x) => (x === c ? next : x)),
                  done,
                )
              }
              onRemove={() =>
                writeClauses(
                  clauses.filter((x) => x !== c),
                  () => {
                    closeAnyForm();
                    focusSoon(() => byTestId(`${testIdBase}-clauses-title`));
                  },
                )
              }
              testIdBase={testIdBase}
            />
          ))}

          {newPerson ? (
            <ClauseRow
              key={`new-${refKey(newPerson.ref)}`}
              clause={{ ...NEW_CLAUSE, payee: newPerson.ref }}
              name={newPerson.name}
              meta={metaOf(newPerson.ref)}
              agreement={null}
              stage1={null}
              editable={rowsEditable}
              busy={busy}
              isNew
              askedHint={askedHint(newPerson.ref)}
              onSave={(next, done) => {
                const payeeKey = `${newPerson.ref.kind}:${newPerson.ref.id}`;
                writeClauses([...clauses, next], () => {
                  done();
                  setNewPerson(null);
                  // Focus the saved clause's Edit (its row now has an id).
                  focusSoon(() => {
                    const rows = byTestId(
                      clauseListId,
                    )?.querySelectorAll<HTMLElement>(
                      `[data-payee="${payeeKey}"]`,
                    );
                    return rows?.[rows.length - 1]?.querySelector<HTMLElement>(
                      '[data-testid$="-edit"]',
                    );
                  });
                });
              }}
              onRemove={null}
              onCancelNew={() => {
                setNewPerson(null);
                focusSoon(() => byTestId(`${testIdBase}-search`));
              }}
              testIdBase={testIdBase}
            />
          ) : null}

          {full && remainder ? (
            <li
              className={styles.clauseRow}
              data-testid={`${testIdBase}-rest`}
              data-deal-row="rest"
            >
              <div className={styles.who}>
                <span className={styles.whoName}>{nameOf(remainder)}</span>
                <span className={styles.whoMeta}>{metaOf(remainder)}</span>
              </div>
              {restForm.isOpen ? (
                <RestForm
                  key={restForm.seed}
                  changed={restForm.changed ? nameOf(remainder) : null}
                  current={remainder}
                  options={restOptions}
                  busy={busy}
                  testId={`${testIdBase}-rest`}
                  onCancel={() => {
                    restForm.closeForm();
                    focusRestEdit();
                  }}
                  onSave={(next) =>
                    writeClauses(
                      clauses,
                      () => {
                        restForm.closeForm();
                        focusRestEdit();
                      },
                      next,
                    )
                  }
                />
              ) : (
                <>
                  <div className={styles.terms}>
                    {draft?.remainder && liveRemainder ? (
                      <>
                        <p className={styles.termsLine}>
                          <s className={`${styles.was} ${styles.termsWas}`}>
                            <span className={styles.srOnly}>
                              {t("deals.history.before")}{" "}
                            </span>
                            {t("deals.freeze.restWas", {
                              name: nameOf(liveRemainder),
                            })}
                          </s>
                        </p>
                        <NotSaved testId={`${testIdBase}-rest-not-saved`} />
                      </>
                    ) : null}
                    <p className={styles.termsLine}>
                      <span className={styles.termsMain}>
                        {t("deals.restMain")}
                      </span>
                      {remainderCredited ? (
                        <span>{t("deals.restTail")}</span>
                      ) : null}
                    </p>
                    <span className={styles.stamp}>
                      {restIsPaidPerOrder
                        ? t("deals.paidThrough")
                        : t("deals.settledDirectly")}
                    </span>
                  </div>
                  <div className={styles.rowSide}>
                    <AgreementTag
                      agreement={{ kind: "WITH_THE_TERMS" }}
                      name={nameOf(remainder)}
                    />
                    {rowsEditable && restOptions.length > 1 ? (
                      <Button
                        variant="secondary"
                        size="$3"
                        onPress={restForm.openForm}
                        disabled={busy || restForm.blocked}
                        aria-label={t("deals.changeRest")}
                        testID={`${testIdBase}-rest-edit`}
                      >
                        <Pencil size={14} strokeWidth={2} aria-hidden />
                        {t("deals.edit")}
                      </Button>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          ) : null}
        </ul>

        {anySettledDirectly ? (
          <p className={styles.notice}>
            <Info size={16} strokeWidth={2} aria-hidden />
            <span>
              {remainder
                ? t("deals.settledDirectlyNote", { name: nameOf(remainder) })
                : t("deals.settledDirectlyNoteNoRest")}
            </span>
          </p>
        ) : null}
        {drift ? (
          <p className={styles.notice} data-testid={`${testIdBase}-drift`}>
            <Info size={16} strokeWidth={2} aria-hidden />
            <span>
              {t("deals.drift", { percent: read.perOrderPercentTotal ?? 0 })}
            </span>
          </p>
        ) : null}

        {rowsEditable && !newPerson ? (
          <PayeePicker
            suggestions={suggestions}
            // A payee added in this change (not saved yet) is taken too.
            taken={[
              ...dealPeople.map((p) => p.ref),
              ...(draft?.addedClauses ?? []).map((c) => c.payee),
            ]}
            disabled={busy || pickerSlot.blocked}
            onPick={(p) => {
              setNewPerson(p);
              setPicked((list) => [...list, p]);
              openForm(
                `clause:${clauseTestId(testIdBase, { ...NEW_CLAUSE, payee: p.ref })}`,
              );
            }}
            testIdBase={testIdBase}
          />
        ) : null}
      </section>

      {full || read.deductions.length > 0 ? (
        <OffTheTop
          deductions={deductions}
          nameOf={nameOf}
          creditable={dedupePeople([...parties, ...dealPeople])}
          editable={rowsEditable}
          busy={busy}
          onChange={writeDeductions}
          unsavedOf={
            draft
              ? (d) => {
                  // Added in this change: no id yet, or a client one.
                  if (!d.id || isDraftId(d.id)) return { was: null };
                  return draft.deductions[d.id]
                    ? { was: liveCostById.get(d.id) ?? null }
                    : null;
                }
              : undefined
          }
          removed={removedCosts}
          testIdBase={testIdBase}
        />
      ) : null}

      {resaleSlotOf(resaleSlot, testIdBase)}

      {changing && freeze ? (
        <ChangeFooter
          count={changeCount}
          tellNames={tellNames}
          canSave={
            changeCount > 0 &&
            slotState.key === null &&
            !newPerson &&
            (!freeze.resalePending || freeze.resalePending.valid)
          }
          busy={busy}
          onSave={saveFrozenChange}
          onDiscard={freeze.discardChange}
          testIdBase={testIdBase}
        />
      ) : (
        <DealCalculator
          target={target}
          nameOf={nameOfId}
          restLineIds={restLineIds}
          testIdBase={testIdBase}
        />
      )}

      {freeze?.phase === "frozen" &&
      freeze.changes &&
      freeze.changes.items.length > 0 ? (
        <DealChanges first={freeze.changes} testIdBase={testIdBase} />
      ) : null}
    </div>
  );
}

function RestForm({
  changed,
  current,
  options,
  busy,
  testId,
  onCancel,
  onSave,
}: {
  /** Set (to who takes the rest now) when the deal changed under this form. */
  changed: string | null;
  current: DealPayeeRef;
  options: readonly DealPerson[];
  busy: boolean;
  testId: string;
  onCancel: () => void;
  onSave: (next: DealPayeeRef) => void;
}) {
  const { t } = useDealWords();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstField(formRef);
  const [value, setValue] = useState(refKey(current));
  const submit = () => {
    const next = options.find((o) => refKey(o.ref) === value)?.ref;
    if (next && !busy) onSave(next);
  };
  return (
    <form
      ref={formRef}
      className={`${styles.form} ${styles.rowForm}`}
      aria-label={t("deals.changeRest")}
      // @th/ui Buttons render type="submit", so Cancel and Remove would submit
      // too (a second write that undid a removal). Each button acts on press;
      // the form itself never submits.
      onSubmit={(e) => e.preventDefault()}
      data-testid={`${testId}-form`}
    >
      {changed !== null ? <ChangedNotice now={changed} /> : null}
      <div className={styles.field}>
        <label className={styles.kicker} htmlFor={`${testId}-select`}>
          {t("deals.form.rest")}
        </label>
        <select
          id={`${testId}-select`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          {options.map((o) => (
            <option key={refKey(o.ref)} value={refKey(o.ref)}>
              {o.name}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{t("deals.restHint")}</p>
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="$3"
          onPress={submit}
          disabled={busy}
          testID={`${testId}-save`}
        >
          {t("deals.save")}
        </Button>
        <Button
          variant="ghost"
          size="$3"
          onPress={onCancel}
          disabled={busy}
          testID={`${testId}-cancel`}
        >
          {t("deals.cancel")}
        </Button>
      </div>
    </form>
  );
}
