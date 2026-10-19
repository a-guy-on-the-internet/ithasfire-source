"use client";

import { useMemo, useState } from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  Badge,
  Button,
  Modal,
  NextLinkAnchor,
  StyledSelect,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  ArrowLeft,
  Check,
  Link2,
  Megaphone,
  Pencil,
  Plus,
} from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { AdminTableErrorState } from "@/components/AdminTableParts";
import {
  VolunteerAskForm,
  type VolunteerAskFormInitial,
} from "@/components/volunteering/VolunteerAskForm";
import { AskWaiverSection } from "@/components/volunteering/AskWaiverSection";
import { SECTION_HEADING_PROPS } from "@/components/volunteering/section-heading-props";
import {
  WRAPPING_BUTTON_ICON_STYLE,
  WRAPPING_BUTTON_LABEL_PROPS,
  WRAPPING_BUTTON_PROPS,
  WRAPPING_BUTTON_ROW_PROPS,
} from "@/components/volunteering/wrapping-button-props";
import { VolunteerGroupCard } from "@/components/volunteering/VolunteerGroupCard";
import {
  SignupReviewRow,
  type SignupRowData,
} from "@/components/volunteering/SignupReviewRow";
import type { GroupOption } from "@/components/volunteering/GroupAssignmentMenu";
import {
  BroadcastComposer,
  type BroadcastScopeOption,
} from "@/components/volunteering/BroadcastComposer";
import {
  ASK_CADENCE_LABEL_KEY,
  ASK_STATUS_LABEL_KEY,
  ASK_STATUS_TONE,
  volunteerConflictMessageKey,
  type AskStatus,
  type SignupStatus,
} from "@/components/volunteering/volunteering-helpers";
import { formatAskWindow } from "@/components/volunteering/ask-window-label";

// ─────────────────────────────────────────────────────────────────────────────
// Styled
// ─────────────────────────────────────────────────────────────────────────────

const SectionFrame = styled(YStack, {
  name: "AskManageSection",
  gap: "$3",
  borderTopWidth: 1,
  borderTopColor: "$borderColor",
  paddingTop: "$4",
});

const RoleCardFrame = styled(YStack, {
  name: "AskRoleCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  padding: "$4",
  gap: "$2",
});

// ─────────────────────────────────────────────────────────────────────────────
// Status transitions
// ─────────────────────────────────────────────────────────────────────────────

/** Owner-facing lifecycle actions per current status (FR-007). */
const STATUS_ACTIONS: Record<AskStatus, AskStatus[]> = {
  DRAFT: ["OPEN"],
  OPEN: ["PAUSED", "CLOSED"],
  PAUSED: ["OPEN", "CLOSED"],
  CLOSED: ["OPEN", "ARCHIVED"],
  ARCHIVED: [],
};

const STATUS_ACTION_LABEL_KEY: Record<AskStatus, string> = {
  DRAFT: "volunteering.statusActionDraft",
  OPEN: "volunteering.statusActionOpen",
  PAUSED: "volunteering.statusActionPause",
  CLOSED: "volunteering.statusActionClose",
  ARCHIVED: "volunteering.statusActionArchive",
};

/** Close and archive are destructive-ish — stop new signups / freeze. */
const CONFIRMED_TRANSITIONS: ReadonlySet<AskStatus> = new Set([
  "CLOSED",
  "ARCHIVED",
]);

/** Sentinel for "no role filter" in the pending-queue role select. */
const ALL_ROLES_VALUE = "__all__";

/**
 * General-pool page size for the cursor-paginated roster read. The roster
 * returns `nextCursor` when more pool rows exist; "Load more" fetches the
 * next page through the same infinite query.
 */
const POOL_PAGE_LIMIT = 50;

