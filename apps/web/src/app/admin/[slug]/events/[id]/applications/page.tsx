"use client";

import { use, useCallback, useMemo, useRef, useState } from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  CharCountTextarea,
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
  Text,
  Button,
  Badge,
  Spinner,
  useNotify,
} from "@th/ui";
import {
  Check,
  XCircle,
  Undo2,
  ChevronDown,
  ChevronUp,
  Hourglass,
} from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";

import { trpc } from "@/trpc";
import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate } from "@/lib/format";
import { useTranslations, useFormatters } from "@th/ui";
import {
  ActionBar,
  AdminTableErrorState,
  FilterChips,
  FilterRow,
  SearchBar,
  TableContainer,
} from "@/components/AdminTableParts";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { EventOpsShell } from "../_components/EventOpsShell";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SubmissionStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "WAITLISTED"
  | "WITHDRAWN"
  | "EXPIRED";

/**
 * Statuses that represent an ORGANIZER decision and are therefore
 * rescindable. WITHDRAWN (the applicant's own action) and EXPIRED (the
 * nightly sweep) are NOT: `rescindEventApplicationDecision` rejects both
 * with INVALID_STATUS, so offering the button would be a guaranteed error
 * toast.
 */
const RESCINDABLE_STATUSES = new Set<SubmissionStatus>([
  "APPROVED",
  "REJECTED",
  "WAITLISTED",
]);

/**
 * One question as captured into `questionsSnapshot` at submit time.
 * `type` is deliberately loose (`string`, not the enum) — the row only needs
 * the label here, and a loose type keeps this page tolerant of future
 * question kinds without a lockstep edit.
 */
interface QuestionSnapshotEntry {
  label: string;
  type: string;
  options?: { id: string; label: string }[];
  /**
   * The question's form position at submit time. Optional: legacy snapshots
   * (captured before the field existed) lack it.
   */
  order?: number;
}

