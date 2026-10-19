"use client";

import { useMemo, useState } from "react";
import { YStack } from "tamagui";
import { Button, Text, useNotify, useTranslations } from "@th/ui";
import { ShieldAlert } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import {
  VolunteerRewardForm,
  type RewardFormExisting,
} from "@/components/volunteering/VolunteerRewardForm";
import {
  RewardLedgerTable,
  type RewardLedgerGrantRow,
} from "@/components/volunteering/RewardLedgerTable";
import { volunteerConflictMessageKey } from "@/components/volunteering/volunteering-helpers";

/** Audit reason stamped on a finance-initiated void (not user-facing text). */
const MANUAL_VOID_REASON = "manually_voided";

function trpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : null;
}

interface RewardsTabProps {
  eventId: string;
  /** Finance capability (mirrors the server ORG_FINANCE_ROLES gate). */
  canFinance: boolean;
}

/**
 * Comp-ticket rewards tab for the event volunteer admin (volunteer-comp-tickets
 * spec, B6). Resolves the event's EVENT-subject ask, then renders the
 * finance-gated reward config form + the reward ledger. Rewards attach to
 * EVENT-subject asks only, which is exactly what this event owns — hence this
 * lives on the established event volunteer surface rather than the generic ask
 * page.
 *
 * Config + ledger reads are server-gated to `ORG_FINANCE_ROLES`; non-finance
 * actors get a read-only notice and the queries never fire.
 */
