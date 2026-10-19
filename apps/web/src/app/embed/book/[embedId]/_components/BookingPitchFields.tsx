"use client";

import type { CSSProperties } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import {
  BOOKING_FEE_TYPES,
  BOOKING_LINEUP_MAX,
  BOOKING_LINEUP_MIN,
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_TECH_NEEDS_MAX,
  BOOKING_ACT_NAME_MAX,
  formatSetLength,
} from "@/app/p/[slug]/_components/blocks/request-to-play-form.helpers";
import {
  DANGER,
  STEEL_BLUE,
  TEXT_MUTED,
  inputLabelStyle,
  inputStyle,
} from "@/app/embed/[embedId]/_components/embed-theme";

import {
  EMBED_BOOKING_MAX_DATES,
  pitchFieldId,
  type EmbedPitchError,
  type EmbedPitchField,
  type EmbedPitchValues,
} from "./booking-widget-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared styles
// ─────────────────────────────────────────────────────────────────────────────

export const fieldColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

export const fieldErrorStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  color: DANGER,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 110,
  resize: "vertical",
  fontFamily: "inherit",
  lineHeight: 1.5,
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  fontFamily: "inherit",
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_MUTED,
};

const inlineTextButtonStyle: CSSProperties = {
  alignSelf: "flex-start",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  // Mobile tap-target floor.
  minHeight: 44,
  padding: "6px 8px",
  border: "none",
  borderRadius: 0,
  background: "none",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: STEEL_BLUE,
  cursor: "pointer",
  fontFamily: "inherit",
};

const errorBorder = (hasError: boolean): CSSProperties =>
  hasError ? { borderColor: DANGER } : {};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export type BookingPitchFieldsProps = {
  idBase: string;
  values: EmbedPitchValues;
  onChange: <K extends keyof EmbedPitchValues>(
    field: K,
    value: EmbedPitchValues[K],
  ) => void;
  /** Anonymous submissions must name the act; signed-in senders may skip it. */
  requireActName: boolean;
  /** First validation problem, rendered inline under its field. */
  error: EmbedPitchError | null;
  disabled: boolean;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
};

/**
 * The pitch fields shared by the anonymous and signed-in embed booking forms
 * (FR-002): act name, preferred dates (≤3), pitch message, and a collapsed
 * "More details" section with the optional fields. Strict-Swiss chrome,
 * inline-specific errors (NFR-005), labels on everything.
 */
