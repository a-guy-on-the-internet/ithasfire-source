"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { YStack, XStack } from "tamagui";
import {
  DataTable,
  type DataTableColumn,
  Text,
  Button,
  Badge,
  useTranslations,
  useFormatters,
  useNotify,
} from "@th/ui";
import type { VolunteerSignupStatus } from "@th/types";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import {
  BulkActionBar,
  NoResults,
  Pagination,
} from "@/components/AdminTableParts";
import { usePageClamp } from "@/hooks/usePageClamp";
import { RewardStatusBadge } from "@/components/volunteering/RewardStatusBadge";
import { rewardStatusBySignup } from "@/components/volunteering/volunteering-helpers";

import { RejectSignupDialog } from "./RejectSignupDialog";
import {
  type BatchReviewResult,
  batchFailureKey,
  chunkIds,
  partitionBatchResults,
} from "./batch-review.helpers";

type SignupRow = {
  id: string;
  roleId: string;
  shiftId: string | null;
  contactEmail: string;
  contactName: string | null;
  contactPhone: string | null;
  status: VolunteerSignupStatus;
  createdAt: Date;
  checkedInAt: Date | null;
  hoursWorked: number | null;
  /**
   * When the volunteer accepted the event's waiver (Gap 3). Null for
   * signups submitted before the gate was enabled — a legitimate,
   * non-negative state that renders no chip.
   */
  waiverAcceptedAt: Date | null;
  notes: string | null;
  answers: unknown;
};

/** Compose a per-event hours CSV from a flat HoursReportRow array. */
function rowsToCsv(
  rows: ReadonlyArray<{
    contactName: string | null;
    contactEmail: string;
    roleName: string;
    shiftLabel: string | null;
    shiftStartsAt: Date | string | null;
    shiftEndsAt: Date | string | null;
    status: VolunteerSignupStatus;
    checkedInAt: Date | string | null;
    waiverAcceptedAt: Date | string | null;
    scheduledHours: number | null;
    actualHours: number | null;
    notes: string | null;
  }>,
): string {
  const header = [
    "name",
    "email",
    "role",
    "shift",
    "shift_starts_at",
    "shift_ends_at",
    "status",
    "checked_in_at",
    "waiver_accepted_at",
    "scheduled_hours",
    "actual_hours",
    "notes",
  ];
  // Always-quote every cell so values that contain commas, newlines,
  // or embedded quotes parse correctly in every CSV consumer
  // (Excel, Numbers, Sheets, Python csv). Quotes get RFC 4180
  // double-escaped.
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fmt = (v: Date | string | null | undefined) =>
    v == null ? "" : v instanceof Date ? v.toISOString() : v;
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        cell(r.contactName ?? ""),
        cell(r.contactEmail),
        cell(r.roleName),
        cell(r.shiftLabel ?? ""),
        cell(fmt(r.shiftStartsAt)),
        cell(fmt(r.shiftEndsAt)),
        cell(r.status),
        cell(fmt(r.checkedInAt)),
        cell(fmt(r.waiverAcceptedAt)),
        cell(r.scheduledHours == null ? "" : r.scheduledHours.toString()),
        cell(r.actualHours == null ? "" : r.actualHours.toString()),
        cell(r.notes ?? ""),
      ].join(","),
    );
  }
  // UTF-8 BOM so legacy Excel-on-Mac doesn't double-encode emoji /
  // accented names. Modern Sheets / Numbers strip it transparently.
  // \r\n line endings match RFC 4180.
  return "﻿" + lines.join("\r\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const extractAnswerNote = (answers: unknown): string | null => {
  if (!answers || typeof answers !== "object") return null;
  const note = (answers as Record<string, unknown>).note;
  return typeof note === "string" && note.trim() ? note.trim() : null;
};

type StatusFilter = VolunteerSignupStatus | "ALL";

const STATUS_OPTIONS: StatusFilter[] = [
  "ALL",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "CHECKED_IN",
  "NO_SHOW",
];

const STATUS_LABEL_KEY: Record<VolunteerSignupStatus, string> = {
  PENDING: "admin.volunteerSignupsStatusPending",
  APPROVED: "admin.volunteerSignupsStatusApproved",
  REJECTED: "admin.volunteerSignupsStatusRejected",
  WITHDRAWN: "admin.volunteerSignupsStatusWithdrawn",
  CHECKED_IN: "admin.volunteerSignupsStatusCheckedIn",
  NO_SHOW: "admin.volunteerSignupsStatusNoShow",
};

