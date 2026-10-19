"use client";

import { useId, useRef, useState } from "react";
import { Button, SegmentedControl } from "@th/ui";
import { Pencil, Trash2 } from "lucide-react";

import { centsToDollarsInput, percentFromText } from "@/lib/booking-agreements";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

import {
  clauseWordsOf,
  type ClauseAgreement,
  type DealAmountType,
  type DealBasis,
  type DealClauseInput,
  type DealResolution,
} from "./deal-model";
import {
  ChangedNotice,
  byTestId,
  focusSoon,
  useDealForm,
  useFocusFirstField,
} from "./form-slot";
import { NotSaved } from "./DealFreeze";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

/** A clause row's test id: keyed on the clause, since a payee can have several. */
export const clauseTestId = (testIdBase: string, clause: DealClauseInput) =>
  `${testIdBase}-clause-${clause.id ?? `new-${clause.payee.id}`}`;

/** One payee's clause: the plain-words line, and its editor. */
export function ClauseRow({
  clause,
  name,
  meta,
  agreement,
  stage1,
  editable,
  busy,
  isNew = false,
  askedHint,
  onSave,
  onRemove,
  onCancelNew,
  unsaved = null,
  testIdBase,
}: {
  clause: DealClauseInput;
  name: string;
  /** "Group · Party", "Person · From the bill". */
  meta: string;
  agreement: ClauseAgreement | null;
  stage1: "PAID_PER_ORDER" | "SETTLED_DIRECTLY" | null;
  editable: boolean;
  busy: boolean;
  /** A clause just added through the picker: its form is already open. */
  isNew?: boolean;
  /** Set when the payee is not a party: they will be asked to agree. */
  askedHint?: string | null;
  onSave: (next: DealClauseInput, done: () => void) => void;
  onRemove: (() => void) | null;
  /** For a clause that was never saved: drop it instead of removing. */
  onCancelNew?: () => void;
  /**
   * Changing a frozen deal (freeze-the-deal FR-010): this row holds an edit
   * not sent yet. `was` is the clause as saved (null: added in this change);
   * `removed` draws the saved clause struck, as taken off.
   */
  unsaved?: { was: DealClauseInput | null; removed?: boolean } | null;
  testIdBase: string;
}) {
  const { t, clauseWords } = useDealWords();
  const testId = clauseTestId(testIdBase, clause);
  const form = useDealForm(`clause:${testId}`);
  const editing = isNew || form.isOpen;
  const words = clauseWords(clause);
  const wordsText = `${words.main}${words.tail ?? ""}`;
  const was = unsaved?.was ? clauseWords(unsaved.was) : null;
  const focusEdit = () => focusSoon(() => byTestId(`${testId}-edit`));

  return (
    <li
      className={styles.clauseRow}
      data-testid={testId}
      data-deal-row="clause"
      data-payee={`${clause.payee.kind}:${clause.payee.id}`}
    >
      <div className={styles.who}>
        <span className={styles.whoName}>{name}</span>
        <span className={styles.whoMeta}>{meta}</span>
      </div>

      {editing ? (
        <ClauseForm
          key={form.seed}
          changed={form.changed ? (isNew ? "" : wordsText) : null}
          clause={clause}
          name={name}
          wordsText={wordsText}
          formLabel={
            isNew
              ? t("deals.newClauseFor", { name })
              : t("deals.editClauseFor", { name, words: wordsText })
          }
          busy={busy}
          askedHint={askedHint ?? null}
          testId={testId}
          onCancel={() => {
            form.closeForm();
            if (isNew) onCancelNew?.();
            else focusEdit();
          }}
          onSave={(next) =>
            onSave(next, () => {
              form.closeForm();
              if (!isNew) focusEdit();
            })
          }
          onRemove={onRemove}
        />
      ) : (
        <>
          <div className={styles.terms}>
            {unsaved?.removed ? (
              <p className={styles.termsLine}>
                <s className={`${styles.was} ${styles.termsWas}`}>
                  <span className={styles.srOnly}>
                    {t("deals.history.before")}{" "}
                  </span>
                  {wordsText}
                </s>
                <span className={styles.termsMain}>
                  {t("deals.freeze.removed")}
                </span>
              </p>
            ) : (
              <p className={styles.termsLine}>
                {was ? (
                  <s className={`${styles.was} ${styles.termsWas}`}>
                    <span className={styles.srOnly}>
                      {t("deals.history.before")}{" "}
                    </span>
                    {`${was.main}${was.tail ?? ""}`}
                  </s>
                ) : null}
                <span className={styles.termsMain}>{words.main}</span>
                {words.tail ? <span>{words.tail}</span> : null}
              </p>
            )}
            {unsaved ? (
              <NotSaved testId={`${testId}-not-saved`} />
            ) : null}
            {stage1 && !unsaved ? (
              <span className={styles.stamp}>
                {stage1 === "PAID_PER_ORDER"
                  ? t("deals.paidThrough")
                  : t("deals.settledDirectly")}
              </span>
            ) : null}
          </div>
          <div className={styles.rowSide}>
            {agreement ? (
              <AgreementTag agreement={agreement} name={name} />
            ) : null}
            {editable && !unsaved?.removed ? (
              <Button
                variant="secondary"
                size="$3"
                onPress={form.openForm}
                disabled={busy || form.blocked}
                aria-label={t("deals.editClauseFor", {
                  name,
                  words: wordsText,
                })}
                testID={`${testId}-edit`}
              >
                <Pencil size={14} strokeWidth={2} aria-hidden />
                {t("deals.edit")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

export type DealTagTone = "neutral" | "warning" | "agreed" | "declined";

const TAG_TONE_CLASS: Record<DealTagTone, string | undefined> = {
  neutral: styles.tagNeutral,
  warning: styles.tagWarning,
  agreed: styles.tagAgreed,
  declined: styles.tagDeclined,
};

/**
 * The board's outlined status tag: Plex Mono overline, a rule and text in one
 * status token, no fill. Drawn here rather than with `@th/ui` Badge, whose
 * fixed status hexes fall under 4.5:1 on Stub, and it wraps instead of
 * truncating a payee's name at 320.
 */
export function DealTag({
  tone,
  children,
}: {
  tone: DealTagTone;
  children: string;
}) {
  return (
    <span className={`${styles.tag} ${TAG_TONE_CLASS[tone] ?? ""}`}>
      {children}
    </span>
  );
}

/** Where a payee stands on their clause. */
export function AgreementTag({
  agreement,
  name,
}: {
  agreement: ClauseAgreement;
  name: string;
}) {
  const { t } = useDealWords();
  switch (agreement.kind) {
    case "WITH_THE_TERMS":
      return (
        <DealTag tone="neutral">{t("deals.agreement.withTheTerms")}</DealTag>
      );
    case "AGREED":
      return <DealTag tone="agreed">{t("deals.agreement.agreed")}</DealTag>;
    case "DECLINED":
      return <DealTag tone="declined">{t("deals.agreement.declined")}</DealTag>;
    case "COUNTERED":
      return (
        <DealTag tone="warning">
          {t("deals.agreement.countered", { name })}
        </DealTag>
      );
    case "WAITING":
      return (
        <DealTag tone="warning">
          {t("deals.agreement.waiting", { name })}
        </DealTag>
      );
  }
}

type FormErrors = { amount?: string; percent?: string };

function ClauseForm({
  changed,
  clause,
  name,
  wordsText,
  formLabel,
  busy,
  askedHint,
  testId,
  onCancel,
  onSave,
  onRemove,
}: {
  /** Set (to the clause's words now) when the deal changed under this form. */
  changed: string | null;
  clause: DealClauseInput;
  name: string;
  /** The clause as it stands, in words: part of the form's and Remove's names. */
  wordsText: string;
  formLabel: string;
  busy: boolean;
  askedHint: string | null;
  testId: string;
  onCancel: () => void;
  onSave: (next: DealClauseInput) => void;
  onRemove: (() => void) | null;
}) {
  const { t, money } = useDealWords();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstField(formRef);
  const amountId = useId();
  const percentId = useId();
  const [amountType, setAmountType] = useState<DealAmountType>(
    clause.amountType,
  );
  const [amountText, setAmountText] = useState(
    centsToDollarsInput(clause.amountCents ?? null),
  );
  const [percentText, setPercentText] = useState(
    clause.percent === null || clause.percent === undefined
      ? ""
      : String(clause.percent),
  );
  const [basis, setBasis] = useState<DealBasis>(clause.basis);
  const [resolution, setResolution] = useState<DealResolution>(
    clause.resolution ?? "GREATER_OF",
  );
  const [errors, setErrors] = useState<FormErrors>({});

  const hasAmount = amountType !== "PERCENT";
  const hasPercent = amountType !== "FIXED";

  const parseAmount = (): number | null => {
    const r = parseMoneyInputToCents(amountText);
    return r.ok && r.cents > 0 ? r.cents : null;
  };
  const parsePercent = (): number | null => {
    const p = percentFromText(percentText);
    if (p === null) return null;
    if (amountType === "FIXED_AND_PERCENT" && p < 1) return null;
    return p;
  };

  const draft = (): DealClauseInput | null => {
    const amountCents = hasAmount ? parseAmount() : null;
    const percent = hasPercent ? parsePercent() : null;
    const next: FormErrors = {};
    if (hasAmount && amountCents === null)
      next.amount = t("deals.errors.amountInvalid");
    if (hasPercent && percent === null)
      next.percent = t("deals.errors.percentInvalid");
    setErrors(next);
    if (next.amount || next.percent) return null;
    return {
      ...clause,
      amountType,
      amountCents,
      percent,
      basis,
      resolution: amountType === "FIXED_AND_PERCENT" ? resolution : null,
    };
  };

  // The preview reads the typed values. A blank or unreadable field shows as
  // "—": an unknown amount is never zero.
  const typedAmount = hasAmount ? parseAmount() : null;
  const typedPercent = hasPercent ? percentFromText(percentText) : null;
  const previewKeys = clauseWordsOf({
    amountType,
    amountCents: hasAmount ? 0 : null,
    percent: hasPercent ? 0 : null,
    basis,
    resolution: amountType === "FIXED_AND_PERCENT" ? resolution : null,
  });
  const previewValues = {
    amount: !hasAmount ? "" : typedAmount === null ? "—" : money(typedAmount),
    percent: !hasPercent ? 0 : typedPercent === null ? "—" : typedPercent,
  };
  const preview = {
    main: t(previewKeys.mainKey, previewValues),
    tail: previewKeys.tailKey ? t(previewKeys.tailKey) : null,
  };

  const submit = () => {
    if (busy) return;
    const next = draft();
    if (next) onSave(next);
  };

  return (
    <form
      ref={formRef}
      className={`${styles.form} ${styles.rowForm}`}
      aria-label={formLabel}
      // @th/ui Buttons render type="submit", so Cancel and Remove would submit
      // too (a second write that undid a removal). Each button acts on press;
      // the form itself never submits.
      onSubmit={(e) => e.preventDefault()}
      data-testid={`${testId}-form`}
    >
      {changed !== null ? <ChangedNotice now={changed} /> : null}
      <div className={styles.field}>
        <span className={styles.kicker}>{t("deals.form.shape")}</span>
        <SegmentedControl<DealAmountType>
          wrap
          value={amountType}
          onChange={setAmountType}
          ariaLabel={t("deals.form.shape")}
          options={[
            { value: "FIXED", label: t("deals.form.fixed") },
            { value: "PERCENT", label: t("deals.form.percent") },
            { value: "FIXED_AND_PERCENT", label: t("deals.form.both") },
          ]}
          testIdBase={`${testId}-shape`}
        />
      </div>

      <div className={styles.formGrid}>
        {hasAmount ? (
          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={amountId}>
              {t("deals.form.guarantee")}
            </label>
            <div className={styles.affixed}>
              <span className={styles.affix} aria-hidden>
                $
              </span>
              <input
                id={amountId}
                inputMode="decimal"
                value={amountText}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={errors.amount ? `${amountId}-err` : undefined}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  setErrors((x) => ({ ...x, amount: undefined }));
                }}
                data-testid={`${testId}-amount`}
              />
            </div>
            {errors.amount ? (
              <p id={`${amountId}-err`} className={styles.fieldError}>
                {errors.amount}
              </p>
            ) : null}
          </div>
        ) : null}
        {hasPercent ? (
          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={percentId}>
              {t("deals.form.percentLabel")}
            </label>
            <div className={styles.affixed}>
              <input
                id={percentId}
                inputMode="numeric"
                value={percentText}
                aria-invalid={errors.percent ? true : undefined}
                aria-describedby={
                  errors.percent ? `${percentId}-err` : undefined
                }
                onChange={(e) => {
                  setPercentText(e.target.value);
                  setErrors((x) => ({ ...x, percent: undefined }));
                }}
                data-testid={`${testId}-percent`}
              />
              <span className={styles.affix} aria-hidden>
                %
              </span>
            </div>
            {errors.percent ? (
              <p id={`${percentId}-err`} className={styles.fieldError}>
                {errors.percent}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {hasPercent ? (
        <div className={styles.field}>
          <span className={styles.kicker}>{t("deals.form.of")}</span>
          <SegmentedControl<DealBasis>
            wrap
            value={basis}
            onChange={setBasis}
            ariaLabel={t("deals.form.of")}
            options={[
              { value: "NET_POOL", label: t("deals.form.ofPool") },
              { value: "GROSS", label: t("deals.form.ofTickets") },
            ]}
            testIdBase={`${testId}-basis`}
          />
        </div>
      ) : null}

      {amountType === "FIXED_AND_PERCENT" ? (
        <div className={styles.field}>
          <span className={styles.kicker}>{t("deals.form.together")}</span>
          <SegmentedControl<DealResolution>
            wrap
            value={resolution}
            onChange={setResolution}
            ariaLabel={t("deals.form.together")}
            options={[
              { value: "GREATER_OF", label: t("deals.form.greater") },
              { value: "SUM", label: t("deals.form.sum") },
            ]}
            testIdBase={`${testId}-resolution`}
          />
        </div>
      ) : null}

      <p className={styles.termsLine} aria-live="polite">
        <span className={styles.termsMain}>{preview.main}</span>
        {preview.tail ? <span>{preview.tail}</span> : null}
      </p>
      {askedHint ? <p className={styles.hint}>{askedHint}</p> : null}

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
              aria-label={t("deals.removeClauseFor", {
                name,
                words: wordsText,
              })}
              testID={`${testId}-remove`}
            >
              <Trash2 size={14} strokeWidth={2} aria-hidden />
              {t("deals.remove")}
            </Button>
          </span>
        ) : null}
      </div>
    </form>
  );
}
