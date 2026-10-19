"use client";

import { forwardRef, useId, useState, type ReactNode } from "react";
import { Button, Text, useTranslations } from "@th/ui";

import {
  ARRIVAL_AREA_LABEL_MAX,
  ARRIVAL_AREA_NOTE_MAX,
  ARRIVAL_AREA_PRICE_TEXT_MAX,
  COST_ORDER,
  KIND_ORDER,
  validateAreaForm,
  type AreaDraft,
  type AreaFormErrors,
  type AreaFormFields,
} from "./arrival-areas-editor.helpers";
import { COST_LABEL_KEY, KIND_LABEL_KEY } from "./arrival-areas";
import styles from "./arrival-areas-editor.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// The selected area's form (arrival-areas FR-001, board section 3): kind,
// label, cost, price text (paid only), note, accessible spots. No hours, no
// booking links (R1 Q4, Q12).
//
// Validation timing (DS v2 §6a): a field is checked when the person leaves
// it, its error clears as soon as they type, and Save re-checks everything.
// Only the label can fail on the client (required, 80 characters); the
// browser's maxLength holds the others. A failed Save moves focus to the
// label, the one field that can be wrong.
// ─────────────────────────────────────────────────────────────────────────────

export type ArrivalAreaFormProps = {
  draft: AreaDraft;
  dirty: boolean;
  saving: boolean;
  removing: boolean;
  onChange: (fields: AreaFormFields) => void;
  onSave: () => void;
  /** Discard unsaved changes, or close a clean form. */
  onDismiss: () => void;
  onRemove: () => void;
  /** Server-side notice (conflict, refusal), rendered above the fields. */
  notice?: ReactNode;
  /** Shown under the heading: why the area needs a look (FR-014). */
  flags?: ReactNode;
  /** Errors the parent forced (a failed Save); merged with blur errors. */
  submitErrors: AreaFormErrors;
  onClearSubmitError: (field: keyof AreaFormErrors) => void;
  /** Ids the parent focuses. */
  labelInputId: string;
  /** One below the heading the form sits under (no skipped levels). */
  headingLevel: 3 | 4;
};