interface SubmissionRow {
  id: string;
  eventId: string;
  humanId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: SubmissionStatus;
  answers: Record<string, unknown>;
  questionsSnapshot: Record<string, QuestionSnapshotEntry>;
  decisionReason: string | null;
  reviewerHumanId: string | null;
  reviewedAt: Date | null;
  approvalToken: string | null;
  tokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Server cap on the optional rejection note (review input schema). */
const REJECT_REASON_MAX_LENGTH = 500;

const FILTER_OPTION_VALUES = [
  "PENDING",
  "APPROVED",
  "WAITLISTED",
  "REJECTED",
  "WITHDRAWN",
  "EXPIRED",
] as const satisfies readonly SubmissionStatus[];

// No `ALL` entry: there is no "All" chip to label (the default scope is the
// absence of a selection), and the other index site is a
// `statusFilter !== "ALL"` branch where TS has already narrowed it away.
// Keyed by SubmissionStatus rather than `string` so a future gap is a type
// error instead of an `undefined` handed to `t()`.
//
// CHIP labels only. Spanish declines these as PLURALS ("Aprobadas"), which
// is right on a filter chip covering a set and wrong on one row's badge —
// hence the separate singular map below. Do not merge the two.
const STATUS_FILTER_KEYS: Record<SubmissionStatus, string> = {
  PENDING: "admin.filterPending",
  APPROVED: "admin.filterApproved",
  REJECTED: "admin.filterRejected",
  WAITLISTED: "admin.filterWaitlisted",
  WITHDRAWN: "admin.filterWithdrawn",
  EXPIRED: "admin.filterExpired",
};

/** SINGULAR labels for a single row's status badge (see note above). */
const STATUS_BADGE_KEYS: Record<SubmissionStatus, string> = {
  PENDING: "admin.statusBadgePending",
  APPROVED: "admin.statusBadgeApproved",
  REJECTED: "admin.statusBadgeRejected",
  WAITLISTED: "admin.statusBadgeWaitlisted",
  WITHDRAWN: "admin.statusBadgeWithdrawn",
  EXPIRED: "admin.statusBadgeExpired",
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled layout
// ─────────────────────────────────────────────────────────────────────────────

const ExpandedAnswers = styled(YStack, {
  name: "ExpandedAnswers",
  padding: "$3",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  gap: "$2",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getStatusBadgeTone(
  status: SubmissionStatus,
): "info" | "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "PENDING":
      return "info";
    case "APPROVED":
      return "success";
    case "WAITLISTED":
      return "warning";
    case "REJECTED":
      return "danger";
    // Neither an approval nor a refusal — the applicant left (WITHDRAWN) or
    // the window closed on them (EXPIRED). Neutral, not danger.
    case "WITHDRAWN":
    case "EXPIRED":
      return "neutral";
  }
}

interface AnswerEntryDisplay {
  questionId: string;
  label: string;
  value: unknown;
}

// Rank bands for answer ordering: snapshot `order` first (0..), then the
// live form's order, then snapshot key position, then answers key position.
const LIVE_ORDER_RANK_BASE = 1_000_000;
const SNAPSHOT_POSITION_RANK_BASE = 2_000_000;
const UNKNOWN_RANK_BASE = 3_000_000;

/**
 * Resolve each answer's heading and the render order.
 *
 * Label: `questionsSnapshot[id].label` (submit-time truth) → live form
 * question label (pre-snapshot submissions, whose snapshot is `{}`) → the raw
 * question id as last resort.
 *
 * Order: `questionsSnapshot` is a Postgres `jsonb` column, and jsonb does
 * NOT preserve object key order — keys come back bytewise-sorted, and since
 * every key is a same-length UUID that means UUID-lex order, not form order
 * (`answers` is jsonb too, so ITS key order is equally meaningless). So rank
 * by the snapshot entry's explicit `order` field (submit-time truth) first;
 * legacy entries without one fall back to the live form's `order`; snapshot
 * key position and answers key position are stable-but-arbitrary last
 * resorts.
 */
function buildAnswerEntries(
  answers: Record<string, unknown>,
  snapshot: Record<string, QuestionSnapshotEntry>,
  liveQuestions: ReadonlyMap<string, { label: string; order: number }>,
): AnswerEntryDisplay[] {
  const snapshotPosition = new Map(
    Object.keys(snapshot).map((id, index) => [id, index] as const),
  );
  return Object.entries(answers)
    .map(([questionId, value], index) => {
      const entry = snapshot[questionId];
      const live = liveQuestions.get(questionId);
      const snapshotIndex = snapshotPosition.get(questionId);
      const rank =
        entry?.order !== undefined
          ? entry.order
          : live
            ? LIVE_ORDER_RANK_BASE + live.order
            : snapshotIndex !== undefined
              ? SNAPSHOT_POSITION_RANK_BASE + snapshotIndex
              : UNKNOWN_RANK_BASE + index;
      return {
        questionId,
        label: entry?.label ?? live?.label ?? questionId,
        value,
        rank,
        index,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ questionId, label, value }) => ({ questionId, label, value }));
}

/**
 * MULTI_CHOICE answers arrive as arrays of the chosen option TEXT (the gate
 * component submits option labels, not ids) — join them at this table's
 * density rather than `String(value)`'s bare comma-join. Scalars pass
 * through; blank/absent renders an em dash.
 */
function formatAnswerValue(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : String(item)))
      .filter((item) => item.trim().length > 0);
    return parts.length > 0 ? parts.join(" · ") : "—";
  }
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