export function BookingPitchFields({
  idBase,
  values,
  onChange,
  requireActName,
  error,
  disabled,
  detailsOpen,
  onDetailsOpenChange,
}: BookingPitchFieldsProps) {
  const today = new Date().toISOString().slice(0, 10);

  const fieldError = (field: EmbedPitchField): string | null =>
    error?.field === field ? error.message : null;

  const errorProps = (field: EmbedPitchField) => {
    const message = fieldError(field);
    return {
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `${pitchFieldId(idBase, field)}-error` : undefined,
    };
  };

  const renderError = (field: EmbedPitchField) => {
    const message = fieldError(field);
    if (!message) return null;
    return (
      <p id={`${pitchFieldId(idBase, field)}-error`} style={fieldErrorStyle}>
        {message}
      </p>
    );
  };

  const updateDate = (index: number, value: string) => {
    const next = [...values.preferredDates];
    next[index] = value;
    onChange("preferredDates", next);
  };

  const removeDate = (index: number) => {
    onChange(
      "preferredDates",
      values.preferredDates.filter((_, i) => i !== index),
    );
  };

  const detailsRegionId = `${idBase}-more-details`;

  return (
    <>
      {/* ── Act name ─────────────────────────────────────────────────── */}
      <div style={fieldColumnStyle}>
        <label
          htmlFor={pitchFieldId(idBase, "actName")}
          style={inputLabelStyle}
        >
          Act or band name{requireActName ? "" : " · Optional"}
        </label>
        <input
          id={pitchFieldId(idBase, "actName")}
          type="text"
          maxLength={BOOKING_ACT_NAME_MAX}
          value={values.actName}
          onChange={(e) => onChange("actName", e.target.value)}
          disabled={disabled}
          autoComplete="organization"
          style={{ ...inputStyle, ...errorBorder(Boolean(fieldError("actName"))) }}
          {...errorProps("actName")}
        />
        {renderError("actName")}
      </div>

      {/* ── Preferred dates ──────────────────────────────────────────── */}
      <div
        role="group"
        aria-labelledby={`${idBase}-dates-label`}
        style={fieldColumnStyle}
      >
        <span id={`${idBase}-dates-label`} style={inputLabelStyle}>
          Preferred dates
        </span>
        {values.preferredDates.map((value, index) => (
          <div key={index} style={{ display: "flex", gap: 8 }}>
            <input
              id={
                index === 0
                  ? pitchFieldId(idBase, "dates")
                  : `${pitchFieldId(idBase, "dates")}-${index}`
              }
              type="date"
              value={value}
              min={today}
              onChange={(e) => updateDate(index, e.target.value)}
              disabled={disabled}
              aria-label={`Preferred date ${index + 1}`}
              style={{
                ...inputStyle,
                flex: 1,
                ...(index === 0
                  ? errorBorder(Boolean(fieldError("dates")))
                  : {}),
              }}
              {...(index === 0 ? errorProps("dates") : {})}
            />
            {values.preferredDates.length > 1 && (
              <button
                type="button"
                onClick={() => removeDate(index)}
                disabled={disabled}
                aria-label={`Remove date ${index + 1}`}
                style={{
                  ...inlineTextButtonStyle,
                  alignSelf: "stretch",
                  minWidth: 44,
                  justifyContent: "center",
                }}
              >
                <X size={16} aria-hidden />
              </button>
            )}
          </div>
        ))}
        {values.preferredDates.length < EMBED_BOOKING_MAX_DATES && (
          <button
            type="button"
            onClick={() =>
              onChange("preferredDates", [...values.preferredDates, ""])
            }
            disabled={disabled}
            style={inlineTextButtonStyle}
          >
            + Add another date
          </button>
        )}
        {renderError("dates")}
      </div>

      {/* ── Pitch ────────────────────────────────────────────────────── */}
      <div style={fieldColumnStyle}>
        <label
          htmlFor={pitchFieldId(idBase, "message")}
          style={inputLabelStyle}
        >
          Your pitch
        </label>
        <textarea
          id={pitchFieldId(idBase, "message")}
          value={values.message}
          onChange={(e) => onChange("message", e.target.value)}
          disabled={disabled}
          maxLength={2000}
          placeholder="Who are you, what are you planning, and why this place?"
          style={{
            ...textareaStyle,
            ...errorBorder(Boolean(fieldError("message"))),
          }}
          {...errorProps("message")}
        />
        <p style={hintStyle}>
          At least 10 characters — a couple of sentences go a long way.
        </p>
        {renderError("message")}
      </div>

      {/* ── More details (collapsed optional fields) ─────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <button
          type="button"
          onClick={() => onDetailsOpenChange(!detailsOpen)}
          aria-expanded={detailsOpen}
          aria-controls={detailsRegionId}
          disabled={disabled}
          style={{
            ...inlineTextButtonStyle,
            alignSelf: "stretch",
            justifyContent: "flex-start",
            minHeight: 44,
            padding: "10px 0",
            borderTop: `2px solid ${STEEL_BLUE}`,
          }}
        >
          {detailsOpen ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
          More details · Optional
        </button>

        {detailsOpen && (
          <div
            id={detailsRegionId}
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ ...fieldColumnStyle, flex: 1, minWidth: 140 }}>
                <label
                  htmlFor={pitchFieldId(idBase, "genre")}
                  style={inputLabelStyle}
                >
                  Genre
                </label>
                <input
                  id={pitchFieldId(idBase, "genre")}
                  type="text"
                  maxLength={120}
                  value={values.genre}
                  onChange={(e) => onChange("genre", e.target.value)}
                  disabled={disabled}
                  style={inputStyle}
                />
              </div>
              <div style={{ ...fieldColumnStyle, flex: 1, minWidth: 140 }}>
                <label
                  htmlFor={pitchFieldId(idBase, "lineupSize")}
                  style={inputLabelStyle}
                >
                  Lineup size
                </label>
                <input
                  id={pitchFieldId(idBase, "lineupSize")}
                  type="number"
                  inputMode="numeric"
                  min={BOOKING_LINEUP_MIN}
                  max={BOOKING_LINEUP_MAX}
                  step={1}
                  value={values.lineupSize}
                  onChange={(e) => onChange("lineupSize", e.target.value)}
                  disabled={disabled}
                  style={{
                    ...inputStyle,
                    ...errorBorder(Boolean(fieldError("lineupSize"))),
                  }}
                  {...errorProps("lineupSize")}
                />
                {renderError("lineupSize")}
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ ...fieldColumnStyle, flex: 1, minWidth: 140 }}>
                <label
                  htmlFor={pitchFieldId(idBase, "setLength")}
                  style={inputLabelStyle}
                >
                  Set length
                </label>
                <select
                  id={pitchFieldId(idBase, "setLength")}
                  value={values.setLengthMinutes}
                  onChange={(e) => onChange("setLengthMinutes", e.target.value)}
                  disabled={disabled}
                  style={{
                    ...selectStyle,
                    ...errorBorder(Boolean(fieldError("setLength"))),
                  }}
                  {...errorProps("setLength")}
                >
                  <option value="">Not sure yet</option>
                  {BOOKING_SET_LENGTH_PRESETS.map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      {formatSetLength(minutes)}
                    </option>
                  ))}
                </select>
                {renderError("setLength")}
              </div>
              <div style={{ ...fieldColumnStyle, flex: 1, minWidth: 140 }}>
                <label
                  htmlFor={pitchFieldId(idBase, "expectedDraw")}
                  style={inputLabelStyle}
                >
                  Expected draw
                </label>
                <input
                  id={pitchFieldId(idBase, "expectedDraw")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={values.expectedDraw}
                  onChange={(e) => onChange("expectedDraw", e.target.value)}
                  disabled={disabled}
                  style={{
                    ...inputStyle,
                    ...errorBorder(Boolean(fieldError("expectedDraw"))),
                  }}
                  {...errorProps("expectedDraw")}
                />
                {renderError("expectedDraw")}
              </div>
            </div>

            <div style={fieldColumnStyle}>
              <label
                htmlFor={pitchFieldId(idBase, "techNeeds")}
                style={inputLabelStyle}
              >
                Tech or backline needs
              </label>
              <textarea
                id={pitchFieldId(idBase, "techNeeds")}
                value={values.techNeeds}
                onChange={(e) => onChange("techNeeds", e.target.value)}
                disabled={disabled}
                maxLength={BOOKING_TECH_NEEDS_MAX}
                style={{
                  ...textareaStyle,
                  minHeight: 70,
                  ...errorBorder(Boolean(fieldError("techNeeds"))),
                }}
                {...errorProps("techNeeds")}
              />
              {renderError("techNeeds")}
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ ...fieldColumnStyle, flex: 1, minWidth: 140 }}>
                <label
                  htmlFor={`${idBase}-feeType`}
                  style={inputLabelStyle}
                >
                  Fee ask
                </label>
                <select
                  id={`${idBase}-feeType`}
                  value={values.feeType}
                  onChange={(e) => {
                    const next = e.target
                      .value as EmbedPitchValues["feeType"];
                    onChange("feeType", next);
                    // Mirror the server cross-field rule: an amount only rides
                    // GUARANTEE / DOOR_SPLIT — clear it otherwise so a stale
                    // value can never be submitted.
                    if (next !== "GUARANTEE" && next !== "DOOR_SPLIT") {
                      onChange("feeAmountDollars", "");
                    }
                  }}
                  disabled={disabled}
                  style={selectStyle}
                >
                  <option value="">Not specified</option>
                  {BOOKING_FEE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type === "GUARANTEE"
                        ? "Guarantee"
                        : type === "DOOR_SPLIT"
                          ? "Door split"
                          : "Negotiable"}
                    </option>
                  ))}
                </select>
              </div>
              {(values.feeType === "GUARANTEE" ||
                values.feeType === "DOOR_SPLIT") && (
                <div style={{ ...fieldColumnStyle, flex: 1, minWidth: 140 }}>
                  <label
                    htmlFor={pitchFieldId(idBase, "feeAmount")}
                    style={inputLabelStyle}
                  >
                    Amount · USD
                  </label>
                  <input
                    id={pitchFieldId(idBase, "feeAmount")}
                    type="text"
                    inputMode="decimal"
                    maxLength={12}
                    placeholder="0.00"
                    value={values.feeAmountDollars}
                    onChange={(e) =>
                      onChange("feeAmountDollars", e.target.value)
                    }
                    disabled={disabled}
                    style={{
                      ...inputStyle,
                      ...errorBorder(Boolean(fieldError("feeAmount"))),
                    }}
                    {...errorProps("feeAmount")}
                  />
                  {renderError("feeAmount")}
                </div>
              )}
            </div>

            {(
              [
                { key: "linkMusic", label: "Music link" },
                { key: "linkVideo", label: "Live video link" },
                { key: "linkSocial", label: "Social link" },
                { key: "linkEpk", label: "EPK link" },
              ] as const
            ).map((slot, slotIndex) => (
              <div key={slot.key} style={fieldColumnStyle}>
                <label
                  htmlFor={
                    slotIndex === 0
                      ? pitchFieldId(idBase, "links")
                      : `${idBase}-${slot.key}`
                  }
                  style={inputLabelStyle}
                >
                  {slot.label}
                </label>
                <input
                  id={
                    slotIndex === 0
                      ? pitchFieldId(idBase, "links")
                      : `${idBase}-${slot.key}`
                  }
                  type="url"
                  placeholder="https://"
                  value={values[slot.key]}
                  onChange={(e) => onChange(slot.key, e.target.value)}
                  disabled={disabled}
                  style={{
                    ...inputStyle,
                    ...(slotIndex === 0
                      ? errorBorder(Boolean(fieldError("links")))
                      : {}),
                  }}
                  {...(slotIndex === 0 ? errorProps("links") : {})}
                />
                {slotIndex === 0 && renderError("links")}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
