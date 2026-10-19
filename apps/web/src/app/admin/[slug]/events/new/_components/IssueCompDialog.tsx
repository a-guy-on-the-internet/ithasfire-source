"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Modal,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { CheckCircle, Gift } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export type IssueCompDialogProps = {
  eventId: string;
  open: boolean;
  /**
   * Closes the dialog. The OWNER of this callback is responsible for putting
   * focus back somewhere real — see `CompTicketsTab`, which restores to the
   * header trigger rather than to whatever opened the dialog.
   */
  onClose: () => void;
};

/**
 * The comp-issuing form, relocated verbatim out of the comp-tickets page and
 * into a dialog.
 *
 * WHY A DIALOG, not a panel beside the ledger: issuing is an occasional act,
 * the ledger is the page's subject, and a permanently-open five-field form was
 * the whole reason the page had no room to show what had already been comped.
 * A dialog also keeps the surface honest for the roles that can READ the
 * ledger but cannot ISSUE (EDITOR / FINANCE) — there is simply nothing to
 * render for them rather than a form that can only 403.
 *
 * Everything below the shell — the field set, the client-side validity rule,
 * the mutation, the toast pair and the success banner — is the pre-existing
 * behaviour moved, not rewritten. Three things are ADDED, all of them
 * additive:
 *  - `comp.list` is invalidated on success so the new row appears in the
 *    ledger behind the dialog without a manual refresh;
 *  - the dialog stays OPEN on success (form reset, focus back in the email
 *    field) so a run of comps can be issued in one sitting — which is what
 *    keeps the original inline success banner meaningful instead of deleting
 *    it along with the page-level form;
 *  - the banner is a live region, and the fields carry accessible names (the
 *    hand-rolled `<select>` had none).
 */
