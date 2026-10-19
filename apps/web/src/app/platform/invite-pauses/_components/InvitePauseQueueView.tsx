"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  CharCountTextarea,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { ExternalLink, MailX } from "lucide-react";

import { formatRelativeAge } from "../../reports/_components/entity-report-queue.helpers";
import {
  complaintRatePercent,
  invitePauseOwnerHref,
  isAwaitingReview,
  type InvitePauseFilter,
  type InvitePauseQueueItem,
} from "./invite-pause-queue.helpers";

/** Server cap on the decision note (DECISION_NOTE_MAX in core). */
const DECISION_NOTE_MAX = 2000;

/** Organiser and staff free text renders as TEXT ONLY, line breaks kept. */
const PRE_WRAP: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

const FILTERS: ReadonlyArray<{ value: InvitePauseFilter; key: string }> = [
  { value: "OPEN", key: "invitePauseQueue.filterOpen" },
  { value: "AWAITING_REVIEW", key: "invitePauseQueue.filterAwaiting" },
  { value: "LIFTED", key: "invitePauseQueue.filterLifted" },
];

const EMPTY_KEY: Record<InvitePauseFilter, string> = {
  AWAITING_REVIEW: "invitePauseQueue.emptyAwaiting",
  OPEN: "invitePauseQueue.emptyOpen",
  LIFTED: "invitePauseQueue.emptyLifted",
};

export type InvitePauseDecision = "LIFTED" | "KEPT";

export type InvitePauseQueueViewProps = {
  items: InvitePauseQueueItem[];
  filter: InvitePauseFilter;
  onFilterChange: (filter: InvitePauseFilter) => void;
  /** Review requests still waiting (any filter); undefined while unknown. */
  waitingCount?: number;
  /** The count came from a full page: more may wait, so it reads "100+". */
  waitingCountIsFloor?: boolean;
  isLoading: boolean;
  isError: boolean;
  /** ADMIN / REVIEWER: show Review / Lift / Keep. SUPPORT reads only. */
  canDecide: boolean;
  /** A decision is in flight: disables the inline controls. */
  isDecisionPending: boolean;
  /** More rows exist past the loaded pages. */
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  /**
   * Record a decision. When the promise resolves the panel closes and focus
   * moves to the heading; when it rejects (the container shows why) the
   * panel stays open and the note survives.
   */
  onDecide: (
    pauseId: string,
    decision: InvitePauseDecision,
    note?: string,
  ) => void | Promise<unknown>;
};

/**
 * PURE view for /platform/invite-pauses: organisers whose invite emails were
 * paused for spam complaints. Staff lift the pause or keep it with a note
 * the organiser sees in their invite panel. Same list + inline-decision shape
 * as the reports queue (`EntityReportQueueView`), including its focus moves.
 * No complainant data exists on these rows, and none is shown.
 */
