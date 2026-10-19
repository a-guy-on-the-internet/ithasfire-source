"use client";

import { useId, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import {
  bpsToPercentText,
  bpsToWholePercent,
  canViewerConfirmLine,
  percentFromText,
  percentTextToBps,
  type ViewerIdentity,
} from "@/lib/booking-agreements";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { HumanSearchCombobox } from "@/app/admin/[slug]/events/new/_components/HumanSearchCombobox";
import type { AgreementGetOutput } from "./AgreementEditor";
import { isAnswerLine } from "./agreement-deal";

type AgreementLine = AgreementGetOutput["lines"][number];

/**
 * The share a row displays, sent with the payee's answer: the server refuses
 * the answer if the stored line no longer matches it.
 */
const answeredOf = (line: AgreementLine) => ({
  percent: line.percent,
  floorCents: line.floorCents,
  capPercent: line.capPercent,
});
type AgreementStatus = AgreementGetOutput["agreement"]["status"];

const CONFIRMATION_LABEL_KEYS: Record<string, string> = {
  PENDING: "admin.baLineConfPending",
  CONFIRMED: "admin.baLineConfConfirmed",
  COUNTERED: "admin.baLineConfCountered",
  DECLINED: "admin.baLineConfDeclined",
};

const CONFIRMATION_TONES: Record<
  string,
  "success" | "info" | "warning" | "neutral" | "danger"
> = {
  PENDING: "warning",
  CONFIRMED: "success",
  COUNTERED: "warning",
  DECLINED: "danger",
};

function ColumnLabel({ children, flex }: { children: string; flex?: number }) {
  return (
    <Text
      flex={flex}
      variant="caption"
      weight="bold"
      tone="muted"
      textTransform="uppercase"
      letterSpacing={0.6}
    >
      {children}
    </Text>
  );
}

/**
 * Payout lines: editable rows while DRAFT (either party, edit access),
 * read-only otherwise. Party lines are implied by whole-agreement acceptance
 * (`requiresConfirmation = false`); third-party lines confirm individually —
 * the payee may also COUNTER (propose a different share, in bps, with a
 * required note) or DECLINE. A countered ask is visible to everyone; parties
 * apply it via the DRAFT line editor ("Apply counter" prefills the percent
 * when the ask is a whole percent — line percents are integers).
 *
 * `answersOnly` (the agreement page, where "The deal" edits the terms): only
 * the lines a payee still answers for themselves and any open counter-ask,
 * with no line editing; nothing at all when there are none.
 */
export function PayoutLinesSection({
  agreementId,
  status,
  lines,
  mayEdit,
  viewer,
  onRefresh,
  onActionError,
  answersOnly = false,
}: {
  agreementId: string;
  status: AgreementStatus;
  lines: AgreementLine[];
  mayEdit: boolean;
  viewer: ViewerIdentity;
  onRefresh: () => void;
  onActionError: (err: unknown) => void;
  /** Only the payee answers: no line editing, nothing when none are open. */
  answersOnly?: boolean;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const addPercentId = useId();

  // ── Inline row edit state ─────────────────────────────────────────────────
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editPercent, setEditPercent] = useState("");

  // ── Per-line counter / decline state (payee-side) ─────────────────────────
  const [counterLineId, setCounterLineId] = useState<string | null>(null);
  const [counterPercent, setCounterPercent] = useState("");
  const [counterNote, setCounterNote] = useState("");
  const [declineLineId, setDeclineLineId] = useState<string | null>(null);
  // Which payee decision is in flight — Confirm / Counter / Decline share one
  // mutation, so this keys the spinner to the button that fired it (all three
  // stay disabled while anything is pending).
  const [pendingDecision, setPendingDecision] = useState<
    "CONFIRM" | "COUNTER" | "DECLINE" | null
  >(null);

  // ── Add-payee form state ──────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [searchSelection, setSearchSelection] = useState<{
    humanId: string;
    displayName: string;
  } | null>(null);
  const [addPercent, setAddPercent] = useState("");

  const upsertMutation = trpc.bookingAgreements.upsertLine.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const removeMutation = trpc.bookingAgreements.removeLine.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const confirmMutation = trpc.payoutTerms.confirmPayoutLine.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const anyPending =
    upsertMutation.isPending ||
    removeMutation.isPending ||
    confirmMutation.isPending;

  const totalPercent = useMemo(
    () => lines.reduce((sum, line) => sum + line.percent, 0),
    [lines],
  );

  const editable = !answersOnly && mayEdit && status === "DRAFT";
  const shownLines = answersOnly
    ? lines.filter((line) => isAnswerLine(line, viewer))
    : lines;
  const viewerAnswers = shownLines.some((line) =>
    canViewerConfirmLine(line, viewer),
  );

  // ── Handlers ──────────────────────────────────────────────────────────────
  const startEdit = (line: AgreementLine) => {
    setEditingLineId(line.id);
    setEditPercent(String(line.percent));
  };

  const cancelEdit = () => {
    setEditingLineId(null);
    setEditPercent("");
  };

  const saveEdit = (line: AgreementLine) => {
    if (anyPending || !line.subjectType || !line.subjectId) return;
    const percent = percentFromText(editPercent);
    if (percent === null) return;
    upsertMutation.mutate(
      {
        agreementId,
        lineId: line.id,
        payeeRef: {
          kind: line.subjectType === "organization" ? "org" : "human",
          id: line.subjectId,
        },
        percent,
        capPercent: line.capPercent,
        priority: line.priority,
      },
      {
        onSuccess: () => {
          cancelEdit();
          toast.success({
            id: "ba-line-saved",
            title: String(t("admin.baLineSavedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  const removeLine = (line: AgreementLine) => {
    if (anyPending) return;
    removeMutation.mutate(
      { agreementId, lineId: line.id },
      {
        onSuccess: () => {
          toast.success({
            id: "ba-line-removed",
            title: String(t("admin.baLineRemovedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  const confirmLine = (line: AgreementLine) => {
    if (anyPending) return;
    setPendingDecision("CONFIRM");
    confirmMutation.mutate(
      {
        payoutTermsLineId: line.id,
        decision: "CONFIRM",
        answered: answeredOf(line),
      },
      {
        onSuccess: () => {
          closeCounterForm();
          toast.success({
            id: "ba-line-confirmed",
            title: String(t("admin.baLineConfirmedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
        onSettled: () => setPendingDecision(null),
      },
    );
  };

  const openCounterForm = (line: AgreementLine) => {
    setCounterLineId(line.id);
    // Pre-seed with the payee's previous ask (re-counter) or the line's
    // current share, so the form opens with a valid value to adjust.
    setCounterPercent(
      line.counterPercentBps !== null
        ? bpsToPercentText(line.counterPercentBps)
        : String(line.percent),
    );
    setCounterNote(line.counterNote ?? "");
  };

  const closeCounterForm = () => {
    setCounterLineId(null);
    setCounterPercent("");
    setCounterNote("");
  };

  const counterBps = percentTextToBps(counterPercent);
  const counterNoteTrimmed = counterNote.trim();
  const counterNoteValid = counterNoteTrimmed.length >= 10;

  const submitCounter = (line: AgreementLine) => {
    if (anyPending || counterBps === null || !counterNoteValid) return;
    setPendingDecision("COUNTER");
    confirmMutation.mutate(
      {
        payoutTermsLineId: line.id,
        decision: "COUNTER",
        answered: answeredOf(line),
        counterPercentBps: counterBps,
        counterNote: counterNoteTrimmed,
      },
      {
        onSuccess: () => {
          closeCounterForm();
          toast.success({
            id: "ba-line-countered",
            title: String(t("admin.baCounteredToast")),
          });
          onRefresh();
        },
        onError: onActionError,
        onSettled: () => setPendingDecision(null),
      },
    );
  };

  const declineLine = () => {
    if (anyPending || !declineLineId) return;
    const line = lines.find((l) => l.id === declineLineId);
    if (!line) return;
    setPendingDecision("DECLINE");
    confirmMutation.mutate(
      {
        payoutTermsLineId: line.id,
        decision: "DECLINE",
        answered: answeredOf(line),
      },
      {
        onSuccess: () => {
          closeCounterForm();
          toast.success({
            id: "ba-line-declined",
            title: String(t("admin.baLineDeclinedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
        onSettled: () => {
          setDeclineLineId(null);
          setPendingDecision(null);
        },
      },
    );
  };

  const addPercentValue = percentFromText(addPercent);
  const canAdd =
    Boolean(searchSelection) && addPercentValue !== null && !anyPending;

  const addLine = () => {
    if (!canAdd || !searchSelection) return;
    upsertMutation.mutate(
      {
        agreementId,
        payeeRef: { kind: "human", id: searchSelection.humanId },
        percent: addPercentValue as number,
        priority: lines.length,
      },
      {
        onSuccess: () => {
          setSearchInput("");
          setSearchSelection(null);
          setAddPercent("");
          toast.success({
            id: "ba-line-saved",
            title: String(t("admin.baLineSavedToast")),
          });
          onRefresh();
        },
        onError: onActionError,
      },
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (answersOnly && shownLines.length === 0) return null;
  const titleKey = !answersOnly
    ? "admin.baLinesTitle"
    : viewerAnswers
      ? "deals.answers.titleYours"
      : "deals.answers.titleAsks";
  const subtitleKey = !answersOnly
    ? "admin.baLinesSubtitle"
    : viewerAnswers
      ? "deals.answers.hintYours"
      : "deals.answers.hintAsks";
  return (
    <YStack gap="$3" testID={answersOnly ? "ba-line-answers" : undefined}>
      <YStack gap="$1">
        <Text
          variant="h4"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.3}
        >
          {String(t(titleKey))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t(subtitleKey))}
        </Text>
      </YStack>

      {shownLines.length === 0 ? (
        <YStack
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          alignItems="center"
        >
          <Text variant="bodySmall" tone="muted" textAlign="center">
            {String(t("admin.baLinesEmpty"))}
          </Text>
        </YStack>
      ) : (
        <YStack borderWidth={2} borderColor="$borderColor">
          {/* Header row — hidden from narrow screens where rows wrap. */}
          <XStack
            gap="$3"
            paddingHorizontal="$3"
            paddingVertical="$2"
            borderBottomWidth={2}
            borderBottomColor="$borderColor"
            display="none"
            $gtSm={{ display: "flex" }}
          >
            <ColumnLabel flex={2}>
              {String(t("admin.baLineColPayee"))}
            </ColumnLabel>
            <ColumnLabel flex={1}>
              {String(t("admin.baLineColShare"))}
            </ColumnLabel>
            <ColumnLabel flex={1}>
              {String(t("admin.baLineColConfirmation"))}
            </ColumnLabel>
            {editable ? <XStack width={72} /> : null}
          </XStack>

          {shownLines.map((line) => {
            const isEditing = editingLineId === line.id;
            const showLineActions = canViewerConfirmLine(line, viewer);
            const isCountering = counterLineId === line.id;
            // "Apply counter" only when the ask is a whole percent — line
            // percents are integers, so a fractional ask can't be applied.
            const counterWholePercent =
              line.counterPercentBps !== null
                ? bpsToWholePercent(line.counterPercentBps)
                : null;
            const editPercentValue = percentFromText(editPercent);
            const canSaveEdit = editPercentValue !== null && !anyPending;

            return (
              <YStack
                key={line.id}
                gap="$2"
                paddingHorizontal="$3"
                paddingVertical="$3"
                borderBottomWidth={1}
                borderBottomColor="$borderColor"
              >
                <XStack gap="$3" alignItems="center" flexWrap="wrap">
                  {/* Payee */}
                  <YStack flex={2} minWidth={160} gap="$1">
                    <Text variant="bodySmall" weight="bold">
                      {line.displayName ?? line.payeeId.slice(0, 8)}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {line.subjectType === "organization"
                        ? String(t("admin.baLineTagOrg"))
                        : line.subjectType === "human"
                          ? String(t("admin.baLineTagHuman"))
                          : String(t("admin.baLineUnresolvedPayee"))}
                    </Text>
                  </YStack>

                  {/* Share (read or edit) */}
                  {isEditing ? (
                    <>
                      <XStack flex={1} minWidth={90} gap="$1" alignItems="center">
                        <TextInput
                          value={editPercent}
                          onChangeText={setEditPercent}
                          inputMode="numeric"
                          fullWidth
                          aria-label={String(t("admin.baAddPercentLabel"))}
                          aria-invalid={
                            editPercentValue === null ? true : undefined
                          }
                          testId={`ba-line-percent-${line.id}`}
                        />
                        <Text variant="bodySmall" tone="muted">
                          %
                        </Text>
                      </XStack>
                      {counterWholePercent !== null ? (
                        <Button
                          variant="ghost"
                          size="$1"
                          disabled={anyPending}
                          onPress={() =>
                            setEditPercent(String(counterWholePercent))
                          }
                          testID={`ba-line-apply-counter-${line.id}`}
                        >
                          {String(
                            t("admin.baApplyCounter", {
                              percent: counterWholePercent,
                            }),
                          )}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Text flex={1} minWidth={60} variant="bodySmall" weight="bold">
                        {line.percent}%
                      </Text>
                    </>
                  )}

                  {/* Confirmation */}
                  <XStack flex={1} minWidth={90}>
                    {line.requiresConfirmation ? (
                      <Badge
                        tone={
                          CONFIRMATION_TONES[line.confirmationStatus ?? ""] ??
                          "neutral"
                        }
                        size="sm"
                      >
                        {String(
                          t(
                            CONFIRMATION_LABEL_KEYS[
                              line.confirmationStatus ?? ""
                            ] ?? "admin.baLineConfPending",
                          ),
                        )}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" size="sm">
                        {String(t("admin.baLineImplied"))}
                      </Badge>
                    )}
                  </XStack>

                  {/* Row actions */}
                  {editable ? (
                    isEditing ? (
                      <XStack gap="$1" alignItems="center">
                        <Button
                          variant="ghost"
                          size="$2"
                          disabled={anyPending}
                          onPress={cancelEdit}
                        >
                          {String(t("common.cancel"))}
                        </Button>
                        <Button
                          variant="primary"
                          size="$2"
                          disabled={!canSaveEdit}
                          onPress={() => saveEdit(line)}
                          testID={`ba-line-save-${line.id}`}
                        >
                          {upsertMutation.isPending ? (
                            <Spinner size="sm" />
                          ) : (
                            String(t("admin.baLineSave"))
                          )}
                        </Button>
                      </XStack>
                    ) : (
                      <XStack gap="$1" alignItems="center">
                        <Button
                          variant="ghost"
                          size="$1"
                          icon
                          disabled={anyPending || !line.subjectId}
                          onPress={() => startEdit(line)}
                          aria-label={String(t("admin.baLineEdit"))}
                          testID={`ba-line-edit-${line.id}`}
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="$1"
                          icon
                          disabled={anyPending}
                          onPress={() => removeLine(line)}
                          aria-label={String(t("admin.baLineRemove"))}
                          testID={`ba-line-remove-${line.id}`}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </XStack>
                    )
                  ) : null}
                </XStack>

                {/* Open counter-ask — visible to every viewer of the line. */}
                {line.confirmationStatus === "COUNTERED" &&
                line.counterPercentBps !== null ? (
                  <Text
                    variant="caption"
                    tone="muted"
                    testID={`ba-line-counter-ask-${line.id}`}
                  >
                    {String(
                      t("admin.baCounterAsk", {
                        percent: bpsToPercentText(line.counterPercentBps),
                        note: line.counterNote ?? "",
                      }),
                    )}
                  </Text>
                ) : null}

                {/* Per-payee actions — viewer is this line's payee. */}
                {showLineActions ? (
                  <XStack
                    gap="$3"
                    alignItems="center"
                    justifyContent="space-between"
                    flexWrap="wrap"
                    padding="$2"
                    backgroundColor="$surfaceMuted"
                  >
                    <Text variant="caption" tone="muted" flex={1} minWidth={180}>
                      {String(t("admin.baConfirmYourLineHint"))}
                    </Text>
                    <XStack gap="$2" flexWrap="wrap">
                      <Button
                        variant="primary"
                        size="$2"
                        disabled={anyPending}
                        onPress={() => confirmLine(line)}
                        testID={`ba-line-confirm-${line.id}`}
                      >
                        {confirmMutation.isPending &&
                        pendingDecision === "CONFIRM" ? (
                          <Spinner size="sm" />
                        ) : (
                          String(t("admin.baConfirmYourLine"))
                        )}
                      </Button>
                      <Button
                        variant="outlined"
                        size="$2"
                        disabled={anyPending}
                        onPress={() =>
                          isCountering
                            ? closeCounterForm()
                            : openCounterForm(line)
                        }
                        testID={`ba-line-counter-${line.id}`}
                      >
                        {String(t("admin.baLineCounter"))}
                      </Button>
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={anyPending}
                        onPress={() => setDeclineLineId(line.id)}
                        testID={`ba-line-decline-${line.id}`}
                      >
                        {String(t("admin.baLineDecline"))}
                      </Button>
                    </XStack>
                  </XStack>
                ) : null}

                {/* Inline counter form — proposed share % + required note. */}
                {showLineActions && isCountering ? (
                  <YStack
                    gap="$2"
                    padding="$3"
                    borderWidth={1}
                    borderColor="$borderColor"
                    backgroundColor="$surface"
                  >
                    <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
                      <YStack flex={1} minWidth={110} gap="$1">
                        <Text variant="caption" tone="muted">
                          {String(t("admin.baCounterPercentLabel"))}
                        </Text>
                        <TextInput
                          value={counterPercent}
                          onChangeText={setCounterPercent}
                          inputMode="decimal"
                          fullWidth
                          aria-label={String(t("admin.baCounterPercentLabel"))}
                          aria-invalid={counterBps === null ? true : undefined}
                          testId={`ba-counter-percent-${line.id}`}
                        />
                      </YStack>
                      <YStack flex={3} minWidth={220} gap="$1">
                        <Text variant="caption" tone="muted">
                          {String(t("admin.baCounterNoteLabel"))}
                        </Text>
                        <TextInput
                          value={counterNote}
                          onChangeText={setCounterNote}
                          maxLength={2000}
                          fullWidth
                          aria-label={String(t("admin.baCounterNoteLabel"))}
                          aria-invalid={
                            counterNote.trim() !== "" && !counterNoteValid
                              ? true
                              : undefined
                          }
                          testId={`ba-counter-note-${line.id}`}
                        />
                      </YStack>
                    </XStack>
                    {counterPercent.trim() !== "" && counterBps === null ? (
                      <Text variant="caption" tone="error">
                        {String(t("admin.baErrCounterPercentInvalid"))}
                      </Text>
                    ) : null}
                    <Text variant="caption" tone="muted">
                      {String(t("admin.baCounterNoteHint"))}
                    </Text>
                    <XStack gap="$2" justifyContent="flex-end">
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={anyPending}
                        onPress={closeCounterForm}
                      >
                        {String(t("common.cancel"))}
                      </Button>
                      <Button
                        variant="primary"
                        size="$2"
                        disabled={
                          counterBps === null || !counterNoteValid || anyPending
                        }
                        onPress={() => submitCounter(line)}
                        testID={`ba-counter-submit-${line.id}`}
                      >
                        {confirmMutation.isPending &&
                        pendingDecision === "COUNTER" ? (
                          <Spinner size="sm" />
                        ) : (
                          String(t("admin.baCounterSubmit"))
                        )}
                      </Button>
                    </XStack>
                  </YStack>
                ) : null}
              </YStack>
            );
          })}

          {/* Totals (a subset's total would mislead, so not in answersOnly) */}
          {answersOnly ? null : (
            <XStack
              paddingHorizontal="$3"
              paddingVertical="$2"
              justifyContent="flex-end"
              gap="$2"
            >
              <Text
                variant="caption"
                weight="bold"
                tone={totalPercent > 100 ? "error" : "muted"}
              >
                {String(t("admin.baLineTotal", { percent: totalPercent }))}
              </Text>
              {totalPercent > 100 ? (
                <Text variant="caption" tone="error">
                  {String(t("admin.baLineOverAllocated"))}
                </Text>
              ) : null}
            </XStack>
          )}
        </YStack>
      )}

      {/* ── Add payee (DRAFT only) ──────────────────────────────────────── */}
      {editable ? (
        <YStack gap="$2">
          <Text
            variant="caption"
            weight="bold"
            tone="muted"
            textTransform="uppercase"
            letterSpacing={0.6}
          >
            {String(t("admin.baAddPayeeLabel"))}
          </Text>
          <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
            <YStack flex={2} minWidth={220} gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.baAddPayeeSearchLabel"))}
              </Text>
              <HumanSearchCombobox
                selectedHumanId={searchSelection?.humanId ?? null}
                selectedDisplayName={searchSelection?.displayName ?? null}
                inputValue={searchInput}
                onInputChange={setSearchInput}
                onSelect={(humanId, displayName) =>
                  setSearchSelection({ humanId, displayName })
                }
                onClear={() => setSearchSelection(null)}
                placeholder={String(t("admin.baAddPayeeSearchPlaceholder"))}
                disabled={anyPending}
                testId="ba-add-payee-search"
              />
            </YStack>
            <YStack flex={1} minWidth={90} gap="$1">
              <Text tag="label" htmlFor={addPercentId} variant="caption" tone="muted">
                {String(t("admin.baAddPercentLabel"))}
              </Text>
              <TextInput
                id={addPercentId}
                value={addPercent}
                onChangeText={setAddPercent}
                placeholder="0"
                inputMode="numeric"
                fullWidth
                aria-invalid={
                  addPercent.trim() !== "" && addPercentValue === null
                    ? true
                    : undefined
                }
                testId="ba-add-percent"
              />
            </YStack>
            <Button
              variant="outlined"
              size="$2"
              disabled={!canAdd}
              onPress={addLine}
              testID="ba-add-line"
            >
              {upsertMutation.isPending ? (
                <Spinner size="sm" />
              ) : (
                <>
                  <Plus size={14} />
                  {String(t("admin.baAddLine"))}
                </>
              )}
            </Button>
          </XStack>
          {addPercent.trim() !== "" && addPercentValue === null ? (
            <Text variant="caption" tone="error">
              {String(t("admin.baErrPercentInvalid"))}
            </Text>
          ) : null}
        </YStack>
      ) : null}

      <ConfirmDialog
        open={declineLineId !== null}
        onConfirm={declineLine}
        onCancel={() => setDeclineLineId(null)}
        title={String(t("admin.baDeclineLineConfirmTitle"))}
        description={String(t("admin.baDeclineLineConfirmBody"))}
        confirmLabel={String(t("admin.baLineDecline"))}
        cancelLabel={String(t("common.cancel"))}
        loading={confirmMutation.isPending && pendingDecision === "DECLINE"}
        loadingLabel={String(t("common.loading"))}
      />
    </YStack>
  );
}
