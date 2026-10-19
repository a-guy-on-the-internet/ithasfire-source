"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Modal,
  StyledSelect,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { volunteerConflictMessageKey } from "./volunteering-helpers";

export type BroadcastScope =
  | { kind: "ALL" }
  | { kind: "ROLE"; roleId: string }
  | { kind: "GROUP"; groupId: string }
  | { kind: "POOL" };

export type BroadcastScopeOption = {
  /** Stable select value (e.g. "all", `role:${id}`, `group:${id}`, "pool"). */
  id: string;
  label: string;
  scope: BroadcastScope;
};

export type BroadcastComposerProps = {
  askId: string;
  open: boolean;
  /**
   * The scopes THIS actor may target. Owners pass the full set (whole ask /
   * per-role / per-group / pool); a coordinator passes only their own
   * group(s) — the server enforces the same rule, the composer just never
   * offers what would be refused.
   */
  scopes: BroadcastScopeOption[];
  /** Pre-selected scope id (e.g. the group whose card opened the composer). */
  initialScopeId?: string;
  onClose: () => void;
  onSent?: () => void;
};

/**
 * One-way roster announcement (FR-009). `broadcastId` is a client-generated
 * uuid held stable across retries of the SAME message, so a network retry
 * replays the ledger row instead of double-sending; it is regenerated after
 * a successful send, or when the message content is edited after a failure.
 */
export function BroadcastComposer({
  askId,
  open,
  scopes,
  initialScopeId,
  onClose,
  onSent,
}: BroadcastComposerProps) {
  const t = useTranslations();
  const notify = useNotify();

  const [scopeId, setScopeId] = useState(
    initialScopeId ?? scopes[0]?.id ?? "",
  );
  // Callers keep the composer mounted and toggle `open` (e.g. a group card
  // pre-scoping the send) — re-sync the requested scope on each open.
  useEffect(() => {
    if (open && initialScopeId) setScopeId(initialScopeId);
  }, [open, initialScopeId]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // Idempotency key for the in-flight message. Held stable across UNEDITED
  // retries of a failed send (so a network retry replays the ledger row),
  // regenerated after a successful send — and also when the user edits the
  // subject/body after a failure, since the edited message must not silently
  // replay the original ledger row.
  const broadcastIdRef = useRef<string>(crypto.randomUUID());
  const failedSinceLastEditRef = useRef(false);

  const rotateIdIfEditedAfterFailure = () => {
    if (failedSinceLastEditRef.current) {
      broadcastIdRef.current = crypto.randomUUID();
      failedSinceLastEditRef.current = false;
    }
  };
  const handleSubjectChange = (value: string) => {
    rotateIdIfEditedAfterFailure();
    setSubject(value);
  };
  const handleBodyChange = (value: string) => {
    rotateIdIfEditedAfterFailure();
    setBody(value);
  };

  const sendMutation = trpc.volunteer.broadcasts.send.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: (result) => {
      notify.toast.success({
        id: "volunteer-broadcast-sent",
        title: String(t("volunteering.broadcastSent")),
        message: String(
          t("volunteering.broadcastSentBody", {
            count: result.recipientCount,
          }),
        ),
      });
      broadcastIdRef.current = crypto.randomUUID();
      failedSinceLastEditRef.current = false;
      setSubject("");
      setBody("");
      onSent?.();
      onClose();
    },
    onError: (err) => {
      failedSinceLastEditRef.current = true;
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-broadcast-failed",
        title: String(t("volunteering.broadcastFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  const scopeOptions = useMemo(
    () => scopes.map((s) => ({ value: s.id, label: s.label })),
    [scopes],
  );

  const selectedScope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const canSend =
    Boolean(selectedScope) &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    !sendMutation.isPending;

  const handleSend = () => {
    if (!selectedScope || !canSend) return;
    sendMutation.mutate({
      askId,
      scope: selectedScope.scope,
      subject: subject.trim(),
      body: body.trim(),
      broadcastId: broadcastIdRef.current,
    });
  };

  if (!open) return null;

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(t("volunteering.broadcastTitle"))}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="bodySmall" tone="muted">
              {String(t("volunteering.broadcastHint"))}
            </Text>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.broadcastScopeLabel"))}
              </Text>
              <StyledSelect
                value={scopeId}
                options={scopeOptions}
                onChange={setScopeId}
                fullWidth
                testId="volunteer-broadcast-scope"
                aria-label={String(t("volunteering.broadcastScopeLabel"))}
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.broadcastSubjectLabel"))}
              </Text>
              <TextInput
                value={subject}
                onChangeText={handleSubjectChange}
                maxLength={200}
                fullWidth
                minHeight={44}
                testId="volunteer-broadcast-subject"
                aria-label={String(t("volunteering.broadcastSubjectLabel"))}
              />
            </YStack>

            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.broadcastBodyLabel"))}
              </Text>
              <TextInput
                value={body}
                onChangeText={handleBodyChange}
                multiline
                numberOfLines={5}
                maxLength={5000}
                fullWidth
                testId="volunteer-broadcast-body"
                aria-label={String(t("volunteering.broadcastBodyLabel"))}
              />
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button
              variant="ghost"
              onPress={onClose}
              disabled={sendMutation.isPending}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSend}
              disabled={!canSend}
              data-testid="volunteer-broadcast-send"
            >
              {sendMutation.isPending
                ? String(t("common.loading"))
                : String(t("volunteering.broadcastSendCta"))}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