export function IssueCompDialog({
  eventId,
  open,
  onClose,
}: IssueCompDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [ticketTypeId, setTicketTypeId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [successInfo, setSuccessInfo] = useState<{
    orderId: string;
    recipientEmail: string;
    quantity: number;
  } | null>(null);

  // Only fetched while the dialog is open — the ledger behind it has no use
  // for the ticket-type list.
  const ticketTypesQuery = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId },
    { enabled: !!eventId && open, staleTime: 60_000 },
  );

  const ticketTypesForForm = useMemo(() => {
    const data = ticketTypesQuery.data;
    if (!data?.ticketTypes?.length) return [];
    return data.ticketTypes.map((tt) => ({ id: tt.id, name: tt.name }));
  }, [ticketTypesQuery.data]);

  const effectiveTicketTypeId = ticketTypeId || ticketTypesForForm[0]?.id || "";

  // TextInput hands back either the raw <input> or a styled wrapper around it;
  // resolve to the DOM input so `.focus()` always works (same idiom as
  // AdminTableParts' SearchBar).
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const resolveEmailRef = useCallback((node: unknown) => {
    emailInputRef.current =
      node instanceof HTMLInputElement
        ? node
        : ((node as HTMLElement | null)?.querySelector?.("input") ?? null);
  }, []);

  const resetForm = useCallback(() => {
    setEmail("");
    setName("");
    setQuantity("1");
    setReason("");
    setTicketTypeId("");
  }, []);

  const issueMutation = trpc.comp.issue.useMutation({
    onSuccess: (data) => {
      setSuccessInfo({
        orderId: data.orderId,
        recipientEmail: email,
        quantity: parseInt(quantity, 10),
      });
      toast.success(String(t("admin.compIssuedToast")));
      resetForm();
      // The row the organizer just created has to show up in the ledger
      // behind this dialog; without this it only appears on a manual refresh.
      void utils.comp.list.invalidate();
      // Back to the top of a now-empty form, ready for the next recipient.
      emailInputRef.current?.focus();
    },
    onError: (error) => {
      toast.danger(formatErrorMessage(error, t));
    },
  });

  const handleSubmit = useCallback(() => {
    const qty = parseInt(quantity, 10);
    if (!email || !effectiveTicketTypeId || isNaN(qty) || qty < 1) return;

    issueMutation.mutate({
      eventId,
      ticketTypeId: effectiveTicketTypeId,
      quantity: qty,
      recipientEmail: email,
      recipientName: name || undefined,
      reason: reason || undefined,
    });
  }, [
    email,
    name,
    effectiveTicketTypeId,
    quantity,
    reason,
    eventId,
    issueMutation,
  ]);

  const isValid =
    email.includes("@") && effectiveTicketTypeId && parseInt(quantity, 10) >= 1;

  // Focus lands on the first field rather than on the panel: this dialog is a
  // form, and Modal.Panel deliberately does not steal focus that a consumer
  // has already placed inside it.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      emailInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // A stale "3 tickets issued to …" banner must not greet the next open.
  useEffect(() => {
    if (!open) setSuccessInfo(null);
  }, [open]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Modal open={open} onClose={handleClose}>
      {/* Dialog semantics are Modal.Panel's job: it always sets role="dialog"
          + aria-modal, and Modal.Header registers the title so the panel gets
          aria-labelledby. Nothing to re-declare here. */}
      <Modal.Panel width={560}>
        <Modal.Header
          title={String(t("admin.compIssueDialogTitle"))}
          subtitle={String(t("admin.opsCompTicketsPurpose"))}
          onClose={handleClose}
        />

        <Modal.Body>
          {successInfo && (
            <XStack
              gap="$2"
              alignItems="center"
              flexWrap="wrap"
              backgroundColor="$surfaceMuted"
              borderLeftWidth={4}
              borderLeftColor="$success"
              borderRadius={0}
              padding="$3"
              {...({ role: "status", "aria-live": "polite" } as object)}
            >
              {/* Stub's `success` (#166534) is the SSR/first-paint fallback —
                  a bright value here would flash on load. */}
              <CheckCircle
                size={18}
                color="var(--success, #166534)"
                aria-hidden
              />
              <Text variant="body" flexShrink={1} minWidth={0}>
                {String(
                  t("admin.compIssuedBanner", {
                    count: successInfo.quantity,
                    email: successInfo.recipientEmail,
                  }),
                )}
              </Text>
              <Button
                variant="ghost"
                size="$2"
                marginLeft="auto"
                onPress={() => setSuccessInfo(null)}
              >
                {String(t("admin.compIssuedBannerDismiss"))}
              </Button>
            </XStack>
          )}

          <YStack gap="$2">
            <Text variant="label">
              {String(t("admin.compIssueRecipientEmailLabel"))}
            </Text>
            <TextInput
              ref={resolveEmailRef}
              value={email}
              onChangeText={setEmail}
              placeholder={String(t("admin.compIssueRecipientEmailPlaceholder"))}
              autoCapitalize="none"
              keyboardType="email-address"
              fullWidth
              containerWidth="100%"
              aria-label={String(t("admin.compIssueRecipientEmailLabel"))}
              testId="comp-recipient-email"
            />
          </YStack>

          <YStack gap="$2">
            <Text variant="label">
              {String(t("admin.compIssueRecipientNameLabel"))}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={String(t("admin.compIssueOptionalPlaceholder"))}
              fullWidth
              containerWidth="100%"
              aria-label={String(t("admin.compIssueRecipientNameLabel"))}
              testId="comp-recipient-name"
            />
          </YStack>

          <YStack gap="$2">
            <Text variant="label">
              {String(t("admin.compIssueTicketTypeLabel"))}
            </Text>
            {ticketTypesQuery.isLoading ? (
              <Spinner size="sm" />
            ) : ticketTypesForForm.length === 0 ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.compIssueNoTicketTypes"))}
              </Text>
            ) : (
              <XStack
                tag="select"
                borderWidth={2}
                borderColor="$borderColor"
                borderRadius={0}
                padding="$2"
                minHeight={44}
                backgroundColor="$background"
                // @ts-expect-error -- native select on web
                value={effectiveTicketTypeId}
                aria-label={String(t("admin.compIssueTicketTypeLabel"))}
                data-testid="comp-ticket-type"
                onChange={(e: { target: { value: string } }) =>
                  setTicketTypeId(e.target.value)
                }
              >
                {ticketTypesForForm.map((tt) => (
                  <option key={tt.id} value={tt.id}>
                    {tt.name}
                  </option>
                ))}
              </XStack>
            )}
          </YStack>

          <YStack gap="$2">
            <Text variant="label">
              {String(t("admin.compIssueQuantityLabel"))}
            </Text>
            <TextInput
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="numeric"
              placeholder="1"
              fullWidth
              containerWidth="100%"
              aria-label={String(t("admin.compIssueQuantityLabel"))}
              testId="comp-quantity"
            />
          </YStack>

          <YStack gap="$2">
            <Text variant="label">
              {String(t("admin.compIssueReasonLabel"))}
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder={String(t("admin.compIssueReasonPlaceholder"))}
              fullWidth
              containerWidth="100%"
              aria-label={String(t("admin.compIssueReasonLabel"))}
              testId="comp-reason"
            />
          </YStack>
        </Modal.Body>

        {/* `secondary`, not `primary`: the surface's one primary is the header
            "Issue comps" trigger (v2 §04, one primary per viewport). Wraps at
            320px rather than pushing past the panel edge. */}
        <Modal.Footer flexWrap="wrap">
          <Button variant="ghost" size="$3" onPress={handleClose}>
            {String(t("common.cancel"))}
          </Button>
          <Button
            variant="secondary"
            size="$3"
            onPress={handleSubmit}
            disabled={!isValid || issueMutation.isPending}
            testID="comp-issue-submit"
          >
            {issueMutation.isPending ? (
              <Spinner size="sm" />
            ) : (
              <>
                <Gift size={16} aria-hidden />
                {String(t("admin.compIssueSubmit"))}
              </>
            )}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

IssueCompDialog.displayName = "IssueCompDialog";
