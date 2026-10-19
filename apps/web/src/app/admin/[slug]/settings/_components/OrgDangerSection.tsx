"use client";

import { useCallback, useState } from "react";
import { useRouter } from "@bprogress/next/app";
import { XStack, YStack } from "tamagui";
import {
  Button,
  LabeledTextInput,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { AlertTriangle, DollarSign, Trash2 } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtCurrency } from "@/lib/format";

/**
 * "Delete group" — the owner-only danger zone, moved onto its own route
 * unchanged: the pending-payouts warning, the type-the-name confirmation and
 * the mismatch toast are all preserved.
 *
 * Reaching this route at all is OWNER-gated by the nav model's entitlement set
 * (`buildOrgSettingsGroups`), which the shell enforces with a redirect; the
 * `deleteOrg` mutation is authorised server-side regardless.
 */
export function OrgDangerSection({ orgId }: { orgId: string }) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const router = useRouter();

  const orgQuery = trpc.orgs.getOrg.useQuery({ orgId }, { enabled: !!orgId });

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

  // Pending payout info, so the owner is warned before deletion.
  const payoutQuery = trpc.orders.getOwnerPayoutSummary.useQuery(
    { orgId },
    { enabled: Boolean(orgId), staleTime: 30_000 },
  );
  // UNKNOWN IS NOT "NO". This gate gets a DESTRUCTIVE action wrong in the
  // dangerous direction if it reads a failed or in-flight query as zero: the
  // old `?? 0` enabled "Delete group" for an org whose payout read never
  // landed. Three states, three behaviours.
  const pendingItemCount = payoutQuery.data?.pendingItemCount ?? null;
  const hasPendingPayouts = pendingItemCount !== null && pendingItemCount > 0;
  /** The read LANDED and the ledger read behind it degraded. */
  const payoutUnresolved =
    !payoutQuery.isLoading && payoutQuery.data?.resolved !== true;
  /** Anything short of "we checked, and nothing is waiting" blocks deletion. */
  const deletionBlocked =
    hasPendingPayouts || payoutQuery.isLoading || payoutUnresolved;

  const deleteMutation = trpc.orgs.deleteOrg.useMutation({
    onSuccess: () => {
      toast.success({
        id: "org-deleted",
        title: String(t("admin.deleteOrgSuccess")),
      });
      router.push("/admin");
    },
    onError: (error) => {
      const msg = formatErrorMessage(error);
      const isActiveEvents = getAppErrorCode(error) === "ORG_HAS_ACTIVE_EVENTS";
      toast.danger({
        id: "org-delete-error",
        title: String(t("admin.deleteOrgError")),
        message: isActiveEvents
          ? String(t("admin.deleteOrgHasActiveEvents"))
          : msg,
      });
    },
  });

  const handleDeleteOrg = useCallback(() => {
    if (!orgId || !orgQuery.data) return;
    if (deleteConfirmName.trim() !== orgQuery.data.name) {
      toast.danger({
        id: "org-delete-name-mismatch",
        title: String(t("admin.deleteOrgNameMismatch")),
      });
      return;
    }
    deleteMutation.mutate({ orgId });
  }, [orgId, orgQuery.data, deleteConfirmName, deleteMutation, toast, t]);

  return (
    <YStack gap="$4">
      <XStack gap="$2" alignItems="center">
        {/* var() form with the Stub hex as the SSR/first-paint fallback. */}
        <AlertTriangle size={18} color="var(--danger, #B91C1C)" aria-hidden />
        <Text variant="h4" weight="bold" tone="error">
          {String(t("admin.settingsDanger"))}
        </Text>
      </XStack>

      <Text variant="body" tone="muted">
        {String(t("admin.settingsDangerDescription"))}
      </Text>

      <YStack
        borderWidth={2}
        borderColor="$danger"
        borderRadius={0}
        padding="$4"
        gap="$3"
      >
        <XStack
          justifyContent="space-between"
          alignItems="flex-start"
          flexWrap="wrap"
          gap="$3"
        >
          <YStack flex={1} gap="$1" minWidth={180}>
            <Text variant="body" weight="bold">
              {String(t("admin.deleteOrgButton"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("admin.deleteOrgDescription"))}
            </Text>
          </YStack>
          <Button
            variant="destructive"
            onPress={() => setShowDeleteConfirm(true)}
            disabled={deleteMutation.isPending || deletionBlocked}
            testID="org-settings-delete-btn"
          >
            <Trash2 size={14} />
            {String(t("admin.deleteOrgButton"))}
          </Button>
        </XStack>

        {payoutUnresolved && (
          <XStack
            gap="$3"
            padding="$3"
            borderRadius={0}
            backgroundColor="$surfaceMuted"
            borderLeftWidth={3}
            borderLeftColor="$warning"
            alignItems="flex-start"
          >
            <AlertTriangle
              size={16}
              color="var(--warning, #92400E)"
              style={{ flexShrink: 0, marginTop: 2 }}
              aria-hidden
            />
            <YStack gap="$1" flex={1}>
              <Text variant="body" weight="bold">
                {/* i18n: key pending */}
                We could not check your pending payouts
              </Text>
              <Text variant="caption" tone="muted">
                {/* i18n: key pending */}
                Deleting is blocked until we can confirm no money is waiting to
                be paid out to this group. Reload and try again.
              </Text>
            </YStack>
          </XStack>
        )}

        {hasPendingPayouts && payoutQuery.data && (
          <XStack
            gap="$3"
            padding="$3"
            borderRadius={0}
            // `$warningBackground` was carried in from the old scroll page and
            // is NOT a token — it exists in no theme, so this callout rendered
            // with no fill at all and the amber signal was invisible. Rather
            // than mint a token for one panel, this uses the Swiss structural
            // form already used by `SectionCard`: a muted surface with a
            // 3px semantic rule. Both keys exist in all three themes.
            backgroundColor="$surfaceMuted"
            borderLeftWidth={3}
            borderLeftColor="$warning"
            alignItems="flex-start"
          >
            <DollarSign
              size={16}
              color="var(--warning, #92400E)"
              style={{ flexShrink: 0, marginTop: 2 }}
              aria-hidden
            />
            <YStack gap="$1" flex={1}>
              <Text variant="body" weight="bold">
                {String(t("admin.deleteOrgPendingPayoutsTitle"))}
              </Text>
              <Text variant="caption" tone="muted">
                {String(
                  t("admin.deleteOrgPendingPayoutsDescription", {
                    count: pendingItemCount,
                    // Only reachable with `hasPendingPayouts`, which implies
                    // the read resolved — but the coalesce keeps the money
                    // figure from ever becoming `null` in a formatter.
                    amount: fmtCurrency(
                      fmt,
                      payoutQuery.data.pendingPayoutCents ?? 0,
                      payoutQuery.data.currency,
                    ),
                  }),
                )}
              </Text>
            </YStack>
          </XStack>
        )}

        {showDeleteConfirm && (
          <YStack
            gap="$3"
            paddingTop="$2"
            borderTopWidth={1}
            borderTopColor="$borderColor"
          >
            <Text variant="body" weight="bold">
              {String(t("admin.deleteOrgConfirmTitle"))}
            </Text>
            <Text variant="caption" tone="muted">
              {String(t("admin.deleteOrgConfirmDescription"))}
            </Text>

            <LabeledTextInput
              label={String(t("admin.deleteOrgConfirmLabel"))}
              name="deleteOrgConfirm"
              value={deleteConfirmName}
              onChangeText={setDeleteConfirmName}
              placeholder={String(t("admin.deleteOrgConfirmPlaceholder"))}
              testId="org-settings-delete-confirm-input"
            />

            <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
              <Button
                variant="ghost"
                onPress={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmName("");
                }}
                disabled={deleteMutation.isPending}
              >
                {String(t("common.cancel"))}
              </Button>
              <Button
                variant="destructive"
                onPress={handleDeleteOrg}
                disabled={
                  deleteMutation.isPending ||
                  deleteConfirmName.trim() !== (orgQuery.data?.name ?? "")
                }
                testID="org-settings-delete-confirm-btn"
              >
                {deleteMutation.isPending ? (
                  <Spinner size="sm" />
                ) : (
                  String(t("admin.deleteOrgConfirmButton"))
                )}
              </Button>
            </XStack>
          </YStack>
        )}
      </YStack>
    </YStack>
  );
}
