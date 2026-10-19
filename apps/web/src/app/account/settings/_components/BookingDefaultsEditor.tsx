"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import {
  BOOKING_ACT_NAME_MAX,
  BOOKING_FEE_CURRENCY,
  BOOKING_FEE_TYPES,
  BOOKING_LINEUP_MAX,
  BOOKING_LINEUP_MIN,
  BOOKING_MESSAGE_TEMPLATE_MAX,
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_TECH_NEEDS_MAX,
  buildBookingDefaultsPayload,
  centsToFeeAmountInput,
  formatSetLength,
  type BookingDefaultsField,
  type BookingDefaultsFieldErrorKey,
  type BookingDefaultsFormValues,
} from "@/app/p/[slug]/_components/blocks/request-to-play-form.helpers";
import formStyles from "@/app/p/[slug]/_components/blocks/RequestToPlayBlock.module.css";

/**
 * "Booking defaults" editor (performer-mode spec 2026-07-11; org mount
 * booking-review-data-weave WS1, 2026-07-13).
 *
 * A performer saves reusable pitch values here; the public booking-request form
 * (`RequestToPlayForm`) later prefills untouched fields from them. Mounted for
 * the HUMAN performer by `PerformerSection` (account settings) and for ORG
 * performers by `OrgSettingsView` (org admin settings) — the tRPC procedures
 * take `{ ownerType, ownerId }` and enforce authz server-side (self for
 * humans, org EDIT roles for orgs).
 *
 * Org differences: the verified-stats default and the genre-from-profile hint
 * are hidden — `create-booking-request` builds verified-stats snapshots and
 * genre prefill for HUMAN senders only.
 *
 * The fields, formatting, and client validation are shared with the booking
 * form via `request-to-play-form.helpers` so the two surfaces never drift. The
 * strict-Swiss field styling is reused from `RequestToPlayBlock.module.css`;
 * money renders in Montserrat with `tabular-nums` (the only brand font — no
 * mono webfont exists any more), so no font scoping is needed here.
 */
