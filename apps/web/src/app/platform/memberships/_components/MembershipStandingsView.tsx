"use client";

import { useState } from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  Badge,
  Button,
  Modal,
  Separator,
  Spinner,
  Text,
  TextInput,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Building2, HeartHandshake, User } from "lucide-react";

import { trpc } from "@/trpc";
import { formatCents } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";

// ─────────────────────────────────────────────────────────────────────────────
// Platform-admin membership standing tools (recurring-memberships spec):
// dispute-fee exposure per owner, rolling-reserve override, suspend/unsuspend.
// Layout mirrors the sibling platform tables (FeeWaiversView rows + the
// humans-page Modal pattern).
// ─────────────────────────────────────────────────────────────────────────────

type StandingRow = {
  ownerType: "ORG" | "HUMAN";
  ownerId: string;
  ownerLabel: string | null;
  tierCount: number;
  activeTierCount: number;
  memberCount: number;
  suspended: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  reserveBps: number;
  reserveReleaseDays: number;
  overriddenBy: string | null;
  overrideReason: string | null;
  disputeCount: number;
  disputeAmountCents: number;
  disputeFeeCents: number;
  openDisputeCount: number;
  openDisputeAmountCents: number;
  openDisputeFeeCents: number;
  lostDisputeCount: number;
  lostDisputeAmountCents: number;
  lostDisputeFeeCents: number;
};

const SectionCard = styled(YStack, {
  name: "StandingSectionCard",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColor",
});

const Row = styled(XStack, {
  name: "StandingRow",
  paddingVertical: "$3",
  paddingHorizontal: "$4",
  gap: "$4",
  alignItems: "center",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  flexWrap: "wrap",
});

const HintText = styled(Text, {
  name: "StandingHintText",
  variant: "caption",
  color: "$colorMuted",
  fontSize: 12,
});

const CellLabel = styled(Text, {
  name: "StandingCellLabel",
  variant: "caption",
  color: "$colorMuted",
  fontSize: 11,
  textTransform: "uppercase",
});

type DialogState =
  | { kind: "suspend"; row: StandingRow }
  | { kind: "reserve"; row: StandingRow }
  | null;