export default function EventApplicationsPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  // Only the load flag is needed: the surface no longer renders the event's
  // own title (the admin rail owns "which event"), so there is nothing here
  // that depends on the resolved owner.
  const { isLoading: ownerLoading } = useCurrentAdminOwner(slug);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  // State
  const [searchText, setSearchText] = useState("");
  const debouncedQuery = useDebouncedValue(searchText.trim(), 300);
  const [statusFilter, setStatusFilter] = useState<SubmissionStatus | "ALL">(
    "ALL",
  );
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [sort, setSort] = useState<DataTableSortState>({
    columnId: "createdAt",
    direction: "desc",
  });
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  // Reject-with-reason composer: which row's composer is open + its draft.
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  // Waitlist confirm: which row is awaiting confirmation. NO reason field —
  // the server's superRefine rejects `decisionReason` on WAITLISTED, and the
  // applicant's waitlist notification is deliberately neutral.
  const [waitlistTargetId, setWaitlistTargetId] = useState<string | null>(null);

  // i18n
  const t = useTranslations();
  const fmt = useFormatters();

  // Mutations
  const reviewMutation =
    trpc.events.reviewEventApplicationSubmission.useMutation();
  const rescindMutation =
    trpc.events.rescindEventApplicationDecision.useMutation();

  // Fetch submissions
  const submissionsQuery = trpc.events.listEventApplicationSubmissions.useQuery(
    {
      eventId,
      statuses: statusFilter === "ALL" ? undefined : [statusFilter],
      limit: 200,
      offset: 0,
    },
    {
      staleTime: 15_000,
      placeholderData: keepPreviousData,
    },
  );

  // Live form questions — the label fallback for PRE-SNAPSHOT submissions
  // (their `questionsSnapshot` is `{}`) and the order fallback when the
  // snapshot can't rank an answer. Best-effort: nothing here gates on it; a
  // failed/loading form just means those old rows show raw ids briefly.
  const formQuery = trpc.events.getApplicationForm.useQuery(
    { eventId },
    { staleTime: 60_000 },
  );

  const liveQuestionMeta = useMemo(() => {
    const map = new Map<string, { label: string; order: number }>();
    for (const question of formQuery.data?.questions ?? []) {
      map.set(question.id, { label: question.label, order: question.order });
    }
    return map;
  }, [formQuery.data?.questions]);

  // Filter + sort
  const sortedRows = useMemo(() => {
    const items = submissionsQuery.data?.submissions;
    if (!items?.length) return [];

    let rows: SubmissionRow[] = items.map((item) => ({
      ...item,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
      reviewedAt: item.reviewedAt ? new Date(item.reviewedAt) : null,
      tokenExpiresAt: item.tokenExpiresAt
        ? new Date(item.tokenExpiresAt)
        : null,
    }));

    // Client-side search on email
    if (debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.contactEmail?.toLowerCase().includes(q) ||
          r.contactPhone?.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q),
      );
    }

    const { columnId, direction } = sort;
    const multiplier = direction === "asc" ? 1 : -1;

    rows.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (columnId) {
        case "contactEmail":
          aVal = (a.contactEmail ?? "").toLowerCase();
          bVal = (b.contactEmail ?? "").toLowerCase();
          break;
        case "status":
          aVal = a.status;
          bVal = b.status;
          break;
        case "createdAt":
          aVal = a.createdAt.getTime();
          bVal = b.createdAt.getTime();
          break;
        default:
          return 0;
      }

      if (aVal < bVal) return -1 * multiplier;
      if (aVal > bVal) return 1 * multiplier;
      return 0;
    });

    return rows;
  }, [submissionsQuery.data?.submissions, sort, debouncedQuery]);

  // ─── Actions ───────────────────────────────────────────────────────

  /**
   * The ONE recovery path, shared by `FilterRow` and the empty state.
   *
   * Deliberately not two handlers. A query-only clear leaves an active status
   * chip behind, so pressing the empty state's button on
   * `REJECTED + "foo"`-with-no-rejections emptied the query, left the table
   * just as empty, and then hid the button (the render was gated on
   * `isSearching`) — the user pressed the recovery affordance and was left
   * with no way out. AttendeesTab documents the same trap.
   */
  const handleClearAll = useCallback(() => {
    setSearchText("");
    setStatusFilter("ALL");
    searchInputRef.current?.focus();
  }, []);

  const handleApprove = useCallback(
    async (submissionId: string) => {
      setActionInFlight(submissionId);
      try {
        await reviewMutation.mutateAsync({
          eventId,
          submissionId,
          decision: "APPROVED",
        });
        // Approving a row whose reject composer is open closes the composer —
        // otherwise a stale "Reject application" confirm would sit under a
        // now-approved row.
        if (rejectTargetId === submissionId) {
          setRejectTargetId(null);
          setRejectReason("");
        }
        toast.success({
          id: `approve-${submissionId}`,
          title: t("admin.applicationApproved") as string,
          message: t("admin.applicationApprovedMessage") as string,
        });
        await utils.events.listEventApplicationSubmissions.invalidate();
      } catch (err) {
        toast.danger({
          id: `approve-error-${submissionId}`,
          title: t("admin.failedToApprove") as string,
          message: formatErrorMessage(err, t),
        });
      } finally {
        setActionInFlight(null);
      }
    },
    [eventId, rejectTargetId, reviewMutation, toast, utils, t],
  );

  const handleReject = useCallback(
    async (submissionId: string, reason: string) => {
      setActionInFlight(submissionId);
      try {
        const trimmed = reason.trim();
        await reviewMutation.mutateAsync({
          eventId,
          submissionId,
          decision: "REJECTED",
          // Only ever sent on REJECTED (the server's superRefine rejects it
          // on APPROVED), and only when there is content — never an empty
          // string.
          ...(trimmed.length > 0 ? { decisionReason: trimmed } : {}),
        });
        setRejectTargetId(null);
        setRejectReason("");
        toast.info({
          id: `reject-${submissionId}`,
          title: t("admin.applicationRejected") as string,
          message: t("admin.applicationRejectedMessage") as string,
        });
        await utils.events.listEventApplicationSubmissions.invalidate();
      } catch (err) {
        // Composer stays open on failure so the typed reason isn't lost.
        toast.danger({
          id: `reject-error-${submissionId}`,
          title: t("admin.failedToReject") as string,
          message: formatErrorMessage(err, t),
        });
      } finally {
        setActionInFlight(null);
      }
    },
    [eventId, reviewMutation, toast, utils, t],
  );

  /** Open (or toggle closed) the reject-reason composer for a row. */
  const toggleRejectComposer = useCallback((rowId: string) => {
    setRejectTargetId((prev) => (prev === rowId ? null : rowId));
    setRejectReason("");
  }, []);

  const handleWaitlist = useCallback(
    async (submissionId: string) => {
      setActionInFlight(submissionId);
      try {
        // No `decisionReason` key, ever — the server's superRefine rejects
        // it for any decision other than REJECTED.
        await reviewMutation.mutateAsync({
          eventId,
          submissionId,
          decision: "WAITLISTED",
        });
        setWaitlistTargetId(null);
        // A waitlisted row's reject composer would otherwise sit open under
        // a now-decided row.
        if (rejectTargetId === submissionId) {
          setRejectTargetId(null);
          setRejectReason("");
        }
        toast.info({
          id: `waitlist-${submissionId}`,
          title: t("admin.applicationWaitlisted") as string,
          message: t("admin.applicationWaitlistedMessage") as string,
        });
        await utils.events.listEventApplicationSubmissions.invalidate();
      } catch (err) {
        setWaitlistTargetId(null);
        toast.danger({
          id: `waitlist-error-${submissionId}`,
          title: t("admin.failedToWaitlist") as string,
          message: formatErrorMessage(err, t),
        });
      } finally {
        setActionInFlight(null);
      }
    },
    [eventId, rejectTargetId, reviewMutation, toast, utils, t],
  );

  const handleRescind = useCallback(
    async (submissionId: string) => {
      setActionInFlight(submissionId);
      try {
        await rescindMutation.mutateAsync({
          eventId,
          submissionId,
        });
        toast.info({
          id: `rescind-${submissionId}`,
          title: t("admin.decisionRescinded") as string,
          message: t("admin.decisionRescindedMessage") as string,
        });
        await utils.events.listEventApplicationSubmissions.invalidate();
      } catch (err) {
        toast.danger({
          id: `rescind-error-${submissionId}`,
          title: t("admin.failedToRescind") as string,
          message: formatErrorMessage(err, t),
        });
      } finally {
        setActionInFlight(null);
      }
    },
    [eventId, rescindMutation, toast, utils, t],
  );

  const toggleExpand = useCallback((rowId: string) => {
    setExpandedRowId((prev) => (prev === rowId ? null : rowId));
  }, []);

  // ─── Columns ───────────────────────────────────────────────────────

  const columns: DataTableColumn<SubmissionRow>[] = useMemo(
    () => [
      {
        id: "contactEmail",
        header: String(t("admin.applicantColumn")),
        width: 2.5,
        // Stacked cell (name + phone + inline expanded answers): opt out of
        // the DataTable's whole-cell nowrap/ellipsis wrapper so the expanded
        // answers block can wrap; the name line truncates itself below.
        truncate: false,
        cell: (row) => {
          const isExpanded = expandedRowId === row.id;
          const answerEntries = buildAnswerEntries(
            row.answers,
            row.questionsSnapshot,
            liveQuestionMeta,
          );
          const rejectionReason =
            row.status === "REJECTED" ? row.decisionReason : null;
          return (
            <YStack gap={4}>
              <YStack gap={2}>
                <Text variant="body" weight="bold" truncate>
                  {row.contactEmail ||
                    row.contactPhone ||
                    String(t("admin.anonymous"))}
                </Text>
                {row.contactEmail && row.contactPhone && (
                  <Text variant="caption" tone="muted">
                    {row.contactPhone}
                  </Text>
                )}
              </YStack>
              {isExpanded && (answerEntries.length > 0 || rejectionReason) && (
                <ExpandedAnswers>
                  {answerEntries.map((entry) => (
                    <YStack key={entry.questionId} gap={2}>
                      <Text variant="overline" tone="muted">
                        {entry.label}
                      </Text>
                      {/* pre-wrap keeps LONG_TEXT paragraph breaks;
                          overflowWrap breaks applicant-controlled unbroken
                          tokens (URLs, 500-char no-space strings) that
                          pre-wrap alone would let force horizontal panning. */}
                      <Text
                        variant="body"
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {formatAnswerValue(entry.value)}
                      </Text>
                    </YStack>
                  ))}
                  {rejectionReason && (
                    <YStack
                      gap={2}
                      marginTop="$2"
                      paddingTop="$2"
                      borderTopWidth={1}
                      borderTopColor="$borderColor"
                    >
                      <Text variant="overline" tone="muted">
                        {String(t("admin.applicationRejectionReason"))}
                      </Text>
                      <Text
                        variant="body"
                        tone="muted"
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {rejectionReason}
                      </Text>
                    </YStack>
                  )}
                  {row.reviewedAt && (
                    <YStack
                      gap={2}
                      marginTop="$2"
                      paddingTop="$2"
                      borderTopWidth={1}
                      borderTopColor="$borderColor"
                    >
                      <Text variant="caption" tone="muted">
                        {String(
                          t("admin.reviewedAt", {
                            date: fmtDate(fmt, row.reviewedAt),
                          }),
                        )}
                      </Text>
                    </YStack>
                  )}
                </ExpandedAnswers>
              )}
            </YStack>
          );
        },
      },
      {
        id: "status",
        header: String(t("admin.statusColumn")),
        width: 1,
        cell: (row) => (
          <Badge tone={getStatusBadgeTone(row.status)} size="sm">
            {/* SINGULAR badge label — never the plural filter-chip key. */}
            {String(t(STATUS_BADGE_KEYS[row.status]))}
          </Badge>
        ),
      },
      {
        id: "createdAt",
        header: String(t("admin.appliedColumn")),
        width: 1.5,
        noWrap: true,
        cell: (row) => (
          <Text variant="caption" tone="muted">
            {fmtDate(fmt, row.createdAt)}
          </Text>
        ),
      },
      {
        id: "answers",
        header: "",
        width: 0.5,
        cell: (row) => {
          const hasDetails =
            Object.keys(row.answers).length > 0 ||
            (row.status === "REJECTED" && Boolean(row.decisionReason));
          if (!hasDetails) return null;
          const isExpanded = expandedRowId === row.id;
          return (
            <Button
              variant="ghost"
              size="$1"
              icon
              onPress={() => toggleExpand(row.id)}
              aria-label={
                isExpanded
                  ? (t("admin.collapseAnswers") as string)
                  : (t("admin.viewAnswers") as string)
              }
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </Button>
          );
        },
      },
      {
        id: "actions",
        header: "",
        // Three actions on a PENDING row (approve / waitlist / reject) need
        // more room than the old two; the cluster wraps rather than
        // overflowing the cell at narrow widths.
        width: 3,
        cell: (row) => {
          const isBusy = actionInFlight === row.id;
          if (row.status === "PENDING") {
            return (
              <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() => {
                    void handleApprove(row.id);
                  }}
                  disabled={isBusy}
                  borderRadius={0}
                >
                  <Check size={14} aria-hidden />
                  {isBusy ? "..." : String(t("admin.approve"))}
                </Button>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => {
                    setWaitlistTargetId(row.id);
                  }}
                  disabled={isBusy}
                  borderRadius={0}
                  testID={`application-waitlist-open-${row.id}`}
                >
                  <Hourglass size={14} aria-hidden />
                  {String(t("admin.waitlistDecision"))}
                </Button>
                <Button
                  variant="ghost"
                  size="$2"
                  onPress={() => {
                    toggleRejectComposer(row.id);
                  }}
                  disabled={isBusy}
                  borderRadius={0}
                  aria-expanded={rejectTargetId === row.id}
                  testID={`application-reject-open-${row.id}`}
                >
                  <XCircle size={14} aria-hidden />
                  {String(t("admin.reject"))}
                </Button>
              </XStack>
            );
          }
          // Rescind only undoes an ORGANIZER decision. WITHDRAWN (applicant's
          // own action) and EXPIRED (sweep) are rejected server-side with
          // INVALID_STATUS, so those rows get no action at all rather than a
          // button that can only fail.
          if (!RESCINDABLE_STATUSES.has(row.status)) {
            return null;
          }
          return (
            <XStack justifyContent="flex-end">
              <Button
                variant="ghost"
                size="$2"
                onPress={() => {
                  void handleRescind(row.id);
                }}
                disabled={isBusy}
                borderRadius={0}
                testID={`application-rescind-${row.id}`}
              >
                <Undo2 size={14} aria-hidden />
                {isBusy ? "..." : String(t("admin.rescind"))}
              </Button>
            </XStack>
          );
        },
      },
    ],
    [
      expandedRowId,
      actionInFlight,
      liveQuestionMeta,
      rejectTargetId,
      handleApprove,
      handleRescind,
      toggleExpand,
      toggleRejectComposer,
      t,
      fmt,
    ],
  );

  // ─── Reject-with-reason composer (full-width expanded row) ─────────
  // Mirrors the bookings decline-reason panel (OrgReceivedRequestsTable),
  // but the tone is attendee-facing: the note is shared with the applicant.

  const renderRejectComposer = useCallback(
    (row: SubmissionRow) => {
      if (rejectTargetId !== row.id) return null;
      const isBusy = actionInFlight === row.id;
      return (
        <YStack
          gap="$2"
          padding="$4"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          <Text variant="bodySmall" weight="bold">
            {String(t("admin.applicationRejectReasonLabel"))}
          </Text>
          <CharCountTextarea
            value={rejectReason}
            onChange={setRejectReason}
            maxLength={REJECT_REASON_MAX_LENGTH}
            minHeight={64}
            placeholder={String(t("admin.applicationRejectReasonPlaceholder"))}
            disabled={isBusy}
            testIdBase={`application-reject-reason-${row.id}`}
          />
          <Text variant="caption" tone="muted">
            {String(t("admin.applicationRejectReasonHint"))}
          </Text>
          <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
            <Button
              variant="ghost"
              size="$2"
              disabled={isBusy}
              borderRadius={0}
              onPress={() => {
                setRejectTargetId(null);
                setRejectReason("");
              }}
              testID={`application-reject-cancel-${row.id}`}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="destructive"
              size="$2"
              disabled={isBusy}
              borderRadius={0}
              onPress={() => {
                void handleReject(row.id, rejectReason);
              }}
              testID={`application-reject-confirm-${row.id}`}
            >
              {isBusy ? (
                <Spinner size="sm" />
              ) : (
                String(t("admin.applicationRejectConfirm"))
              )}
            </Button>
          </XStack>
        </YStack>
      );
    },
    [rejectTargetId, actionInFlight, rejectReason, handleReject, t],
  );

  const totalSubmissions = submissionsQuery.data?.pagination?.count ?? 0;
  const isSearching = debouncedQuery.length > 0;

  const countLabel = submissionsQuery.isLoading
    ? String(t("common.loading"))
    : isSearching
      ? String(t("admin.nApplicationResults", { count: sortedRows.length }))
      : String(t("admin.nApplications", { count: totalSubmissions }));

  // ─── Loading ───────────────────────────────────────────────────────
  // Still inside the shell rather than a bare centred spinner: the h1 and the
  // purpose line are known before the owner resolves, so the page does not
  // flash a headingless box on the way in.

  if (ownerLoading) {
    return (
      <AdminEmailVerificationGate mode="block">
        <EventOpsShell
          title={String(t("admin.applications"))}
          purpose={String(t("admin.opsApplicationsPurpose"))}
        >
          <YStack
            padding="$6"
            gap="$3"
            alignItems="center"
            justifyContent="center"
            minHeight={240}
          >
            <Spinner size="lg" />
            <Text variant="body" tone="muted">
              {String(t("common.loading"))}
            </Text>
          </YStack>
        </EventOpsShell>
      </AdminEmailVerificationGate>
    );
  }

  return (
    <AdminEmailVerificationGate mode="block">
      <EventOpsShell
        title={String(t("admin.applications"))}
        purpose={String(t("admin.opsApplicationsPurpose"))}
        filters={
          /* SearchBar carries `flex: 1`, which grows along its parent's MAIN
             axis — horizontal only inside a row. Bare in a column it stretches
             VERTICALLY and centres a 44px input in a tall empty band.
             FilterRow is the row wrapper, and it owns the clear affordance so
             the field no longer needs its own × button. */
          <FilterRow
            hasActiveFilters={searchText.length > 0 || statusFilter !== "ALL"}
            onClearAll={handleClearAll}
          >
            <SearchBar
              value={searchText}
              onChangeText={setSearchText}
              placeholder={String(t("admin.searchEmailPhonePlaceholder"))}
              testId="application-search-input"
              inputRef={searchInputRef}
            />
            {/* No "All" chip: `undefined` IS the default scope (every status),
                and a chip for the default would sit permanently selected. */}
            <FilterChips<SubmissionStatus>
              options={FILTER_OPTION_VALUES.map((f) => ({
                value: f,
                label: String(t(STATUS_FILTER_KEYS[f])),
              }))}
              selected={statusFilter === "ALL" ? undefined : statusFilter}
              onSelect={(v) => setStatusFilter(v ?? "ALL")}
            />
          </FilterRow>
        }
      >
        {submissionsQuery.isError ? (
          <AdminTableErrorState
            message={formatErrorMessage(submissionsQuery.error, t)}
            onRetry={() => {
              void submissionsQuery.refetch();
            }}
            testId="applications-table-error"
          />
        ) : (
          <YStack flex={1} minHeight={0}>
            <ActionBar
              onRefresh={() => {
                void submissionsQuery.refetch();
              }}
              countLabel={countLabel}
            />

            {/* TableContainer owns scrolling (overflow auto). The 640 floor
                lives on the INNER box, not on the container's parent as it
                used to: on the parent it widened the page itself, so a phone
                panned the whole surface — chrome, header and all. Inside, the
                table pans within its own bordered box and the sticky header
                sticks to the box that actually scrolls. */}
            <TableContainer>
              <YStack minWidth={640}>
                <DataTable
                  columns={columns}
                  rows={sortedRows}
                  getRowKey={(row) => row.id}
                  isLoading={submissionsQuery.isLoading}
                  emptyState={
                    <YStack padding="$6" alignItems="center" gap="$3">
                      <Text variant="h4" weight="bold" textAlign="center">
                        {isSearching
                          ? String(t("admin.noApplicationMatches"))
                          : statusFilter !== "ALL"
                            ? String(
                                t("admin.noStatusApplications", {
                                  status: String(
                                    t(STATUS_FILTER_KEYS[statusFilter]),
                                  ).toLowerCase(),
                                }),
                              )
                            : String(t("admin.noApplicationsYet"))}
                      </Text>
                      <Text
                        variant="body"
                        tone="muted"
                        textAlign="center"
                        maxWidth={360}
                      >
                        {isSearching
                          ? String(
                              t("admin.noApplicationsMatchingQuery", {
                                query: debouncedQuery,
                              }),
                            )
                          : String(t("admin.applicationsWillAppear"))}
                      </Text>
                      {/* Rendered for EITHER narrowing — a status chip alone
                          can empty the table, and gating on `isSearching`
                          left that case with no recovery button at all.
                          `atClearFiltersShowAll` rather than
                          `clearSearch`/`atClearFilters`: FilterRow's "Clear
                          filters" is on screen at the same moment, and two
                          controls sharing one accessible name is ambiguous
                          for screen-reader and voice-control users (see
                          NoResultsProps.clearLabel). */}
                      {(isSearching || statusFilter !== "ALL") && (
                        <Button
                          variant="secondary"
                          size="$2"
                          onPress={handleClearAll}
                        >
                          {String(t("admin.atClearFiltersShowAll"))}
                        </Button>
                      )}
                    </YStack>
                  }
                  renderExpandedRow={renderRejectComposer}
                  sort={sort}
                  onSortChange={setSort}
                  testIdBase="applications-table"
                />
              </YStack>
            </TableContainer>
          </YStack>
        )}

        {/* Waitlist confirm — neutral copy, no reason field (the server
            rejects `decisionReason` on WAITLISTED). */}
        <ConfirmDialog
          open={waitlistTargetId !== null}
          onConfirm={() => {
            if (waitlistTargetId) void handleWaitlist(waitlistTargetId);
          }}
          onCancel={() => setWaitlistTargetId(null)}
          title={String(t("admin.applicationWaitlistConfirmTitle"))}
          description={String(t("admin.applicationWaitlistConfirmBody"))}
          confirmLabel={String(t("admin.applicationWaitlistConfirm"))}
          cancelLabel={String(t("common.cancel"))}
          loading={
            waitlistTargetId !== null && actionInFlight === waitlistTargetId
          }
        />
      </EventOpsShell>
    </AdminEmailVerificationGate>
  );
}