export const ArrivalAreaForm = forwardRef<HTMLHeadingElement, ArrivalAreaFormProps>(
  function ArrivalAreaForm(
    {
      draft,
      dirty,
      saving,
      removing,
      onChange,
      onSave,
      onDismiss,
      onRemove,
      notice,
      flags,
      submitErrors,
      onClearSubmitError,
      labelInputId,
      headingLevel,
    },
    headingRef,
  ) {
    const t = useTranslations();
    const tr = (key: string, values?: Record<string, string | number>) =>
      String(t(key, values));
    const uid = useId();
    const [blurErrors, setBlurErrors] = useState<AreaFormErrors>({});
    const [confirmRemove, setConfirmRemove] = useState(false);
    const fields = draft.fields;
    const errors: AreaFormErrors = { ...blurErrors, ...submitErrors };
    const isNew = draft.areaId === null;
    // A moderator at a place that hides its address sees no note and no
    // price text (core withholds both, with the shape): the fields are not
    // offered, so an empty box can never read as "there is none".
    const withheld = draft.base?.geometryWithheld === true;
    const Heading = headingLevel === 3 ? "h3" : "h4";

    const set = <K extends keyof AreaFormFields>(key: K, value: AreaFormFields[K]) => {
      // Read-only while saving: a keystroke now would be lost when the
      // saved row replaces the draft.
      if (saving) return;
      onChange({ ...fields, [key]: value });
      if (key === "label" || key === "priceText" || key === "note") {
        const field = key as keyof AreaFormErrors;
        if (errors[field]) {
          setBlurErrors((prev) => {
            const next = { ...prev };
            delete next[field];
            return next;
          });
          onClearSubmitError(field);
        }
      }
    };

    const blur = (field: keyof AreaFormErrors) => {
      const found = validateAreaForm(fields)[field];
      setBlurErrors((prev) => {
        const next = { ...prev };
        if (found) (next as Record<string, string>)[field] = found;
        else delete next[field];
        return next;
      });
    };

    const labelErrorId = `${uid}-label-error`;
    const noteCountId = `${uid}-note-count`;
    const priceId = `${uid}-price`;
    const noteId = `${uid}-note`;
    const accessibleId = `${uid}-accessible`;

    return (
      <form
        className={styles.form}
        noValidate
        aria-labelledby={`${uid}-heading`}
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        data-testid="arrival-area-form"
      >
        <Heading
          id={`${uid}-heading`}
          ref={headingRef}
          tabIndex={-1}
          className={styles.formHead}
        >
          <Text variant="overline" weight="bold" tag="span">
            {tr(
              isNew
                ? "arrivalAreasEditor.formNewTitle"
                : "arrivalAreasEditor.formEditTitle",
            )}
          </Text>
        </Heading>

        {notice}
        {flags}

        <fieldset className={styles.field}>
          <legend className={styles.labelRow}>
            <Text variant="overline" tag="span">
              {tr("arrivalAreasEditor.fieldKind")}
            </Text>
          </legend>
          <div className={styles.seg}>
            {KIND_ORDER.map((kind) => (
              <label key={kind} className={styles.segOption}>
                <input
                  type="radio"
                  name={`${uid}-kind`}
                  value={kind}
                  checked={fields.kind === kind}
                  onChange={() => set("kind", kind)}
                />
                <span>{tr(KIND_LABEL_KEY[kind])}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={styles.field}>
          <label htmlFor={labelInputId} className={styles.labelRow}>
            <Text variant="overline" tag="span">
              {tr("arrivalAreasEditor.fieldLabel")}
            </Text>
          </label>
          <input
            id={labelInputId}
            className={styles.input}
            value={fields.label}
            maxLength={ARRIVAL_AREA_LABEL_MAX}
            required
            aria-required="true"
            aria-invalid={errors.label ? "true" : undefined}
            aria-describedby={errors.label ? labelErrorId : undefined}
            autoComplete="off"
            readOnly={saving}
            placeholder={tr("arrivalAreasEditor.fieldLabelPlaceholder")}
            onChange={(e) => set("label", e.target.value)}
            onBlur={() => blur("label")}
            data-testid="arrival-area-label"
          />
          {errors.label ? (
            <p id={labelErrorId} className={styles.fieldError}>
              {tr(
                errors.label === "required"
                  ? "arrivalAreasEditor.errorLabelRequired"
                  : "arrivalAreasEditor.errorLabelTooLong",
                { max: ARRIVAL_AREA_LABEL_MAX },
              )}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.labelRow}>
            <Text variant="overline" tag="span">
              {tr("arrivalAreasEditor.fieldCost")}
            </Text>
          </legend>
          <div className={styles.seg}>
            {COST_ORDER.map((cost) => (
              <label key={cost} className={styles.segOption}>
                <input
                  type="radio"
                  name={`${uid}-cost`}
                  value={cost}
                  checked={fields.cost === cost}
                  onChange={() => set("cost", cost)}
                />
                <span>{tr(COST_LABEL_KEY[cost])}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {fields.cost === "PAID" && !withheld ? (
          <div className={styles.field}>
            <label htmlFor={priceId} className={styles.labelRow}>
              <span>
                <Text variant="overline" tag="span">
                  {tr("arrivalAreasEditor.fieldPriceText")}
                </Text>{" "}
                <span className={styles.optional}>
                  {tr("arrivalAreasEditor.optional")}
                </span>
              </span>
            </label>
            <input
              id={priceId}
              className={styles.input}
              value={fields.priceText}
              maxLength={ARRIVAL_AREA_PRICE_TEXT_MAX}
              autoComplete="off"
              readOnly={saving}
              placeholder={tr("arrivalAreasEditor.fieldPriceTextPlaceholder")}
              onChange={(e) => set("priceText", e.target.value)}
              data-testid="arrival-area-price"
            />
          </div>
        ) : null}

        {withheld ? null : (
          <div className={styles.field}>
            <label htmlFor={noteId} className={styles.labelRow}>
              <span>
                <Text variant="overline" tag="span">
                  {tr("arrivalAreasEditor.fieldNote")}
                </Text>{" "}
                <span className={styles.optional}>
                  {tr("arrivalAreasEditor.optional")}
                </span>
              </span>
              <span id={noteCountId} className={styles.counter}>
                {fields.note.length} / {ARRIVAL_AREA_NOTE_MAX}
              </span>
            </label>
            <textarea
              id={noteId}
              className={styles.input}
              value={fields.note}
              maxLength={ARRIVAL_AREA_NOTE_MAX}
              aria-describedby={noteCountId}
              placeholder={tr("arrivalAreasEditor.fieldNotePlaceholder")}
              readOnly={saving}
              onChange={(e) => set("note", e.target.value)}
              data-testid="arrival-area-note"
            />
          </div>
        )}

        <label htmlFor={accessibleId} className={styles.check}>
          <input
            id={accessibleId}
            type="checkbox"
            checked={fields.accessibleSpots}
            onChange={(e) => set("accessibleSpots", e.target.checked)}
          />
          {tr("arrivalAreasEditor.fieldAccessibleSpots")}
        </label>

        {confirmRemove && !isNew ? (
          <div className={styles.confirm} role="group" aria-label={tr("arrivalAreasEditor.remove")}>
            <p>
              {tr("arrivalAreasEditor.removeConfirm", { label: draft.base?.label ?? "" })}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={`${styles.textButton} ${styles.danger}`}
                onClick={() => {
                  setConfirmRemove(false);
                  onRemove();
                }}
                disabled={removing}
                data-testid="arrival-area-remove-confirm"
              >
                {tr("arrivalAreasEditor.removeConfirmYes")}
              </button>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => setConfirmRemove(false)}
              >
                {tr("arrivalAreasEditor.removeConfirmNo")}
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.actions}>
          <Button
            variant="primary"
            size="$3"
            onPress={onSave}
            disabled={saving || !dirty}
            minHeight={44}
            data-testid="arrival-area-save"
          >
            {tr(saving ? "arrivalAreasEditor.saving" : "arrivalAreasEditor.save")}
          </Button>
          <button
            type="button"
            className={styles.textButton}
            onClick={onDismiss}
            disabled={saving}
            data-testid="arrival-area-dismiss"
          >
            {tr(dirty ? "arrivalAreasEditor.discard" : "arrivalAreasEditor.close")}
          </button>
          {!isNew && !confirmRemove ? (
            <button
              type="button"
              className={`${styles.textButton} ${styles.danger}`}
              onClick={() => setConfirmRemove(true)}
              disabled={saving || removing}
              data-testid="arrival-area-remove"
            >
              {tr("arrivalAreasEditor.remove")}
            </button>
          ) : null}
        </div>
      </form>
    );
  },
);
