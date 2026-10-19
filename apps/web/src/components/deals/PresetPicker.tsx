"use client";

import { useId, useRef, useState } from "react";
import { Button, SegmentedControl } from "@th/ui";

import { centsToDollarsInput, percentFromText } from "@/lib/booking-agreements";
import { parseMoneyInputToCents } from "@/lib/money/parse-money-input";

import {
  DEAL_PRESETS,
  PRESET_FIELDS,
  refKey,
  type DealBasis,
  type DealPerson,
  type DealPresetKey,
  type PresetValues,
} from "./deal-model";
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

export const PRESET_LABEL_KEYS: Record<DealPresetKey, string> = {
  GUARANTEE: "deals.preset.guarantee",
  DOOR_SPLIT: "deals.preset.doorSplit",
  GUARANTEE_PLUS_PERCENT: "deals.preset.guaranteePlus",
  VERSUS: "deals.preset.versus",
  STRAIGHT_PERCENT: "deals.preset.straight",
  ROOM_RENTAL: "deals.preset.roomRental",
};

/**
 * FR-003a: Guarantee · Door split · Guarantee + % · Versus · Straight % ·
 * Room rental. The deal's current shape is pressed. Choosing a preset opens
 * its few numbers (prefilled from the deal as it stands); one Save writes
 * the clauses and costs in one step.
 */
export function PresetPicker({
  current,
  defaultsFor,
  people,
  parties,
  editable,
  busy,
  onApply,
  testIdBase,
}: {
  current: DealPresetKey | null;
  defaultsFor: (preset: DealPresetKey) => Partial<PresetValues>;
  /** Everyone the preset can name: parties, the deal's payees, suggestions. */
  people: readonly DealPerson[];
  /** Who can take the rest (and owe a shortfall). */
  parties: readonly DealPerson[];
  editable: boolean;
  busy: boolean;
  onApply: (values: PresetValues, done: () => void) => void;
  testIdBase: string;
}) {
  const { t } = useDealWords();
  const testId = `${testIdBase}-presets`;
  const kickerId = useId();
  // The open preset lives in the deal's one-form slot.
  const openKey = useCurrentDealForm();
  const { seed, changed } = useOpenFormFreshness();
  const openForm = useOpenDealForm();
  const closeForms = useCloseDealForms();
  const prefix = `preset:${testId}:`;
  const open = openKey?.startsWith(prefix)
    ? (openKey.slice(prefix.length) as DealPresetKey)
    : null;
  const blocked = openKey !== null && open === null;
  const close = (p: DealPresetKey) => {
    closeForms();
    focusSoon(() => byTestId(`${testId}-${p}`));
  };

  return (
    <div className={styles.presets} data-testid={testId}>
      <p id={kickerId} className={styles.kicker}>
        {t("deals.startFromPreset")}
      </p>
      <div className={styles.presetRow} role="group" aria-labelledby={kickerId}>
        {DEAL_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={styles.presetButton}
            aria-pressed={(open ?? current) === p}
            aria-expanded={editable ? open === p : undefined}
            disabled={!editable || busy || blocked}
            onClick={() => (open === p ? close(p) : openForm(`${prefix}${p}`))}
            data-testid={`${testId}-${p}`}
          >
            {t(PRESET_LABEL_KEYS[p])}
          </button>
        ))}
      </div>
      <p className={styles.hint}>{t("deals.presetHint")}</p>

      {open && editable ? (
        <PresetForm
          key={`${open}:${seed}`}
          changed={changed}
          preset={open}
          initial={defaultsFor(open)}
          people={people}
          parties={parties}
          busy={busy}
          testId={`${testId}-form`}
          onCancel={() => close(open)}
          onApply={(values) => onApply(values, () => close(open))}
        />
      ) : null}
    </div>
  );
}

