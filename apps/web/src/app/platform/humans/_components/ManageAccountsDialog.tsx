"use client";

import { useCallback, useState } from "react";
import { YStack, XStack } from "tamagui";
import {
  Button,
  Modal,
  Text,
  Spinner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Link2Off } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { lookupOwn } from "@/lib/lookup-own";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ManageAccountsDialogProps {
  open: boolean;
  onClose: () => void;
  humanId: string;
  humanName: string;
  onMutationSuccess: () => void;
}

// Provider labels for display
const PROVIDER_LABEL: Record<string, string> = {
  credential: "Email / Password",
  google: "Google",
  apple: "Apple",
};

function providerLabel(providerId: string): string {
  return lookupOwn(PROVIDER_LABEL, providerId) ?? providerId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ManageAccountsDialog({
  open,
  onClose,
  humanId,
  humanName,
  onMutationSuccess,
}: ManageAccountsDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // Confirm dialog state — unlink account
  const [unlinkTarget, setUnlinkTarget] = useState<string | null>(null);

  // ── Query linked accounts ─────────────────────────────────────────
  const {
    data: accounts,
    isLoading,
    refetch,
  } = trpc.platform.listHumanAuthAccounts.useQuery(
    { humanId },
    { enabled: open, staleTime: 10_000 },
  );

  // ── Unlink mutation ───────────────────────────────────────────────
  const unlinkMut = trpc.platform.unlinkAuthAccount.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      refetch();
      utils.platform.listHumans.invalidate();
      onMutationSuccess();
    },
  });

  const handleUnlink = useCallback((providerId: string) => {
    setUnlinkTarget(providerId);
  }, []);

  const confirmUnlink = useCallback(async () => {
    if (!unlinkTarget) return;
    try {
      await unlinkMut.mutateAsync({ humanId, providerId: unlinkTarget });
      toast.success({
        title: String(t("admin.phAccountUnlinked")),
      });
    } catch (err) {
      toast.danger({
        title: String(t("admin.phUnlinkFailed")),
        message: formatErrorMessage(err, t),
      });
    } finally {
      setUnlinkTarget(null);
    }
  }, [humanId, unlinkTarget, unlinkMut, toast, t]);

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("admin.phManageAccountsTitle", { name: humanName }))}
          onClose={onClose}
        />
        <Modal.Body>
          {isLoading ? (
            <YStack alignItems="center" padding="$6">
              <Spinner />
            </YStack>
          ) : !accounts?.length ? (
            <Text variant="body" tone="muted">
              {String(t("admin.phNoLinkedAccounts"))}
            </Text>
          ) : (
            <YStack gap="$3">
              {accounts.map((acct) => (
                <XStack
                  key={`${acct.providerId}-${acct.accountId}`}
                  alignItems="center"
                  justifyContent="space-between"
                  padding="$3"
                  borderWidth={1}
                  borderColor="$borderColor"
                  borderRadius={0}
                >
                  <YStack gap="$1">
                    <Text variant="body" weight="bold">
                      {providerLabel(acct.providerId)}
                    </Text>
                    <Text
                      variant="bodySmall"
                      tone="muted"
                      style={{ fontSize: 11 }}
                    >
                      {acct.accountId}
                    </Text>
                  </YStack>

                  <Button
                    variant="ghost"
                    size="$2"
                    onPress={() => handleUnlink(acct.providerId)}
                    disabled={unlinkMut.isPending}
                  >
                    <Link2Off size={14} />
                    {String(t("admin.phUnlink"))}
                  </Button>
                </XStack>
              ))}
            </YStack>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={onClose}>
            {String(t("admin.close"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>

      <ConfirmDialog
        open={!!unlinkTarget}
        onConfirm={confirmUnlink}
        onCancel={() => setUnlinkTarget(null)}
        title={String(t("admin.phUnlink"))}
        description={String(
          t("admin.phUnlinkConfirm", {
            provider: unlinkTarget ? providerLabel(unlinkTarget) : "",
          }),
        )}
        confirmLabel={String(t("admin.phUnlink"))}
        tone="danger"
        loading={unlinkMut.isPending}
      />
    </Modal>
  );
}