export function MembershipStandingsView() {
  const t = useTranslations();
  const { toast } = useNotify();

  const [dialog, setDialog] = useState<DialogState>(null);
  const [reason, setReason] = useState("");
  const [reserveBps, setReserveBps] = useState("0");
  const [reserveDays, setReserveDays] = useState("90");

  const listQuery = trpc.platform.listMembershipStandings.useQuery({});

  const closeDialog = () => {
    setDialog(null);
    setReason("");
  };

  const onMutationError = (err: unknown) => {
    toast.danger({
      id: "standing-error",
      title: String(t("platformMemberships.toastError")),
      message: formatErrorMessage(err, t),
    });
  };

  const suspendMut = trpc.platform.suspendMembershipStanding.useMutation({
    meta: { silent: true },
    onSuccess: (_data, variables) => {
      toast.success({
        id: "standing-suspend",
        title: String(
          t(
            variables.suspend
              ? "platformMemberships.toastSuspended"
              : "platformMemberships.toastUnsuspended",
          ),
        ),
      });
      closeDialog();
      listQuery.refetch();
    },
    onError: onMutationError,
  });

  const overrideMut = trpc.platform.overrideMembershipStanding.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      toast.success({
        id: "standing-reserve",
        title: String(t("platformMemberships.toastReserveSaved")),
      });
      closeDialog();
      listQuery.refetch();
    },
    onError: onMutationError,
  });

  const openSuspendDialog = (row: StandingRow) => {
    setReason("");
    setDialog({ kind: "suspend", row });
  };

  const openReserveDialog = (row: StandingRow) => {
    setReason("");
    setReserveBps(String(row.reserveBps));
    setReserveDays(String(row.reserveReleaseDays));
    setDialog({ kind: "reserve", row });
  };

  const rows = (listQuery.data?.rows ?? []) as StandingRow[];
  const isPending = suspendMut.isPending || overrideMut.isPending;
  const reasonValid = reason.trim().length > 0;

  const bpsValue = Number.parseInt(reserveBps, 10);
  const daysValue = Number.parseInt(reserveDays, 10);
  const reserveValid =
    Number.isInteger(bpsValue) &&
    bpsValue >= 0 &&
    bpsValue <= 10_000 &&
    Number.isInteger(daysValue) &&
    daysValue >= 0 &&
    daysValue <= 365;

  const ownerName = (row: StandingRow) => row.ownerLabel ?? row.ownerId;

  return (
    <YStack gap="$5" padding="$4">
      <YStack gap="$2">
        <XStack alignItems="center" gap="$2">
          <HeartHandshake size={20} color="var(--accent)" />
          <Text variant="h3" weight="bold">
            {String(t("platformMemberships.title"))}
          </Text>
        </XStack>
        <Text variant="caption" tone="muted">
          {String(t("platformMemberships.subtitle"))}
        </Text>
      </YStack>

      <SectionCard>
        {listQuery.isLoading ? (
          <XStack padding="$5" justifyContent="center">
            <Spinner />
          </XStack>
        ) : listQuery.isError ? (
          <YStack padding="$5" gap="$2">
            <Text tone="error">
              {String(t("platformMemberships.loadError"))}
            </Text>
            <HintText>{formatErrorMessage(listQuery.error, t)}</HintText>
          </YStack>
        ) : rows.length === 0 ? (
          <YStack padding="$5">
            <HintText>{String(t("platformMemberships.empty"))}</HintText>
          </YStack>
        ) : (
          rows.map((row) => (
            <Row key={`${row.ownerType}:${row.ownerId}`}>
              {/* Owner */}
              <XStack alignItems="center" gap="$2" minWidth={200} flex={2}>
                {row.ownerType === "ORG" ? (
                  <Building2 size={16} color="var(--colorMuted)" />
                ) : (
                  <User size={16} color="var(--colorMuted)" />
                )}
                <YStack gap="$1" flex={1}>
                  <Text weight="semibold">{ownerName(row)}</Text>
                  <HintText>
                    {String(
                      t("platformMemberships.tiersCell", {
                        active: row.activeTierCount,
                        total: row.tierCount,
                      }),
                    )}{" "}
                    ·{" "}
                    {String(
                      t("platformMemberships.membersCell", {
                        count: row.memberCount,
                      }),
                    )}
                  </HintText>
                </YStack>
              </XStack>

              {/* Dispute exposure */}
              <YStack gap="$1" minWidth={190} flex={2}>
                <CellLabel>
                  {String(t("platformMemberships.colExposure"))}
                </CellLabel>
                {row.disputeCount === 0 ? (
                  <HintText>
                    {String(t("platformMemberships.exposureNone"))}
                  </HintText>
                ) : (
                  <>
                    <Text variant="caption" weight="semibold">
                      {String(
                        t("platformMemberships.exposureFees", {
                          value: formatCents(row.disputeFeeCents),
                        }),
                      )}{" "}
                      ·{" "}
                      {String(
                        t("platformMemberships.exposureDisputed", {
                          value: formatCents(row.disputeAmountCents),
                        }),
                      )}
                    </Text>
                    <HintText>
                      {String(
                        t("platformMemberships.exposureCounts", {
                          count: row.disputeCount,
                          open: row.openDisputeCount,
                          lost: row.lostDisputeCount,
                        }),
                      )}
                    </HintText>
                  </>
                )}
              </YStack>

              {/* Reserve */}
              <YStack gap="$1" minWidth={150} flex={1}>
                <CellLabel>
                  {String(t("platformMemberships.colReserve"))}
                </CellLabel>
                {row.reserveBps > 0 ? (
                  <Text variant="caption" weight="semibold">
                    {String(
                      t("platformMemberships.reserveCell", {
                        bps: row.reserveBps,
                        days: row.reserveReleaseDays,
                      }),
                    )}
                  </Text>
                ) : (
                  <HintText>
                    {String(t("platformMemberships.reserveNone"))}
                  </HintText>
                )}
                {row.overriddenBy ? (
                  <HintText>
                    {String(
                      t("platformMemberships.manualOverride", {
                        actor: row.overriddenBy.slice(0, 8),
                      }),
                    )}
                  </HintText>
                ) : null}
              </YStack>

              {/* Status */}
              <YStack gap="$1" minWidth={110}>
                <CellLabel>
                  {String(t("platformMemberships.colStatus"))}
                </CellLabel>
                {row.suspended ? (
                  <YStack gap="$1">
                    <Badge tone="danger">
                      {String(t("platformMemberships.statusSuspended"))}
                    </Badge>
                    {row.suspendedReason ? (
                      <HintText>{row.suspendedReason}</HintText>
                    ) : null}
                  </YStack>
                ) : (
                  <Badge tone="success">
                    {String(t("platformMemberships.statusOk"))}
                  </Badge>
                )}
              </YStack>

              {/* Actions */}
              <XStack gap="$2" minWidth={220} justifyContent="flex-end" flex={1}>
                <Button
                  size="$2"
                  variant="outlined"
                  disabled={isPending}
                  onPress={() => openReserveDialog(row)}
                >
                  {String(t("platformMemberships.actionEditReserve"))}
                </Button>
                <Button
                  size="$2"
                  variant={row.suspended ? "outlined" : "destructive"}
                  disabled={isPending}
                  onPress={() => openSuspendDialog(row)}
                >
                  {String(
                    t(
                      row.suspended
                        ? "platformMemberships.actionUnsuspend"
                        : "platformMemberships.actionSuspend",
                    ),
                  )}
                </Button>
              </XStack>
            </Row>
          ))
        )}
      </SectionCard>

      {/* ── Suspend / unsuspend dialog ─────────────────────────────────── */}
      <Modal open={dialog?.kind === "suspend"} onClose={closeDialog}>
        <Modal.Panel width={480}>
          <Modal.Header
            title={String(
              t(
                dialog?.kind === "suspend" && dialog.row.suspended
                  ? "platformMemberships.unsuspendTitle"
                  : "platformMemberships.suspendTitle",
              ),
            )}
            onClose={closeDialog}
          />
          <Modal.Body>
            <YStack gap="$4">
              <Text variant="body">
                {dialog?.kind === "suspend"
                  ? String(
                      t(
                        dialog.row.suspended
                          ? "platformMemberships.unsuspendBody"
                          : "platformMemberships.suspendBody",
                        { owner: ownerName(dialog.row) },
                      ),
                    )
                  : ""}
              </Text>
              <YStack gap="$2">
                <Text variant="label">
                  {String(t("platformMemberships.reasonLabel"))}
                </Text>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder={String(
                    t("platformMemberships.reasonPlaceholder"),
                  )}
                  autoFocus
                  fullWidth
                  testId="standing-suspend-reason-input"
                />
              </YStack>
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={closeDialog} disabled={isPending}>
              {String(t("platformMemberships.cancel"))}
            </Button>
            <Button
              variant={
                dialog?.kind === "suspend" && dialog.row.suspended
                  ? "primary"
                  : "destructive"
              }
              disabled={!reasonValid || isPending}
              onPress={() => {
                if (dialog?.kind !== "suspend") return;
                suspendMut.mutate({
                  ownerType: dialog.row.ownerType,
                  ownerId: dialog.row.ownerId,
                  suspend: !dialog.row.suspended,
                  reason: reason.trim(),
                });
              }}
            >
              {suspendMut.isPending
                ? String(t("platformMemberships.saving"))
                : String(
                    t(
                      dialog?.kind === "suspend" && dialog.row.suspended
                        ? "platformMemberships.confirmUnsuspend"
                        : "platformMemberships.confirmSuspend",
                    ),
                  )}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>

      {/* ── Reserve dialog ─────────────────────────────────────────────── */}
      <Modal open={dialog?.kind === "reserve"} onClose={closeDialog}>
        <Modal.Panel width={480}>
          <Modal.Header
            title={String(t("platformMemberships.reserveTitle"))}
            onClose={closeDialog}
          />
          <Modal.Body>
            <YStack gap="$4">
              <Text variant="body">
                {dialog?.kind === "reserve"
                  ? String(
                      t("platformMemberships.reserveBody", {
                        owner: ownerName(dialog.row),
                      }),
                    )
                  : ""}
              </Text>
              <YStack gap="$2">
                <Text variant="label">
                  {String(t("platformMemberships.reserveBpsLabel"))}
                </Text>
                <TextInput
                  value={reserveBps}
                  onChangeText={(v) =>
                    setReserveBps(v.replace(/[^0-9]/g, ""))
                  }
                  inputMode="numeric"
                  fullWidth
                  testId="standing-reserve-bps-input"
                />
                <HintText>
                  {String(t("platformMemberships.reserveBpsHint"))}
                </HintText>
              </YStack>
              <YStack gap="$2">
                <Text variant="label">
                  {String(t("platformMemberships.reserveDaysLabel"))}
                </Text>
                <TextInput
                  value={reserveDays}
                  onChangeText={(v) =>
                    setReserveDays(v.replace(/[^0-9]/g, ""))
                  }
                  inputMode="numeric"
                  fullWidth
                  testId="standing-reserve-days-input"
                />
                <HintText>
                  {String(t("platformMemberships.reserveDaysHint"))}
                </HintText>
              </YStack>
              <YStack gap="$2">
                <Text variant="label">
                  {String(t("platformMemberships.reasonLabel"))}
                </Text>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder={String(
                    t("platformMemberships.reasonPlaceholder"),
                  )}
                  fullWidth
                  testId="standing-reserve-reason-input"
                />
              </YStack>
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={closeDialog} disabled={isPending}>
              {String(t("platformMemberships.cancel"))}
            </Button>
            <Button
              disabled={!reasonValid || !reserveValid || isPending}
              onPress={() => {
                if (dialog?.kind !== "reserve") return;
                overrideMut.mutate({
                  ownerType: dialog.row.ownerType,
                  ownerId: dialog.row.ownerId,
                  reserveBps: bpsValue,
                  reserveReleaseDays: daysValue,
                  reason: reason.trim(),
                });
              }}
            >
              {overrideMut.isPending
                ? String(t("platformMemberships.saving"))
                : String(t("platformMemberships.confirmReserve"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </YStack>
  );
}
