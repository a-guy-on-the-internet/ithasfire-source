"use client";

import { useMemo, useRef, useState, useCallback } from "react";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { useParams } from "next/navigation";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Button,
  Text,
  Badge,
  Spinner,
  StyledSelect,
  type StyledSelectOption,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { ArrowRightLeft, Rows3, Trash2, UserPlus, XCircle } from "lucide-react";
import {
  RowActionMenu,
  type RowActionMenuItem,
} from "@/components/data-table/RowActionMenu";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { getSiteUrl } from "@/config/site";
import {
  ActionBar,
  AdminTableErrorState,
  TableContainer,
  SearchBar,
  Pagination,
  NoResults,
  ColumnSelector,
  SkeletonEmptyState,
  type ColumnOption,
} from "@/components/AdminTableParts";
import { useAdminTableParams } from "@/hooks/useAdminTableParams";
import { useColumnVisibility } from "@/hooks/useColumnVisibility";
import { useTableDensity } from "@/hooks/useTableDensity";
import { useIsMobile } from "@/hooks/useIsMobile";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type OrgRole = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER" | "FINANCE" | "SCANNER";
type DelegateRole = Exclude<OrgRole, "OWNER">;

interface MemberRow {
  humanId: string;
  name: string | null;
  email: string | null;
  role: OrgRole;
  joinedAt: Date;
}

const ALL_ROLES: OrgRole[] = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "FINANCE",
  "SCANNER",
  "VIEWER",
];
const DELEGATE_ROLES: OrgRole[] = ALL_ROLES.filter((r) => r !== "OWNER");
const NON_OWNER_ROLES: OrgRole[] = ALL_ROLES.filter((r) => r !== "OWNER");

const ROLE_LABEL_KEYS: Record<OrgRole, string> = {
  OWNER: "admin.roleOwner",
  ADMIN: "admin.roleAdmin",
  EDITOR: "admin.roleEditor",
  FINANCE: "admin.roleFinance",
  SCANNER: "admin.roleScanner",
  VIEWER: "admin.roleViewer",
};