const STATUS_TONE: Record<
  VolunteerSignupStatus,
  "info" | "success" | "warning" | "danger" | "neutral"
> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  WITHDRAWN: "neutral",
  CHECKED_IN: "info",
  NO_SHOW: "neutral",
};

/** Reject dialog target: a single row, or the current batch selection. */
type RejectTarget = { kind: "single"; row: SignupRow } | { kind: "batch" };

/**
 * Button hover/press state with `color` grafted on: the public frame type
 * omits text props, but `color` in hover/press styles lands on the FRAME and
 * the label tracks it via `color: inherit` (see @th/ui Button.tsx). Keeping
 * every OTHER key checked is why this isn't an `as never`.
 *
 * NOTE: if a THIRD consumer needs this inverted-surface secondary, promote a
 * proper `secondaryInverted` ladder into @th/ui button-variants instead of
 * another local graft.
 */
type InvertedState = NonNullable<
  ComponentProps<typeof Button>["hoverStyle"]
> & { color?: string };

/** Secondary-on-ink ladder for the BulkActionBar's inverted fill: paper
 * outline at rest, paper fill + ink label on hover/press. */
const invertedSecondaryHover: InvertedState = {
  backgroundColor: "$onStructure",
  borderColor: "$onStructure",
  color: "$surfaceStrong",
};
const invertedSecondaryPress: InvertedState = {
  ...invertedSecondaryHover,
  scale: 0.98,
};

interface SignupsTabProps {
  eventId: string;
}

