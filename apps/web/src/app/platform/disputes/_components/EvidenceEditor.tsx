"use client";

// i18n: key pending — every user-facing string in this file is an English
// literal; the locale catalogs are off-limits for this change (see the
// "Roles" nav item precedent in platform/layout.tsx).

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { XStack, YStack } from "tamagui";
import {
  Alert,
  Badge,
  Button,
  CharCountTextarea,
  Spinner,
  Text,
  useFormatters,
  useNotify,
} from "@th/ui";
import { CheckCircle2, RotateCcw, Save, Send } from "lucide-react";

import { trpc } from "@/trpc";
import { fmtDate } from "@/lib/format";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { useSecondFactorRequiredToast } from "@/components/community/use-second-factor-required-toast";
import type { DisputeDetailData } from "./DisputeDetail";
import {
  EVIDENCE_COMBINED_MAX,
  EVIDENCE_FIELD_MAX,
  EVIDENCE_TEXT_FIELDS,
  changedFields,
  combinedChars,
  decodeDeskError,
  draftFromFields,
  isDraftDirty,
  sourceStateLabel,
  sourcesForDisplay,
  violatedFieldKeys,
  type DecodedDeskError,
  type DueTreatment,
  type EvidenceDraft,
  type EvidenceTextKey,
  type SourceState,
} from "./dispute-desk.helpers";

type Evidence = NonNullable<DisputeDetailData["evidence"]>;
type Dispute = DisputeDetailData["dispute"];

export interface EvidenceEditorProps {
  disputeId: string;
  evidence: Evidence | null;
  dispute: Dispute;
  canWrite: boolean;
  isMobile: boolean;
  due: DueTreatment;
  onChanged: () => void;
  /** Reports unsaved edits so the parent can pause its poll. */
  onDirtyChange?: (dirty: boolean) => void;
}

type ConfirmKind = "reassemble" | "approve" | "submit" | null;

const isoOf = (record: Evidence | null): string | null =>
  record ? new Date(record.updatedAt).toISOString() : null;

/**
 * The evidence package: provenance, the 14 editable Stripe text fields, and
 * the DRAFT → APPROVED → SUBMITTED lifecycle actions. Write actions only
 * render for ADMIN (`canWrite`); SUPPORT reads.
 *
 * Mount with `key={evidence.id}`. The draft is initialised from the server
 * fields and re-synced whenever the record's `updatedAt` moves — unless the
 * operator has unsaved edits, in which case the draft is KEPT and a banner
 * offers to reload. A successful write re-baselines from the returned record
 * so the follow-up refetch is a no-op.
 */
