"use client";

import { useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Modal,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Archive, Copy, Gift, Pencil, Plus, Rocket } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtCurrency } from "@/lib/format";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { TableContainer } from "@/components/AdminTableParts";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";

import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { PolicyStatements } from "./PolicyStatements";
import { TierFormDialog } from "./TierFormDialog";
import { BenefitsDialog } from "./BenefitsDialog";
import type { TierRow, TierStatus } from "./tier-row";

// ─────────────────────────────────────────────────────────────────────────────
// Admin memberships: open to ANY payee — deliberately no locked/gated state
// (spec 2026-08-05: the $2 Connect fee is recovered from the payout itself, so
// there is nothing to gate). The two payout policies the spec requires the
// owner to have actively seen render in the setup/empty state AND persist as a
// compact note above the tier table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Join link for a published tier. `?tab=memberships` is the contract with the
 * entity-page membership tab (built in parallel — keep the shape in sync).
 */
function buildJoinLink(owner: {
  kind: "org" | "human";
  slug: string;
}): string {
  const origin =
    typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/p/${owner.slug}?tab=memberships`;
}

const STATUS_TONE: Record<TierStatus, "info" | "success" | "neutral"> = {
  DRAFT: "info",
  ACTIVE: "success",
  ARCHIVED: "neutral",
};

const STATUS_LABEL_KEY: Record<TierStatus, string> = {
  DRAFT: "adminMemberships.statusDraft",
  ACTIVE: "adminMemberships.statusActive",
  ARCHIVED: "adminMemberships.statusArchived",
};

export const MembershipsView = () => {
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);
  // Tier CRUD, publish, archive and benefit mutations all server-enforce
  // ORG_FINANCE_ROLES; reads are open to any org role. Mirror that split:
  // write affordances behind canFinance, the list visible to everyone.
  const { canFinance } = useAdminOwnerCapabilities(currentOwner);
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();

  const [formOpen, setFormOpen] = useState(false);
  const [editingTier, setEditingTier] = useState<TierRow | null>(null);
  const [benefitsTier, setBenefitsTier] = useState<TierRow | null>(null);
  const [publishTarget, setPublishTarget] = useState<TierRow | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TierRow | null>(null);
  const [publishedTier, setPublishedTier] = useState<TierRow | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────
  const ownerType =
    currentOwner?.kind === "org"
      ? ("ORGANIZATION" as const)
      : ("HUMAN" as const);
  const ownerId =
    currentOwner?.kind === "org"
      ? currentOwner.orgId
      : currentOwner?.kind === "human"
        ? currentOwner.humanId
        : undefined;
  const entitySlug =
    currentOwner?.kind === "org"
      ? currentOwner.orgSlug
      : currentOwner?.kind === "human"
        ? currentOwner.adminSlug.replace(/^@/, "")
        : undefined;

  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } =
    trpc.memberships.tiers.list.useQuery(
      { ownerType, ownerId: ownerId! },
      { enabled: !!ownerId, staleTime: 30_000 },
    );

  const rows = useMemo<TierRow[]>(
    () =>
      (data?.items ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        benefitsDescription: item.benefitsDescription,
        priceCents: item.priceCents,
        currency: item.currency,
        interval: item.interval,
        status: item.status,
        sortOrder: item.sortOrder,
        memberCount: item.memberCount,
        priceLocked: item.priceLocked,
        benefits: item.benefits,
        createdAt: new Date(item.createdAt),
      })),
    [data],
  );

  // ── Mutations ─────────────────────────────────────────────────────────
  const publishMutation = trpc.memberships.tiers.publish.useMutation({
    onSuccess: (_tier, variables) => {
      toast.success(String(t("adminMemberships.published")));
      void utils.memberships.tiers.list.invalidate();
      // Surface the join link immediately — the spec's publish step ends with
      // a shareable link, not a silent status flip.
      const published = rows.find((row) => row.id === variables.tierId);
      if (published) setPublishedTier(published);
    },
    onError: (err) => toast.danger(formatErrorMessage(err, t)),
  });

  const archiveMutation = trpc.memberships.tiers.archive.useMutation({
    onSuccess: () => {
      toast.success(String(t("adminMemberships.archived")));
      void utils.memberships.tiers.list.invalidate();
    },
    onError: (err) => toast.danger(formatErrorMessage(err, t)),
  });

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleCreate = useCallback(() => {
    setEditingTier(null);
    setFormOpen(true);
  }, []);

  const handleEdit = useCallback((row: TierRow) => {
    setEditingTier(row);
    setFormOpen(true);
  }, []);

  const handleFormSuccess = useCallback(() => {
    setFormOpen(false);
    setEditingTier(null);
    void utils.memberships.tiers.list.invalidate();
  }, [utils]);

  const confirmPublish = useCallback(() => {
    if (!publishTarget) return;
    publishMutation.mutate(
      { tierId: publishTarget.id },
      { onSettled: () => setPublishTarget(null) },
    );
  }, [publishTarget, publishMutation]);

  const confirmArchive = useCallback(() => {
    if (!archiveTarget) return;
    archiveMutation.mutate(
      { tierId: archiveTarget.id },
      { onSettled: () => setArchiveTarget(null) },
    );
  }, [archiveTarget, archiveMutation]);

  const handleCopyJoinLink = useCallback(() => {
    if (!entitySlug || !currentOwner) return;
    const link = buildJoinLink({ kind: currentOwner.kind, slug: entitySlug });
    void navigator.clipboard.writeText(link).then(
      () => toast.success(String(t("adminMemberships.linkCopied"))),
      () => toast.danger(String(t("adminMemberships.copyFailed"))),
    );
  }, [entitySlug, currentOwner, toast, t]);

  // ── Columns ───────────────────────────────────────────────────────────
  const formatPrice = useCallback(
    (row: TierRow): string => {
      const price = fmtCurrency(fmt, row.priceCents, row.currency);
      return String(
        t(
          row.interval === "MONTH"
            ? "adminMemberships.priceMonthly"
            : "adminMemberships.priceYearly",
          { price },
        ),
      );
    },
    [fmt, t],
  );

  const columns: DataTableColumn<TierRow>[] = useMemo(
    () => [
      {
        id: "name",
        header: String(t("adminMemberships.tierColumn")),
        width: 2.4,
        sortValue: (row: TierRow) => row.name,
        cell: (row) => (
          <YStack gap="$1" minWidth={0}>
            <Text variant="body" weight="bold">
              {row.name}
            </Text>
            {row.description ? (
              <Text
                variant="caption"
                tone="muted"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {row.description}
              </Text>
            ) : null}
          </YStack>
        ),
      },
      {
        id: "price",
        header: String(t("adminMemberships.priceColumn")),
        width: 1.4,
        noWrap: true,
        sortValue: (row: TierRow) => row.priceCents,
        cell: (row) => (
          <Text
            variant="body"
            weight="bold"
            style={{
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {formatPrice(row)}
          </Text>
        ),
      },
      {
        id: "status",
        header: String(t("adminMemberships.statusColumn")),
        width: 1,
        cell: (row) => (
          <Badge tone={STATUS_TONE[row.status]} size="sm">
            {String(t(STATUS_LABEL_KEY[row.status]))}
          </Badge>
        ),
      },
      {
        id: "members",
        header: String(t("adminMemberships.membersColumn")),
        width: 1,
        sortValue: (row: TierRow) => row.memberCount,
        cell: (row) => (
          <Text variant="body" style={{ fontVariantNumeric: "tabular-nums" }}>
            {row.memberCount}
          </Text>
        ),
      },
      {
        id: "benefits",
        header: String(t("adminMemberships.benefitsColumn")),
        width: 1.2,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {String(
              t("adminMemberships.benefitsCount", {
                count: row.benefits.length,
              }),
            )}
          </Text>
        ),
      },
    ],
    [t, formatPrice],
  );

  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.7,
      render: (row: TierRow) => {
        if (!canFinance || row.status === "ARCHIVED") return null;
        const items: RowActionMenuItem[] = [
          {
            key: "edit",
            label: String(t("adminMemberships.actionEdit")),
            icon: <Pencil size={14} />,
            onPress: () => handleEdit(row),
          },
          ...(row.status === "DRAFT"
            ? [
                {
                  key: "publish",
                  label: String(t("adminMemberships.actionPublish")),
                  icon: <Rocket size={14} />,
                  disabled: publishMutation.isPending,
                  onPress: () => setPublishTarget(row),
                },
              ]
            : []),
          ...(row.status === "ACTIVE"
            ? [
                {
                  key: "copy-join-link",
                  label: String(t("adminMemberships.actionCopyJoinLink")),
                  icon: <Copy size={14} />,
                  onPress: handleCopyJoinLink,
                },
              ]
            : []),
          {
            key: "benefits",
            label: String(t("adminMemberships.actionBenefits")),
            icon: <Gift size={14} />,
            onPress: () => setBenefitsTier(row),
          },
          {
            key: "archive",
            label: String(t("adminMemberships.actionArchive")),
            icon: <Archive size={14} />,
            tone: "danger" as const,
            disabled: archiveMutation.isPending,
            onPress: () => setArchiveTarget(row),
          },
        ];
        return (
          <XStack justifyContent="flex-end">
            <RowActionMenu
              items={items}
              ariaLabel={`Actions for tier ${row.name}`}
            />
          </XStack>
        );
      },
    }),
    [
      canFinance,
      t,
      handleEdit,
      handleCopyJoinLink,
      publishMutation.isPending,
      archiveMutation.isPending,
    ],
  );

  // ── Render ────────────────────────────────────────────────────────────
  if (isOwnerLoading || isLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("adminMemberships.loading"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!ownerId) {
    return (
      <YStack padding="$4">
        <Text variant="body" tone="muted">
          {String(t("admin.noOrgSelected"))}
        </Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack padding="$4" gap="$3">
        <Text variant="body" tone="error">
          {formatErrorMessage(error.message, t)}
        </Text>
        <Button variant="secondary" size="$2" onPress={() => void refetch()}>
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

  const hasTiers = rows.length > 0;

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      {/* AdminPageHeader's h2 is a fixed 40px and "MEMBERSHIPS" is one
          unbreakable word — at a 320px viewport it overflows by ~43px.
          Down-scale the title with a container-relative clamp (container
          query units, never viewport @media — the 256px admin rail makes
          viewport width lie; see the admin-rail rule). Scoped here instead
          of AdminPageHeader because that file is mid-flight in a concurrent
          change; fold this into the header when it settles. */}
      <div
        className="th-memberships-header"
        style={{ containerType: "inline-size" }}
      >
        {/* !important because Tamagui's atomic font-size class resolves via a
            CSS variable and wins the cascade against any plain selector. */}
        <style>{`.th-memberships-header h2 { font-size: clamp(24px, 11cqw, 40px) !important; }`}</style>
        <AdminPageHeader
          title={String(t("adminMemberships.title"))}
          section="memberships"
          trailing={
            hasTiers && canFinance ? (
              <Button variant="primary" size="$3" onPress={handleCreate}>
                <Plus size={16} />
                {String(t("adminMemberships.createTier"))}
              </Button>
            ) : undefined
          }
        />
      </div>

      {hasTiers ? (
        <>
          {/* Spec: the policies stay visible once tiers exist — compact note. */}
          <PolicyStatements compact />
          <TableContainer>
            {/* minWidth INSIDE the (overflow:auto) container: on narrow
                viewports the table scrolls within its own frame instead of
                either crushing columns to one-character slivers or forcing
                the whole document to scroll (the promos page puts the same
                minWidth OUTSIDE and pays with document-level overflow). */}
            <YStack minWidth={560}>
              <DataTable<TierRow>
                columns={columns}
                rows={rows}
                getRowKey={(row) => row.id}
                isLoading={isLoading}
                clientSort
                rowActions={rowActions}
                testIdBase="memberships-tiers-table"
              />
            </YStack>
          </TableContainer>
        </>
      ) : (
        // Setup / empty state — the spec's "stated at setup, not buried"
        // moment: both policy statements render at full size beside the
        // first-tier CTA.
        <YStack
          gap="$4"
          maxWidth={640}
          width="100%"
          marginHorizontal="auto"
          borderTopWidth={4}
          borderTopColor="$borderColorStrong"
          paddingTop="$4"
          marginTop="$2"
        >
          <Text
            variant="label"
            tone="muted"
            style={{
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              fontWeight: 700,
              fontSize: 11,
            }}
          >
            01 / {String(t("adminMemberships.setupEyebrow"))}
          </Text>
          <Text variant="h3" weight="bold">
            {String(t("adminMemberships.setupTitle"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("adminMemberships.setupIntro"))}
          </Text>
          <PolicyStatements />
          {canFinance && (
            <Button
              variant="primary"
              size="$3"
              alignSelf="flex-start"
              onPress={handleCreate}
            >
              <Plus size={18} />
              {String(t("adminMemberships.createFirstTier"))}
            </Button>
          )}
        </YStack>
      )}

      {formOpen && (
        <TierFormDialog
          ownerType={ownerType}
          ownerId={ownerId}
          editingTier={editingTier}
          onClose={() => {
            setFormOpen(false);
            setEditingTier(null);
          }}
          onSuccess={handleFormSuccess}
        />
      )}

      {benefitsTier && (
        <BenefitsDialog
          ownerType={ownerType}
          ownerId={ownerId}
          // Re-read the row from the live list so attach/remove refreshes the
          // dialog's benefit list, not a stale snapshot.
          tier={rows.find((row) => row.id === benefitsTier.id) ?? benefitsTier}
          onClose={() => setBenefitsTier(null)}
          onChanged={() => {}}
        />
      )}

      <ConfirmDialog
        open={!!publishTarget}
        onConfirm={confirmPublish}
        onCancel={() => setPublishTarget(null)}
        title={String(t("adminMemberships.publishConfirmTitle"))}
        description={String(
          t("adminMemberships.publishConfirmBody", {
            price: publishTarget ? formatPrice(publishTarget) : "",
          }),
        )}
        confirmLabel={String(t("adminMemberships.publishConfirm"))}
        loading={publishMutation.isPending}
      />

      <ConfirmDialog
        open={!!archiveTarget}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
        title={String(t("adminMemberships.archiveConfirmTitle"))}
        description={String(
          t("adminMemberships.archiveConfirmBody", {
            tierName: archiveTarget?.name ?? "",
          }),
        )}
        confirmLabel={String(t("adminMemberships.actionArchive"))}
        tone="danger"
        loading={archiveMutation.isPending}
      />

      {publishedTier && entitySlug && currentOwner && (
        <JoinLinkDialog
          tierName={publishedTier.name}
          joinLink={buildJoinLink({
            kind: currentOwner.kind,
            slug: entitySlug,
          })}
          onCopy={handleCopyJoinLink}
          onClose={() => setPublishedTier(null)}
        />
      )}
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Post-publish join-link dialog — publish ends with a shareable link in hand.
// ─────────────────────────────────────────────────────────────────────────────

function JoinLinkDialog({
  tierName,
  joinLink,
  onCopy,
  onClose,
}: {
  tierName: string;
  joinLink: string;
  onCopy: () => void;
  onClose: () => void;
}) {
  const t = useTranslations();

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("adminMemberships.joinLinkTitle"))}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body">
              {String(t("adminMemberships.joinLinkBody", { tierName }))}
            </Text>
            <XStack gap="$2" alignItems="center">
              <TextInput
                value={joinLink}
                onChangeText={() => {}}
                fullWidth
                aria-label={String(t("adminMemberships.joinLinkTitle"))}
                {...({ editable: false } as Record<string, unknown>)}
              />
              <Button variant="secondary" size="$3" onPress={onCopy}>
                <Copy size={14} />
                {String(t("adminMemberships.copyLink"))}
              </Button>
            </XStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onPress={onClose}>
            {String(t("adminMemberships.done"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