export function SignupsTab({ eventId }: SignupsTabProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();
  const utils = trpc.useUtils();

  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);

  // ── Paging ───────────────────────────────────────────────────────────
  // This query used to be sent with no `limit`, so the adapter applied
  // OFFSET_DEFAULT_LIMIT (25) and the tab rendered `items` while ignoring
  // `pageInfo.total` — signup 26 onward was unreachable, and "select all"
  // silently meant "select the first 25". Local state rather than
  // `useAdminTableParams`: this is still one of three sibling tabs behind a
  // single URL, so `?p=` would leak across them. Switch to the URL-synced
  // hook when the tab becomes its own route.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  // ── Bulk review state ────────────────────────────────────────────────
  // Selected signup ids (only PENDING rows are selectable).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // signupId → failure code from the last batch; rendered as an inline
  // marker on the row until the next successful action or filter change.
  const [batchFailures, setBatchFailures] = useState<Record<string, string>>(
    {},
  );
  // Spans the whole batch run (which may chunk into several mutations),
  // unlike `reviewBatchMutation.isPending` which flickers between chunks.
  const [batchPending, setBatchPending] = useState(false);
  // Synchronous double-submit guard. `batchPending` re-renders the UI,
  // but a second click in the same tick still sees the stale closure —
  // the ref flips immediately, so the second call bails.
  const batchRunningRef = useRef(false);

  // Selection and failure markers are scoped to the current filter view.
  // Persisting selection across filter changes invites "approve rows I
  // can no longer see" mistakes, so the simplest correct behavior is a
  // reset whenever the visible set changes wholesale.
  useEffect(() => {
    setSelectedIds(new Set());
    setBatchFailures({});
    // Same reasoning applies to the page: a filter change replaces the
    // visible set wholesale, so holding page 3 would strand the user on an
    // empty tail.
    setPage(0);
  }, [status, roleFilter]);

  const rolesQuery = trpc.volunteer.roles.list.useQuery({ eventId });
  const signupsQuery = trpc.volunteer.signups.list.useQuery({
    eventId,
    ...(status !== "ALL" ? { status } : {}),
    ...(roleFilter !== "ALL" ? { roleId: roleFilter } : {}),
    limit: pageSize,
    offset: page * pageSize,
  });

  // Comp-reward status per signup (volunteer-comp-tickets spec, FR-006).
  // Resolve the event's EVENT-subject ask, then read its reward ledger and
  // fold grants into a signupId → status map. The ledger is ORG_FINANCE_ROLES
  // gated server-side, so a non-finance viewer's ledger query 403s silently
  // (retry off, meta silent) and simply yields no badges — defense in depth.
  const askQuery = trpc.volunteer.asks.listBySubject.useQuery(
    { subjectType: "EVENT", subjectId: eventId },
    { staleTime: 30_000, retry: 1, meta: { silent: true } },
  );
  const rewardAskId = askQuery.data?.[0]?.id ?? null;
  const ledgerQuery = trpc.volunteer.rewards.ledger.useQuery(
    { askId: rewardAskId ?? "" },
    {
      enabled: Boolean(rewardAskId),
      staleTime: 15_000,
      retry: false,
      meta: { silent: true },
    },
  );
  const rewardStatusMap = useMemo(
    () => rewardStatusBySignup(ledgerQuery.data?.grants ?? []),
    [ledgerQuery.data],
  );
  const hasRewardData = rewardStatusMap.size > 0;

  const invalidateAll = () =>
    Promise.all([
      utils.volunteer.signups.list.invalidate(),
      utils.volunteer.signups.counts.invalidate(),
    ]);

  const approveMutation = trpc.volunteer.signups.review.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-signup-approved",
        title: String(t("admin.volunteerSignupsApproved")),
      });
      setBatchFailures({});
      void invalidateAll();
    },
    onError: (err) => {
      // Capacity counts only accepted (APPROVED | CHECKED_IN) signups, so
      // approving past capacity is the one place the server hard-stops.
      // There is no force flag — the admin's remedy is raising capacity.
      const code = getAppErrorCode(err);
      if (code === "SHIFT_FULL" || code === "ROLE_FULL") {
        notify.toast.danger({
          id: "volunteer-signup-action-failed",
          title: String(t("admin.volunteerSignupsCapacityFullTitle")),
          message: String(
            t(
              code === "ROLE_FULL"
                ? "admin.volunteerSignupsRoleFullBody"
                : "admin.volunteerSignupsShiftFullBody",
            ),
          ),
        });
        return;
      }
      notify.toast.danger({
        id: "volunteer-signup-action-failed",
        title: String(t("admin.volunteerSignupsActionFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const rejectMutation = trpc.volunteer.signups.review.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-signup-rejected",
        title: String(t("admin.volunteerSignupsRejected")),
      });
      setBatchFailures({});
      void invalidateAll();
      setRejectTarget(null);
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-signup-action-failed",
        title: String(t("admin.volunteerSignupsActionFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  /**
   * Admin hours-worked override. `null` value clears and reverts to
   * scheduled hours. Optimistic UI is overkill here — invalidating
   * the list query keeps things in sync once the mutation resolves.
   */
  const updateHoursMutation = trpc.volunteer.signups.updateHours.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-hours-updated",
        title: String(t("admin.volunteerSignupsHoursUpdated")),
      });
      void invalidateAll();
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-hours-update-failed",
        title: String(t("admin.volunteerSignupsHoursUpdateFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const utilsRef = utils;
  const handleExportHours = async () => {
    try {
      const result = await utilsRef.volunteer.signups.exportHours.fetch({
        eventId,
      });
      const csv = rowsToCsv(result.rows);
      const safeTitle =
        (result.eventTitle ?? "event")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "event";
      const filename = `volunteer-hours-${safeTitle}-${new Date().toISOString().slice(0, 10)}.csv`;
      downloadCsv(filename, csv);
    } catch (err) {
      notify.toast.danger({
        id: "volunteer-hours-export-failed",
        // Shared with the org-level hours view so the wording stays
        // identical between the two export surfaces.
        title: String(t("admin.volunteerHoursExportFailed")),
        message: formatErrorMessage(err),
      });
    }
  };

  const checkInMutation = trpc.volunteer.signups.checkIn.useMutation({
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-signup-checked-in",
        title: String(t("admin.volunteerSignupsCheckedIn")),
      });
      void invalidateAll();
    },
    onError: (err) => {
      notify.toast.danger({
        id: "volunteer-signup-action-failed",
        title: String(t("admin.volunteerSignupsActionFailed")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const rolesById = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        shifts: Array<{
          id: string;
          label: string | null;
          startsAt: Date;
          endsAt: Date;
        }>;
      }
    >();
    for (const r of roles) {
      map.set(r.id, {
        name: r.name,
        shifts: r.shifts.map((s) => ({
          id: s.id,
          label: s.label,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
        })),
      });
    }
    return map;
  }, [roles]);

  const rows: SignupRow[] = useMemo(() => {
    const result = signupsQuery.data;
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    return items.map((s) => ({
      id: s.id,
      roleId: s.roleId,
      shiftId: s.shiftId,
      contactEmail: s.contactEmail,
      contactName: s.contactName,
      contactPhone: s.contactPhone,
      status: s.status,
      createdAt: s.createdAt,
      checkedInAt: s.checkedInAt,
      hoursWorked: (s as { hoursWorked?: number | null }).hoursWorked ?? null,
      waiverAcceptedAt:
        (s as { waiverAcceptedAt?: Date | null }).waiverAcceptedAt ?? null,
      notes: s.notes,
      answers: s.answers,
    }));
  }, [signupsQuery.data]);

  // `Array.isArray` above tolerates a bare-array response; a paginated result
  // is the real contract, so the total comes off `pageInfo` and falls back to
  // the row count for the array shape.
  const totalSignups = useMemo(() => {
    const result = signupsQuery.data;
    if (!result || Array.isArray(result)) return rows.length;
    return result.pageInfo?.total ?? rows.length;
  }, [signupsQuery.data, rows.length]);
  const totalPages = Math.ceil(totalSignups / pageSize);

  // Approving the last row on the final page shrinks the set under our feet;
  // clamp back instead of stranding an empty table with the pager hidden.
  usePageClamp({
    page,
    totalPages,
    isFetching: signupsQuery.isFetching,
    setPage,
  });

  // The ids we'd actually submit: intersection of the selection with the
  // currently visible PENDING rows. Stale ids (row reviewed elsewhere,
  // refetch flipped its status) silently drop out instead of erroring.
  const selectedPendingIds = useMemo(
    () =>
      rows
        .filter((r) => r.status === "PENDING" && selectedIds.has(r.id))
        .map((r) => r.id),
    [rows, selectedIds],
  );

  const reviewBatchMutation = trpc.volunteer.signups.reviewBatch.useMutation({
    meta: { silent: true },
  });

  /**
   * Run a bulk review over the current selection. Partial success is
   * normal: the mutation resolves with per-id results. Succeeded ids are
   * deselected; failed ids stay selected (so the admin can raise capacity
   * and retry) and get an inline marker mapped from their failure code.
   */
  const runBatch = async (
    decision: "APPROVED" | "REJECTED",
    notes?: string | null,
  ) => {
    if (batchRunningRef.current) return;
    const ids = selectedPendingIds;
    if (ids.length === 0) {
      // Selection emptied out from under us (e.g. a refetch flipped the
      // rows out of PENDING while the reject dialog was open). Close the
      // dialog and say why instead of stranding it over an empty batch.
      setRejectTarget(null);
      notify.toast.info({
        id: "volunteer-signups-batch",
        title: String(t("admin.volunteerSignupsBatchSelectionEmpty")),
      });
      return;
    }
    batchRunningRef.current = true;
    setBatchPending(true);
    try {
      // The mutation accepts at most 100 ids per call — chunk larger
      // selections and merge the per-id results into one settled outcome.
      const results: BatchReviewResult[] = [];
      for (const chunk of chunkIds(ids)) {
        const res = await reviewBatchMutation.mutateAsync({
          signupIds: chunk,
          decision,
          notes: notes ?? null,
        });
        results.push(...res.results);
      }
      const { failedIds, okCount, failureById } =
        partitionBatchResults(results);
      if (failedIds.length === 0) {
        setBatchFailures({});
        setSelectedIds(new Set());
        notify.toast.success({
          id: "volunteer-signups-batch",
          title: String(
            t(
              decision === "APPROVED"
                ? "admin.volunteerSignupsBatchApproved"
                : "admin.volunteerSignupsBatchRejected",
              { count: okCount },
            ),
          ),
        });
      } else {
        // Failed ids stay selected so the admin can fix capacity and
        // retry; succeeded ids drop out of the selection.
        setBatchFailures(failureById);
        setSelectedIds(new Set(failedIds));
        notify.toast.warning({
          id: "volunteer-signups-batch",
          title: String(t("admin.volunteerSignupsBatchPartialTitle")),
          message: String(
            t("admin.volunteerSignupsBatchPartialBody", {
              ok: okCount,
              total: results.length,
            }),
          ),
        });
      }
    } catch (err) {
      // Whole-call failure (network, authz). Selection is left intact.
      notify.toast.danger({
        id: "volunteer-signup-action-failed",
        title: String(t("admin.volunteerSignupsActionFailed")),
        message: formatErrorMessage(err, t),
      });
    } finally {
      batchRunningRef.current = false;
      setBatchPending(false);
      setRejectTarget(null);
      void invalidateAll();
    }
  };

  const columns: Array<DataTableColumn<SignupRow>> = [
    {
      id: "volunteer",
      header: String(t("admin.volunteerSignupsVolunteerColumn")),
      width: 3,
      cell: (row) => (
        <YStack gap="$1">
          <Text variant="body" style={{ fontWeight: 600 }}>
            {row.contactName ?? row.contactEmail}
          </Text>
          {row.contactName ? (
            <Text variant="caption" tone="muted">
              {row.contactEmail}
            </Text>
          ) : null}
          {row.contactPhone ? (
            <Text variant="caption" tone="muted">
              {row.contactPhone}
            </Text>
          ) : null}
        </YStack>
      ),
      sortValue: (row) => (row.contactName ?? row.contactEmail).toLowerCase(),
    },
    {
      id: "role",
      header: String(t("admin.volunteerSignupsRoleColumn")),
      width: 2,
      cell: (row) => {
        const role = rolesById.get(row.roleId);
        return <Text variant="body">{role?.name ?? "—"}</Text>;
      },
      sortValue: (row) => rolesById.get(row.roleId)?.name?.toLowerCase() ?? "",
    },
    {
      id: "shift",
      header: String(t("admin.volunteerSignupsShiftColumn")),
      width: 3,
      cell: (row) => {
        if (!row.shiftId) {
          return (
            <Text variant="body" tone="muted">
              {String(t("admin.volunteerSignupsNoShift"))}
            </Text>
          );
        }
        const role = rolesById.get(row.roleId);
        const shift = role?.shifts.find((s) => s.id === row.shiftId);
        if (!shift) {
          return <Text variant="body">{row.shiftId.slice(0, 8)}</Text>;
        }
        return (
          <YStack gap="$1">
            {shift.label ? (
              <Text variant="body" style={{ fontWeight: 600 }}>
                {shift.label}
              </Text>
            ) : null}
            <Text variant="caption" tone="muted">
              {fmt.dateTime(shift.startsAt, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Text>
          </YStack>
        );
      },
      sortValue: (row) => {
        if (!row.shiftId) return "";
        const role = rolesById.get(row.roleId);
        const shift = role?.shifts.find((s) => s.id === row.shiftId);
        return shift?.startsAt ?? "";
      },
    },
    {
      id: "status",
      header: String(t("admin.volunteerSignupsStatusColumn")),
      width: 2,
      cell: (row) => (
        <YStack gap="$1" alignItems="flex-start">
          <Badge tone={STATUS_TONE[row.status]} size="sm">
            {String(t(STATUS_LABEL_KEY[row.status]))}
          </Badge>
          {row.status === "CHECKED_IN" && row.checkedInAt ? (
            <Text variant="caption" tone="muted">
              {fmt.dateTime(row.checkedInAt, { timeStyle: "short" })}
            </Text>
          ) : null}
          {/* Waiver acceptance chip (Gap 3). Only the positive state is
              rendered — pre-gate signups are legitimately waiver-less, so
              null gets no chip rather than a negative marker. Plain span
              wrapper carries the native title tooltip with the date. */}
          {row.waiverAcceptedAt ? (
            <span
              title={String(
                t("admin.volunteerSignupsWaiverAcceptedTooltip", {
                  date: fmt.dateTime(row.waiverAcceptedAt, {
                    dateStyle: "medium",
                  }),
                }),
              )}
              data-testid={`volunteer-signup-waiver-chip-${row.id}`}
            >
              <Badge tone="neutral" size="sm">
                {String(t("admin.volunteerSignupsWaiverChip"))}
              </Badge>
            </span>
          ) : null}
          {/* Plain visible text on purpose — no role="alert". A large
              partial failure would otherwise inject dozens of identical
              live regions at once and flood screen readers. The partial-
              failure toast is the single announced channel. */}
          {batchFailures[row.id] ? (
            <Text variant="caption" tone="error">
              {String(t(batchFailureKey(batchFailures[row.id])))}
            </Text>
          ) : null}
        </YStack>
      ),
      sortValue: (row) => row.status,
    },
    // Comp-reward status — only present when the event has reward grants
    // (finance viewers). Non-finance viewers never receive ledger data, so
    // the column stays hidden rather than showing empty cells.
    ...(hasRewardData
      ? [
          {
            id: "reward",
            header: String(t("admin.volunteerSignupsRewardColumn")),
            width: 1.5,
            cell: (row: SignupRow) => {
              const rewardStatus = rewardStatusMap.get(row.id) ?? null;
              if (!rewardStatus) {
                return (
                  <Text variant="body" tone="muted">
                    —
                  </Text>
                );
              }
              return (
                <RewardStatusBadge
                  status={rewardStatus}
                  testIdSuffix={row.id}
                />
              );
            },
          } satisfies DataTableColumn<SignupRow>,
        ]
      : []),
    {
      id: "hours",
      header: String(t("admin.volunteerSignupsHoursColumn")),
      width: 1.5,
      cell: (row) => {
        // Hours are only meaningful once we've decided the volunteer
        // actually showed up (or pre-committed): hide the Edit
        // affordance for PENDING / REJECTED / WITHDRAWN / NO_SHOW so
        // admins don't accidentally record hours on a non-event.
        const isHoursActionable =
          row.status === "CHECKED_IN" || row.status === "APPROVED";
        const role = rolesById.get(row.roleId);
        const shift = row.shiftId
          ? role?.shifts.find((s) => s.id === row.shiftId)
          : null;
        const rawScheduled =
          shift?.startsAt && shift?.endsAt
            ? (shift.endsAt.getTime() - shift.startsAt.getTime()) / 3_600_000
            : null;
        // Clamp negative durations defensively — a misconfigured
        // shift with endsAt < startsAt should not surface as a
        // negative hours-worked default in the prompt or CSV.
        const scheduled =
          rawScheduled == null
            ? null
            : Number(Math.max(0, rawScheduled).toFixed(2));
        const display = row.hoursWorked ?? scheduled;
        if (!isHoursActionable) {
          return (
            <Text variant="body" tone="muted">
              —
            </Text>
          );
        }
        return (
          <XStack gap="$2" alignItems="center">
            <Text variant="body">{display == null ? "—" : `${display}h`}</Text>
            <Button
              size="$2"
              variant="secondary"
              onPress={() => {
                // Lightweight prompt() instead of a dialog component
                // for v1. The set-by-shift-duration default fills in
                // the current value so the admin can nudge it.
                const next = window.prompt(
                  String(
                    t("admin.volunteerSignupsHoursPrompt", {
                      name: row.contactName ?? row.contactEmail,
                      scheduled: scheduled ?? "—",
                    }),
                  ),
                  row.hoursWorked == null ? "" : String(row.hoursWorked),
                );
                if (next === null) return; // cancelled
                const trimmed = next.trim();
                if (trimmed === "") {
                  updateHoursMutation.mutate({
                    signupId: row.id,
                    hoursWorked: null,
                  });
                  return;
                }
                const parsed = Number(trimmed);
                if (!Number.isFinite(parsed) || parsed < 0 || parsed > 99) {
                  notify.toast.danger({
                    id: "volunteer-hours-invalid",
                    title: String(t("admin.volunteerSignupsHoursInvalid")),
                  });
                  return;
                }
                updateHoursMutation.mutate({
                  signupId: row.id,
                  hoursWorked: Number(parsed.toFixed(2)),
                });
              }}
              testID={`volunteer-edit-hours-${row.id}`}
            >
              {String(t("admin.volunteerSignupsHoursEdit"))}
            </Button>
          </XStack>
        );
      },
    },
    {
      id: "submitted",
      header: String(t("admin.volunteerSignupsSubmittedColumn")),
      width: 2,
      cell: (row) => (
        <Text variant="body">
          {fmt.dateTime(row.createdAt, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </Text>
      ),
      sortValue: (row) => row.createdAt,
    },
    {
      id: "notes",
      header: String(t("admin.volunteerSignupsNotesColumn")),
      width: 3,
      cell: (row) => {
        const volunteerNote = extractAnswerNote(row.answers);
        const adminNote = row.notes;
        if (!volunteerNote && !adminNote) {
          return (
            <Text variant="caption" tone="muted">
              —
            </Text>
          );
        }
        return (
          <YStack gap="$1">
            {volunteerNote ? (
              <Text variant="caption">{volunteerNote}</Text>
            ) : null}
            {adminNote ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.volunteerSignupsAdminNotePrefix"))} {adminNote}
              </Text>
            ) : null}
          </YStack>
        );
      },
    },
  ];

  const isLoading = signupsQuery.isLoading || rolesQuery.isLoading;
  const statusFilterId = "volunteer-signups-status-filter";
  const roleFilterId = "volunteer-signups-role-filter";

  // These two were the only 1px-bordered controls on the surface — every other
  // box here (table, bulk bar, pagination's rows-per-page select) is the DS's
  // 2px rule, so the filters read as a lighter, differently-padded species
  // sitting right above a heavy table. One shared style keeps them in family.
  const filterSelectStyle: React.CSSProperties = {
    minHeight: 44,
    padding: "8px 12px",
    fontSize: 16,
    borderRadius: 0,
    border: "2px solid var(--borderColor, #211C16)",
    background: "var(--surface, #FDFAF3)",
    color: "var(--color, #211C16)",
  };

  return (
    <YStack gap="$4">
      {/* Filters */}
      <XStack
        gap="$3"
        flexWrap="wrap"
        alignItems="flex-end"
        justifyContent="space-between"
      >
        <XStack gap="$3" flexWrap="wrap" alignItems="center">
          <YStack gap="$1" minWidth={180}>
            <label htmlFor={statusFilterId}>
              <Text variant="label" tone="muted">
                {String(t("admin.volunteerSignupsFilterStatus"))}
              </Text>
            </label>
            <select
              id={statusFilterId}
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              data-testid="volunteer-signups-filter-status"
              style={filterSelectStyle}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === "ALL"
                    ? String(t("admin.volunteerSignupsFilterAll"))
                    : String(t(STATUS_LABEL_KEY[s]))}
                </option>
              ))}
            </select>
          </YStack>

          <YStack gap="$1" minWidth={180}>
            <label htmlFor={roleFilterId}>
              <Text variant="label" tone="muted">
                {String(t("admin.volunteerSignupsFilterRole"))}
              </Text>
            </label>
            <select
              id={roleFilterId}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              data-testid="volunteer-signups-filter-role"
              style={filterSelectStyle}
            >
              <option value="ALL">
                {String(t("admin.volunteerSignupsFilterAllRoles"))}
              </option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </YStack>
        </XStack>
        {/* Hours-report CSV download — grant/board reporting use case. */}
        <Button
          size="$3"
          variant="secondary"
          onPress={() => void handleExportHours()}
          testID="volunteer-export-hours-csv"
        >
          {String(t("admin.volunteerSignupsExportHoursCsv"))}
        </Button>
      </XStack>

      {/* Bulk review bar — visible while at least one PENDING row is
          selected. APPROVE stays the table's sole primary (v2 one-primary
          rule; reviewer ruling 2026-07-14 — see rowActions below). */}
      <BulkActionBar
        count={selectedPendingIds.length}
        onClear={() => setSelectedIds(new Set())}
        testId="volunteer-signups-bulk-bar"
      >
        <Button
          variant="primary"
          size="$2"
          minHeight={44}
          onPress={() => void runBatch("APPROVED")}
          disabled={batchPending}
          testID="volunteer-signups-approve-selected"
        >
          {String(
            t("admin.volunteerSignupsApproveSelected", {
              count: selectedPendingIds.length,
            }),
          )}
        </Button>
        <Button
          variant="secondary"
          size="$2"
          minHeight={44}
          // Still the secondary action — but secondary's ink outline is
          // invisible on the bar's ink fill, so its ladder re-points at the
          // bar's foreground token (paper outline, paper-fill inversion).
          borderColor="$onStructure"
          color="$onStructure"
          // `color` in hover/press styles lands on the FRAME and the label
          // tracks it via `color: inherit` (see Button.tsx) — InvertedState
          // (above) grafts just that key on so the rest stays type-checked.
          hoverStyle={invertedSecondaryHover}
          pressStyle={invertedSecondaryPress}
          onPress={() => setRejectTarget({ kind: "batch" })}
          disabled={batchPending}
          testID="volunteer-signups-reject-selected"
        >
          {String(
            t("admin.volunteerSignupsRejectSelected", {
              count: selectedPendingIds.length,
            }),
          )}
        </Button>
      </BulkActionBar>

      {/* Scoped horizontal scroll: the HTML table collapses into a
          one-character-per-line mess below ~760px, so phones swipe the
          table sideways INSIDE this container while the page itself
          stays put. Filters + bulk bar live outside, full width. */}
      <div
        data-testid="volunteer-signups-table-scroll"
        style={{
          maxWidth: "100%",
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div style={{ minWidth: 800 }}>
          <DataTable<SignupRow>
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            isLoading={isLoading}
            clientSort
            selectable={{
              selectedKeys: selectedIds,
              onSelectionChange: setSelectedIds,
              // Only PENDING signups are reviewable — other statuses get no
              // checkbox at all.
              isRowSelectable: (row) => row.status === "PENDING",
              disabled: batchPending,
              selectAllLabel: String(t("admin.volunteerSignupsSelectAllAria")),
              getRowLabel: (row) =>
                String(
                  t("admin.volunteerSignupsSelectRowAria", {
                    name: row.contactName ?? row.contactEmail,
                  }),
                ),
              // 24px boxes — the default 16px is too small a touch target.
              checkboxSize: "lg",
            }}
            testIdBase="volunteer-signups-table"
            emptyState={
              <NoResults
                title={String(t("admin.volunteerSignupsEmptyTitle"))}
                description={String(
                  t("admin.volunteerSignupsEmptyDescription"),
                )}
              />
            }
            rowActions={{
              header: String(t("admin.volunteerSignupsActionsColumn")),
              width: 3,
              render: (row) => (
                <XStack gap="$2" flexWrap="wrap" justifyContent="flex-end">
                  {row.status === "PENDING" ? (
                    <>
                      {/* Per-row actions are secondary — the table is one
                          region, and the bulk bar holds its sole primary
                          (v2 one-primary rule; reviewer ruling 2026-07-14). */}
                      <Button
                        variant="secondary"
                        size="$2"
                        onPress={() =>
                          approveMutation.mutate({
                            signupId: row.id,
                            decision: "APPROVED",
                          })
                        }
                        disabled={approveMutation.isPending || batchPending}
                      >
                        {String(t("admin.volunteerSignupsApprove"))}
                      </Button>
                      <Button
                        variant="secondary"
                        size="$2"
                        onPress={() => setRejectTarget({ kind: "single", row })}
                        disabled={batchPending}
                      >
                        {String(t("admin.volunteerSignupsReject"))}
                      </Button>
                    </>
                  ) : null}
                  {row.status === "APPROVED" ? (
                    <Button
                      variant="secondary"
                      size="$2"
                      onPress={() =>
                        checkInMutation.mutate({ signupId: row.id })
                      }
                      disabled={checkInMutation.isPending}
                    >
                      {String(t("admin.volunteerSignupsCheckIn"))}
                    </Button>
                  ) : null}
                </XStack>
              ),
            }}
          />
        </div>
      </div>

      {/* Pager sits OUTSIDE the horizontal table scroller so it stays put
          while a narrow viewport swipes the table sideways. Its range label
          ("Rows 1–25 of 60") is also what finally tells the organizer the set
          is bigger than the page. */}
      <Pagination
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={(next) => {
          setPageSize(next);
          setPage(0);
        }}
        total={totalSignups}
      />

      <RejectSignupDialog
        open={rejectTarget !== null}
        pending={
          rejectTarget?.kind === "batch"
            ? batchPending
            : rejectMutation.isPending
        }
        title={
          rejectTarget?.kind === "batch"
            ? String(
                t("admin.volunteerSignupsRejectBatchDialogTitle", {
                  count: selectedPendingIds.length,
                }),
              )
            : undefined
        }
        confirmLabel={
          rejectTarget?.kind === "batch"
            ? String(
                t("admin.volunteerSignupsRejectBatchConfirmCta", {
                  count: selectedPendingIds.length,
                }),
              )
            : undefined
        }
        onCancel={() => setRejectTarget(null)}
        onConfirm={(notes) => {
          if (!rejectTarget) return;
          if (rejectTarget.kind === "batch") {
            // One reason applied to every signup in the batch. runBatch
            // closes the dialog when the run settles.
            void runBatch("REJECTED", notes || null);
            return;
          }
          rejectMutation.mutate({
            signupId: rejectTarget.row.id,
            decision: "REJECTED",
            notes: notes || null,
          });
        }}
      />
    </YStack>
  );
}