export function EvidenceEditor({
  disputeId,
  evidence,
  dispute,
  canWrite,
  isMobile,
  due,
  onChanged,
  onDirtyChange,
}: EvidenceEditorProps) {
  const fmt = useFormatters();
  const { toast } = useNotify();
  const handleSecondFactor = useSecondFactorRequiredToast();

  const [baseline, setBaseline] = useState<EvidenceDraft>(() =>
    draftFromFields(evidence?.fields),
  );
  const [draft, setDraft] = useState<EvidenceDraft>(baseline);
  const [seenIso, setSeenIso] = useState<string | null>(() => isoOf(evidence));
  const [staleServer, setStaleServer] = useState(false);
  const [error, setError] = useState<DecodedDeskError | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);

  const status = evidence?.status ?? null;
  const dirty = isDraftDirty(baseline, draft);
  const total = combinedChars(draft);
  const editable = canWrite && status !== null && status !== "SUBMITTED";
  const violated = violatedFieldKeys(error);
  const overCombined =
    total > EVIDENCE_COMBINED_MAX || error?.combinedViolation != null;
  const actionSize = isMobile ? "$4" : "$3";

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const syncFromServer = useCallback((record: Evidence | null) => {
    const next = draftFromFields(record?.fields);
    setBaseline(next);
    setDraft(next);
    setSeenIso(isoOf(record));
    setStaleServer(false);
  }, []);

  // The record moved under us (poll, another operator, a resync after a
  // failed write). Clean editor → take the server's fields; dirty editor →
  // keep the edits and say so.
  const serverIso = isoOf(evidence);
  useEffect(() => {
    if (serverIso === seenIso) return;
    if (!isDraftDirty(baseline, draft)) {
      syncFromServer(evidence);
    } else {
      setSeenIso(serverIso);
      setStaleServer(true);
    }
    // Only a server-side change should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIso]);

  const onError = useCallback(
    (err: unknown) => {
      if (handleSecondFactor(err)) return;
      const decoded = decodeDeskError(err);
      setError(decoded);
      // The package is not what we thought — resync (edits survive via the
      // stale-server branch above).
      if (decoded.code === "DISPUTE_EVIDENCE_STATE_INVALID") onChanged();
    },
    [handleSecondFactor, onChanged],
  );

  // Every mutation handles its own failure inline (meta.silent opts out of
  // the global danger toast, which would double up).
  const assemble = trpc.platform.disputes.assemble.useMutation({
    meta: { silent: true },
    onSuccess: (result) => {
      setError(null);
      switch (result.skipped) {
        case "unlinked":
          toast.info({
            title: "This dispute is not linked to an order; nothing to assemble",
          });
          break;
        case "already_submitted":
          toast.info({ title: "Package already submitted" });
          break;
        case "already_assembled":
          toast.info({ title: "Evidence package already exists" });
          break;
        default:
          if (result.fallback) {
            toast.warning({
              title: "Assembled a minimal draft — some sources were unavailable",
            });
          } else {
            toast.success({ title: "Evidence package assembled" });
          }
      }
      // A forced re-assemble discards edits by design.
      if (result.evidence) syncFromServer(result.evidence);
      onChanged();
    },
    onError,
  });
  const updateDraft = trpc.platform.disputes.updateDraft.useMutation({
    meta: { silent: true },
    onSuccess: (result) => {
      setError(null);
      syncFromServer(result.evidence);
      toast.success({ title: "Draft saved" });
      onChanged();
    },
    onError,
  });
  const approve = trpc.platform.disputes.approve.useMutation({
    meta: { silent: true },
    onSuccess: (result) => {
      setError(null);
      syncFromServer(result.evidence);
      toast.success({ title: "Evidence approved" });
      onChanged();
    },
    onError,
  });
  const submit = trpc.platform.disputes.submit.useMutation({
    meta: { silent: true },
    onSuccess: (result) => {
      setError(null);
      syncFromServer(result.evidence);
      toast.success({
        title: result.reconciledFromProcessor
          ? "Stripe already held this submission; the record was reconciled."
          : "Evidence submitted to Stripe",
        message: `Stripe status: ${result.processorStatus}. Submissions: ${result.processorSubmissionCount}.`,
      });
      onChanged();
    },
    onError,
  });

  const busy =
    assemble.isPending ||
    updateDraft.isPending ||
    approve.isPending ||
    submit.isPending;

  const setField = useCallback((key: EvidenceTextKey, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // Editing an errored field clears its error (validation timing rule).
    setError((prev) =>
      prev?.fieldViolations.some((v) => v.field === key)
        ? {
            ...prev,
            fieldViolations: prev.fieldViolations.filter(
              (v) => v.field !== key,
            ),
          }
        : prev,
    );
  }, []);

  const handleSave = () => {
    const fields = changedFields(baseline, draft);
    if (Object.keys(fields).length === 0) return;
    updateDraft.mutate({ disputeId, fields });
  };

  const runConfirmed = () => {
    const kind = confirm;
    setConfirm(null);
    if (kind === "reassemble") assemble.mutate({ disputeId, force: true });
    if (kind === "approve") approve.mutate({ disputeId });
    if (kind === "submit") submit.mutate({ disputeId });
  };

  // ── Action availability ───────────────────────────────────────────────────
  const canSave = editable && dirty && !busy;
  const canApprove =
    editable &&
    (status === "DRAFT" || status === "SUBMIT_FAILED") &&
    !dirty &&
    !busy;
  const canSubmit =
    canWrite && status === "APPROVED" && !dirty && !due.overdue && !busy;
  const canReassemble = canWrite && status !== "SUBMITTED" && !busy;

  const approveHint =
    (status === "DRAFT" || status === "SUBMIT_FAILED") && dirty
      ? "Save the draft before approving."
      : null;
  const submitHint =
    status === "APPROVED"
      ? due.overdue
        ? "The evidence deadline has passed; Stripe will not accept a submission."
        : dirty
          ? "Unsaved edits — saving drops the package back to draft."
          : null
      : status === "SUBMITTED"
        ? null
        : "Approve the package to enable submission.";

  const submittedAt = evidence?.submittedAt ?? dispute.evidenceSubmittedAt;

  return (
    <YStack gap="$4" minWidth={0}>
      {/* ── Lifecycle banners ─────────────────────────────────────────────── */}
      {evidence === null && (
        <Alert
          tone="info"
          compact
          title="No evidence package yet"
          description="Nothing has been assembled for this dispute. The package is built automatically when a dispute opens; if it did not, assemble it now."
          actions={
            canWrite ? (
              <Button
                variant="primary"
                size={actionSize}
                onPress={() => assemble.mutate({ disputeId, force: false })}
                disabled={busy}
              >
                {assemble.isPending ? <Spinner size="small" /> : null}
                Assemble evidence
              </Button>
            ) : undefined
          }
        />
      )}
      {status === "SUBMITTED" && (
        <Alert
          tone="success"
          compact
          title="Submitted to Stripe"
          description={[
            submittedAt ? `Sent ${fmtDate(fmt, submittedAt)}` : null,
            evidence?.submittedByHumanId
              ? `by ${evidence.submittedByHumanId}`
              : null,
            typeof dispute.evidenceSubmissionCount === "number"
              ? `Stripe submissions: ${dispute.evidenceSubmissionCount}`
              : evidence?.processorSubmissionCount != null
                ? `Stripe submissions: ${evidence.processorSubmissionCount}`
                : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      )}
      {status === "SUBMIT_FAILED" && (
        <Alert
          tone="danger"
          compact
          title="Last submission failed"
          description={
            evidence?.submitError ??
            "Stripe did not accept the package. Fix the fields below, save, approve and try again."
          }
        />
      )}
      {status === "APPROVED" && (
        <Alert
          tone="info"
          compact
          title="Approved — ready to submit"
          description={
            evidence?.reviewedAt
              ? `Approved ${fmtDate(fmt, evidence.reviewedAt)}. Editing any field drops it back to draft.`
              : "Editing any field drops it back to draft."
          }
        />
      )}
      {!canWrite && evidence && (
        <Text variant="caption" tone="muted">
          You can read this package. Editing, approval and submission need the
          ADMIN role.
        </Text>
      )}

      {/* ── Server moved under a dirty editor ─────────────────────────────── */}
      {staleServer && evidence && (
        <Alert
          tone="warning"
          compact
          title="This package changed while you were editing"
          description="Your unsaved edits are kept — reload to discard them."
          actions={
            <Button
              variant="secondary"
              size={actionSize}
              onPress={() => syncFromServer(evidence)}
              aria-label="Reload package"
            >
              Reload
            </Button>
          }
        />
      )}

      {/* ── Inline mutation error ─────────────────────────────────────────── */}
      {error && (
        <Alert
          tone="danger"
          compact
          title={error.title}
          description={
            [
              error.detail,
              error.fieldViolations.length > 0
                ? `Over the ${fmt.number(EVIDENCE_FIELD_MAX)} character limit: ${error.fieldViolations
                    .map(
                      (v) =>
                        `${EVIDENCE_TEXT_FIELDS.find((f) => f.key === v.field)?.stripeName ?? v.field} (${fmt.number(v.chars)})`,
                    )
                    .join(", ")}.`
                : null,
              error.combinedViolation
                ? `Combined size ${fmt.number(error.combinedViolation.chars)} exceeds ${fmt.number(error.combinedViolation.max)}.`
                : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onDismiss={() => setError(null)}
        />
      )}

      {evidence && (
        <>
          {/* ── Provenance ───────────────────────────────────────────────── */}
          <YStack gap="$2">
            <XStack alignItems="center" gap="$2" flexWrap="wrap">
              <Text variant="overline" tone="muted">
                Sources
              </Text>
              <Text variant="caption" tone="muted">
                · assembled {fmtDate(fmt, evidence.assembledAt)} · v
                {evidence.assembledVersion}
              </Text>
              {evidence.sources.truncated && (
                <Badge tone="warning" size="xs">
                  Truncated
                </Badge>
              )}
            </XStack>
            <SourcesList sources={evidence.sources} />
          </YStack>

          {/* ── Fields ───────────────────────────────────────────────────── */}
          <YStack gap="$4">
            {EVIDENCE_TEXT_FIELDS.map((meta) => {
              const id = `evidence-${meta.key}`;
              const hintId = `${id}-hint`;
              const errorId = `${id}-error`;
              const value = draft[meta.key];
              const violation = error?.fieldViolations.find(
                (v) => v.field === meta.key,
              );
              const isViolated = violated.has(meta.key);
              return (
                <YStack key={meta.key} gap="$2">
                  <YStack gap="$1">
                    {editable ? (
                      <label htmlFor={id} style={{ cursor: "default" }}>
                        <Text
                          variant="overline"
                          color={isViolated ? "$dangerSoft" : undefined}
                        >
                          <StripeName name={meta.stripeName} />
                        </Text>
                      </label>
                    ) : (
                      <Text variant="overline" id={`${id}-label`}>
                        <StripeName name={meta.stripeName} />
                      </Text>
                    )}
                    <Text id={hintId} variant="caption" tone="muted">
                      {meta.hint}
                    </Text>
                    {violation && (
                      <Text
                        id={errorId}
                        variant="caption"
                        color="$dangerSoft"
                        role="alert"
                      >
                        {fmt.number(violation.chars)} /{" "}
                        {fmt.number(violation.max)} — over by{" "}
                        {fmt.number(violation.chars - violation.max)}.
                      </Text>
                    )}
                  </YStack>
                  {editable ? (
                    <CharCountTextarea
                      id={id}
                      value={value}
                      onChange={(next) => setField(meta.key, next)}
                      maxLength={EVIDENCE_FIELD_MAX}
                      minHeight={meta.short ? 44 : 96}
                      maxLines={meta.short ? 3 : 14}
                      disabled={busy}
                      error={isViolated}
                      ariaDescribedBy={
                        violation ? `${hintId} ${errorId}` : hintId
                      }
                      testIdBase={id}
                    />
                  ) : (
                    <ReadOnlyValue labelledBy={`${id}-label`} value={value} />
                  )}
                </YStack>
              );
            })}
          </YStack>

          {/* ── Combined counter ─────────────────────────────────────────── */}
          <XStack justifyContent="flex-end">
            <Text
              variant="caption"
              fontFamily="$mono"
              color={overCombined ? "$dangerSoft" : "$colorMuted"}
              data-testid="evidence-combined-count"
            >
              Combined {fmt.number(total)} / {fmt.number(EVIDENCE_COMBINED_MAX)}
            </Text>
          </XStack>

          {/* ── Actions (ADMIN only) ─────────────────────────────────────── */}
          {canWrite && (
            <YStack gap="$2">
              <XStack gap="$2" flexWrap="wrap" justifyContent="flex-end">
                <Button
                  variant="ghost"
                  size={actionSize}
                  onPress={() => setConfirm("reassemble")}
                  disabled={!canReassemble}
                  aria-label="Re-assemble evidence"
                >
                  {assemble.isPending ? (
                    <Spinner size="small" />
                  ) : (
                    <RotateCcw size={14} aria-hidden />
                  )}
                  Re-assemble
                </Button>
                {status !== "SUBMITTED" && (
                  <Button
                    variant="secondary"
                    size={actionSize}
                    onPress={handleSave}
                    disabled={!canSave}
                    aria-label="Save draft"
                  >
                    {updateDraft.isPending ? (
                      <Spinner size="small" />
                    ) : (
                      <Save size={14} aria-hidden />
                    )}
                    Save draft
                  </Button>
                )}
                {(status === "DRAFT" || status === "SUBMIT_FAILED") && (
                  <Button
                    variant="secondary"
                    size={actionSize}
                    onPress={() => setConfirm("approve")}
                    disabled={!canApprove}
                    aria-label="Approve evidence"
                  >
                    {approve.isPending ? (
                      <Spinner size="small" />
                    ) : (
                      <CheckCircle2 size={14} aria-hidden />
                    )}
                    Approve
                  </Button>
                )}
                {status !== "SUBMITTED" && (
                  <Button
                    variant="primary"
                    size={actionSize}
                    onPress={() => setConfirm("submit")}
                    disabled={!canSubmit}
                    aria-label="Submit to Stripe"
                  >
                    {submit.isPending ? (
                      <Spinner size="small" />
                    ) : (
                      <Send size={14} aria-hidden />
                    )}
                    Submit to Stripe
                  </Button>
                )}
              </XStack>
              {(approveHint || submitHint) && (
                <Text
                  variant="caption"
                  tone="muted"
                  style={{ textAlign: "right" }}
                >
                  {[approveHint, submitHint].filter(Boolean).join(" ")}
                </Text>
              )}
            </YStack>
          )}
        </>
      )}

      {/* ── Confirm dialogs ───────────────────────────────────────────────── */}
      <ConfirmDialog
        open={confirm === "reassemble"}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirmed}
        title="Re-assemble evidence?"
        description="Rebuilds the draft from order data and discards your edits. Approval is cleared; the new draft needs a fresh sign-off."
        confirmLabel="Re-assemble"
        tone="danger"
      />
      <ConfirmDialog
        open={confirm === "approve"}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirmed}
        title="Approve this evidence package?"
        description="Approval marks the package ready to submit. You can still edit it afterwards, which drops it back to draft."
        confirmLabel="Approve"
      />
      <ConfirmDialog
        open={confirm === "submit"}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirmed}
        title="Submit evidence to Stripe?"
        confirmLabel="Submit"
        description={
          <YStack gap="$3">
            <Text variant="body" tone="muted">
              This package is sent to the card network through Stripe. It
              cannot be recalled or edited once sent.
            </Text>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content minmax(0, 1fr)",
                columnGap: 16,
                rowGap: 6,
                margin: 0,
              }}
            >
              <dt style={{ margin: 0 }}>
                <Text variant="overline" tone="muted">
                  Dispute
                </Text>
              </dt>
              <dd style={{ margin: 0, minWidth: 0 }}>
                <Text
                  variant="bodySmall"
                  fontFamily="$mono"
                  style={{ overflowWrap: "anywhere" }}
                >
                  {dispute.stripeDisputeId}
                </Text>
              </dd>
              <dt style={{ margin: 0 }}>
                <Text variant="overline" tone="muted">
                  Size
                </Text>
              </dt>
              <dd style={{ margin: 0 }}>
                <Text variant="bodySmall" fontFamily="$mono">
                  {fmt.number(total)} / {fmt.number(EVIDENCE_COMBINED_MAX)}
                </Text>
              </dd>
              <dt style={{ margin: 0 }}>
                <Text variant="overline" tone="muted">
                  Due
                </Text>
              </dt>
              <dd style={{ margin: 0 }}>
                <Text variant="bodySmall">
                  {dispute.evidenceDueBy
                    ? `${fmtDate(fmt, dispute.evidenceDueBy)} (${due.label})`
                    : "No deadline reported"}
                </Text>
              </dd>
            </dl>
          </YStack>
        }
      />
    </YStack>
  );
}