export function InvitePauseQueueView({
  items,
  filter,
  onFilterChange,
  waitingCount,
  waitingCountIsFloor = false,
  isLoading,
  isError,
  canDecide,
  isDecisionPending,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  onDecide,
}: InvitePauseQueueViewProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const tr = (key: string, values?: Record<string, string | number>) =>
    String(t(key, values));
  const formatDate = (iso: string) =>
    fmt.dateTime(new Date(iso), { dateStyle: "medium" });

  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // ── Focus management (copied from the reports queue) ───────────────────
  // Open → the note textarea. Close → that row's Review button. A decision
  // that succeeds (the row may leave the list) → the queue heading.
  const selectedIdRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const reviewCtaRefs = useRef<Map<string, HTMLElement>>(new Map());
  const pendingFocusRef = useRef<
    { target: "row"; id: string } | { target: "heading" } | null
  >(null);

  const setSelectedId = (id: string | null) => {
    selectedIdRef.current = id;
    setSelectedIdState(id);
  };

  useEffect(() => {
    if (selectedId) {
      panelRef.current?.querySelector("textarea")?.focus();
      return;
    }
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (!pending) return;
    if (pending.target === "row") {
      reviewCtaRefs.current.get(pending.id)?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [selectedId]);

  const closePanel = (
    focus: { target: "row"; id: string } | { target: "heading" } | null,
  ) => {
    pendingFocusRef.current = focus;
    setSelectedId(null);
    setNote("");
  };

  const decide = (pauseId: string, decision: InvitePauseDecision) => {
    const trimmed = note.trim();
    if (decision === "KEPT" && !trimmed) return;
    void Promise.resolve()
      .then(() => onDecide(pauseId, decision, trimmed || undefined))
      .then(
        () => {
          if (selectedIdRef.current === pauseId) {
            closePanel({ target: "heading" });
          }
        },
        () => {
          /* keep the panel open on error */
        },
      );
  };

  const header = (
    <YStack gap="$2">
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Text
          variant="h4"
          tag="h2"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={0.5}
          tabIndex={-1}
          ref={(node) => {
            headingRef.current = node as unknown as HTMLElement | null;
          }}
        >
          {tr("invitePauseQueue.title")}
        </Text>
        {typeof waitingCount === "number" && waitingCount > 0 ? (
          <Badge tone="warning" size="sm" data-testid="invite-pause-waiting-count">
            {waitingCountIsFloor
              ? tr("invitePauseQueue.waitingCountAtLeast", { count: waitingCount })
              : tr("invitePauseQueue.waitingCount", { count: waitingCount })}
          </Badge>
        ) : null}
      </XStack>
      <Text variant="bodySmall" tone="muted">
        {tr("invitePauseQueue.subtitle")}
      </Text>
      <XStack
        role="group"
        aria-label={tr("invitePauseQueue.filterLabel")}
        gap="$2"
        flexWrap="wrap"
      >
        {FILTERS.map((option) => {
          const active = option.value === filter;
          return (
            <Button
              key={option.value}
              variant={active ? "secondary" : "ghost"}
              size="$3"
              minHeight={44}
              aria-pressed={active}
              onPress={() => {
                if (active) return;
                closePanel(null);
                onFilterChange(option.value);
              }}
              data-testid={`invite-pause-filter-${option.value}`}
            >
              {tr(option.key)}
            </Button>
          );
        })}
      </XStack>
    </YStack>
  );

  if (isLoading) {
    return (
      <YStack gap="$4">
        {header}
        <YStack alignItems="center" justifyContent="center" padding="$6" aria-busy>
          <Spinner size="large" />
        </YStack>
      </YStack>
    );
  }

  if (isError) {
    return (
      <YStack gap="$4">
        {header}
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surface"
        >
          <Text variant="body" tone="error" role="alert">
            {tr("invitePauseQueue.loadError")}
          </Text>
          <XStack>
            <Button variant="secondary" size="$3" minHeight={44} onPress={onRetry}>
              {tr("invitePauseQueue.retry")}
            </Button>
          </XStack>
        </YStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$4">
      {header}

      {items.length === 0 ? (
        <YStack
          alignItems="center"
          justifyContent="center"
          padding="$6"
          gap="$3"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surface"
          data-testid="invite-pause-empty"
        >
          <MailX size={28} style={{ opacity: 0.4 }} aria-hidden />
          <Text variant="h4" textAlign="center">
            {tr(EMPTY_KEY[filter])}
          </Text>
          <Text variant="body" tone="muted" textAlign="center">
            {tr("invitePauseQueue.emptyHint")}
          </Text>
        </YStack>
      ) : (
        <YStack gap="$3" tag="ul" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((item) => {
            const isSelected = item.id === selectedId;
            const lifted = item.liftedAt !== null;
            const waiting = isAwaitingReview(item);
            const href = invitePauseOwnerHref(item);
            const kindLabel = tr(
              item.ownerKind === "ORG"
                ? "invitePauseQueue.ownerKindOrg"
                : "invitePauseQueue.ownerKindHuman",
            );
            // Unique per-row accessible names: every row has the same
            // buttons, so each carries the organiser's name AND kind (an
            // organisation and a person can share a name).
            const ownerText = item.ownerName?.trim()
              ? `${item.ownerName.trim()} (${kindLabel})`
              : `${kindLabel} ${item.ownerId}`;
            const pct = complaintRatePercent(item.complaintCount, item.recipientCount);
            const busy = isDecisionPending;
            const noteId = `invite-pause-note-${item.id}`;
            const keepHintId = `invite-pause-keep-hint-${item.id}`;

            return (
              <YStack
                key={item.id}
                tag="li"
                borderWidth={2}
                borderColor={isSelected ? "$accent" : "$borderColor"}
                backgroundColor="$surface"
                data-testid={`invite-pause-row-${item.id}`}
              >
                <YStack gap="$3" padding="$3" minWidth={0}>
                  {/* ── Status + reason + age ─────────────────────────── */}
                  <XStack gap="$2" alignItems="center" flexWrap="wrap">
                    {lifted ? (
                      <Badge tone="success" variant="outline" size="sm">
                        {tr("invitePauseQueue.badgeLifted")}
                      </Badge>
                    ) : waiting ? (
                      <Badge tone="warning" size="sm">
                        {tr("invitePauseQueue.badgeReviewAsked")}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" variant="outline" size="sm">
                        {tr("invitePauseQueue.badgePaused")}
                      </Badge>
                    )}
                    <Text variant="overline">
                      {tr(
                        item.reason === "COMPLAINT_RATE"
                          ? "invitePauseQueue.reasonRate"
                          : "invitePauseQueue.reasonCount",
                      )}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {tr("invitePauseQueue.pausedAge", {
                        age: formatRelativeAge(
                          new Date(item.pausedAt),
                          new Date(),
                          fmt.locale,
                        ),
                      })}
                    </Text>
                  </XStack>

                  {/* ── Organiser ──────────────────────────────────────── */}
                  <YStack gap="$1" minWidth={0}>
                    <Text variant="overline" tone="muted">
                      {tr("invitePauseQueue.ownerLabel")}
                    </Text>
                    {href ? (
                      <NextLinkAnchor href={href} target="_blank" textDecorationLine="none">
                        <XStack gap="$2" alignItems="center" minHeight={24} flexWrap="wrap">
                          <ExternalLink size={12} aria-hidden />
                          <Text
                            variant="bodySmall"
                            weight="bold"
                            color="$accentText"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {item.ownerName?.trim() || kindLabel}
                          </Text>
                          <Text
                            variant="caption"
                            tone="muted"
                            style={{ overflowWrap: "anywhere" }}
                          >
                            {item.ownerName?.trim() ? kindLabel : item.ownerId}
                          </Text>
                        </XStack>
                      </NextLinkAnchor>
                    ) : (
                      <XStack gap="$2" alignItems="baseline" flexWrap="wrap" minWidth={0}>
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          style={{ overflowWrap: "anywhere" }}
                        >
                          {item.ownerName?.trim() || kindLabel}
                        </Text>
                        <Text
                          variant="caption"
                          tone="muted"
                          style={{ overflowWrap: "anywhere" }}
                        >
                          {item.ownerName?.trim() ? kindLabel : item.ownerId}
                        </Text>
                      </XStack>
                    )}
                  </YStack>

                  {/* ── Facts ──────────────────────────────────────────── */}
                  <YStack tag="dl" gap="$2" style={{ margin: 0 }}>
                    <Fact label={tr("invitePauseQueue.factComplaints")}>
                      {tr("invitePauseQueue.factComplaintsValue", {
                        count: item.complaintCount,
                      })}
                    </Fact>
                    <Fact label={tr("invitePauseQueue.factInvited")}>
                      {pct === null
                        ? tr("invitePauseQueue.factInvitedValue", {
                            count: item.recipientCount,
                          })
                        : tr("invitePauseQueue.factInvitedValuePct", {
                            count: item.recipientCount,
                            pct: fmt.number(pct, { maximumFractionDigits: 1 }),
                          })}
                    </Fact>
                    <Fact label={tr("invitePauseQueue.factPausedOn")}>
                      {formatDate(item.pausedAt)}
                    </Fact>
                    {item.reviewRequestedAt ? (
                      <Fact label={tr("invitePauseQueue.factReviewAsked")}>
                        {formatDate(item.reviewRequestedAt)}
                      </Fact>
                    ) : null}
                    {item.decision && item.decidedAt ? (
                      <Fact label={tr("invitePauseQueue.factLastDecision")}>
                        {tr(
                          item.decision === "LIFTED"
                            ? "invitePauseQueue.decisionLiftedOn"
                            : "invitePauseQueue.decisionKeptOn",
                          { date: formatDate(item.decidedAt) },
                        )}
                      </Fact>
                    ) : null}
                  </YStack>

                  {/* ── The organiser's note ───────────────────────────── */}
                  {item.reviewRequestedAt ? (
                    <YStack gap="$1" minWidth={0}>
                      <Text variant="overline" tone="muted">
                        {tr("invitePauseQueue.organiserNoteLabel")}
                      </Text>
                      {item.reviewRequestNote ? (
                        <Quote>{item.reviewRequestNote}</Quote>
                      ) : (
                        <Text variant="bodySmall" tone="muted">
                          {tr("invitePauseQueue.organiserNoNote")}
                        </Text>
                      )}
                    </YStack>
                  ) : null}

                  {/* ── Staff's last note (shown to the organiser) ─────── */}
                  {item.decisionNote ? (
                    <YStack gap="$1" minWidth={0}>
                      <Text variant="overline" tone="muted">
                        {tr("invitePauseQueue.decisionNoteLabel")}
                      </Text>
                      <Quote>{item.decisionNote}</Quote>
                    </YStack>
                  ) : null}

                  {/* ── Actions ────────────────────────────────────────── */}
                  {lifted || !canDecide ? null : isSelected ? (
                    <YStack
                      gap="$3"
                      ref={(node) => {
                        panelRef.current = node as unknown as HTMLElement | null;
                      }}
                    >
                      <YStack gap="$1">
                        <label htmlFor={noteId} style={{ display: "block" }}>
                          <Text variant="overline" tag="span">
                            {tr("invitePauseQueue.noteLabel")}
                          </Text>
                        </label>
                        <CharCountTextarea
                          id={noteId}
                          value={note}
                          onChange={setNote}
                          maxLength={DECISION_NOTE_MAX}
                          minHeight={72}
                          disabled={busy}
                          ariaDescribedBy={keepHintId}
                          testIdBase="invite-pause-decision-note"
                        />
                        <Text id={keepHintId} variant="caption" tone="muted">
                          {tr("invitePauseQueue.noteHint")}
                        </Text>
                      </YStack>
                      <XStack gap="$2" flexWrap="wrap">
                        <Button
                          variant="primary"
                          size="$3"
                          minHeight={44}
                          onPress={() => decide(item.id, "LIFTED")}
                          disabled={busy}
                          aria-label={tr("invitePauseQueue.liftAria", { owner: ownerText })}
                          data-testid={`invite-pause-lift-${item.id}`}
                        >
                          {tr("invitePauseQueue.lift")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="$3"
                          minHeight={44}
                          onPress={() => decide(item.id, "KEPT")}
                          disabled={busy || note.trim().length === 0}
                          aria-label={tr("invitePauseQueue.keepAria", { owner: ownerText })}
                          aria-describedby={keepHintId}
                          data-testid={`invite-pause-keep-${item.id}`}
                        >
                          {tr("invitePauseQueue.keep")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="$3"
                          minHeight={44}
                          onPress={() => closePanel({ target: "row", id: item.id })}
                          disabled={busy}
                          aria-label={tr("invitePauseQueue.closeAria", { owner: ownerText })}
                          data-testid={`invite-pause-close-${item.id}`}
                        >
                          {tr("invitePauseQueue.close")}
                        </Button>
                      </XStack>
                    </YStack>
                  ) : (
                    <XStack>
                      <Button
                        variant="secondary"
                        size="$3"
                        minHeight={44}
                        ref={(node) => {
                          if (node) {
                            reviewCtaRefs.current.set(item.id, node as unknown as HTMLElement);
                          } else {
                            reviewCtaRefs.current.delete(item.id);
                          }
                        }}
                        aria-label={tr("invitePauseQueue.reviewAria", { owner: ownerText })}
                        onPress={() => {
                          setSelectedId(item.id);
                          setNote("");
                        }}
                        data-testid={`invite-pause-review-${item.id}`}
                      >
                        {tr("invitePauseQueue.reviewCta")}
                      </Button>
                    </XStack>
                  )}
                </YStack>
              </YStack>
            );
          })}
        </YStack>
      )}

      {items.length > 0 && hasNextPage ? (
        <XStack justifyContent="center" paddingVertical="$2">
          <Button
            variant="secondary"
            size="$3"
            minHeight={44}
            onPress={onLoadMore}
            disabled={isFetchingNextPage}
            aria-busy={isFetchingNextPage || undefined}
            data-testid="invite-pause-load-more"
          >
            {isFetchingNextPage ? <Spinner size="small" /> : null}
            {tr("invitePauseQueue.loadMore")}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
}

/** One fact: mono label, value beside it (wraps under it when narrow). */
function Fact({ label, children }: { label: string; children: string }) {
  return (
    <XStack gap="$2" alignItems="baseline" flexWrap="wrap" minWidth={0}>
      <Text variant="overline" tone="muted" tag="dt" style={{ minWidth: 120 }}>
        {label}
      </Text>
      <Text variant="bodySmall" tag="dd" style={{ margin: 0, overflowWrap: "anywhere" }}>
        {children}
      </Text>
    </XStack>
  );
}

/** Quoted free text: 3px ink rule on the left, text only. */
function Quote({ children }: { children: string }) {
  return (
    <YStack
      tag="blockquote"
      borderLeftWidth={3}
      borderLeftColor="$borderColor"
      paddingLeft="$2"
      style={{ margin: 0 }}
      minWidth={0}
    >
      <Text variant="bodySmall" style={PRE_WRAP}>
        {children}
      </Text>
    </YStack>
  );
}
