"use client";

import { useId, useRef, useState } from "react";
import { Button, SegmentedControl } from "@th/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { centsToDollarsInput, percentFromText } from "@/lib/booking-agreements";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

import {
  refKey,
  sameRef,
  type DealDeductionInput,
  type DealDeductionKind,
  type DealPerson,
} from "./deal-model";
import { DealTag } from "./ClauseRow";
import { costFormKey } from "./deal-form-state";
import { NotSaved } from "./DealFreeze";
import {
  ChangedNotice,
  byTestId,
  focusSoon,
  useCloseDealForms,
  useCurrentDealForm,
  useFocusFirstField,
  useOpenDealForm,
  useOpenFormFreshness,
} from "./form-slot";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

const KIND_KEYS: Record<DealDeductionKind, string> = {
  RENTAL: "deals.costKind.rental",
  EXPENSE: "deals.costKind.expense",
  HOUSE_NUT: "deals.costKind.houseNut",
};

/**
 * "Off the top": costs taken from ticket money before the pool is split, in
 * waterfall order, each credited back to whoever fronted it. The section's
 * total is not summed here (no client money math); each row says its own
 * amount and the calculator shows what was actually recouped.
 */
export function OffTheTop({
  deductions,
  nameOf,
  creditable,
  editable,
  busy,
  onChange,
  unsavedOf,
  removed = [],
  testIdBase,
}: {
  deductions: readonly DealDeductionInput[];
  nameOf: (ref: DealPerson["ref"]) => string;
  /** Who a cost can be credited to: the parties and the deal's payees. */
  creditable: readonly DealPerson[];
  editable: boolean;
  busy: boolean;
  onChange: (next: DealDeductionInput[], done: () => void) => void;
  /**
   * Changing a frozen deal (freeze-the-deal FR-010): whether a cost holds an
   * edit not sent yet, and the cost as saved (null: added in this change).
   */
  unsavedOf?: (d: DealDeductionInput) => { was: DealDeductionInput | null } | null;
  /** Costs this change takes off, drawn struck under the list. */
  removed?: readonly DealDeductionInput[];
  testIdBase: string;
}) {
  const { t, money } = useDealWords();
  const amountOf = (d: DealDeductionInput) =>
    d.percent !== null && d.percent !== undefined
      ? t("deals.costPercent", { percent: d.percent })
      : money(d.amountCents ?? 0);
  const testId = `${testIdBase}-costs`;
  const { open, openCost, close } = useCostForms(testId);
  const { seed, changed } = useOpenFormFreshness();
  // Keyed by the cost's id, never its position: removing an earlier cost
  // elsewhere must not move an open form onto a different one.
  const editing: number | "new" | null =
    open === costFormKey(testId, null)
      ? "new"
      : (() => {
          const i = deductions.findIndex(
            (d) => d.id && costFormKey(testId, d.id) === open,
          );
          return i === -1 ? null : i;
        })();
  const anyOpen = open !== null;
  const nowOf = (d: DealDeductionInput) =>
    `${d.label}: ${
      d.percent !== null && d.percent !== undefined
        ? t("deals.costPercent", { percent: d.percent })
        : money(d.amountCents ?? 0)
    }`;

  const focusEditOf = (index: number) =>
    focusSoon(() => byTestId(`${testId}-${index}-edit`));
  const replaceAt = (index: number, next: DealDeductionInput | null) => {
    const list = [...deductions];
    if (next) list[index] = next;
    else list.splice(index, 1);
    onChange(list, () => {
      close();
      if (next) focusEditOf(index);
      // Removed: the cost now in its place, else the section heading.
      else
        focusSoon(
          () => byTestId(`${testId}-${index}-edit`),
          () => byTestId(`${testId}-title`),
        );
    });
  };

  return (
    <section
      className={styles.presets}
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <div className={styles.sectionHead}>
        <div className={styles.sectionHeadText}>
          <h4
            id={`${testId}-title`}
            className={styles.sectionTitle}
            tabIndex={-1}
            data-testid={`${testId}-title`}
          >
            {t("deals.offTheTop")}
          </h4>
          <p className={styles.hint}>{t("deals.offTheTopHint")}</p>
        </div>
      </div>

      {deductions.length === 0 && removed.length === 0 && editing !== "new" ? (
        <p className={styles.hint}>{t("deals.noCosts")}</p>
      ) : null}

      <ul className={styles.list}>
        {deductions.map((d, i) =>
          editing === i ? (
            <li
              key={d.id ?? i}
              className={`${styles.costRow} ${styles.costRowForm}`}
            >
              <CostForm
                key={seed}
                changed={changed ? nowOf(d) : null}
                initial={d}
                nameOf={nameOf}
                creditable={creditable}
                busy={busy}
                testId={`${testId}-${i}`}
                onCancel={() => {
                  close();
                  focusEditOf(i);
                }}
                onSave={(next) => replaceAt(i, next)}
                onRemove={() => replaceAt(i, null)}
              />
            </li>
          ) : (
            <li
              key={d.id ?? i}
              className={styles.costRow}
              data-testid={`${testId}-${i}`}
            >
              <div className={styles.who}>
                <span className={styles.whoName}>{d.label}</span>
                <span className={styles.whoMeta}>
                  {t(
                    d.kind === "RENTAL"
                      ? "deals.recoupedBy"
                      : "deals.frontedBy",
                    {
                      name: nameOf(d.creditedPayee),
                    },
                  )}
                </span>
              </div>
              <div className={styles.costSide}>
                {unsavedOf?.(d) ? (
                  <NotSaved testId={`${testId}-${i}-not-saved`} />
                ) : null}
                {d.estimated ? (
                  <DealTag tone="warning">{t("deals.estimated")}</DealTag>
                ) : null}
                {(() => {
                  const was = unsavedOf?.(d)?.was;
                  return was && amountOf(was) !== amountOf(d) ? (
                    <s className={styles.was}>
                      <span className={styles.srOnly}>
                        {t("deals.history.before")}{" "}
                      </span>
                      {amountOf(was)}
                    </s>
                  ) : null;
                })()}
                <span className={styles.costAmount}>{amountOf(d)}</span>
                {editable ? (
                  <Button
                    variant="ghost"
                    size="$3"
                    icon
                    onPress={() => openCost(d.id ?? null)}
                    disabled={busy || anyOpen}
                    aria-label={t("deals.editCost", { label: d.label })}
                    testID={`${testId}-${i}-edit`}
                  >
                    <Pencil size={15} strokeWidth={2} aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          ),
        )}
        {removed.map((d, i) => (
          <li
            key={`removed-${d.id ?? i}`}
            className={styles.costRow}
            data-testid={`${testId}-removed-${i}`}
          >
            <div className={styles.who}>
              <s className={`${styles.whoName} ${styles.was}`}>{d.label}</s>
              <span className={styles.whoMeta}>{t("deals.freeze.removed")}</span>
            </div>
            <div className={styles.costSide}>
              <NotSaved />
              <s className={styles.was}>{amountOf(d)}</s>
            </div>
          </li>
        ))}
      </ul>

      {editing === "new" ? (
        <CostForm
          key={seed}
          changed={changed ? "" : null}
          initial={null}
          nameOf={nameOf}
          creditable={creditable}
          busy={busy}
          testId={`${testId}-new`}
          onCancel={() => {
            close();
            focusSoon(() => byTestId(`${testId}-add`));
          }}
          onSave={(next) =>
            onChange([...deductions, next], () => {
              close();
              focusEditOf(deductions.length);
            })
          }
          onRemove={null}
        />
      ) : editable ? (
        <div>
          <Button
            variant="ghost"
            size="$3"
            onPress={() => openCost(null)}
            disabled={busy || anyOpen || creditable.length === 0}
            testID={`${testId}-add`}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t("deals.addCost")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function CostForm({
  changed,
  initial,
  nameOf,
  creditable,
  busy,
  testId,
  onCancel,
  onSave,
  onRemove,
}: {
  /** Set (to the cost as it is now) when the deal changed under this form. */
  changed: string | null;
  initial: DealDeductionInput | null;
  nameOf: (ref: DealPerson["ref"]) => string;
  creditable: readonly DealPerson[];
  busy: boolean;
  testId: string;
  onCancel: () => void;
  onSave: (next: DealDeductionInput) => void;
  onRemove: (() => void) | null;
}) {
  const { t } = useDealWords();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstField(formRef);
  const labelId = useId();
  const amountId = useId();
  const creditId = useId();
  const usesPercent =
    initial?.percent !== null && initial?.percent !== undefined;
  const [kind, setKind] = useState<DealDeductionKind>(
    initial?.kind ?? "EXPENSE",
  );
  const [label, setLabel] = useState(initial?.label ?? "");
  const [mode, setMode] = useState<"AMOUNT" | "PERCENT">(
    usesPercent ? "PERCENT" : "AMOUNT",
  );
  const [valueText, setValueText] = useState(
    usesPercent
      ? String(initial?.percent ?? "")
      : centsToDollarsInput(initial?.amountCents ?? null),
  );
  const firstCredit = creditable[0]?.ref;
  const [credited, setCredited] = useState(
    initial
      ? refKey(initial.creditedPayee)
      : firstCredit
        ? refKey(firstCredit)
        : "",
  );
  const [estimated, setEstimated] = useState(initial?.estimated ?? false);
  const [errors, setErrors] = useState<{ label?: string; value?: string }>({});

  const submit = () => {
    if (busy) return;
    const next: { label?: string; value?: string } = {};
    const trimmed = label.trim();
    if (!trimmed) next.label = t("deals.errors.labelRequired");
    let amountCents: number | null = null;
    let percent: number | null = null;
    if (mode === "PERCENT") {
      percent = percentFromText(valueText);
      if (percent === null) next.value = t("deals.errors.percentInvalid");
    } else {
      const r = parseMoneyInputToCents(valueText);
      if (r.ok) amountCents = r.cents;
      else next.value = t("deals.errors.amountInvalid");
    }
    setErrors(next);
    const creditedRef =
      creditable.find((p) => refKey(p.ref) === credited)?.ref ??
      (initial && refKey(initial.creditedPayee) === credited
        ? initial.creditedPayee
        : null);
    if (next.label || next.value || !creditedRef) return;
    onSave({
      ...(initial?.id ? { id: initial.id } : {}),
      kind,
      label: trimmed,
      amountCents,
      percent,
      creditedPayee: creditedRef,
      estimated,
    });
  };

  const kindLabel = (k: DealDeductionKind) => t(KIND_KEYS[k]);

  return (
    <form
      ref={formRef}
      className={styles.form}
      aria-label={
        initial
          ? t("deals.editCost", { label: initial.label })
          : t("deals.addCost")
      }
      // @th/ui Buttons render type="submit", so Cancel and Remove would submit
      // too (a second write that undid a removal). Each button acts on press;
      // the form itself never submits.
      onSubmit={(e) => e.preventDefault()}
      data-testid={`${testId}-form`}
    >
      {changed !== null ? <ChangedNotice now={changed} /> : null}
      <div className={styles.field}>
        <span className={styles.kicker}>{t("deals.form.costKind")}</span>
        <SegmentedControl<DealDeductionKind>
          wrap
          value={kind}
          onChange={(k) => {
            // A blank or untouched label follows the kind.
            if (!label.trim() || label === kindLabel(kind))
              setLabel(kindLabel(k));
            setKind(k);
          }}
          ariaLabel={t("deals.form.costKind")}
          options={(["RENTAL", "EXPENSE", "HOUSE_NUT"] as const).map((k) => ({
            value: k,
            label: kindLabel(k),
          }))}
          testIdBase={`${testId}-kind`}
        />
      </div>

      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label className={styles.kicker} htmlFor={labelId}>
            {t("deals.form.costLabel")}
          </label>
          <input
            id={labelId}
            value={label}
            maxLength={200}
            aria-invalid={errors.label ? true : undefined}
            aria-describedby={errors.label ? `${labelId}-err` : undefined}
            onChange={(e) => {
              setLabel(e.target.value);
              setErrors((x) => ({ ...x, label: undefined }));
            }}
            data-testid={`${testId}-label`}
          />
          {errors.label ? (
            <p id={`${labelId}-err`} className={styles.fieldError}>
              {errors.label}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.kicker} htmlFor={amountId}>
            {mode === "PERCENT"
              ? t("deals.form.costPercent")
              : t("deals.form.costAmount")}
          </label>
          <div className={styles.affixed}>
            {mode === "AMOUNT" ? (
              <span className={styles.affix} aria-hidden>
                $
              </span>
            ) : null}
            <input
              id={amountId}
              inputMode={mode === "PERCENT" ? "numeric" : "decimal"}
              value={valueText}
              aria-invalid={errors.value ? true : undefined}
              aria-describedby={errors.value ? `${amountId}-err` : undefined}
              onChange={(e) => {
                setValueText(e.target.value);
                setErrors((x) => ({ ...x, value: undefined }));
              }}
              data-testid={`${testId}-value`}
            />
            {mode === "PERCENT" ? (
              <span className={styles.affix} aria-hidden>
                %
              </span>
            ) : null}
          </div>
          {errors.value ? (
            <p id={`${amountId}-err`} className={styles.fieldError}>
              {errors.value}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.kicker} htmlFor={creditId}>
            {t("deals.form.creditedTo")}
          </label>
          <select
            id={creditId}
            value={credited}
            onChange={(e) => setCredited(e.target.value)}
            data-testid={`${testId}-credited`}
          >
            {creditable.map((p) => (
              <option key={refKey(p.ref)} value={refKey(p.ref)}>
                {p.name}
              </option>
            ))}
            {initial &&
            !creditable.some((p) => sameRef(p.ref, initial.creditedPayee)) ? (
              <option value={refKey(initial.creditedPayee)}>
                {nameOf(initial.creditedPayee)}
              </option>
            ) : null}
          </select>
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.kicker}>{t("deals.form.costAs")}</span>
        <SegmentedControl<"AMOUNT" | "PERCENT">
          wrap
          value={mode}
          onChange={(m) => {
            setMode(m);
            setValueText("");
          }}
          ariaLabel={t("deals.form.costAs")}
          options={[
            { value: "AMOUNT", label: t("deals.form.costAsAmount") },
            { value: "PERCENT", label: t("deals.form.costAsPercent") },
          ]}
          testIdBase={`${testId}-mode`}
        />
      </div>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={estimated}
          onChange={(e) => setEstimated(e.target.checked)}
          data-testid={`${testId}-estimated`}
        />
        <span>{t("deals.form.estimated")}</span>
      </label>

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
        {onRemove ? (
          <span className={styles.actionsEnd}>
            <Button
              variant="destructiveGhost"
              size="$3"
              onPress={onRemove}
              disabled={busy}
              testID={`${testId}-remove`}
            >
              <Trash2 size={14} strokeWidth={2} aria-hidden />
              {t("deals.removeCost")}
            </Button>
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Which cost form is open, kept in the deal's one-form slot under
 * `costFormKey` (the cost's id, or "new"). `open` is the open form's key,
 * whichever section it is in, or null.
 */
function useCostForms(testId: string) {
  const openForm = useOpenDealForm();
  const closeAll = useCloseDealForms();
  const open = useCurrentDealForm();
  return {
    open,
    openCost: (id: string | null) => openForm(costFormKey(testId, id)),
    close: closeAll,
  };
}