EvidenceEditor.displayName = "EvidenceEditor";

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Stripe evidence key with a break opportunity after each underscore.
 * Underscores are not line-break points in CSS, so a name wider than a
 * narrow panel would otherwise split mid-word ("PRODUCT_DESCRIPTI / ON").
 * `<wbr>` contributes nothing to the accessible name.
 */
function StripeName({ name }: { name: string }) {
  const parts = name.split("_");
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={`${part}-${i}`}>
          {i > 0 ? (
            <>
              _<wbr />
            </>
          ) : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function sourceTone(state: SourceState): "success" | "warning" | "neutral" {
  switch (state) {
    case "found":
      return "success";
    case "missing":
      return "warning";
    default:
      return "neutral";
  }
}

/** Provenance chips: what the assembler found, missed, or could not apply. */
function SourcesList({ sources }: { sources: Evidence["sources"] }) {
  const items = sourcesForDisplay(sources);
  return (
    <ul
      aria-label="Evidence sources"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        margin: 0,
        padding: 0,
        listStyle: "none",
      }}
    >
      {items.map((item) => (
        <li key={item.key} style={{ display: "contents" }}>
          <Badge tone={sourceTone(item.state)} size="xs">
            {item.label}: {sourceStateLabel(item.state)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Read-only rendering of a field (SUPPORT, or a SUBMITTED package). */
function ReadOnlyValue({
  labelledBy,
  value,
}: {
  labelledBy: string;
  value: string;
}): ReactNode {
  return (
    <YStack
      tag="div"
      role="group"
      aria-labelledby={labelledBy}
      borderWidth={2}
      borderColor="$borderColorSoft"
      backgroundColor="$surfaceMuted"
      padding="$3"
      minHeight={44}
    >
      {value ? (
        <Text
          variant="bodySmall"
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {value}
        </Text>
      ) : (
        <Text variant="bodySmall" tone="muted">
          (empty)
        </Text>
      )}
    </YStack>
  );
}