function PresetForm({
  changed,
  preset,
  initial,
  people,
  parties,
  busy,
  testId,
  onCancel,
  onApply,
}: {
  /** The deal changed under this form; what the user typed is kept. */
  changed: boolean;
  preset: DealPresetKey;
  initial: Partial<PresetValues>;
  people: readonly DealPerson[];
  parties: readonly DealPerson[];
  busy: boolean;
  testId: string;
  onCancel: () => void;
  onApply: (values: PresetValues) => void;
}) {
  const { t } = useDealWords();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstField(formRef);
  const fields = PRESET_FIELDS[preset];
  const ids = {
    payee: useId(),
    rest: useId(),
    guarantee: useId(),
    percent: useId(),
    rental: useId(),
  };

  const [payee, setPayee] = useState(
    initial.payee ? refKey(initial.payee) : "",
  );
  const [rest, setRest] = useState(
    initial.remainder
      ? refKey(initial.remainder)
      : parties[0]
        ? refKey(parties[0].ref)
        : "",
  );
  const [guarantee, setGuarantee] = useState(
    centsToDollarsInput(initial.guaranteeCents ?? null),
  );
  const [percent, setPercent] = useState(
    initial.percent === undefined ? "" : String(initial.percent),
  );
  const [basis, setBasis] = useState<DealBasis>(initial.basis ?? "NET_POOL");
  const [rental, setRental] = useState(
    centsToDollarsInput(initial.rentalCents ?? null),
  );
  const [mode, setMode] = useState<"FIXED_FEE" | "RECOUPED_FROM_DOOR">(
    initial.rentalMode ?? "RECOUPED_FROM_DOOR",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isRental = preset === "ROOM_RENTAL";
  // Anyone but whoever takes the rest can be the act (or the place renting).
  const payeeOptions = people.filter((p) => refKey(p.ref) !== rest);

  const submit = () => {
    if (busy) return;
    const e: Record<string, string> = {};
    const payeeRef = people.find((p) => refKey(p.ref) === payee)?.ref;
    const restRef = parties.find((p) => refKey(p.ref) === rest)?.ref;
    if (!payeeRef)
      e.payee = t(isRental ? "deals.errors.pickPlace" : "deals.errors.pickAct");
    if (!restRef) e.rest = t("deals.errors.pickRest");
    if (payeeRef && restRef && refKey(payeeRef) === refKey(restRef))
      e.payee = t("deals.errors.sameAsRest");
    let guaranteeCents: number | undefined;
    let percentValue: number | undefined;
    let rentalCents: number | undefined;
    if (fields.guarantee) {
      const r = parseMoneyInputToCents(guarantee);
      if (r.ok && r.cents > 0) guaranteeCents = r.cents;
      else e.guarantee = t("deals.errors.amountInvalid");
    }
    if (fields.percent) {
      const p = percentFromText(percent);
      const min = fields.guarantee ? 1 : 0;
      if (p !== null && p >= min) percentValue = p;
      else e.percent = t("deals.errors.percentInvalid");
    }
    if (fields.rental) {
      const r = parseMoneyInputToCents(rental);
      if (r.ok && r.cents > 0) rentalCents = r.cents;
      else e.rental = t("deals.errors.amountInvalid");
    }
    setErrors(e);
    if (Object.keys(e).length > 0 || !payeeRef || !restRef) return;
    onApply({
      preset,
      payee: payeeRef,
      remainder: restRef,
      guaranteeCents,
      percent: percentValue,
      basis: fields.basis ? basis : undefined,
      rentalCents,
      rentalMode: fields.rental ? mode : undefined,
    });
  };

  const err = (key: string) =>
    errors[key] ? (
      <p id={`${testId}-${key}-err`} className={styles.fieldError}>
        {errors[key]}
      </p>
    ) : null;

  return (
    <form
      ref={formRef}
      className={styles.form}
      aria-label={t(PRESET_LABEL_KEYS[preset])}
      // @th/ui Buttons render type="submit", so Cancel and Remove would submit
      // too (a second write that undid a removal). Each button acts on press;
      // the form itself never submits.
      onSubmit={(e) => e.preventDefault()}
      data-testid={testId}
    >
      {changed ? <ChangedNotice now="" /> : null}
      <p className={styles.hint}>{t(`deals.presetExplain.${preset}`)}</p>

      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label className={styles.kicker} htmlFor={ids.payee}>
            {isRental ? t("deals.form.place") : t("deals.form.act")}
          </label>
          <select
            id={ids.payee}
            value={payee}
            aria-invalid={errors.payee ? true : undefined}
            aria-describedby={errors.payee ? `${testId}-payee-err` : undefined}
            onChange={(e) => setPayee(e.target.value)}
            data-testid={`${testId}-payee`}
          >
            <option value="">{t("deals.form.choose")}</option>
            {payeeOptions.map((p) => (
              <option key={refKey(p.ref)} value={refKey(p.ref)}>
                {p.name}
              </option>
            ))}
          </select>
          {err("payee")}
        </div>

        {parties.length > 1 || isRental ? (
          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={ids.rest}>
              {isRental ? t("deals.form.renter") : t("deals.form.rest")}
            </label>
            <select
              id={ids.rest}
              value={rest}
              aria-invalid={errors.rest ? true : undefined}
              aria-describedby={errors.rest ? `${testId}-rest-err` : undefined}
              onChange={(e) => setRest(e.target.value)}
              data-testid={`${testId}-rest`}
            >
              {parties.map((p) => (
                <option key={refKey(p.ref)} value={refKey(p.ref)}>
                  {p.name}
                </option>
              ))}
            </select>
            {err("rest")}
          </div>
        ) : null}

        {fields.guarantee ? (
          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={ids.guarantee}>
              {t("deals.form.guarantee")}
            </label>
            <div className={styles.affixed}>
              <span className={styles.affix} aria-hidden>
                $
              </span>
              <input
                id={ids.guarantee}
                inputMode="decimal"
                value={guarantee}
                aria-invalid={errors.guarantee ? true : undefined}
                aria-describedby={
                  errors.guarantee ? `${testId}-guarantee-err` : undefined
                }
                onChange={(e) => setGuarantee(e.target.value)}
                data-testid={`${testId}-guarantee`}
              />
            </div>
            {err("guarantee")}
          </div>
        ) : null}

        {fields.percent ? (
          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={ids.percent}>
              {preset === "DOOR_SPLIT"
                ? t("deals.form.percentOfPool")
                : preset === "STRAIGHT_PERCENT"
                  ? t("deals.form.percentOfTickets")
                  : t("deals.form.percentLabel")}
            </label>
            <div className={styles.affixed}>
              <input
                id={ids.percent}
                inputMode="numeric"
                value={percent}
                aria-invalid={errors.percent ? true : undefined}
                aria-describedby={
                  errors.percent ? `${testId}-percent-err` : undefined
                }
                onChange={(e) => setPercent(e.target.value)}
                data-testid={`${testId}-percent`}
              />
              <span className={styles.affix} aria-hidden>
                %
              </span>
            </div>
            {err("percent")}
          </div>
        ) : null}

        {fields.rental ? (
          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={ids.rental}>
              {t("deals.form.rental")}
            </label>
            <div className={styles.affixed}>
              <span className={styles.affix} aria-hidden>
                $
              </span>
              <input
                id={ids.rental}
                inputMode="decimal"
                value={rental}
                aria-invalid={errors.rental ? true : undefined}
                aria-describedby={
                  errors.rental ? `${testId}-rental-err` : undefined
                }
                onChange={(e) => setRental(e.target.value)}
                data-testid={`${testId}-rental`}
              />
            </div>
            {err("rental")}
          </div>
        ) : null}
      </div>

      {fields.basis ? (
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

      {fields.rental ? (
        <div className={styles.field}>
          <span className={styles.kicker}>{t("deals.form.rentalMode")}</span>
          <SegmentedControl<"FIXED_FEE" | "RECOUPED_FROM_DOOR">
            wrap
            value={mode}
            onChange={setMode}
            ariaLabel={t("deals.form.rentalMode")}
            options={[
              {
                value: "RECOUPED_FROM_DOOR",
                label: t("deals.form.rentalRecouped"),
              },
              { value: "FIXED_FEE", label: t("deals.form.rentalFixed") },
            ]}
            testIdBase={`${testId}-mode`}
          />
          <p className={styles.hint}>
            {mode === "FIXED_FEE"
              ? t("deals.form.rentalFixedHint")
              : t("deals.form.rentalRecoupedHint")}
          </p>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="$3"
          onPress={submit}
          disabled={busy}
          testID={`${testId}-apply`}
        >
          {t("deals.usePreset")}
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