/** Narrow a transport signup record to the row shape the review row takes. */
function toSignupRow(signup: {
  id: string;
  contactName: string | null;
  contactEmail: string;
  status: string;
  groupId: string | null;
  roleId: string;
  createdAt: Date | string;
}): SignupRowData {
  return {
    id: signup.id,
    contactName: signup.contactName,
    contactEmail: signup.contactEmail,
    status: signup.status as SignupStatus,
    groupId: signup.groupId,
    roleId: signup.roleId,
    createdAt: signup.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// View
// ─────────────────────────────────────────────────────────────────────────────

type AskManageViewProps = {
  slug: string;
  askId: string;
};

type RoleDialogState =
  | null
  | { mode: "create" }
  | {
      mode: "edit";
      id: string;
      initial: {
        name: string;
        description: string | null;
        capacity: number | null;
        defaultHours: number | null;
      };
    };

/**
 * Owner management page for a generic volunteer ask: header + lifecycle
 * transitions, the pending review queue, roles, groups (with coordinator
 * management and lazy member lists), the general pool, and roster
 * broadcasts. Powered by `volunteer.roster.ask` (FR-007) — cursor-paginated
 * over the general pool via useInfiniteQuery — plus
 * `volunteer.signups.listByAsk` for the queue and per-group members.
 */
export function AskManageView({ slug, askId }: AskManageViewProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();
  const utils = trpc.useUtils();

  const [editOpen, setEditOpen] = useState(false);
  const [roleDialog, setRoleDialog] = useState<RoleDialogState>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [broadcastScopeId, setBroadcastScopeId] = useState<string | null>(
    null,
  );
  const [confirmStatus, setConfirmStatus] = useState<AskStatus | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [queueRoleId, setQueueRoleId] = useState<string | null>(null);

  // Cursor-paginated roster: page 1 carries the ask/roles/groups metadata;
  // every page carries a slice of the general pool (keyset cursor). Pattern
  // mirrors eventSaves.listMine (SavedEvents.tsx).
  const rosterQuery = trpc.volunteer.roster.ask.useInfiniteQuery(
    { askId, limit: POOL_PAGE_LIMIT },
    {
      staleTime: 15_000,
      retry: 1,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const broadcastsQuery = trpc.volunteer.broadcasts.list.useQuery(
    { askId },
    { staleTime: 15_000, retry: 1, meta: { silent: true } },
  );
  const pendingQueueQuery = trpc.volunteer.signups.listByAsk.useQuery(
    {
      askId,
      scope: { kind: "ALL" },
      status: "PENDING",
      ...(queueRoleId ? { roleId: queueRoleId } : {}),
    },
    { staleTime: 15_000, retry: 1, meta: { silent: true } },
  );
  // A PLACE ask with no zone of its own edits in the place's zone. Same
  // query and input as the place layout, so it is usually cached.
  const rosterAsk = rosterQuery.data?.pages[0]?.ask;
  const askPlaceId =
    rosterAsk?.subjectType === "PLACE" ? rosterAsk.subjectId : null;
  const placeQuery = trpc.places.getPlaceTitle.useQuery(
    { placeId: askPlaceId ?? "" },
    {
      enabled: askPlaceId !== null,
      staleTime: 60_000,
      retry: 2,
      meta: { silent: true },
    },
  );

  const invalidate = () => {
    // Invalidation refetches every loaded roster page in sequence, so the
    // pool stays consistent after a decision lands.
    return Promise.all([
      utils.volunteer.roster.ask.invalidate({ askId }),
      utils.volunteer.broadcasts.list.invalidate({ askId }),
      utils.volunteer.signups.listByAsk.invalidate(),
    ]);
  };

  const updateAskMutation = trpc.volunteer.asks.update.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-ask-status-updated",
        title: String(t("volunteering.askUpdated")),
      });
      setConfirmStatus(null);
      void invalidate();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-ask-status-failed",
        title: String(t("volunteering.askSaveFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  // Metadata (ask/roles/groups) is repeated on every page — read it off
  // page 1; the general pool is the concatenation of all loaded pages.
  const rosterPages = rosterQuery.data?.pages;
  const data = rosterPages?.[0];
  const groups = data?.groups ?? [];
  const roles = data?.roles ?? [];

  const groupOptions = useMemo(
    () => groups.map((g) => ({ id: g.id, name: g.name })),
    [groups],
  );

  const roleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of roles) map.set(role.id, role.name);
    return map;
  }, [roles]);

  const pendingItems = pendingQueueQuery.data?.items ?? [];
  const pendingTotal = pendingQueueQuery.data?.pageInfo.total ?? 0;

  // General pool = every loaded cursor page, deduped by id (a row can move
  // between page boundaries when signups are approved/assigned mid-scroll).
  const poolRows = useMemo(() => {
    const map = new Map<string, SignupRowData>();
    for (const page of rosterPages ?? []) {
      for (const signup of page.generalPool) {
        if (!map.has(signup.id)) map.set(signup.id, toSignupRow(signup));
      }
    }
    return [...map.values()];
  }, [rosterPages]);

  const showPoolLoadMore = rosterQuery.hasNextPage;
  const poolLoadingMore = rosterQuery.isFetchingNextPage;

  const loadMorePool = () => {
    void rosterQuery.fetchNextPage();
  };

  const broadcastScopes = useMemo<BroadcastScopeOption[]>(() => {
    const options: BroadcastScopeOption[] = [
      {
        id: "all",
        label: String(t("volunteering.broadcastScopeAll")),
        scope: { kind: "ALL" },
      },
      {
        id: "pool",
        label: String(t("volunteering.broadcastScopePool")),
        scope: { kind: "POOL" },
      },
    ];
    for (const role of roles) {
      options.push({
        id: `role:${role.id}`,
        label: String(
          t("volunteering.broadcastScopeRole", { name: role.name }),
        ),
        scope: { kind: "ROLE", roleId: role.id },
      });
    }
    for (const group of groups) {
      options.push({
        id: `group:${group.id}`,
        label: String(
          t("volunteering.broadcastScopeGroup", { name: group.name }),
        ),
        scope: { kind: "GROUP", groupId: group.id },
      });
    }
    return options;
  }, [roles, groups, t]);

  const copyPublicLink = () => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    void navigator.clipboard.writeText(`${base}/v/${askId}`).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  const applyStatus = (status: AskStatus) => {
    updateAskMutation.mutate({ askId, status });
  };

  const scopeLabelForBroadcast = (record: {
    scopeType: string;
    scopeId: string | null;
  }): string => {
    switch (record.scopeType) {
      case "ALL":
        return String(t("volunteering.broadcastScopeAll"));
      case "POOL":
        return String(t("volunteering.broadcastScopePool"));
      case "ROLE":
        return String(
          t("volunteering.broadcastScopeRole", {
            name:
              (record.scopeId && roleNameById.get(record.scopeId)) ??
              String(t("volunteering.deletedScope")),
          }),
        );
      case "GROUP":
        return String(
          t("volunteering.broadcastScopeGroup", {
            name:
              groups.find((g) => g.id === record.scopeId)?.name ??
              String(t("volunteering.deletedScope")),
          }),
        );
      default:
        return record.scopeType;
    }
  };

  // ── Early states ────────────────────────────────────────────────────────

  if (rosterQuery.isLoading) {
    return (
      <YStack padding="$6" alignItems="center">
        <Text tone="muted">{String(t("admin.loading"))}</Text>
      </YStack>
    );
  }

  if (rosterQuery.isError || !data) {
    return (
      <YStack padding="$4" flex={1} maxWidth={1440} marginHorizontal="auto" width="100%">
        <AdminTableErrorState
          message={formatErrorMessage(rosterQuery.error, t)}
          onRetry={() => {
            void rosterQuery.refetch();
          }}
          testId="volunteer-ask-manage-error"
        />
      </YStack>
    );
  }

  const ask = data.ask;
  const askStatus = ask.status as AskStatus;
  const availableTransitions = STATUS_ACTIONS[askStatus] ?? [];

  // Waiver-template owner scope per subject type (ask-level-volunteer-waivers
  // FR-007): ORG → the org itself; PLACE → the denormalized owning org;
  // HUMAN → the subject human. EVENT asks don't use ask-level waivers.
  const waiverOwner: { orgId: string | null; humanId: string | null } =
    ask.subjectType === "ORG"
      ? { orgId: ask.subjectId, humanId: null }
      : ask.subjectType === "PLACE"
        ? { orgId: ask.orgId ?? null, humanId: null }
        : ask.subjectType === "HUMAN"
          ? { orgId: null, humanId: ask.subjectId }
          : { orgId: null, humanId: null };

  const askWindow = formatAskWindow(fmt, t, ask);

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <XStack gap="$2" alignItems="center">
        <Button variant="ghost" size="$2" minHeight={44} asChild>
          <NextLinkAnchor href={`/admin/${slug}/volunteers`}>
            <XStack gap="$2" alignItems="center">
              <ArrowLeft size={14} />
              <Text variant="bodySmall">
                {String(t("volunteering.backToAsks"))}
              </Text>
            </XStack>
          </NextLinkAnchor>
        </Button>
      </XStack>

      <XStack
        gap="$3"
        alignItems="flex-start"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        {/* Basis, not minWidth: a 260px floor overflowed the page at 320px
            (same fix as the AsksList card). */}
        <YStack
          gap="$2"
          flexGrow={1}
          flexShrink={1}
          flexBasis={260}
          minWidth={0}
        >
          <Text tag="h1" variant="h3" weight="bold">
            {ask.title}
          </Text>
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Badge tone={ASK_STATUS_TONE[askStatus]} size="sm">
              {String(t(ASK_STATUS_LABEL_KEY[askStatus]))}
            </Badge>
            <Badge tone="neutral" size="sm">
              {String(
                t(
                  ASK_CADENCE_LABEL_KEY[
                    ask.cadence as keyof typeof ASK_CADENCE_LABEL_KEY
                  ],
                ),
              )}
            </Badge>
            {askWindow ? (
              <Text variant="caption" tone="muted">
                {askWindow}
              </Text>
            ) : null}
          </XStack>
          {ask.description ? (
            <Text variant="body" tone="muted">
              {ask.description}
            </Text>
          ) : null}
        </YStack>

        {/* flexShrink + minWidth 0: an XStack does not shrink by default, so
            without them the group stays on one max-content line and its wrap
            never fires at 320px. */}
        <XStack
          gap="$2"
          flexWrap="wrap"
          alignItems="center"
          flexShrink={1}
          minWidth={0}
        >
          <Button
            variant="ghost"
            size="$2"
            {...WRAPPING_BUTTON_PROPS}
            onPress={copyPublicLink}
            data-testid="volunteer-ask-copy-public-link"
          >
            <XStack gap="$2" alignItems="center" {...WRAPPING_BUTTON_ROW_PROPS}>
              {copiedLink ? (
                <Check size={14} style={WRAPPING_BUTTON_ICON_STYLE} />
              ) : (
                <Link2 size={14} style={WRAPPING_BUTTON_ICON_STYLE} />
              )}
              <Text variant="bodySmall" {...WRAPPING_BUTTON_LABEL_PROPS}>
                {copiedLink
                  ? String(t("volunteering.publicLinkCopied"))
                  : String(t("volunteering.copyPublicLink"))}
              </Text>
            </XStack>
          </Button>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            onPress={() => setEditOpen(true)}
            data-testid="volunteer-ask-edit"
          >
            <XStack gap="$2" alignItems="center">
              <Pencil size={14} />
              <Text tone="inherit" variant="bodySmall">{String(t("common.edit"))}</Text>
            </XStack>
          </Button>
          {availableTransitions.map((next) => (
            <Button
              key={next}
              variant={next === "OPEN" ? "primary" : "outlined"}
              size="$2"
              minHeight={44}
              disabled={updateAskMutation.isPending}
              onPress={() => {
                if (CONFIRMED_TRANSITIONS.has(next)) {
                  setConfirmStatus(next);
                } else {
                  applyStatus(next);
                }
              }}
              data-testid={`volunteer-ask-status-${next.toLowerCase()}`}
            >
              {String(t(STATUS_ACTION_LABEL_KEY[next]))}
            </Button>
          ))}
        </XStack>
      </XStack>

      {/* ── Pending review queue ───────────────────────────────────────── */}
      <SectionFrame data-testid="volunteer-pending-queue">
        <XStack
          justifyContent="space-between"
          alignItems="center"
          gap="$2"
          flexWrap="wrap"
        >
          <XStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
            <Text tag="h2" variant="h4" weight="bold" {...SECTION_HEADING_PROPS}>
              {String(t("volunteering.pendingQueueSection"))}
            </Text>
            {pendingTotal > 0 ? (
              <Badge tone="warning" size="sm">
                {pendingTotal}
              </Badge>
            ) : null}
          </XStack>
          {roles.length > 1 ? (
            <StyledSelect
              value={queueRoleId ?? ALL_ROLES_VALUE}
              options={[
                {
                  value: ALL_ROLES_VALUE,
                  label: String(t("volunteering.roleFilterAll")),
                },
                ...roles.map((role) => ({
                  value: role.id,
                  label: role.name,
                })),
              ]}
              onChange={(value) =>
                setQueueRoleId(value === ALL_ROLES_VALUE ? null : value)
              }
              aria-label={String(t("volunteering.roleFilterLabel"))}
              testId="volunteer-pending-role-filter"
            />
          ) : null}
        </XStack>

        {pendingQueueQuery.isLoading ? (
          <Text variant="bodySmall" tone="muted" role="status">
            {String(t("common.loading"))}
          </Text>
        ) : pendingQueueQuery.isError ? (
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="bodySmall" tone="muted">
              {formatErrorMessage(pendingQueueQuery.error, t)}
            </Text>
            <Button
              variant="secondary"
              size="$2"
              minHeight={44}
              onPress={() => {
                void pendingQueueQuery.refetch();
              }}
            >
              {String(t("volunteering.retryCta"))}
            </Button>
          </XStack>
        ) : pendingItems.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.pendingQueueEmpty"))}
          </Text>
        ) : (
          <YStack gap="$2">
            {pendingItems.map((signup) => (
              <SignupReviewRow
                key={signup.id}
                signup={toSignupRow(signup)}
                roleName={roleNameById.get(signup.roleId) ?? null}
                assignableGroups={groupOptions}
                showGroupMenu={groups.length > 0}
                onChanged={() => {
                  void invalidate();
                }}
              />
            ))}
          </YStack>
        )}
      </SectionFrame>

      {/* ── Waiver ─────────────────────────────────────────────────────── */}
      {ask.subjectType !== "EVENT" ? (
        <SectionFrame data-testid="volunteer-ask-waiver-section">
          <AskWaiverSection
            askId={askId}
            subjectType={ask.subjectType}
            orgId={waiverOwner.orgId}
            humanId={waiverOwner.humanId}
            initialWaiverTemplateId={ask.waiverTemplateId ?? null}
            waiverRequired={ask.waiverRequired}
            onAssigned={() => {
              void invalidate();
            }}
          />
        </SectionFrame>
      ) : null}

      {/* ── Roles ──────────────────────────────────────────────────────── */}
      <SectionFrame>
        <XStack
          justifyContent="space-between"
          alignItems="center"
          gap="$2"
          flexWrap="wrap"
        >
          <Text tag="h2" variant="h4" weight="bold" {...SECTION_HEADING_PROPS}>
            {String(t("volunteering.rolesSection"))}
          </Text>
          <Button
            variant="primary"
            size="$2"
            minHeight={44}
            onPress={() => setRoleDialog({ mode: "create" })}
            data-testid="volunteer-ask-add-role"
          >
            <XStack gap="$2" alignItems="center">
              <Plus size={14} />
              <Text tone="inherit" variant="bodySmall">
                {String(t("volunteering.addRoleCta"))}
              </Text>
            </XStack>
          </Button>
        </XStack>

        {roles.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.rolesEmpty"))}
          </Text>
        ) : (
          <YStack gap="$2">
            {roles.map((role) => (
              <RoleCardFrame key={role.id}>
                <XStack
                  gap="$3"
                  alignItems="flex-start"
                  justifyContent="space-between"
                  flexWrap="wrap"
                >
                  {/* Basis, not minWidth: a 200px floor pushed the badges and
                      edit button past the role card at 320px. */}
                  <YStack
                    gap="$1"
                    flexGrow={1}
                    flexShrink={1}
                    flexBasis={200}
                    minWidth={0}
                  >
                    <Text variant="body" style={{ fontWeight: 700 }}>
                      {role.name}
                    </Text>
                    {role.description ? (
                      <Text variant="caption" tone="muted">
                        {role.description}
                      </Text>
                    ) : null}
                  </YStack>
                  <XStack
                    gap="$2"
                    alignItems="center"
                    flexWrap="wrap"
                    flexShrink={1}
                    minWidth={0}
                  >
                    <Badge
                      tone={
                        role.capacity !== null &&
                        role.acceptedCount >= role.capacity
                          ? "warning"
                          : "neutral"
                      }
                      size="sm"
                    >
                      {role.capacity !== null
                        ? String(
                            t("volunteering.roleFill", {
                              count: role.acceptedCount,
                              cap: role.capacity,
                            }),
                          )
                        : String(
                            t("volunteering.roleFillOpen", {
                              count: role.acceptedCount,
                            }),
                          )}
                    </Badge>
                    {role.pendingCount > 0 ? (
                      <Badge tone="warning" size="sm">
                        {String(
                          t("volunteering.rolePending", {
                            count: role.pendingCount,
                          }),
                        )}
                      </Badge>
                    ) : null}
                    {role.defaultHours != null ? (
                      <Badge tone="info" size="sm">
                        {String(
                          t("volunteering.roleDefaultHours", {
                            hours: role.defaultHours,
                          }),
                        )}
                      </Badge>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="$2"
                      minHeight={44}
                      onPress={() =>
                        setRoleDialog({
                          mode: "edit",
                          id: role.id,
                          initial: {
                            name: role.name,
                            description: role.description,
                            capacity: role.capacity,
                            defaultHours: role.defaultHours,
                          },
                        })
                      }
                      aria-label={String(t("common.edit"))}
                      data-testid={`volunteer-ask-role-edit-${role.id}`}
                    >
                      <Pencil size={14} />
                    </Button>
                  </XStack>
                </XStack>
              </RoleCardFrame>
            ))}
          </YStack>
        )}
      </SectionFrame>

      {/* ── Groups ─────────────────────────────────────────────────────── */}
      <SectionFrame>
        <XStack
          justifyContent="space-between"
          alignItems="center"
          gap="$2"
          flexWrap="wrap"
        >
          <Text tag="h2" variant="h4" weight="bold" {...SECTION_HEADING_PROPS}>
            {String(t("volunteering.groupsSection"))}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            onPress={() => setGroupDialogOpen(true)}
            data-testid="volunteer-ask-add-group"
          >
            <XStack gap="$2" alignItems="center">
              <Plus size={14} />
              <Text tone="inherit" variant="bodySmall">
                {String(t("volunteering.addGroupCta"))}
              </Text>
            </XStack>
          </Button>
        </XStack>

        {groups.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.groupsEmpty"))}
          </Text>
        ) : (
          <YStack gap="$3">
            {groups.map((group) => (
              <OwnerGroupCard
                key={group.id}
                askId={askId}
                group={{
                  id: group.id,
                  name: group.name,
                  description: group.description,
                  capacity: group.capacity,
                  memberCount: group.memberCount,
                  coordinator: group.coordinator,
                }}
                assignableGroups={groupOptions}
                onBroadcast={() => setBroadcastScopeId(`group:${group.id}`)}
                onChanged={() => {
                  void invalidate();
                }}
              />
            ))}
          </YStack>
        )}
      </SectionFrame>

      {/* ── General pool ───────────────────────────────────────────────── */}
      <SectionFrame>
        <Text tag="h2" variant="h4" weight="bold" {...SECTION_HEADING_PROPS}>
          {String(t("volunteering.poolSection"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("volunteering.poolHint"))}
        </Text>
        {poolRows.length === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.poolEmpty"))}
          </Text>
        ) : (
          <YStack gap="$2">
            {poolRows.map((signup) => (
              <SignupReviewRow
                key={signup.id}
                signup={signup}
                roleName={roleNameById.get(signup.roleId) ?? null}
                assignableGroups={groupOptions}
                showGroupMenu={groups.length > 0}
                onChanged={() => {
                  void invalidate();
                }}
              />
            ))}
          </YStack>
        )}
        {showPoolLoadMore ? (
          <XStack>
            <Button
              variant="secondary"
              size="$2"
              minHeight={44}
              disabled={poolLoadingMore}
              onPress={() => {
                void loadMorePool();
              }}
              data-testid="volunteer-pool-load-more"
            >
              {String(
                t(
                  poolLoadingMore
                    ? "common.loading"
                    : "volunteering.loadMoreCta",
                ),
              )}
            </Button>
          </XStack>
        ) : null}
      </SectionFrame>

      {/* ── Broadcasts ─────────────────────────────────────────────────── */}
      <SectionFrame>
        <XStack
          justifyContent="space-between"
          alignItems="center"
          gap="$2"
          flexWrap="wrap"
        >
          <Text tag="h2" variant="h4" weight="bold" {...SECTION_HEADING_PROPS}>
            {String(t("volunteering.broadcastsSection"))}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            minHeight={44}
            onPress={() => setBroadcastScopeId("all")}
            data-testid="volunteer-ask-broadcast"
          >
            <XStack gap="$2" alignItems="center">
              <Megaphone size={14} />
              <Text tone="inherit" variant="bodySmall">
                {String(t("volunteering.broadcastCta"))}
              </Text>
            </XStack>
          </Button>
        </XStack>

        {(broadcastsQuery.data?.broadcasts.length ?? 0) === 0 ? (
          <Text variant="bodySmall" tone="muted">
            {String(t("volunteering.broadcastsEmpty"))}
          </Text>
        ) : (
          <YStack gap="$2">
            {broadcastsQuery.data?.broadcasts.map((b) => (
              <YStack
                key={b.id}
                gap="$1"
                borderWidth={1}
                borderColor="$borderColor"
                padding="$3"
              >
                <XStack
                  gap="$2"
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                >
                  <Text variant="body" style={{ fontWeight: 600 }}>
                    {b.subject}
                  </Text>
                  <XStack gap="$2" alignItems="center">
                    <Badge tone="neutral" size="sm">
                      {scopeLabelForBroadcast(b)}
                    </Badge>
                    <Text variant="caption" tone="muted">
                      {String(
                        t("volunteering.broadcastRecipients", {
                          count: b.recipientCount,
                        }),
                      )}
                      {" · "}
                      {fmt.dateTime(new Date(b.createdAt))}
                    </Text>
                  </XStack>
                </XStack>
                <Text variant="caption" tone="muted">
                  {b.body}
                </Text>
              </YStack>
            ))}
          </YStack>
        )}
      </SectionFrame>

      {/* ── Dialogs ────────────────────────────────────────────────────── */}
      {editOpen ? (
        <VolunteerAskForm
          mode="edit"
          askId={askId}
          defaultTimezone={
            askPlaceId !== null ? placeQuery.data?.timezone : undefined
          }
          initial={
            {
              title: ask.title,
              description: ask.description,
              cadence: ask.cadence,
              startsAt: ask.startsAt,
              endsAt: ask.endsAt,
              capacity: ask.capacity,
              autoApprove: ask.autoApprove,
              waiverRequired: ask.waiverRequired,
              smsOptInEnabled: ask.smsOptInEnabled,
              timezone: ask.timezone,
            } satisfies VolunteerAskFormInitial
          }
          onClose={() => setEditOpen(false)}
          onSuccess={() => {
            setEditOpen(false);
            void invalidate();
          }}
        />
      ) : null}

      {roleDialog ? (
        <AskRoleDialog
          key={roleDialog.mode === "edit" ? `edit-${roleDialog.id}` : "create"}
          askId={askId}
          state={roleDialog}
          onClose={() => setRoleDialog(null)}
          onSuccess={() => {
            setRoleDialog(null);
            void invalidate();
          }}
        />
      ) : null}

      {groupDialogOpen ? (
        <CreateGroupDialog
          askId={askId}
          onClose={() => setGroupDialogOpen(false)}
          onSuccess={() => {
            setGroupDialogOpen(false);
            void invalidate();
          }}
        />
      ) : null}

      <BroadcastComposer
        askId={askId}
        open={broadcastScopeId !== null}
        scopes={broadcastScopes}
        initialScopeId={broadcastScopeId ?? undefined}
        onClose={() => setBroadcastScopeId(null)}
        onSent={() => {
          void invalidate();
        }}
      />

      <ConfirmDialog
        open={confirmStatus !== null}
        tone="danger"
        title={String(
          t(
            confirmStatus === "ARCHIVED"
              ? "volunteering.archiveConfirmTitle"
              : "volunteering.closeConfirmTitle",
          ),
        )}
        description={String(
          t(
            confirmStatus === "ARCHIVED"
              ? "volunteering.archiveConfirmBody"
              : "volunteering.closeConfirmBody",
          ),
        )}
        confirmLabel={String(
          t(
            confirmStatus === "ARCHIVED"
              ? "volunteering.statusActionArchive"
              : "volunteering.statusActionClose",
          ),
        )}
        cancelLabel={String(t("common.cancel"))}
        loading={updateAskMutation.isPending}
        onConfirm={() => {
          if (confirmStatus) applyStatus(confirmStatus);
        }}
        onCancel={() => setConfirmStatus(null)}
      />
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner group card (lazy member list via listByAsk GROUP scope)
// ─────────────────────────────────────────────────────────────────────────────

function OwnerGroupCard({
  askId,
  group,
  assignableGroups,
  onBroadcast,
  onChanged,
}: {
  askId: string;
  group: {
    id: string;
    name: string;
    description: string | null;
    capacity: number | null;
    memberCount: number;
    coordinator: { humanId: string; name: string | null } | null;
  };
  assignableGroups: GroupOption[];
  onBroadcast: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Lazy: nothing is fetched until the owner expands the member list.
  const membersQuery = trpc.volunteer.signups.listByAsk.useQuery(
    { askId, scope: { kind: "GROUP", groupId: group.id } },
    { enabled: expanded, staleTime: 15_000, retry: 1, meta: { silent: true } },
  );

  return (
    <VolunteerGroupCard
      group={group}
      signups={
        expanded && membersQuery.data
          ? membersQuery.data.items.map(toSignupRow)
          : undefined
      }
      members={{
        expanded,
        loading:
          expanded &&
          (membersQuery.isPending ||
            (membersQuery.isError && membersQuery.isFetching)),
        error: expanded && membersQuery.isError,
        onToggle: () => setExpanded((value) => !value),
        onRetry: () => {
          void membersQuery.refetch();
        },
      }}
      assignableGroups={assignableGroups}
      canManageCoordinator
      onBroadcast={onBroadcast}
      onChanged={onChanged}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Role dialog (ask-owned roles: name / description / capacity / defaultHours)
// ─────────────────────────────────────────────────────────────────────────────

function AskRoleDialog({
  askId,
  state,
  onClose,
  onSuccess,
}: {
  askId: string;
  state: Exclude<RoleDialogState, null>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useTranslations();
  const notify = useNotify();

  const initial = state.mode === "edit" ? state.initial : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [capacity, setCapacity] = useState(
    initial?.capacity != null ? String(initial.capacity) : "",
  );
  const [defaultHours, setDefaultHours] = useState(
    initial?.defaultHours != null ? String(initial.defaultHours) : "",
  );
  const [capacityError, setCapacityError] = useState(false);
  const [defaultHoursError, setDefaultHoursError] = useState(false);

  const onError = (err: unknown) => {
    const conflictKey = volunteerConflictMessageKey(err);
    notify.toast.danger({
      id: "volunteer-ask-role-save-failed",
      title: String(t("volunteering.roleSaveFailed")),
      message: conflictKey
        ? String(t(conflictKey))
        : formatErrorMessage(err, t),
    });
  };

  const addMutation = trpc.volunteer.askRoles.add.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-ask-role-saved",
        title: String(t("volunteering.roleSaved")),
      });
      onSuccess();
    },
    onError,
  });
  const updateMutation = trpc.volunteer.askRoles.update.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-ask-role-saved",
        title: String(t("volunteering.roleSaved")),
      });
      onSuccess();
    },
    onError,
  });

  const isPending = addMutation.isPending || updateMutation.isPending;

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    // Out-of-range or non-numeric values block submit with an inline error —
    // silently coercing them to null would save "no cap" / "no default hours"
    // the organizer never asked for.
    const parsedCapacity = capacity.trim() === "" ? null : Number(capacity);
    const capacityInvalid =
      parsedCapacity !== null &&
      (!Number.isFinite(parsedCapacity) || parsedCapacity < 1);
    const parsedHours =
      defaultHours.trim() === "" ? null : Number(defaultHours);
    const hoursInvalid =
      parsedHours !== null &&
      (!Number.isFinite(parsedHours) || parsedHours < 0 || parsedHours > 99);
    setCapacityError(capacityInvalid);
    setDefaultHoursError(hoursInvalid);
    if (capacityInvalid || hoursInvalid) return;

    const capacityValue =
      parsedCapacity === null ? null : Math.floor(parsedCapacity);
    const trimmedDescription = description.trim();

    if (state.mode === "create") {
      addMutation.mutate({
        askId,
        name: trimmedName,
        description: trimmedDescription || null,
        capacity: capacityValue,
        defaultHours: parsedHours,
      });
    } else {
      updateMutation.mutate({
        id: state.id,
        name: trimmedName,
        description: trimmedDescription || null,
        capacity: capacityValue,
        defaultHours: parsedHours,
      });
    }
  };

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={520}>
        <Modal.Header
          title={String(
            t(
              state.mode === "create"
                ? "volunteering.roleDialogCreateTitle"
                : "volunteering.roleDialogEditTitle",
            ),
          )}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.roleFieldName"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={120}
                fullWidth
                minHeight={44}
                testId="volunteer-ask-role-name"
                aria-label={String(t("volunteering.roleFieldName"))}
              />
            </YStack>
            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.roleFieldDescription"))}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={3}
                maxLength={2000}
                fullWidth
                testId="volunteer-ask-role-description"
                aria-label={String(t("volunteering.roleFieldDescription"))}
              />
            </YStack>
            <XStack gap="$3" flexWrap="wrap">
              <YStack gap="$1" flex={1} minWidth={160}>
                <Text variant="label">
                  {String(t("volunteering.roleFieldCapacity"))}
                </Text>
                <TextInput
                  value={capacity}
                  onChangeText={setCapacity}
                  inputMode="numeric"
                  fullWidth
                  minHeight={44}
                  testId="volunteer-ask-role-capacity"
                  aria-label={String(t("volunteering.roleFieldCapacity"))}
                />
                {capacityError ? (
                  <Text variant="caption" tone="error" role="alert">
                    {String(t("volunteering.capacityInvalid"))}
                  </Text>
                ) : null}
              </YStack>
              <YStack gap="$1" flex={1} minWidth={160}>
                <Text variant="label">
                  {String(t("volunteering.roleFieldDefaultHours"))}
                </Text>
                <TextInput
                  value={defaultHours}
                  onChangeText={setDefaultHours}
                  inputMode="decimal"
                  fullWidth
                  minHeight={44}
                  testId="volunteer-ask-role-default-hours"
                  aria-label={String(t("volunteering.roleFieldDefaultHours"))}
                />
                {defaultHoursError ? (
                  <Text variant="caption" tone="error" role="alert">
                    {String(t("volunteering.defaultHoursInvalid"))}
                  </Text>
                ) : null}
              </YStack>
            </XStack>
            <Text variant="caption" tone="muted">
              {String(t("volunteering.roleFieldDefaultHoursHelp"))}
            </Text>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button variant="ghost" onPress={onClose} disabled={isPending}>
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={isPending || !name.trim()}
              data-testid="volunteer-ask-role-submit"
            >
              {String(
                state.mode === "create" ? t("common.create") : t("common.save"),
              )}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create-group dialog