function getRoleBadgeTone(
  role: OrgRole,
): "info" | "success" | "warning" | "neutral" | "danger" {
  switch (role) {
    case "OWNER":
      return "danger";
    case "ADMIN":
      return "warning";
    case "EDITOR":
      return "success";
    case "FINANCE":
      return "info";
    case "SCANNER":
      return "info";
    case "VIEWER":
      return "neutral";
    default:
      return "neutral";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function TeamView() {
  const { toast } = useNotify();
  const { slug } = useParams<{ slug: string }>();
  const utils = trpc.useUtils();
  const t = useTranslations();
  const fmt = useFormatters();
  const isMobile = useIsMobile();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);

  const isOrg = currentOwner?.kind === "org";
  const isHuman = currentOwner?.kind === "human";
  const orgId = isOrg ? currentOwner.orgId : null;
  const humanId = isHuman ? currentOwner.humanId : null;
  const actorRole = isOrg ? currentOwner.role : null;
  const actorIsOwner = actorRole === "OWNER";
  // Management capability — mirrors the server ORG_ADMIN_ROLES set
  // (update-member-role / remove-org-member). This is the same condition the
  // Add Member button already uses. For a human-owned context the actor is
  // always the sole owner of their own delegates, so management stays enabled;
  // only the org roster gates on OWNER/ADMIN.
  const canManageTeam = isOrg ? actorIsOwner || actorRole === "ADMIN" : isHuman;

  // Confirm dialog state — remove member
  const [removeTarget, setRemoveTarget] = useState<{
    humanId: string;
    name: string | null;
  } | null>(null);

  // Confirm dialog state — revoke invitation
  const [revokeTarget, setRevokeTarget] = useState<{
    invitationId: string;
    email: string;
  } | null>(null);

  // Transfer ownership UI state
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);
  // Set synchronously on the first Confirm click: `isPending` only disables
  // the button after a re-render, so a fast double click could send twice.
  const transferInFlight = useRef(false);

  // Add member UI state
  const [showAddMember, setShowAddMember] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<OrgRole>("VIEWER");
  const [addError, setAddError] = useState<string | null>(null);

  // Add delegate UI state (for human principals)
  const [showAddDelegate, setShowAddDelegate] = useState(false);
  const [addDelegateEmail, setAddDelegateEmail] = useState("");
  const [addDelegateRole, setAddDelegateRole] =
    useState<DelegateRole>("VIEWER");
  const [addDelegateError, setAddDelegateError] = useState<string | null>(null);
  const [delegateInvite, setDelegateInvite] = useState<{
    email: string;
    url: string;
  } | null>(null);
  const [delegateLinkCopied, setDelegateLinkCopied] = useState(false);

  // ── Search / pagination state (URL-synced) ─────────────────────────────
  const {
    searchQuery,
    debouncedSearch,
    page,
    pageSize,
    handleSearchChange,
    setPage,
    setPageSize,
  } = useAdminTableParams();

  // ── Column visibility ────────────────────────────────────────────────────
  const ALL_COL_IDS = ["name", "email", "role", "joinedAt"] as const;

  const columnOptions: ColumnOption[] = useMemo(
    () => [
      { id: "name", label: String(t("admin.nameColumn")) },
      { id: "email", label: String(t("admin.emailColumn")) },
      { id: "role", label: String(t("admin.roleLabel")) },
      { id: "joinedAt", label: String(t("admin.joinedColumn")) },
    ],
    [t],
  );

  const colVis = useColumnVisibility("admin-team-columns", ALL_COL_IDS);

  // ── Row density (persisted per-table, mirroring the columns key) ─────────
  const { density, toggleDensity } = useTableDensity("admin-team-density");

  // ── Org members query ─────────────────────────────────────────────────

  const {
    data: orgData,
    isLoading: isOrgMembersLoading,
    error: orgError,
    refetch: refetchOrg,
  } = trpc.orgs.listMembers.useQuery(
    {
      orgId: orgId ?? "",
      limit: pageSize,
      offset: page * pageSize,
    },
    { enabled: !!orgId, staleTime: 15_000, placeholderData: keepPreviousData },
  );

  // ── Human delegates query ─────────────────────────────────────────────

  const {
    data: delegateData,
    isLoading: isDelegatesLoading,
    error: delegateError,
    refetch: refetchDelegates,
  } = trpc.delegates.listDelegates.useQuery(
    {
      principalId: humanId ?? "",
      limit: pageSize,
      offset: page * pageSize,
    },
    {
      enabled: !!humanId,
      staleTime: 15_000,
      placeholderData: keepPreviousData,
    },
  );

  // ── Pending invitations query ─────────────────────────────────────────

  const { data: invitationsData, refetch: refetchInvitations } =
    trpc.orgs.listInvitations.useQuery(
      { orgId: orgId ?? "", status: "PENDING", limit: 100, offset: 0 },
      {
        enabled: !!orgId && (actorIsOwner || actorRole === "ADMIN"),
        staleTime: 15_000,
      },
    );

  // ── Mutations ─────────────────────────────────────────────────────────

  const updateRoleMutation = trpc.orgs.updateMemberRole.useMutation({
    meta: { silent: true },
  });
  const transferOwnershipMutation = trpc.orgs.transferOwnership.useMutation({
    meta: { silent: true },
  });
  const removeMutation = trpc.orgs.removeMember.useMutation({
    meta: { silent: true },
  });
  const updateDelegateRoleMutation =
    trpc.delegates.updateDelegateRole.useMutation({
      meta: { silent: true },
    });
  const removeDelegateMutation = trpc.delegates.removeDelegate.useMutation({
    meta: { silent: true },
  });
  const addMemberMutation = trpc.orgs.inviteMember.useMutation({
    meta: { silent: true },
  });
  const addDelegateMutation = trpc.delegates.createInvite.useMutation({
    meta: { silent: true },
  });
  const revokeInvitationMutation = trpc.orgs.revokeInvitation.useMutation({
    meta: { silent: true },
  });

  // ── Derived state ─────────────────────────────────────────────────────

  const data = isOrg ? orgData : delegateData;
  const isDataLoading = isOrg ? isOrgMembersLoading : isDelegatesLoading;
  const error = isOrg ? orgError : delegateError;
  const refetch = isOrg ? refetchOrg : refetchDelegates;
  // Owners never appear in dropdown options — ownership transfers use a
  // separate flow.  Delegates can never hold the OWNER role either.
  const roleOptions = isOrg ? NON_OWNER_ROLES : DELEGATE_ROLES;

  // Options for the role select — single source of truth shared by the
  // desktop role column and the mobile card so both surfaces always offer
  // the same assignable roles.
  const roleSelectOptions = useMemo<StyledSelectOption<OrgRole>[]>(
    () =>
      roleOptions.map((role) => ({
        value: role,
        label: String(t(ROLE_LABEL_KEYS[role])),
      })),
    [roleOptions, t],
  );

  // ── Callbacks ──────────────────────────────────────────────────────────

  const handleRoleChange = useCallback(
    async (targetHumanId: string, newRole: OrgRole) => {
      try {
        if (isOrg && orgId) {
          await updateRoleMutation.mutateAsync({
            orgId,
            targetHumanId,
            newRole,
          });
          void utils.orgs.listMembers.invalidate();
        } else if (isHuman && humanId) {
          await updateDelegateRoleMutation.mutateAsync({
            principalId: humanId,
            targetHumanId,
            newRole: newRole as Exclude<OrgRole, "OWNER">,
          });
          void utils.delegates.listDelegates.invalidate();
        }
        toast.success({ title: t("admin.roleUpdated") as string });
      } catch (err) {
        toast.danger({
          title: t("admin.failedToUpdateRole") as string,
          message: formatErrorMessage(err, t),
        });
      }
    },
    [
      humanId,
      isHuman,
      isOrg,
      orgId,
      t,
      toast,
      updateDelegateRoleMutation,
      updateRoleMutation,
      utils,
    ],
  );

  const handleRemove = useCallback(
    (targetHumanId: string, name: string | null) => {
      setRemoveTarget({ humanId: targetHumanId, name });
    },
    [],
  );

  const confirmRemove = useCallback(async () => {
    if (!removeTarget) return;
    const { humanId: targetHumanId } = removeTarget;
    try {
      if (isOrg && orgId) {
        await removeMutation.mutateAsync({
          orgId,
          targetHumanId,
        });
        void utils.orgs.listMembers.invalidate();
      } else if (isHuman && humanId) {
        await removeDelegateMutation.mutateAsync({
          principalId: humanId,
          targetHumanId,
        });
        void utils.delegates.listDelegates.invalidate();
      }
      toast.success({
        title: t(
          isOrg ? "admin.memberRemoved" : "admin.delegateRemoved",
        ) as string,
      });
    } catch (err) {
      toast.danger({
        title: t(
          isOrg ? "admin.failedToRemoveMember" : "admin.failedToRemoveDelegate",
        ) as string,
        message: formatErrorMessage(err, t),
      });
    } finally {
      setRemoveTarget(null);
    }
  }, [
    removeTarget,
    isOrg,
    isHuman,
    orgId,
    humanId,
    removeMutation,
    removeDelegateMutation,
    toast,
    utils,
    t,
  ]);

  const handleTransferOwnership = useCallback(async () => {
    if (!transferTargetId || !orgId || transferInFlight.current) return;
    transferInFlight.current = true;
    try {
      // One server transaction: the target becomes OWNER and the actor
      // becomes ADMIN, or nothing changes.
      await transferOwnershipMutation.mutateAsync({
        orgId,
        targetHumanId: transferTargetId,
      });
      // The server has made the actor an ADMIN. Say so in the cached owner
      // entities now, so the Owner-only controls go before the refetch below
      // lands; a second click in that window would only be refused.
      utils.events.listEventOwnerEntities.setData({}, (prev) =>
        prev
          ? {
              ...prev,
              owners: prev.owners.map((o) =>
                o.kind === "org" && o.orgId === orgId
                  ? { ...o, role: "ADMIN" as const }
                  : o,
              ),
            }
          : prev,
      );
      toast.success({
        title: t("admin.ownershipTransferred") as string,
        message: t("admin.youAreNowAdmin") as string,
      });
      setTransferTargetId(null);
      setShowTransferConfirm(false);
    } catch (err) {
      // The confirm step stays open with the member still selected, so the
      // actor can retry or cancel.
      toast.danger({
        title: t("admin.transferFailed") as string,
        message: formatErrorMessage(err, t),
      });
    } finally {
      // The roster, and the actor's own role: `actorRole` comes from
      // `events.listEventOwnerEntities` (via useCurrentAdminOwner), which
      // `listMembers` does not refresh. Refetched after a refusal too, since
      // INSUFFICIENT_ROLE and MEMBER_NOT_FOUND both mean this page is stale.
      void utils.orgs.listMembers.invalidate();
      void utils.events.listEventOwnerEntities.invalidate();
      transferInFlight.current = false;
    }
  }, [orgId, t, toast, transferTargetId, transferOwnershipMutation, utils]);

  const handleAddMember = useCallback(async () => {
    if (!orgId || !addEmail.trim()) return;
    setAddError(null);

    try {
      const result = await addMemberMutation.mutateAsync({
        orgId,
        email: addEmail.trim().toLowerCase(),
        role: addRole,
      });

      // Every invitee — with or without an account — gets a pending
      // invitation and joins only by accepting it; the response never says
      // which (no account-existence oracle).
      toast.success({
        title: t("admin.invitationSent") as string,
        message: String(
          t("admin.invitationSentMessage", {
            email: result.invitation.email,
            role: String(t(ROLE_LABEL_KEYS[addRole])),
          }),
        ),
      });
      void refetchInvitations();

      setAddEmail("");
      setAddRole("VIEWER");
      setShowAddMember(false);
    } catch (err) {
      // ALREADY_A_MEMBER renders via the shared `errors.alreadyAMember` copy
      // (it used to be mislabelled "No account found").
      setAddError(formatErrorMessage(err, t));
    }
  }, [addEmail, addMemberMutation, addRole, orgId, refetchInvitations, t, toast]);

  // Add delegate (human principal) — mint an invitation LINK. Nothing is
  // granted until the invited person opens it while signed in with that
  // email (security review F3: the old flow resolved any email to a humanId
  // and granted access with no consent).
  const handleAddDelegate = useCallback(async () => {
    if (!humanId || !addDelegateEmail.trim()) return;
    setAddDelegateError(null);
    setDelegateInvite(null);
    try {
      const email = addDelegateEmail.trim().toLowerCase();
      const res = await addDelegateMutation.mutateAsync({
        principalId: humanId,
        email,
        role: addDelegateRole,
      });
      setDelegateInvite({
        email,
        url: `${getSiteUrl()}/delegate/accept?token=${encodeURIComponent(res.token)}`,
      });
      setDelegateLinkCopied(false);
      setAddDelegateEmail("");
      setAddDelegateRole("VIEWER");
    } catch (err) {
      setAddDelegateError(formatErrorMessage(err, t));
    }
  }, [humanId, addDelegateEmail, addDelegateRole, addDelegateMutation, t]);

  const copyDelegateInvite = useCallback(() => {
    if (!delegateInvite) return;
    void navigator.clipboard.writeText(delegateInvite.url).then(() => {
      setDelegateLinkCopied(true);
    });
  }, [delegateInvite]);

  const handleRevokeInvitation = useCallback(
    (invitationId: string, email: string) => {
      if (!orgId) return;
      setRevokeTarget({ invitationId, email });
    },
    [orgId],
  );

  const confirmRevokeInvitation = useCallback(async () => {
    if (!revokeTarget || !orgId) return;
    try {
      await revokeInvitationMutation.mutateAsync({
        orgId,
        invitationId: revokeTarget.invitationId,
      });
      toast.success({ title: t("admin.invitationRevoked") as string });
      void refetchInvitations();
    } catch (err) {
      toast.danger({
        title: t("admin.failedToRevokeInvitation") as string,
        message: formatErrorMessage(err, t),
      });
    } finally {
      setRevokeTarget(null);
    }
  }, [
    orgId,
    revokeTarget,
    revokeInvitationMutation,
    toast,
    refetchInvitations,
    t,
  ]);

  // ── Row mapping ───────────────────────────────────────────────────────

  const memberRows = useMemo<MemberRow[]>(() => {
    const items = data?.items;
    if (!items?.length) return [];

    return items.map((m) => ({
      ...m,
      joinedAt: new Date(m.joinedAt),
    }));
  }, [data?.items]);

  // Client-side search (server doesn't support query param)
  const filteredMemberRows = useMemo(() => {
    if (!debouncedSearch) return memberRows;
    const q = debouncedSearch.toLowerCase();
    return memberRows.filter(
      (r) =>
        (r.name ?? "").toLowerCase().includes(q) ||
        (r.email ?? "").toLowerCase().includes(q),
    );
  }, [memberRows, debouncedSearch]);

  // ── Columns ────────────────────────────────────────────────────────────

  const columns: DataTableColumn<MemberRow>[] = useMemo(
    () => [
      {
        id: "name",
        header: String(t("admin.nameColumn")),
        width: 2.5,
        sortValue: (row) => row.name ?? "",
        // Truncated single line (DataTable default) - pair with a tooltip so
        // the full name stays readable when the cell clips.
        tooltipValue: (row) => row.name,
        cell: (row) => <Text variant="body">{row.name ?? "\u2014"}</Text>,
      },
      {
        id: "email",
        header: String(t("admin.emailColumn")),
        width: 3,
        sortValue: (row) => row.email ?? "",
        tooltipValue: (row) => row.email,
        cell: (row) => (
          <Text variant="body" tone="muted">
            {row.email ?? "\u2014"}
          </Text>
        ),
      },
      {
        id: "role",
        header: String(t("admin.roleLabel")),
        width: 2,
        // The cell embeds an interactive StyledSelect for managers - it must
        // not sit inside a clipped (maxWidth:0 + ellipsis) cell.
        truncate: false,
        sortValue: (row) => row.role,
        cell: (row) => {
          // Owners are never editable via dropdown — show a static badge
          if (row.role === "OWNER") {
            return (
              <Badge tone={getRoleBadgeTone("OWNER")} size="sm">
                {String(t("admin.roleOwner"))}
              </Badge>
            );
          }

          // Non-admin actors get the role as static read-only text — the
          // roster stays readable, but the role is not editable (server
          // enforces ORG_ADMIN_ROLES on update-member-role).
          if (!canManageTeam) {
            return (
              <Badge tone={getRoleBadgeTone(row.role)} size="sm">
                {String(t(ROLE_LABEL_KEYS[row.role]))}
              </Badge>
            );
          }

          return (
            <StyledSelect<OrgRole>
              value={row.role}
              options={roleSelectOptions}
              onChange={(newRole) => {
                void handleRoleChange(row.humanId, newRole);
              }}
              size="sm"
            />
          );
        },
      },
      {
        id: "joinedAt",
        header: String(t("admin.joinedColumn")),
        width: 1.5,
        noWrap: true,
        sortValue: (row) => row.joinedAt,
        cell: (row) => (
          <Text variant="body" tone="muted">
            {fmt.dateTime(row.joinedAt, { dateStyle: "medium" })}
          </Text>
        ),
      },
    ],
    [handleRoleChange, roleSelectOptions, canManageTeam, t, fmt],
  );

  const visibleColumns = useMemo(
    () => columns.filter((c) => colVis.isVisible(c.id)),
    [columns, colVis],
  );

  // ── Row actions ────────────────────────────────────────────────────────
  const rowActions = useMemo(
    () => ({
      header: "",
      width: 0.8,
      render: (row: MemberRow) => {
        // Owners cannot be removed — ownership must be transferred first
        if (row.role === "OWNER") return null;
        // Remove is management-only (server enforces ORG_ADMIN_ROLES on
        // remove-org-member). Non-admin actors see no row action.
        if (!canManageTeam) return null;

        const items: RowActionMenuItem[] = [
          {
            key: "remove",
            label: String(t("admin.removeMemberLabel")),
            icon: <Trash2 size={14} />,
            tone: "danger" as const,
            disabled:
              removeMutation.isPending || removeDelegateMutation.isPending,
            onPress: () => handleRemove(row.humanId, row.name),
          },
        ];

        return (
          <XStack justifyContent="flex-end">
            <RowActionMenu
              items={items}
              ariaLabel={`Actions for ${row.name ?? row.email}`}
            />
          </XStack>
        );
      },
    }),
    [
      handleRemove,
      removeMutation.isPending,
      removeDelegateMutation.isPending,
      canManageTeam,
      t,
    ],
  );

  // ── Mobile card (DataTable card mode, <600px) ────────────────────────────
  // Card mode renders neither rowActions nor the role column's interactive
  // cell, so the card mirrors both inline: managers get the SAME StyledSelect
  // the desktop role column uses (same options array, same handleRoleChange,
  // same gate: canManageTeam && not the OWNER row — ownership moves through
  // the dedicated transfer flow) plus the remove action; everyone else sees
  // the role as a read-only badge, exactly like the desktop cell.
  const renderMobileCard = useCallback(
    (row: MemberRow) => {
      // Same gate as the desktop role StyledSelect and the remove row action.
      const canManageRow = canManageTeam && row.role !== "OWNER";
      return (
        <YStack gap="$2" minWidth={0}>
          <XStack gap="$2" alignItems="center" minWidth={0}>
            <Text
              variant="bodySmall"
              weight="bold"
              tone={row.name ? "default" : "muted"}
              flex={1}
              minWidth={0}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.name ?? "—"}
            </Text>
            {!canManageRow && (
              <XStack flexShrink={0}>
                <Badge tone={getRoleBadgeTone(row.role)} size="sm">
                  {String(t(ROLE_LABEL_KEYS[row.role]))}
                </Badge>
              </XStack>
            )}
          </XStack>
          {row.email && (
            <Text
              variant="caption"
              tone="muted"
              minWidth={0}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.email}
            </Text>
          )}
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="caption" tone="muted">
              {String(t("admin.joinedColumn"))}
            </Text>
            <Text variant="caption" tone="muted" aria-hidden>
              ·
            </Text>
            <Text variant="caption" tone="muted">
              {fmt.dateTime(row.joinedAt, { dateStyle: "medium" })}
            </Text>
          </XStack>
          {canManageRow && (
            <YStack gap="$1">
              <Text variant="caption" tone="muted">
                {String(t("admin.roleLabel"))}
              </Text>
              <StyledSelect<OrgRole>
                value={row.role}
                options={roleSelectOptions}
                onChange={(newRole) => {
                  void handleRoleChange(row.humanId, newRole);
                }}
                // 48px frame so the inner native <select> overlay (frame minus
                // padding/borders) itself clears the 44px touch-target floor.
                minHeight={48}
                height={48}
                alignSelf="stretch"
                testId={`team-role-select-${row.humanId}`}
              />
            </YStack>
          )}
          {canManageRow && (
            <Button
              size="$2"
              variant="ghost"
              alignSelf="flex-start"
              minHeight={44}
              onPress={() => handleRemove(row.humanId, row.name)}
              disabled={
                removeMutation.isPending || removeDelegateMutation.isPending
              }
              aria-label={String(t("admin.removeMemberLabel"))}
            >
              <Trash2 size={14} />
              {String(t("admin.removeMemberLabel"))}
            </Button>
          )}
        </YStack>
      );
    },
    [
      canManageTeam,
      fmt,
      handleRemove,
      handleRoleChange,
      roleSelectOptions,
      removeMutation.isPending,
      removeDelegateMutation.isPending,
      t,
    ],
  );

  // Non-owner members eligible to receive ownership
  const transferCandidates = useMemo(
    () => memberRows.filter((r) => r.role !== "OWNER"),
    [memberRows],
  );

  // ── Loading / error states ─────────────────────────────────────────────

  // `!data` keeps refetches/pagination from blanking the page back to the
  // full-screen loader once the first payload has landed (keepPreviousData
  // holds the old rows; DataTable's own skeleton covers the initial load).
  if (isOwnerLoading || (isDataLoading && !data)) {
    return (
      <AdminPageData isLoading loadingMessage={String(t("admin.loadingTeam"))}>
        {null}
      </AdminPageData>
    );
  }

  if (!currentOwner) {
    return (
      <YStack flex={1} padding="$6" gap="$3">
        <Text fontSize="$6" weight="bold">
          {String(t(isOrg ? "admin.team" : "admin.delegates"))}
        </Text>
        <Text color="$textMuted">{String(t("admin.noAccountContext"))}</Text>
      </YStack>
    );
  }

  const heading = isOrg
    ? String(t("admin.team"))
    : String(t("admin.delegates"));
  const totalRows = data?.total ?? 0;
  const totalPages = Math.ceil(totalRows / pageSize);
  const hasActiveSearch = debouncedSearch.length > 0;

  const summaryLabel = (() => {
    if (totalRows === 0) return undefined;
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, totalRows);
    return String(t("admin.nOfTotal", { start, end, total: totalRows }));
  })();

  const subtitle = isOrg
    ? String(t("admin.nMembers", { count: totalRows }))
    : String(t("admin.nDelegates", { count: totalRows }));
  const emptyLabel = isOrg
    ? String(t("admin.noTeamMembersYet"))
    : String(t("admin.noDelegatesYet"));

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <YStack flex={1} padding="$6" gap="$4">
      {/* Header — actions ride AdminPageHeader's `trailing` slot (the same
          pattern PlacesTable et al. use) so they wrap below the title on
          narrow viewports instead of overflowing off a 390px screen. */}
      <AdminPageHeader
        title={heading}
        subtitle={subtitle}
        section="team"
        trailing={
          <>
            {isOrg && (actorIsOwner || actorRole === "ADMIN") && (
              <Button
                size="$3"
                variant="secondary"
                onPress={() => setShowAddMember((v) => !v)}
              >
                <UserPlus size={16} />
                {String(t("admin.addMember"))}
              </Button>
            )}
            {/* Human principals get an Add Delegate button */}
            {isHuman && (
              <Button
                size="$3"
                variant="secondary"
                onPress={() => setShowAddDelegate((v) => !v)}
              >
                <UserPlus size={16} />
                {String(t("admin.addDelegate"))}
              </Button>
            )}
            {/* No Refresh here — the table's ActionBar already carries one
                wired to the same refetch; a second copy overflowed 390px. */}
          </>
        }
      />

      {/* ── Add Member form (owner/admin only) ──────────────────────── */}
      {showAddMember && isOrg && orgId && (
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius="$0"
          backgroundColor="$surfaceMuted"
        >
          <Text fontSize="$4" weight="bold">
            {String(t("admin.addTeamMemberHeading"))}
          </Text>
          <Text fontSize="$3" color="$textMuted">
            {String(t("admin.addTeamMemberDescription"))}
          </Text>
          <XStack gap="$3" alignItems="flex-end" flexWrap="wrap">
            <YStack gap="$1" flex={1} minWidth={200}>
              <Text fontSize="$2" color="$textMuted">
                {String(t("admin.emailLabel"))}
              </Text>
              <input
                type="email"
                placeholder={t("admin.emailPlaceholder") as string}
                value={addEmail}
                onChange={(e) => {
                  setAddEmail(e.target.value);
                  setAddError(null);
                }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--borderColor)",
                  borderRadius: 0,
                  padding: "8px 10px",
                  fontSize: 14,
                  color: "var(--color)",
                }}
              />
            </YStack>
            <YStack gap="$1" minWidth={140}>
              <Text fontSize="$2" color="$textMuted">
                {String(t("admin.roleLabel"))}
              </Text>
              <StyledSelect<OrgRole>
                value={addRole}
                options={NON_OWNER_ROLES.map((role) => ({
                  value: role,
                  label: String(t(ROLE_LABEL_KEYS[role])),
                }))}
                onChange={(v) => setAddRole(v)}
              />
            </YStack>
            <Button
              size="$3"
              variant="primary"
              onPress={() => void handleAddMember()}
              disabled={!addEmail.trim() || addMemberMutation.isPending}
            >
              {addMemberMutation.isPending
                ? String(t("admin.addButtonBusy"))
                : String(t("admin.addButton"))}
            </Button>
          </XStack>
          {addError && (
            <Text fontSize="$3" color="$red10">
              {addError}
            </Text>
          )}
        </YStack>
      )}

      {/* ── Add Delegate form (human principal only) ───────────────── */}
      {showAddDelegate && isHuman && humanId && (
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius="$0"
          backgroundColor="$surfaceMuted"
        >
          <Text fontSize="$4" weight="bold">
            {String(t("admin.addDelegateHeading"))}
          </Text>
          <Text fontSize="$3" color="$textMuted">
            {String(t("admin.addDelegateDescription"))}
          </Text>
          <XStack gap="$3" alignItems="flex-end" flexWrap="wrap">
            <YStack gap="$1" flex={1} minWidth={200}>
              <Text fontSize="$2" color="$textMuted">
                {String(t("admin.emailLabel"))}
              </Text>
              <input
                type="email"
                placeholder={t("admin.emailPlaceholder") as string}
                value={addDelegateEmail}
                onChange={(e) => {
                  setAddDelegateEmail(e.target.value);
                  setAddDelegateError(null);
                }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--borderColor)",
                  borderRadius: 0,
                  padding: "8px 10px",
                  fontSize: 14,
                  color: "var(--color)",
                }}
              />
            </YStack>
            <YStack gap="$1" minWidth={140}>
              <Text fontSize="$2" color="$textMuted">
                {String(t("admin.roleLabel"))}
              </Text>
              <StyledSelect<DelegateRole>
                value={addDelegateRole}
                options={DELEGATE_ROLES.map((role) => ({
                  value: role as DelegateRole,
                  label: String(t(ROLE_LABEL_KEYS[role])),
                }))}
                onChange={(v) => setAddDelegateRole(v)}
              />
            </YStack>
            <Button
              size="$3"
              variant="primary"
              onPress={() => void handleAddDelegate()}
              disabled={
                !addDelegateEmail.trim() || addDelegateMutation.isPending
              }
            >
              {addDelegateMutation.isPending
                ? String(t("admin.addButtonBusy"))
                : String(t("admin.delegateInviteCreate"))}
            </Button>
          </XStack>
          {addDelegateError && (
            <Text fontSize="$3" color="$red10">
              {addDelegateError}
            </Text>
          )}
          {delegateInvite && (
            <YStack gap="$2" data-testid="delegate-invite-link">
              <Text fontSize="$3" weight="bold">
                {String(t("admin.delegateInviteReady"))}
              </Text>
              <Text fontSize="$3" color="$textMuted">
                {String(
                  t("admin.delegateInviteReadyDescription", {
                    email: delegateInvite.email,
                  }),
                )}
              </Text>
              <XStack gap="$2" alignItems="center" flexWrap="wrap">
                <input
                  readOnly
                  aria-label={String(t("admin.delegateInviteLinkLabel"))}
                  value={delegateInvite.url}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    border: "1px solid var(--borderColor)",
                    borderRadius: 0,
                    padding: "8px 10px",
                    fontSize: 13,
                    color: "var(--color)",
                  }}
                />
                <Button size="$3" variant="outlined" onPress={copyDelegateInvite}>
                  {delegateLinkCopied
                    ? String(t("admin.delegateInviteCopied"))
                    : String(t("admin.delegateInviteCopy"))}
                </Button>
              </XStack>
            </YStack>
          )}
        </YStack>
      )}

      {/* Table area — replaced by the shared error surface on failure while
          the header + add-member forms above stay mounted, so the error is
          always recoverable in place (mirrors PlacesTable). */}
      {error ? (
        <YStack flex={1} minHeight={400}>
          <AdminTableErrorState
            message={String(
              t("admin.teamLoadFailed", { error: formatErrorMessage(error, t) }),
            )}
            onRetry={() => {
              void refetch();
            }}
            testId="admin-team-error"
          />
        </YStack>
      ) : (
        /* The 640px table floor drops only below useIsMobile's 600px
           breakpoint, the same breakpoint DataTable uses for card mode, so
           the page never overflows horizontally on phones and there is no
           floorless band (Tamagui's $gtSm media query starts at 641px). */
        <YStack flex={1} minWidth={isMobile ? 0 : 640}>
          <ActionBar
            onRefresh={() => {
              void refetch();
            }}
            countLabel={summaryLabel}
          >
            <SearchBar
              value={searchQuery}
              onChangeText={handleSearchChange}
              placeholder={String(t("admin.searchTeamPlaceholder"))}
            />
            {/* Density toggle — plain-English label on purpose: admin-only
                chrome, and a new i18n key would require editing the locale
                JSON catalogs (same rule as the range label in Pagination). */}
            <Button
              variant="ghost"
              size="$2"
              onPress={toggleDensity}
              aria-pressed={density === "compact"}
              paddingHorizontal="$3"
            >
              <XStack gap="$2" alignItems="center">
                <Rows3 size={14} />
                <Text variant="overline">Density</Text>
              </XStack>
            </Button>
            <ColumnSelector
              options={columnOptions}
              isVisible={colVis.isVisible}
              onToggle={colVis.toggleColumn}
              onShowAll={colVis.showAll}
              hasHidden={colVis.hasHidden}
            />
          </ActionBar>

          <TableContainer>
            <DataTable<MemberRow>
              rows={filteredMemberRows}
              columns={visibleColumns}
              clientSort
              getRowKey={(row) => row.humanId}
              isLoading={isDataLoading}
              density={density}
              rowActions={rowActions}
              renderMobileCard={renderMobileCard}
              testIdBase="team-table"
              emptyState={
                hasActiveSearch ? (
                  <NoResults
                    title={String(t("admin.noMatchingMembers"))}
                    description={String(
                      t("admin.noMatchingMembersDescription"),
                    )}
                    onClearFilters={() => handleSearchChange("")}
                  />
                ) : canManageTeam ? (
                  <SkeletonEmptyState
                    title={emptyLabel}
                    description={String(
                      t(
                        isOrg
                          ? "admin.addTeamMemberDescription"
                          : "admin.addDelegateDescription",
                      ),
                    )}
                    ctaLabel={String(
                      t(isOrg ? "admin.addMember" : "admin.addDelegate"),
                    )}
                    onCtaPress={() => {
                      if (isOrg) setShowAddMember(true);
                      else setShowAddDelegate(true);
                    }}
                    columns={4}
                  />
                ) : (
                  <NoResults title={emptyLabel} />
                )
              }
            />
          </TableContainer>

          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
            total={totalRows}
          />
        </YStack>
      )}

      {/* ── Pending Invitations (owner/admin only) ──────────────────── */}
      {isOrg &&
        orgId &&
        (actorIsOwner || actorRole === "ADMIN") &&
        invitationsData &&
        invitationsData.items.length > 0 && (
          <YStack
            gap="$3"
            padding="$4"
            borderWidth={2}
            borderColor="$borderColor"
            borderRadius="$0"
            backgroundColor="$surfaceMuted"
          >
            <YStack gap="$1">
              <Text fontSize="$4" weight="bold">
                {String(t("admin.pendingInvitations"))}
              </Text>
              <Text fontSize="$3" color="$textMuted">
                {String(t("admin.pendingInvitationsDescription"))}
              </Text>
            </YStack>

            <YStack gap="$2">
              {invitationsData.items.map((inv) => (
                <XStack
                  key={inv.id}
                  justifyContent="space-between"
                  alignItems="center"
                  padding="$3"
                  borderWidth={2}
                  borderColor="$borderColor"
                  borderRadius="$0"
                  backgroundColor="$background"
                >
                  <YStack gap="$1" flex={1}>
                    <Text fontSize="$3" weight="bold">
                      {inv.email}
                    </Text>
                    <XStack gap="$3" alignItems="center">
                      <Badge
                        tone={getRoleBadgeTone(inv.role as OrgRole)}
                        size="sm"
                      >
                        {String(
                          t(ROLE_LABEL_KEYS[inv.role as OrgRole] ?? inv.role),
                        )}
                      </Badge>
                      <Text fontSize="$2" color="$textMuted">
                        {String(
                          t("admin.expiresOn", {
                            date: fmt.dateTime(new Date(inv.expiresAt), {
                              dateStyle: "medium",
                            }),
                          }),
                        )}
                      </Text>
                    </XStack>
                  </YStack>
                  <Button
                    size="$2"
                    variant="ghost"
                    onPress={() => handleRevokeInvitation(inv.id, inv.email)}
                    disabled={revokeInvitationMutation.isPending}
                    aria-label={String(t("admin.revokeInvitation"))}
                  >
                    <XCircle size={14} />
                    {String(t("admin.revokeInvitation"))}
                  </Button>
                </XStack>
              ))}
            </YStack>
          </YStack>
        )}

      {/* ── Transfer Ownership (owner-only) ─────────────────────────── */}
      {isOrg && actorIsOwner && transferCandidates.length > 0 && (
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius="$0"
          backgroundColor="$surfaceMuted"
        >
          <YStack gap="$1">
            <Text fontSize="$4" weight="bold">
              {String(t("admin.transferOwnership"))}
            </Text>
            <Text fontSize="$3" color="$textMuted">
              {String(t("admin.transferOwnershipDescription"))}
            </Text>
          </YStack>

          {!showTransferConfirm ? (
            <XStack gap="$3" alignItems="center" flexWrap="wrap">
              <StyledSelect<string>
                value={transferTargetId ?? ""}
                options={[
                  ...transferCandidates.map((m) => ({
                    value: m.humanId,
                    label: m.name ?? m.email ?? m.humanId,
                  })),
                ]}
                onChange={(v) => setTransferTargetId(v || null)}
                placeholder={String(t("admin.selectMember"))}
              />
              <Button
                size="$3"
                variant="secondary"
                disabled={!transferTargetId}
                onPress={() => setShowTransferConfirm(true)}
              >
                <ArrowRightLeft size={14} />
                {String(t("admin.transfer"))}
              </Button>
            </XStack>
          ) : (
            <YStack
              gap="$3"
              padding="$3"
              borderWidth={2}
              borderColor="$red8"
              borderRadius="$0"
              backgroundColor="$red2"
            >
              <Text fontSize="$3">
                {String(
                  t("admin.transferConfirmMessage", {
                    name:
                      transferCandidates.find(
                        (m) => m.humanId === transferTargetId,
                      )?.name ??
                      transferCandidates.find(
                        (m) => m.humanId === transferTargetId,
                      )?.email ??
                      String(t("admin.thisMember")),
                  }),
                )}
              </Text>
              <XStack gap="$2">
                <Button
                  size="$3"
                  variant="primary"
                  onPress={() => void handleTransferOwnership()}
                  disabled={transferOwnershipMutation.isPending}
                >
                  {transferOwnershipMutation.isPending
                    ? String(t("admin.transferring"))
                    : String(t("admin.confirmTransfer"))}
                </Button>
                <Button
                  size="$3"
                  variant="ghost"
                  onPress={() => setShowTransferConfirm(false)}
                  disabled={transferOwnershipMutation.isPending}
                >
                  {String(t("admin.cancel"))}
                </Button>
              </XStack>
            </YStack>
          )}
        </YStack>
      )}
      {/* ── Confirm remove member/delegate dialog ──────────────── */}
      <ConfirmDialog
        open={!!removeTarget}
        onConfirm={() => {
          void confirmRemove();
        }}
        onCancel={() => setRemoveTarget(null)}
        title={String(
          t(isOrg ? "admin.removeMemberTitle" : "admin.removeDelegateTitle"),
        )}
        description={String(
          t("admin.removeMemberConfirm", {
            name:
              removeTarget?.name ??
              String(t(isOrg ? "admin.thisMember" : "admin.thisDelegate")),
          }),
        )}
        confirmLabel={String(t("admin.remove"))}
        tone="danger"
        loading={removeMutation.isPending || removeDelegateMutation.isPending}
      />

      {/* ── Confirm revoke invitation dialog ───────────────────── */}
      <ConfirmDialog
        open={!!revokeTarget}
        onConfirm={() => {
          void confirmRevokeInvitation();
        }}
        onCancel={() => setRevokeTarget(null)}
        title={String(t("admin.revokeInvitation"))}
        description={String(
          t("admin.revokeInvitationConfirm", {
            email: revokeTarget?.email ?? "",
          }),
        )}
        confirmLabel={String(t("admin.revokeInvitation"))}
        tone="danger"
        loading={revokeInvitationMutation.isPending}
      />
    </YStack>
  );
}
