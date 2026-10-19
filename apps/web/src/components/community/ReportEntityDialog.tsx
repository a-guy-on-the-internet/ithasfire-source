"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Button,
  CharCountTextarea,
  Modal,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";
import { CheckCircle2, Flag } from "lucide-react";
import {
  ENTITY_REPORT_DETAILS_MAX,
  ENTITY_REPORT_REASONS_BY_SUBJECT,
} from "@th/core/use-cases/entity-reports";

import { trpc } from "@/trpc";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { getInvalidFieldsMeta } from "@/lib/suggestion-error";
import { reasonLabelKey } from "@/app/platform/reports/_components/entity-report-queue.helpers";
import {
  isRateLimitedError,
  isReportAlreadyOpenError,
  isUnauthorizedError,
  nextReasonForKey,
  isSelectionKey,
  reportReasonOptionDomId,
  type EntityReportReason,
} from "./report-entity-dialog.helpers";

// Web-only a11y DOM props (role, aria-*, tabIndex, onKeyDown) that Tamagui's
// Stack surfaces don't type — same pass-through cast the claim wizard and the
// Modal primitive use.
const webA11y = (props: Record<string, unknown>): object => props;

export type ReportEntityDialogProps = {
  subjectType: "PLACE" | "HUMAN" | "ORGANIZATION" | "ARRIVAL_AREA";
  subjectId: string;
  /**
   * ARRIVAL_AREA only (arrival-areas FR-011): the event page the area was
   * seen on. The server checks the reporter's password / application gate
   * pass against it, so an event page always sends it.
   */
  seenOnEventId?: string;
  /** Subject display name — rendered as the dialog's context line. */
  subjectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Post-submit terminal states rendered INSIDE the dialog (FR-008). */
type Phase = "form" | "success" | "already_open";

type FieldErrors = { reason?: string; details?: string };

/**
 * In-place report dialog for PLACE / HUMAN / ORGANIZATION listing pages
 * (entity-report-intake spec FR-001/FR-002/FR-008, NFR-004). Opened by the
 * hero "Report" action for signed-in viewers (the hero islands route signed-out
 * viewers to the sign-in overlay instead — this dialog assumes a session).
 *
 * Reason subsets come straight from core's canonical
 * `ENTITY_REPORT_REASONS_BY_SUBJECT` (the constant the server enforces), so
 * the dialog can never drift from the backend rule. Reason LABELS reuse the
 * moderation queue's `moderation.reportsReason*` copy — one vocabulary for
 * reporters and moderators.
 *
 * Radio group follows the house ARIA radio pattern (pure `nextReasonForKey`
 * resolver + roving tabindex + focus-follows-selection by DOM id, wrapping,
 * unhandled keys left alone). The Modal primitive supplies dialog semantics,
 * Esc, backdrop close, initial focus containment, and focus return to the
 * trigger; on open this dialog moves focus to the selected (or first) reason
 * row.
 *
 * Expected server outcomes get first-class states, not raw toasts:
 *  - CONFLICT `report_already_open` → friendly "we're on it" terminal state;
 *  - TOO_MANY_REQUESTS → rate-limit warning toast (dialog stays open);
 *  - INVALID_INPUT meta `details_required` / `invalid_reason_for_subject` →
 *    inline field errors (server backstop for the client-side checks);
 *  - UNAUTHORIZED (session expired mid-dialog) → close + sign-in overlay.
 */
export function ReportEntityDialog({
  subjectType,
  subjectId,
  seenOnEventId,
  subjectName,
  open,
  onOpenChange,
}: ReportEntityDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const pathname = usePathname();
  const { showSignInOverlay } = useAppOverlay();

  const reasons = ENTITY_REPORT_REASONS_BY_SUBJECT[subjectType];
  // An arrival area is a parking, drop-off or load-in area on a map, not a
  // listing, so the dialog names it as an area.
  const isArea = subjectType === "ARRIVAL_AREA";
  const copyKey = {
    title: isArea ? "arrivalAreas.reportTitle" : "reportEntity.title",
    successBody: isArea
      ? "arrivalAreas.reportSuccessBody"
      : "reportEntity.successBody",
    alreadyOpenBody: isArea
      ? "arrivalAreas.reportAlreadyOpenBody"
      : "reportEntity.alreadyOpenBody",
    invalidReason: isArea
      ? "arrivalAreas.reportInvalidReason"
      : "reportEntity.invalidReasonError",
  };

  const [phase, setPhase] = useState<Phase>("form");
  const [reason, setReason] = useState<EntityReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // Close resets to a fresh form so the next open never replays a stale
  // success/already-open state or a previous draft (FR-008 "then close
  // resets to form state").
  const close = () => {
    setPhase("form");
    setReason(null);
    setDetails("");
    setFieldErrors({});
    onOpenChange(false);
  };

  // Move focus to the selected (or first) reason row on open. Runs a frame
  // after Modal.Panel's own focus effect (which only claims focus when
  // nothing inside the dialog has it), so the row wins.
  useEffect(() => {
    if (!open) return;
    const target = reason ?? reasons[0];
    if (!target) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(reportReasonOptionDomId(target))?.focus();
    });
    return () => cancelAnimationFrame(raf);
    // Only on open — re-running on `reason` would yank focus while arrowing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When the form submits, the footer — and whichever button was focused —
  // unmounts with the phase switch, which would strand keyboard focus on
  // <body> and leave the outcome unannounced. Move focus to the terminal
  // state's title (tabIndex -1): that restores the tab position inside the
  // dialog AND makes screen readers announce the outcome text.
  const stateTitleRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (phase === "form") return;
    stateTitleRef.current?.focus();
  }, [phase]);

  const submitMut = trpc.entityReports.submit.useMutation({
    // Every failure branch below is handled bespoke — opt out of the global
    // mutation danger toast (same posture as the moderation queues).
    meta: { silent: true },
    retry: false,
    onSuccess: () => {
      setPhase("success");
    },
    onError: (err) => {
      if (isReportAlreadyOpenError(err)) {
        // FR-003 dedupe: the reporter already has a PENDING report here.
        // A friendly terminal state, not an error.
        setPhase("already_open");
        return;
      }
      if (isRateLimitedError(err)) {
        toast.warning({
          title: String(t("reportEntity.rateLimitedToast")),
          message: String(t("reportEntity.rateLimitedHint")),
        });
        return;
      }
      if (isUnauthorizedError(err)) {
        // Session expired mid-dialog: close and hand off to sign-in, coming
        // back to this page (the openWizardOrSignIn redirect pattern).
        close();
        showSignInOverlay({ redirect: pathname ?? "/" });
        return;
      }
      if (getAppErrorCode(err) === "INVALID_INPUT") {
        // Server backstop for the client-side checks — anchor the message at
        // the offending input via the structured `data.meta.reason`.
        const meta = getInvalidFieldsMeta(err);
        if (meta?.reason === "details_required") {
          setFieldErrors({ details: String(t("reportEntity.detailsRequiredError")) });
          return;
        }
        if (meta?.reason === "invalid_reason_for_subject") {
          setFieldErrors({ reason: String(t(copyKey.invalidReason)) });
          return;
        }
      }
      toast.danger({
        title: String(t("reportEntity.failedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  const selectReason = (next: EntityReportReason) => {
    setReason(next);
    setFieldErrors((prev) => (prev.reason ? { ...prev, reason: undefined } : prev));
  };

  const handleReasonKeyDown =
    (current: EntityReportReason) =>
    (e: { key: string; preventDefault: () => void }) => {
      if (isSelectionKey(e.key)) {
        e.preventDefault();
        selectReason(current);
        return;
      }
      const target = nextReasonForKey(current, e.key, reasons);
      if (!target) return;
      e.preventDefault();
      selectReason(target);
      document.getElementById(reportReasonOptionDomId(target))?.focus();
    };

  const submit = () => {
    if (submitMut.isPending) return;
    // FR-002 client-side: reason required; details required for OTHER. The
    // server enforces both again (backstop wired in onError above).
    if (!reason) {
      setFieldErrors({ reason: String(t("reportEntity.reasonRequiredError")) });
      return;
    }
    const trimmedDetails = details.trim();
    if (reason === "OTHER" && !trimmedDetails) {
      setFieldErrors({
        details: String(t("reportEntity.detailsRequiredError")),
      });
      return;
    }
    setFieldErrors({});
    submitMut.mutate({
      subjectType,
      subjectId,
      reason,
      ...(trimmedDetails ? { details: trimmedDetails } : {}),
      ...(subjectType === "ARRIVAL_AREA" && seenOnEventId
        ? { seenOnEventId }
        : {}),
    });
  };

  const detailsRequired = reason === "OTHER";

  return (
    <Modal open={open} onClose={close}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={String(t(copyKey.title))}
          subtitle={subjectName}
          onClose={close}
        />
        <Modal.Body gap="$4" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {phase === "success" ? (
            // ── FR-008 success state ─────────────────────────────────────
            <YStack gap="$3" alignItems="center" paddingVertical="$4">
              <CheckCircle2
                size={40}
                color="var(--success, #166534)"
                aria-hidden
              />
              <Text
                variant="subtitle"
                weight="bold"
                textAlign="center"
                tabIndex={-1}
                ref={(node) => {
                  stateTitleRef.current =
                    node as unknown as HTMLElement | null;
                }}
              >
                {String(t("reportEntity.successTitle"))}
              </Text>
              <Text variant="body" tone="muted" textAlign="center">
                {String(t(copyKey.successBody))}
              </Text>
              <Button variant="primary" size="$3" onPress={close}>
                {String(t("reportEntity.doneCta"))}
              </Button>
            </YStack>
          ) : phase === "already_open" ? (
            // ── Dedupe state: an earlier report is already PENDING ───────
            <YStack gap="$3" alignItems="center" paddingVertical="$4">
              <Flag size={40} color="var(--accent, #E2481D)" aria-hidden />
              <Text
                variant="subtitle"
                weight="bold"
                textAlign="center"
                tabIndex={-1}
                ref={(node) => {
                  stateTitleRef.current =
                    node as unknown as HTMLElement | null;
                }}
              >
                {String(t("reportEntity.alreadyOpenTitle"))}
              </Text>
              <Text variant="body" tone="muted" textAlign="center">
                {String(t(copyKey.alreadyOpenBody))}
              </Text>
              <Button variant="primary" size="$3" onPress={close}>
                {String(t("reportEntity.doneCta"))}
              </Button>
            </YStack>
          ) : (
            <>
              {/* ── Reason (required) ─────────────────────────────────── */}
              <YStack gap="$2">
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                  {...webA11y({ id: "report-entity-reason-label" })}
                >
                  {String(t("reportEntity.reasonLabel"))}
                </Text>
                <YStack
                  gap="$2"
                  {...webA11y({
                    role: "radiogroup",
                    "aria-labelledby": "report-entity-reason-label",
                    "aria-required": "true",
                    ...(fieldErrors.reason
                      ? { "aria-describedby": "report-entity-reason-error" }
                      : {}),
                  })}
                >
                  {reasons.map((option, index) => {
                    const selected = option === reason;
                    const isFirst = index === 0;
                    return (
                      <XStack
                        key={option}
                        gap="$3"
                        paddingHorizontal="$3"
                        minHeight={44}
                        borderWidth={2}
                        borderColor={selected ? "$accent" : "$borderColor"}
                        backgroundColor="$surface"
                        cursor="pointer"
                        alignItems="center"
                        hoverStyle={{ borderColor: "$accent" }}
                        onPress={() => selectReason(option)}
                        {...webA11y({
                          id: reportReasonOptionDomId(option),
                          role: "radio",
                          "aria-checked": selected,
                          // Roving tabindex: one row in the Tab order, arrows
                          // move within the group. Before any selection the
                          // first row is the entry point.
                          tabIndex: selected || (!reason && isFirst) ? 0 : -1,
                          onKeyDown: handleReasonKeyDown(option),
                        })}
                      >
                        <YStack
                          width={16}
                          height={16}
                          borderRadius={999}
                          borderWidth={2}
                          borderColor={selected ? "$accent" : "$borderColor"}
                          backgroundColor={selected ? "$accent" : "transparent"}
                          flexShrink={0}
                        />
                        <Text variant="bodySmall" weight="bold">
                          {String(t(reasonLabelKey(option)))}
                        </Text>
                      </XStack>
                    );
                  })}
                </YStack>
                {fieldErrors.reason ? (
                  // role="alert" announces the rejection to screen readers
                  // (house field-error pattern: ProposeEditsForm). Focus is
                  // deliberately NOT moved — neither house form precedent
                  // (ProposeEditsForm, ContactContent) moves it.
                  <Text
                    variant="caption"
                    tone="error"
                    {...webA11y({
                      id: "report-entity-reason-error",
                      role: "alert",
                    })}
                  >
                    {fieldErrors.reason}
                  </Text>
                ) : null}
              </YStack>

              {/* ── Details (optional; required for OTHER) ─────────────── */}
              <YStack gap="$2">
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(
                    t(
                      detailsRequired
                        ? "reportEntity.detailsLabelRequired"
                        : "reportEntity.detailsLabelOptional",
                    ),
                  )}
                </Text>
                <CharCountTextarea
                  id="report-entity-details"
                  value={details}
                  onChange={(next) => {
                    setDetails(next);
                    setFieldErrors((prev) =>
                      prev.details ? { ...prev, details: undefined } : prev,
                    );
                  }}
                  maxLength={ENTITY_REPORT_DETAILS_MAX}
                  minHeight={96}
                  placeholder={String(t("reportEntity.detailsPlaceholder"))}
                  disabled={submitMut.isPending}
                  // `error` also sets aria-invalid on the textarea (the
                  // shared component keeps the visual + AT states paired).
                  error={Boolean(fieldErrors.details)}
                  ariaDescribedBy={
                    fieldErrors.details
                      ? "report-entity-details-error"
                      : undefined
                  }
                  testIdBase="report-entity-details"
                />
                {fieldErrors.details ? (
                  // Same alert treatment as the reason error above; covers
                  // BOTH the client-side rejection and the server backstop
                  // (data.meta.reason anchoring) — they render through this
                  // one element.
                  <Text
                    variant="caption"
                    tone="error"
                    {...webA11y({
                      id: "report-entity-details-error",
                      role: "alert",
                    })}
                  >
                    {fieldErrors.details}
                  </Text>
                ) : null}
              </YStack>
            </>
          )}
        </Modal.Body>
        {phase === "form" ? (
          <Modal.Footer>
            <Button
              variant="ghost"
              size="$3"
              onPress={close}
              disabled={submitMut.isPending}
            >
              {String(t("reportEntity.cancel"))}
            </Button>
            <Button
              variant="primary"
              size="$3"
              onPress={submit}
              disabled={submitMut.isPending}
            >
              {String(t("reportEntity.submit"))}
            </Button>
          </Modal.Footer>
        ) : null}
      </Modal.Panel>
    </Modal>
  );
}

ReportEntityDialog.displayName = "ReportEntityDialog";