// ─────────────────────────────────────────────────────────────────────────────

function CreateGroupDialog({
  askId,
  onClose,
  onSuccess,
}: {
  askId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useTranslations();
  const notify = useNotify();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capacity, setCapacity] = useState("");
  const [capacityError, setCapacityError] = useState(false);

  const createMutation = trpc.volunteer.groups.create.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-group-created",
        title: String(t("volunteering.groupCreated")),
      });
      onSuccess();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-group-create-failed",
        title: String(t("volunteering.groupCreateFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    // Same rule as the role dialog: a bad capacity blocks submit instead of
    // silently becoming "no cap".
    const parsedCapacity = capacity.trim() === "" ? null : Number(capacity);
    const capacityInvalid =
      parsedCapacity !== null &&
      (!Number.isFinite(parsedCapacity) || parsedCapacity < 1);
    setCapacityError(capacityInvalid);
    if (capacityInvalid) return;
    createMutation.mutate({
      askId,
      name: trimmedName,
      description: description.trim() || null,
      capacity: parsedCapacity === null ? null : Math.floor(parsedCapacity),
    });
  };

  return (
    <Modal open onClose={onClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("volunteering.groupDialogTitle"))}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.groupFieldName"))}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={120}
                fullWidth
                minHeight={44}
                testId="volunteer-group-name"
                aria-label={String(t("volunteering.groupFieldName"))}
              />
            </YStack>
            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.groupFieldDescription"))}
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={3}
                maxLength={2000}
                fullWidth
                testId="volunteer-group-description"
                aria-label={String(t("volunteering.groupFieldDescription"))}
              />
            </YStack>
            <YStack gap="$1">
              <Text variant="label">
                {String(t("volunteering.groupFieldCapacity"))}
              </Text>
              <TextInput
                value={capacity}
                onChangeText={setCapacity}
                inputMode="numeric"
                fullWidth
                minHeight={44}
                testId="volunteer-group-capacity"
                aria-label={String(t("volunteering.groupFieldCapacity"))}
              />
              {capacityError ? (
                <Text variant="caption" tone="error" role="alert">
                  {String(t("volunteering.capacityInvalid"))}
                </Text>
              ) : null}
            </YStack>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <XStack gap="$2" justifyContent="flex-end">
            <Button
              variant="ghost"
              onPress={onClose}
              disabled={createMutation.isPending}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              onPress={handleSubmit}
              disabled={createMutation.isPending || !name.trim()}
              data-testid="volunteer-group-submit"
            >
              {String(t("common.create"))}
            </Button>
          </XStack>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}