export function RewardsTab({ eventId, canFinance }: RewardsTabProps) {
  const t = useTranslations();
  const notify = useNotify();

  const utils = trpc.useUtils();

  // The grant awaiting void confirmation (drives the destructive dialog).
  const [voidGrant, setVoidGrant] = useState<RewardLedgerGrantRow | null>(null);

  // Resolve the event's EVENT-subject ask (backfill creates one per
  // volunteering-enabled event). Finance-only data hangs off its askId.
  const asksQuery = trpc.volunteer.asks.listBySubject.useQuery(
    { subjectType: "EVENT", subjectId: eventId },
    { staleTime: 15_000, retry: 1, enabled: canFinance },
  );

  const askId = asksQuery.data?.[0]?.id ?? null;

  const eventQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { staleTime: 30_000, retry: 1, enabled: canFinance },
  );
  const ticketTypesQuery = trpc.events.listTicketTypesForEdit.useQuery(
    { eventId },
    { staleTime: 30_000, retry: 1, enabled: canFinance },
  );
  const rolesQuery = trpc.volunteer.roles.list.useQuery(
    { eventId },
    { staleTime: 30_000, retry: 1, enabled: canFinance },
  );
  const rewardsQuery = trpc.volunteer.rewards.list.useQuery(
    { askId: askId ?? "" },
    { staleTime: 15_000, retry: 1, enabled: canFinance && Boolean(askId) },
  );
  const ledgerQuery = trpc.volunteer.rewards.ledger.useQuery(
    { askId: askId ?? "" },
    { staleTime: 15_000, retry: 1, enabled: canFinance && Boolean(askId) },
  );

  const rewards: RewardFormExisting[] = useMemo(
    () =>
      (rewardsQuery.data?.rewards ?? []).map((r) => ({
        id: r.id,
        roleId: r.roleId,
        ticketTypeId: r.ticketTypeId,
        ticketTypeName: r.ticketTypeName,
        faceValueCents: r.faceValueCents,
        trigger: r.trigger,
        maxGrants: r.maxGrants,
        grantsUsed: r.grantsUsed,
        remaining: r.remaining,
        active: r.active,
      })),
    [rewardsQuery.data],
  );

  const ticketTypes = useMemo(
    () =>
      (ticketTypesQuery.data?.ticketTypes ?? []).map((tt) => ({
        id: tt.id,
        name: tt.name,
        priceCents: tt.priceCents,
      })),
    [ticketTypesQuery.data],
  );

  const roles = useMemo(
    () =>
      (rolesQuery.data ?? []).map((role) => ({ id: role.id, name: role.name })),
    [rolesQuery.data],
  );

  const grants: RewardLedgerGrantRow[] = useMemo(
    () =>
      (ledgerQuery.data?.grants ?? []).map((g) => ({
        id: g.id,
        signupId: g.signupId,
        contactEmail: g.contactEmail,
        status: g.status,
        redeemed: g.redeemed,
        faceValueCents: g.faceValueCents,
        grantedAt: g.grantedAt,
        redeemedAt: g.redeemedAt,
        revokedAt: g.revokedAt,
      })),
    [ledgerQuery.data],
  );

  const currency = eventQuery.data?.currency ?? null;

  const refetchAll = () => {
    void utils.volunteer.rewards.list.invalidate({ askId: askId ?? "" });
    void utils.volunteer.rewards.ledger.invalidate({ askId: askId ?? "" });
  };

  // Manual void of an unused comp (finance-gated on the server). On success —
  // or when the comp was scanned between load and click (reward_already_redeemed)
  // — we refresh the ledger + config so counts / remaining budget re-settle and
  // the row flips to its true state (voided, or "Comp used").
  const revokeMutation = trpc.volunteer.rewards.revoke.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-reward-voided",
        title: String(t("volunteering.rewardVoidSuccess")),
      });
      setVoidGrant(null);
      refetchAll();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      const alreadyRedeemed =
        conflictKey === "volunteering.errRewardAlreadyRedeemed";
      notify.toast.danger({
        id: "volunteer-reward-void-failed",
        title: String(t("volunteering.rewardVoidFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
      // A raced-redemption conflict means the ledger is stale — close the
      // dialog and refresh so the row reads "Comp used".
      if (alreadyRedeemed) {
        setVoidGrant(null);
        refetchAll();
      }
    },
  });

  // ── Finance gate (defense in depth — server is the real boundary) ────────
  const forbidden =
    trpcErrorCode(asksQuery.error) === "FORBIDDEN" ||
    trpcErrorCode(rewardsQuery.error) === "FORBIDDEN" ||
    trpcErrorCode(ledgerQuery.error) === "FORBIDDEN";

  if (!canFinance || forbidden) {
    return (
      <YStack
        gap="$2"
        alignItems="center"
        paddingVertical="$8"
        data-testid="volunteer-reward-finance-required"
      >
        <ShieldAlert size={28} color="var(--colorMuted)" />
        <Text variant="h4" weight="bold" textAlign="center">
          {String(t("volunteering.rewardFinanceRequiredTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={440}>
          {String(t("volunteering.rewardFinanceRequiredBody"))}
        </Text>
      </YStack>
    );
  }

  // ── Loading / error / no-ask states ──────────────────────────────────────
  const isLoading =
    asksQuery.isLoading ||
    eventQuery.isLoading ||
    ticketTypesQuery.isLoading ||
    rolesQuery.isLoading;

  if (isLoading) {
    return (
      <YStack paddingVertical="$6" alignItems="center" role="status">
        <Text tone="muted">{String(t("common.loading"))}</Text>
      </YStack>
    );
  }

  if (asksQuery.isError) {
    return (
      <YStack gap="$2" paddingVertical="$6" alignItems="center">
        <Text tone="muted" textAlign="center">
          {formatErrorMessage(asksQuery.error)}
        </Text>
        <Button
          variant="secondary"
          size="$2"
          minHeight={44}
          onPress={() => void asksQuery.refetch()}
        >
          {String(t("volunteering.retryCta"))}
        </Button>
      </YStack>
    );
  }

  if (!askId) {
    return (
      <YStack
        paddingVertical="$6"
        alignItems="center"
        data-testid="volunteer-reward-no-ask"
      >
        <Text tone="muted" textAlign="center" maxWidth={440}>
          {String(t("volunteering.rewardNoAsk"))}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack gap="$6" paddingTop="$3">
      <VolunteerRewardForm
        askId={askId}
        ticketTypes={ticketTypes}
        currency={currency}
        roles={roles}
        rewards={rewards}
        onSaved={refetchAll}
      />

      {ledgerQuery.isLoading ? (
        <Text tone="muted" role="status">
          {String(t("common.loading"))}
        </Text>
      ) : ledgerQuery.isError ? (
        <YStack gap="$2">
          <Text tone="muted">{formatErrorMessage(ledgerQuery.error)}</Text>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            onPress={() => void ledgerQuery.refetch()}
          >
            {String(t("volunteering.retryCta"))}
          </Button>
        </YStack>
      ) : ledgerQuery.data ? (
        <RewardLedgerTable
          ledger={{
            counts: ledgerQuery.data.counts,
            remainingBudget: ledgerQuery.data.remainingBudget,
            faceValueCents: ledgerQuery.data.faceValueCents,
            grants,
          }}
          currency={currency}
          onVoid={setVoidGrant}
          voidPendingId={
            revokeMutation.isPending ? (voidGrant?.id ?? null) : null
          }
        />
      ) : null}

      <ConfirmDialog
        open={voidGrant !== null}
        tone="danger"
        title={String(t("volunteering.rewardVoidConfirmTitle"))}
        description={String(t("volunteering.rewardVoidConfirmBody"))}
        confirmLabel={String(t("volunteering.rewardVoidConfirmCta"))}
        cancelLabel={String(t("common.cancel"))}
        loading={revokeMutation.isPending}
        onConfirm={() => {
          if (voidGrant) {
            revokeMutation.mutate({
              grantId: voidGrant.id,
              reason: MANUAL_VOID_REASON,
            });
          }
        }}
        onCancel={() => setVoidGrant(null)}
      />
    </YStack>
  );
}