export function BookingDefaultsEditor({
  ownerType,
  ownerId,
}: {
  ownerType: "human" | "org";
  ownerId: string;
}) {
  const t = useTranslations();
  const idBase = useId();
  const utils = trpc.useUtils();

  const [actName, setActName] = useState("");
  const [lineupSize, setLineupSize] = useState("");
  const [setLength, setSetLength] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [techNeeds, setTechNeeds] = useState("");
  const [messageTemplate, setMessageTemplate] = useState("");
  const [feeType, setFeeType] =
    useState<BookingDefaultsFormValues["feeType"]>("");
  const [feeAmountDollars, setFeeAmountDollars] = useState("");
  const [linkMusic, setLinkMusic] = useState("");
  const [linkVideo, setLinkVideo] = useState("");
  const [linkSocial, setLinkSocial] = useState("");
  const [linkEpk, setLinkEpk] = useState("");
  const [includeVerifiedStats, setIncludeVerifiedStats] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<BookingDefaultsField, BookingDefaultsFieldErrorKey>>
  >({});
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [initialized, setInitialized] = useState(false);
  const savedKeyRef = useRef("");
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A concrete fee amount only makes sense for GUARANTEE / DOOR_SPLIT — same
  // cross-field UI as the booking form: hide AND clear the amount otherwise.
  const showFeeAmount = feeType === "GUARANTEE" || feeType === "DOOR_SPLIT";

  const values: BookingDefaultsFormValues = useMemo(
    () => ({
      actName,
      lineupSize,
      setLengthMinutes: setLength,
      contactPhone,
      techNeeds,
      messageTemplate,
      feeType,
      feeAmountDollars,
      linkMusic,
      linkVideo,
      linkSocial,
      linkEpk,
      includeVerifiedStats,
    }),
    [
      actName,
      lineupSize,
      setLength,
      contactPhone,
      techNeeds,
      messageTemplate,
      feeType,
      feeAmountDollars,
      linkMusic,
      linkVideo,
      linkSocial,
      linkEpk,
      includeVerifiedStats,
    ],
  );

  const isOrg = ownerType === "org";

  const defaultsQuery = trpc.performers.getBookingDefaults.useQuery(
    { ownerType, ownerId },
    { staleTime: 60_000, retry: false, meta: { silent: true } },
  );

  // Whether the human's verified stats clear the sharing threshold (3+ shows).
  // Gates the verified-stats checkbox below — an ineligible performer has
  // nothing to share (the server would only snapshot null). Deduped with
  // PerformerSection's query by react-query; never needed for orgs.
  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    enabled: !isOrg,
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });
  const statsEligible = statusQuery.data?.human.statsEligible === true;

  const updateMutation = trpc.performers.updateBookingDefaults.useMutation({
    retry: false,
    meta: { silent: true },
  });

  // Seed the form once from the saved defaults (all-null shape when none saved).
  useEffect(() => {
    if (initialized || !defaultsQuery.data) return;
    const d = defaultsQuery.data.defaults;
    const seeded: BookingDefaultsFormValues = {
      actName: d.actName ?? "",
      lineupSize: d.lineupSize != null ? String(d.lineupSize) : "",
      setLengthMinutes:
        d.setLengthMinutes != null ? String(d.setLengthMinutes) : "",
      contactPhone: d.contactPhone ?? "",
      techNeeds: d.techNeeds ?? "",
      messageTemplate: d.messageTemplate ?? "",
      feeType: (d.feeType ?? "") as BookingDefaultsFormValues["feeType"],
      feeAmountDollars:
        d.feeAmountCents != null ? centsToFeeAmountInput(d.feeAmountCents) : "",
      linkMusic: d.linkMusic ?? "",
      linkVideo: d.linkVideo ?? "",
      linkSocial: d.linkSocial ?? "",
      linkEpk: d.linkEpk ?? "",
      includeVerifiedStats: d.includeVerifiedStats === true,
    };
    setActName(seeded.actName);
    setLineupSize(seeded.lineupSize);
    setSetLength(seeded.setLengthMinutes);
    setContactPhone(seeded.contactPhone);
    setTechNeeds(seeded.techNeeds);
    setMessageTemplate(seeded.messageTemplate);
    setFeeType(seeded.feeType);
    setFeeAmountDollars(seeded.feeAmountDollars);
    setLinkMusic(seeded.linkMusic);
    setLinkVideo(seeded.linkVideo);
    setLinkSocial(seeded.linkSocial);
    setLinkEpk(seeded.linkEpk);
    setIncludeVerifiedStats(seeded.includeVerifiedStats);
    savedKeyRef.current = serialize(seeded);
    setInitialized(true);
  }, [initialized, defaultsQuery.data]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const isDirty = initialized && serialize(values) !== savedKeyRef.current;

  const clearErr = (field: BookingDefaultsField) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    if (saveState === "error") setSaveState("idle");
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (updateMutation.isPending || !isDirty) return;

    const result = buildBookingDefaultsPayload(values);
    if (!result.ok) {
      // Pure client validation — nothing was sent, so DON'T surface the generic
      // "couldn't save, try again" status. The inline per-field errors plus a
      // neutral "fix the highlighted fields" hint carry the message instead.
      setFieldErrors(result.errors);
      setSaveState("idle");
      return;
    }

    setFieldErrors({});
    setSaveState("saving");
    const submittedKey = serialize(values);
    updateMutation.mutate(
      { ownerType, ownerId, ...result.payload },
      {
        onSuccess: () => {
          savedKeyRef.current = submittedKey;
          setSaveState("saved");
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
          savedTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
          void utils.performers.getBookingDefaults.invalidate({
            ownerType,
            ownerId,
          });
        },
        onError: () => setSaveState("error"),
      },
    );
  };

  // ── Header + non-happy states ────────────────────────────────────────────
  const header = (
    <YStack gap="$1">
      <Text variant="body" weight="bold">
        {String(t("account.sBkDefTitle"))}
      </Text>
      <Text variant="caption" tone="muted">
        {String(t(isOrg ? "admin.bkDefOrgDesc" : "account.sBkDefDesc"))}
      </Text>
    </YStack>
  );

  if (defaultsQuery.isLoading) {
    return (
      <YStack gap="$3">
        {header}
        <XStack gap="$2" alignItems="center">
          <Spinner size="sm" />
          <Text variant="caption" tone="muted">
            {String(t("common.loading"))}
          </Text>
        </XStack>
      </YStack>
    );
  }

  if (defaultsQuery.isError) {
    return (
      <YStack gap="$3">
        {header}
        <Text variant="caption" color="$brandSecondary" role="alert">
          {String(t("account.sBkDefLoadFailed"))}
        </Text>
      </YStack>
    );
  }

  const statusText =
    saveState === "saving"
      ? String(t("account.sBkDefSaving"))
      : saveState === "saved"
        ? String(t("account.sBkDefSaved"))
        : saveState === "error"
          ? String(t("account.sBkDefSaveFailed"))
          : null;

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  const renderErr = (field: BookingDefaultsField) =>
    fieldErrors[field] ? (
      <p className={formStyles.errorText} role="alert">
        {String(t(fieldErrors[field] as BookingDefaultsFieldErrorKey))}
      </p>
    ) : null;

  return (
    <YStack gap="$3">
      {header}

      <form
        ref={formRef}
        className={formStyles.panelSettings}
        onSubmit={handleSubmit}
        aria-label={String(t("account.sBkDefTitle"))}
        noValidate
      >
        {/* ── Your act ────────────────────────────────────────────────── */}
        <div
          className={formStyles.section}
          role="group"
          aria-labelledby={`${idBase}-sec-act`}
        >
          <p className={formStyles.sectionHeading} id={`${idBase}-sec-act`}>
            {String(t("admin.bkFormSectionAct"))}
          </p>

          <div className={formStyles.fieldGroup}>
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-actName`}
            >
              {String(t("admin.bkFormActNameLabel"))}
            </label>
            <input
              id={`${idBase}-actName`}
              type="text"
              maxLength={BOOKING_ACT_NAME_MAX}
              className={formStyles.input}
              value={actName}
              onChange={(e) => {
                clearErr("actName");
                setActName(e.target.value);
              }}
              placeholder={String(t("admin.bkFormActNamePlaceholder"))}
            />
            {renderErr("actName")}
          </div>

          <div className={formStyles.fieldRow}>
            <div className={formStyles.fieldGroup}>
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-lineup`}
              >
                {String(t("admin.bkFormLineupLabel"))}
              </label>
              <input
                id={`${idBase}-lineup`}
                type="number"
                inputMode="numeric"
                min={BOOKING_LINEUP_MIN}
                max={BOOKING_LINEUP_MAX}
                step={1}
                className={formStyles.input}
                value={lineupSize}
                onChange={(e) => {
                  clearErr("lineupSize");
                  setLineupSize(e.target.value);
                }}
              />
              {renderErr("lineupSize")}
            </div>

            <div className={formStyles.fieldGroup}>
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-phone`}
              >
                {String(t("admin.bkFormPhoneLabel"))}
              </label>
              <input
                id={`${idBase}-phone`}
                type="tel"
                inputMode="tel"
                maxLength={30}
                className={formStyles.input}
                value={contactPhone}
                onChange={(e) => {
                  clearErr("contactPhone");
                  setContactPhone(e.target.value);
                }}
                placeholder={String(t("admin.bkFormPhonePlaceholder"))}
              />
              {renderErr("contactPhone")}
            </div>
          </div>
        </div>

        {/* ── The pitch (message template) ────────────────────────────── */}
        <div
          className={formStyles.section}
          role="group"
          aria-labelledby={`${idBase}-sec-pitch`}
        >
          <p className={formStyles.sectionHeading} id={`${idBase}-sec-pitch`}>
            {String(t("admin.bkFormSectionPitch"))}
          </p>

          <div className={formStyles.fieldGroup}>
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-message`}
            >
              {String(t("account.sBkDefMessageLabel"))}
            </label>
            <textarea
              id={`${idBase}-message`}
              className={formStyles.textarea}
              value={messageTemplate}
              onChange={(e) => {
                clearErr("messageTemplate");
                setMessageTemplate(e.target.value);
              }}
              placeholder={String(t("admin.bkFormMessagePlaceholder"))}
              maxLength={BOOKING_MESSAGE_TEMPLATE_MAX}
            />
            <p className={formStyles.fieldHint}>
              {String(t("account.sBkDefMessageHint"))}
            </p>
            {renderErr("messageTemplate")}
          </div>
        </div>

        {/* ── Performance ─────────────────────────────────────────────── */}
        <div
          className={formStyles.section}
          role="group"
          aria-labelledby={`${idBase}-sec-performance`}
        >
          <p
            className={formStyles.sectionHeading}
            id={`${idBase}-sec-performance`}
          >
            {String(t("admin.bkFormSectionPerformance"))}
          </p>

          <div className={formStyles.fieldGroup}>
            <label
              className={formStyles.fieldLabel}
              htmlFor={`${idBase}-setLength`}
            >
              {String(t("admin.bkFormSetLengthLabel"))}
            </label>
            <select
              id={`${idBase}-setLength`}
              className={formStyles.select}
              value={setLength}
              onChange={(e) => {
                clearErr("setLengthMinutes");
                setSetLength(e.target.value);
              }}
            >
              <option value="">{String(t("admin.bkFormUnspecified"))}</option>
              {BOOKING_SET_LENGTH_PRESETS.map((minutes) => (
                <option key={minutes} value={String(minutes)}>
                  {formatSetLength(minutes)}
                </option>
              ))}
            </select>
            {renderErr("setLengthMinutes")}
          </div>

          <div className={formStyles.fieldGroup}>
            <label className={formStyles.fieldLabel} htmlFor={`${idBase}-tech`}>
              {String(t("admin.bkFormTechNeedsLabel"))}
            </label>
            <textarea
              id={`${idBase}-tech`}
              className={formStyles.textarea}
              value={techNeeds}
              onChange={(e) => {
                clearErr("techNeeds");
                setTechNeeds(e.target.value);
              }}
              placeholder={String(t("admin.bkFormTechNeedsPlaceholder"))}
              maxLength={BOOKING_TECH_NEEDS_MAX}
            />
            {renderErr("techNeeds")}
          </div>

          {/* Genre is sourced from profile tags, never stored here — the
              server prefill applies to HUMAN senders only, so the hint would
              be misleading in the org editor. */}
          {!isOrg && (
            <p className={formStyles.fieldHint}>
              {String(t("account.sBkDefGenreHint"))}
            </p>
          )}
        </div>

        {/* ── Fee ─────────────────────────────────────────────────────── */}
        <div
          className={formStyles.section}
          role="group"
          aria-labelledby={`${idBase}-sec-fee`}
        >
          <p className={formStyles.sectionHeading} id={`${idBase}-sec-fee`}>
            {String(t("admin.bkFormSectionFee"))}
          </p>

          <div className={formStyles.fieldRow}>
            <div className={`${formStyles.fieldGroup} ${formStyles.feeTypeGroup}`}>
              <label
                className={formStyles.fieldLabel}
                htmlFor={`${idBase}-feeType`}
              >
                {String(t("admin.bkFormFeeTypeLabel"))}
              </label>
              <select
                id={`${idBase}-feeType`}
                className={formStyles.select}
                value={feeType}
                onChange={(e) => {
                  clearErr("feeAmount");
                  const next = e.target
                    .value as BookingDefaultsFormValues["feeType"];
                  setFeeType(next);
                  if (next !== "GUARANTEE" && next !== "DOOR_SPLIT") {
                    setFeeAmountDollars("");
                  }
                }}
              >
                <option value="">{String(t("admin.bkFormUnspecified"))}</option>
                {BOOKING_FEE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {String(t(`admin.bkFeeType${type}` as const))}
                  </option>
                ))}
              </select>
            </div>

            {showFeeAmount && (
              <div className={formStyles.fieldGroup}>
                <label
                  className={formStyles.fieldLabel}
                  htmlFor={`${idBase}-feeAmount`}
                >
                  {String(t("admin.bkFormFeeAmountLabel"))} ·{" "}
                  {BOOKING_FEE_CURRENCY.toUpperCase()}
                </label>
                <div className={formStyles.moneyRow}>
                  <span className={formStyles.moneyPrefix} aria-hidden>
                    $
                  </span>
                  <input
                    id={`${idBase}-feeAmount`}
                    type="text"
                    inputMode="decimal"
                    maxLength={12}
                    className={formStyles.moneyInput}
                    value={feeAmountDollars}
                    onChange={(e) => {
                      clearErr("feeAmount");
                      setFeeAmountDollars(e.target.value);
                    }}
                    placeholder="0.00"
                  />
                </div>
                {renderErr("feeAmount")}
              </div>
            )}
          </div>
        </div>

        {/* ── Links ───────────────────────────────────────────────────── */}
        <div
          className={formStyles.section}
          role="group"
          aria-labelledby={`${idBase}-sec-links`}
        >
          <p className={formStyles.sectionHeading} id={`${idBase}-sec-links`}>
            {String(t("admin.bkFormSectionLinks"))}
          </p>

          {(
            [
              {
                field: "linkMusic",
                id: `${idBase}-linkMusic`,
                label: "admin.bkFormLinkMusicLabel",
                value: linkMusic,
                set: setLinkMusic,
              },
              {
                field: "linkVideo",
                id: `${idBase}-linkVideo`,
                label: "admin.bkFormLinkVideoLabel",
                value: linkVideo,
                set: setLinkVideo,
              },
              {
                field: "linkSocial",
                id: `${idBase}-linkSocial`,
                label: "admin.bkFormLinkSocialLabel",
                value: linkSocial,
                set: setLinkSocial,
              },
              {
                field: "linkEpk",
                id: `${idBase}-linkEpk`,
                label: "admin.bkFormLinkEpkLabel",
                value: linkEpk,
                set: setLinkEpk,
              },
            ] as const
          ).map((link) => (
            <div className={formStyles.fieldGroup} key={link.id}>
              <label className={formStyles.fieldLabel} htmlFor={link.id}>
                {String(t(link.label))}
              </label>
              <input
                id={link.id}
                type="url"
                className={formStyles.input}
                value={link.value}
                placeholder="https://"
                onChange={(e) => {
                  clearErr(link.field);
                  link.set(e.target.value);
                }}
              />
              {renderErr(link.field)}
            </div>
          ))}
        </div>

        {/* Verified-stats default preference — HUMAN performers only, and only
            once their stats clear the sharing threshold (3+ shows). The
            snapshot is built server-side from HumanStats for human senders
            (create-booking-request), so the toggle is meaningless for orgs and
            for not-yet-eligible performers. When hidden, the seeded state still
            carries any previously saved value through saves untouched — the
            preference stays inert (never wiped) until they become eligible. */}
        {!isOrg && statsEligible && (
          <div className={formStyles.fieldGroup}>
            <label
              className={formStyles.checkboxRow}
              htmlFor={`${idBase}-stats`}
            >
              <input
                id={`${idBase}-stats`}
                type="checkbox"
                className={formStyles.checkbox}
                checked={includeVerifiedStats}
                onChange={(e) => setIncludeVerifiedStats(e.target.checked)}
              />
              <span className={formStyles.checkboxText}>
                <span>{String(t("account.sBkDefIncludeStatsLabel"))}</span>
                <span className={formStyles.fieldHint}>
                  {String(t("account.sBkDefIncludeStatsHint"))}
                </span>
              </span>
            </label>
          </div>
        )}

        <div className={formStyles.submitRow}>
          <Button
            variant="primary"
            size="$3"
            // Tamagui's Button doesn't reliably forward `type="submit"` to the
            // DOM node, so trigger the form's submit explicitly on press (same
            // pattern as SignUpCard). handleSubmit still guards dirty/pending.
            onPress={() => {
              if (!isDirty || updateMutation.isPending) return;
              formRef.current?.requestSubmit();
            }}
            disabled={!isDirty || updateMutation.isPending}
          >
            {updateMutation.isPending ? (
              <Spinner size="sm" />
            ) : (
              String(t("account.sSave"))
            )}
          </Button>
          {statusText ? (
            // Single spinner lives on the button; the status row is text-only.
            <Text
              variant="caption"
              color={saveState === "error" ? "$brandSecondary" : "$colorMuted"}
              role={saveState === "error" ? "alert" : undefined}
            >
              {statusText}
            </Text>
          ) : hasFieldErrors ? (
            <Text variant="caption" color="$colorMuted">
              {String(t("account.sBkDefFixFields"))}
            </Text>
          ) : null}
        </div>
      </form>
    </YStack>
  );
}

/**
 * Stable serialization of the editor's string form state — order-fixed so the
 * dirty check is reliable regardless of object key order.
 */
function serialize(v: BookingDefaultsFormValues): string {
  return JSON.stringify([
    v.actName,
    v.lineupSize,
    v.setLengthMinutes,
    v.contactPhone,
    v.techNeeds,
    v.messageTemplate,
    v.feeType,
    v.feeAmountDollars,
    v.linkMusic,
    v.linkVideo,
    v.linkSocial,
    v.linkEpk,
    v.includeVerifiedStats,
  ]);
}
