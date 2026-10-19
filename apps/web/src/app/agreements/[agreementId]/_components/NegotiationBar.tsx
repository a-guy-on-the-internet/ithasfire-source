"use client";

import { useEffect, useId, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import { FileX, Send, Undo2 } from "lucide-react";
import {
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import type { AgreementGetOutput } from "./AgreementEditor";

type Agreement = AgreementGetOutput["agreement"];
type ViewerSide = AgreementGetOutput["viewerSide"];
type LinkedEvent = AgreementGetOutput["event"];

/**
 * Contextual lifecycle actions for the agreement (DRAFT ⇄ PROPOSED →
 * ACCEPTED/DECLINED → finalize).
 *
 * The terms belong to the venue/organizer side (`canEditTerms`, served by
 * `bookingAgreements.get` — never guessed here): only that side sends for
 * review, pulls back, or reopens. The act side (`viewerSide === "act"`) sees
 * the terms read-only and, on PROPOSED, gets exactly accept / decline. An
 * agreement with no originating request has no act, so both parties keep
 * every affordance.
 *
 * Cancel is the editor's terminal exit (server: `cancelBookingAgreement`,
 * TERMS_EDITOR_ONLY for the act): offered from DRAFT, PROPOSED and an
 * unfinalized ACCEPTED, never once an event is stamped on the agreement.
 * The reason is required and lands on the booking ledger where the act
 * reads it, so the panel says so before the confirm.
 */
export function NegotiationBar({
  agreementId,
  agreement,
  event,
  mayEdit,
  mayAct,
  canEditTerms,
  viewerSide,
  blockedLineCount,
  onRefresh,
  onActionError,
  onRequestFinalize,
}: {
  agreementId: string;
  agreement: Agreement;
  /**
   * The event linked to the agreement — a DRAFT minted from it before
   * finalize, or the finalized event. Non-null with `agreement.eventId`
   * null means an unfinalized draft that a cancel would orphan.
   */
  event: LinkedEvent;
  mayEdit: boolean;
  /**
   * Client-side mirror of the server's party/role gate on
   * respond/pullBack/reopen/finalize (OWNER/ADMIN/EDITOR for org parties).
   * When false, status notices render without action buttons — FINANCE/
   * VIEWER/SCANNER members can view but would only earn a FORBIDDEN toast.
   */
  mayAct: boolean;
  /**
   * Server-derived, status-independent: the viewer is on the terms-editor
   * side with an edit-level role. Gates send / pull back / reopen.
   */
  canEditTerms: boolean;
  /** `act` = the performer side (accept/decline only); `null` = no request. */
  viewerSide: ViewerSide;
  /**
   * Lines whose payee COUNTERED or DECLINED — these block finalize until
   * the draft is reopened and the economics adjusted (edits reset them to
   * PENDING).
   */
  blockedLineCount: number;
  onRefresh: () => void;
  onActionError: (err: unknown) => void;
  onRequestFinalize: () => void;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const declineReasonId = useId();
  const cancelReasonId = useId();

  const [acceptOpen, setAcceptOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const sendMutation = trpc.bookingAgreements.sendForReview.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const pullBackMutation = trpc.bookingAgreements.pullBack.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const respondMutation = trpc.bookingAgreements.respond.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const reopenMutation = trpc.bookingAgreements.reopen.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const cancelMutation = trpc.bookingAgreements.cancel.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const anyPending =
    sendMutation.isPending ||
    pullBackMutation.isPending ||
    respondMutation.isPending ||
    reopenMutation.isPending ||
    cancelMutation.isPending;

  const handleSend = () => {
    if (anyPending) return;
    sendMutation.mutate(
      { agreementId },
      {
        onSuccess: () => {
          toast.success({
            id: "ba-sent",
            title: String(t("admin.baSentToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  const handlePullBack = () => {
    if (anyPending) return;
    pullBackMutation.mutate(
      { agreementId },
      {
        onSuccess: () => {
          toast.success({
            id: "ba-pulled-back",
            title: String(t("admin.baPulledBackToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  const handleAccept = () => {
    if (anyPending) return;
    respondMutation.mutate(
      { agreementId, action: "accept" },
      {
        onSuccess: () => {
          toast.success({
            id: "ba-accepted",
            title: String(t("admin.baAcceptedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
        onSettled: () => setAcceptOpen(false),
      },
    );
  };

  const handleReopen = () => {
    if (anyPending) return;
    reopenMutation.mutate(
      { agreementId },
      {
        onSuccess: () => {
          toast.success({
            id: "ba-reopened",
            title: String(t("admin.baReopenedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
        onSettled: () => setReopenOpen(false),
      },
    );
  };

  const handleDecline = () => {
    const reason = declineReason.trim();
    if (reason.length < 3 || anyPending) return;
    respondMutation.mutate(
      { agreementId, action: "decline", declineReason: reason },
      {
        onSuccess: () => {
          setDeclining(false);
          setDeclineReason("");
          toast.success({
            id: "ba-declined",
            title: String(t("admin.baDeclinedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  const handleCancel = () => {
    const reason = cancelReason.trim();
    if (reason.length < 3 || anyPending) return;
    cancelMutation.mutate(
      { agreementId, reason },
      {
        onSuccess: () => {
          setCancelling(false);
          setCancelReason("");
          toast.success({
            id: "ba-cancelled",
            title: String(t("admin.baCancelledToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  // ── Status-specific content ───────────────────────────────────────────────
  const isAct = viewerSide === "act";
  let body: React.ReactNode = null;

  /**
   * The editor's walk-away, shared by every cancellable branch. Ghost, so
   * the branch's own primary (Send / Create event) stays the one loud
   * action; the confirm inside the panel is the destructive step.
   */
  const cancelButton = canEditTerms ? (
    <Button
      variant="ghost"
      size="$2"
      disabled={anyPending}
      aria-expanded={cancelling}
      onPress={() => {
        setCancelling((prev) => !prev);
        setCancelReason("");
      }}
      testID="ba-cancel"
    >
      <FileX size={14} />
      {String(t("admin.baCancel"))}
    </Button>
  ) : null;

  // A draft event minted from this agreement is NOT unlinked by a cancel
  // (`cancelBookingAgreement` leaves `draftEventId` stamped) — say so.
  const orphansDraftEvent = event !== null && agreement.eventId === null;

  const cancelPanel = cancelling ? (
    <ReasonPanel
      inputId={cancelReasonId}
      label={String(t("admin.baCancelReasonLabel"))}
      hint={String(t("admin.baCancelReasonHint"))}
      extraHint={
        orphansDraftEvent ? String(t("admin.baCancelDraftEventHint")) : null
      }
      extraHintTestID="ba-cancel-draft-event-hint"
      value={cancelReason}
      onChange={setCancelReason}
      onDismiss={() => {
        setCancelling(false);
        setCancelReason("");
      }}
      // "Keep agreement", not "Cancel" — a plain "Cancel" beside "Cancel
      // agreement" is two near-identical accessible names one tab apart.
      dismissLabel={String(t("admin.baCancelDismiss"))}
      onConfirm={handleCancel}
      confirmLabel={String(t("admin.baCancelConfirm"))}
      confirmDisabled={cancelReason.trim().length < 3 || anyPending}
      dismissDisabled={anyPending}
      pending={cancelMutation.isPending}
      inputTestID="ba-cancel-reason"
      confirmTestID="ba-cancel-confirm"
    />
  ) : null;

  if (agreement.status === "DRAFT" && isAct) {
    body = (
      <BarRow
        notice={String(t("admin.baActSideTermsNotice"))}
        testID="ba-act-side-notice"
      />
    );
  } else if (agreement.status === "DRAFT") {
    body = mayEdit ? (
      <YStack gap="$3">
        <BarRow
          // Unlinked agreements (no act) keep the collaborative copy.
          notice={String(
            t(
              viewerSide === "editor"
                ? "admin.baEditorDraftNotice"
                : "admin.baDraftNotice",
            ),
          )}
          actions={
            <XStack gap="$2" flexWrap="wrap" flexShrink={1} minWidth={0}>
              <Button
                variant="primary"
                size="$2"
                disabled={anyPending}
                onPress={handleSend}
                testID="ba-send-for-review"
              >
                {sendMutation.isPending ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <Send size={14} />
                    {String(t("admin.baSendForReview"))}
                  </>
                )}
              </Button>
              {cancelButton}
            </XStack>
          }
        />
        {cancelPanel}
      </YStack>
    ) : (
      <BarRow notice={String(t("admin.baReadOnlyNotice"))} />
    );
  } else if (agreement.status === "PROPOSED" && !mayAct) {
    body = (
      <YStack gap="$1">
        <BarRow notice={String(t("admin.baProposedNotice"))} />
        <Text variant="caption" tone="muted">
          {String(t("admin.baViewOnlyMemberNotice"))}
        </Text>
      </YStack>
    );
  } else if (agreement.status === "PROPOSED") {
    // On a linked agreement only the ACT responds (server: ACT_RESPONSE_ONLY)
    // and only the EDITOR pulls back (TERMS_EDITOR_ONLY). Unlinked: both.
    const isEditor = viewerSide === "editor";
    body = (
      <YStack gap="$3">
        <BarRow
          notice={String(
            t(
              isAct
                ? "admin.baActSideProposedNotice"
                : isEditor
                  ? "admin.baEditorProposedNotice"
                  : "admin.baProposedNotice",
            ),
          )}
          testID={isAct ? "ba-act-side-notice" : undefined}
          actions={
            // `flexShrink`/`minWidth` are load-bearing, not decoration:
            // Tamagui defaults `flexShrink: 0` (RN semantics), so without them
            // this cluster keeps its MAX-CONTENT width and its own `flexWrap`
            // never fires — the three buttons measured 401px inside a 320px
            // viewport, scrolling the whole page sideways
            // (`documentElement.scrollWidth` 427 vs `clientWidth` 320).
            <XStack gap="$2" flexWrap="wrap" flexShrink={1} minWidth={0}>
              {!isEditor ? (
                <>
                  <Button
                    variant="primary"
                    size="$2"
                    disabled={anyPending}
                    onPress={() => setAcceptOpen(true)}
                    testID="ba-accept"
                  >
                    {String(t("admin.baAccept"))}
                  </Button>
                  <Button
                    variant="outlined"
                    size="$2"
                    disabled={anyPending}
                    onPress={() => {
                      setDeclining((prev) => !prev);
                      setDeclineReason("");
                    }}
                    testID="ba-decline"
                  >
                    {String(t("admin.baDecline"))}
                  </Button>
                </>
              ) : null}
              {canEditTerms ? (
                <Button
                  variant="ghost"
                  size="$2"
                  disabled={anyPending}
                  onPress={handlePullBack}
                  testID="ba-pull-back"
                >
                  {pullBackMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      <Undo2 size={14} />
                      {String(t("admin.baPullBack"))}
                    </>
                  )}
                </Button>
              ) : null}
              {cancelButton}
            </XStack>
          }
        />
        {declining ? (
          <ReasonPanel
            inputId={declineReasonId}
            label={String(t("admin.baDeclineReasonLabel"))}
            hint={String(t("admin.baDeclineReasonHint"))}
            value={declineReason}
            onChange={setDeclineReason}
            onDismiss={() => {
              setDeclining(false);
              setDeclineReason("");
            }}
            dismissLabel={String(t("common.cancel"))}
            onConfirm={handleDecline}
            confirmLabel={String(t("admin.baDeclineConfirm"))}
            confirmDisabled={declineReason.trim().length < 3 || anyPending}
            dismissDisabled={anyPending}
            pending={respondMutation.isPending}
            inputTestID="ba-decline-reason"
            confirmTestID="ba-decline-confirm"
          />
        ) : null}
        {cancelPanel}
      </YStack>
    );
  } else if (agreement.status === "ACCEPTED" && agreement.eventId === null) {
    body = mayAct ? (
      <YStack gap="$1">
        <BarRow
          notice={String(t("admin.baAcceptedNotice"))}
          actions={
            <XStack gap="$2" flexWrap="wrap" flexShrink={1} minWidth={0}>
              <Button
                variant="primary"
                size="$2"
                disabled={anyPending}
                onPress={onRequestFinalize}
                testID="ba-finalize-open"
              >
                {String(t("admin.baFinalize"))}
              </Button>
              {canEditTerms ? (
                <Button
                  variant="outlined"
                  size="$2"
                  disabled={anyPending}
                  onPress={() => setReopenOpen(true)}
                  testID="ba-reopen-open"
                >
                  {reopenMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      <Undo2 size={14} />
                      {String(t("admin.baReopen"))}
                    </>
                  )}
                </Button>
              ) : null}
              {cancelButton}
            </XStack>
          }
        />
        {/* "Reopen the draft to adjust" is only actionable for the editor. */}
        {blockedLineCount > 0 && canEditTerms ? (
          <Text variant="caption" tone="warning" testID="ba-blocked-lines-hint">
            {String(
              t("admin.baCounterBlockedHint", { count: blockedLineCount }),
            )}
          </Text>
        ) : null}
        {cancelPanel}
      </YStack>
    ) : (
      <YStack gap="$1">
        <BarRow notice={String(t("admin.baAcceptedNotice"))} />
        <Text variant="caption" tone="muted">
          {String(t("admin.baViewOnlyMemberNotice"))}
        </Text>
      </YStack>
    );
  } else if (
    (agreement.status === "ACCEPTED" || agreement.status === "FULFILLED") &&
    agreement.eventId !== null
  ) {
    body = <BarRow notice={String(t("admin.baFinalizedNotice"))} />;
  } else if (agreement.status === "DECLINED") {
    body = (
      <YStack gap="$1">
        <Text variant="bodySmall" weight="bold" tone="error">
          {String(t("admin.baDeclinedNotice"))}
        </Text>
        {agreement.declinedReason ? (
          <Text variant="bodySmall" tone="muted">
            {String(
              t("admin.baDeclinedReason", {
                reason: agreement.declinedReason,
              }),
            )}
          </Text>
        ) : null}
      </YStack>
    );
  } else if (agreement.status === "CANCELLED") {
    body = <BarRow notice={String(t("admin.baCancelledNotice"))} />;
  } else {
    body = <BarRow notice={String(t("admin.baReadOnlyNotice"))} />;
  }

  return (
    <YStack
      padding="$3"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
    >
      {body}
      <ConfirmDialog
        open={acceptOpen}
        onConfirm={handleAccept}
        onCancel={() => setAcceptOpen(false)}
        title={String(t("admin.baAcceptConfirmTitle"))}
        description={String(t("admin.baAcceptConfirmBody"))}
        confirmLabel={String(t("admin.baAccept"))}
        cancelLabel={String(t("common.cancel"))}
        loading={respondMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
      <ConfirmDialog
        open={reopenOpen}
        onConfirm={handleReopen}
        onCancel={() => setReopenOpen(false)}
        title={String(t("admin.baReopenConfirmTitle"))}
        description={String(t("admin.baReopenConfirmBody"))}
        confirmLabel={String(t("admin.baReopen"))}
        cancelLabel={String(t("common.cancel"))}
        loading={reopenMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
    </YStack>
  );
}

/**
 * Inline "say why" panel for the two reason-bearing exits (act declines,
 * editor cancels). Expands under the action row instead of a dialog so the
 * terms stay in view while the reason is written.
 */
function ReasonPanel({
  inputId,
  label,
  hint,
  extraHint = null,
  extraHintTestID,
  value,
  onChange,
  onDismiss,
  dismissLabel,
  dismissDisabled,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  pending,
  inputTestID,
  confirmTestID,
}: {
  inputId: string;
  label: string;
  hint: string;
  /** A second caption line for a consequence worth its own sentence. */
  extraHint?: string | null;
  extraHintTestID?: string;
  value: string;
  onChange: (next: string) => void;
  onDismiss: () => void;
  dismissLabel: string;
  dismissDisabled: boolean;
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled: boolean;
  pending: boolean;
  inputTestID: string;
  confirmTestID: string;
}) {
  // The panel mounts on a click one row above it: land the caret in the
  // field so the reason can be typed without a second click.
  const inputRef = useRef<React.ElementRef<typeof TextInput>>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <YStack
      gap="$2"
      padding="$3"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surface"
    >
      <Text tag="label" htmlFor={inputId} variant="bodySmall" weight="bold">
        {label}
      </Text>
      <TextInput
        ref={inputRef}
        id={inputId}
        value={value}
        onChangeText={onChange}
        maxLength={1000}
        fullWidth
        // `testId`, not `testID` — TextInput's own prop name; the RN-style
        // spelling is silently dropped and the input ships without a hook.
        testId={inputTestID}
      />
      <Text variant="caption" tone="muted">
        {hint}
      </Text>
      {extraHint ? (
        <Text variant="caption" tone="warning" testID={extraHintTestID}>
          {extraHint}
        </Text>
      ) : null}
      <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
        <Button
          variant="ghost"
          size="$2"
          disabled={dismissDisabled}
          onPress={onDismiss}
        >
          {dismissLabel}
        </Button>
        <Button
          variant="destructive"
          size="$2"
          disabled={confirmDisabled}
          onPress={onConfirm}
          // Keeps the accessible name while the label is swapped for a spinner.
          aria-label={confirmLabel}
          testID={confirmTestID}
        >
          {pending ? <Spinner size="sm" /> : confirmLabel}
        </Button>
      </XStack>
    </YStack>
  );
}

function BarRow({
  notice,
  actions,
  testID,
}: {
  notice: string;
  actions?: React.ReactNode;
  testID?: string;
}) {
  return (
    <XStack
      gap="$3"
      alignItems="center"
      justifyContent="space-between"
      flexWrap="wrap"
    >
      <Text
        variant="bodySmall"
        tone="muted"
        flex={1}
        minWidth={200}
        testID={testID}
      >
        {notice}
      </Text>
      {actions}
    </XStack>
  );
}
