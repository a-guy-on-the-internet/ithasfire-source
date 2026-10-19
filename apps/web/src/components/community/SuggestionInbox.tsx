"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  CharCountTextarea,
  Checkbox,
  NextLinkAnchor,
  Spinner,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Check, ClipboardList, ExternalLink, X } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { BulkActionBar } from "@/components/AdminTableParts";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";

import { SuggestionDiffCard } from "./SuggestionDiffCard";
import { useSecondFactorRequiredToast } from "./use-second-factor-required-toast";
import {
  MATERIAL_SUGGESTION_FIELDS,
  SUGGESTION_FIELD_LABEL_KEYS,
  orderedSuggestionFieldKeys,
} from "./suggestion-fields-display";

/**
 * Owner-side "Suggested edits" inbox (community-managed-event-listings spec
 * FR-016): PENDING suggestions across an org's events, or on a single
 * (personal or org) event, with the SAME per-field diff review UX as the
 * community moderator queue — list, expandable review panel, optional note,
 * approve/reject, partial-apply ("applied/conflicted") + already-reviewed
 * toasts. Mirrors ModerationQueue's wiring over
 * `eventSuggestions.listForOwner` / `eventSuggestions.review` (server-side
 * authz: ORG_EDIT_ROLES for the org scope, event owner for the event scope).
 *
 * Layout is a DS v2 §5 two-region grid (`7fr 5fr`, `.th-suggestion-inbox-cols`
 * in globals.css) that collapses to one column by re-declaring
 * `grid-template-columns` — no flex-basis pseudo-columns, no JS viewport hook.
 * The collapse is a CONTAINER query: the inbox is embedded next to a 256px
 * admin rail that appears at 960px, so a viewport rule would make the review
 * panel NARROWER as the window gets wider (see the CSS comment).
 *
 * Renders its own loading / error / empty states; callers own the section
 * heading so the inbox drops into dashboards and builder tabs unchanged.
 */

export type SuggestionInboxScope =
  | { kind: "org"; orgId: string }
  | { kind: "event"; eventId: string };

export type SuggestionInboxProps = {
  scope: SuggestionInboxScope;
  /** Page size per fetch (compact surfaces pass a small value). */
  pageLimit?: number;
};

/** One toast id for the whole bulk path — a re-run replaces, never stacks. */
const BULK_TOAST_ID = "owner-suggestions-bulk";

/**
 * The tRPC WIRE code (`error.data.code`), as distinct from the app-level
 * `getAppErrorCode`. Transport-tier failures like the rate-limit floor carry
 * no `appCode` at all — `defaultRateLimit` throws a bare
 * `TRPCError({ code: "TOO_MANY_REQUESTS" })` with a human message
 * (packages/transport/trpc/src/guard.ts) — so `getAppErrorCode` returns null
 * for them and cannot be used to recognise the abort cases.
 */
function trpcErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { data?: { code?: unknown } }).data?.code;
  return typeof code === "string" ? code : null;
}

/** The wrapper is only a focus target — it must not draw a ring of its own. */
const bulkBarFocusStyle: React.CSSProperties = { outline: "none" };

/** Header label: fills its grid cell and matches the 44px gutter height. */
const selectAllLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  minHeight: 44,
  cursor: "pointer",
};

/**
 * Accessible name for a control with no visible label, passed as the DS
 * Checkbox's `label` rather than an `aria-label`.
 *
 * How that names the control (measured, because the source is misleading):
 * `forms/Checkbox.tsx` writes only a native `<label htmlFor>` — there is no
 * `aria-labelledby` anywhere in its source. But Tamagui's Label↔control
 * wiring EMITS one at runtime: the rendered frame is
 * `<button role="checkbox" … aria-labelledby="«rb»">` pointing at that label.
 * That matters wherever a second `<label for>` is also associated (the
 * select-all header below): AccName step 2A takes `aria-labelledby` and
 * never reaches the native labels, so the name is the hidden text ONCE.
 * Chromium's own AX tree: this shape computes "Select all"; the same markup
 * with the `aria-labelledby` removed computes "Select all Select all".
 * Pinned by "does not double the accessible name" in
 * packages/ui .../__tests__/Checkbox.test.tsx.
 */
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * `secondary` on BulkActionBar's ink inversion: the variant's ink outline is
 * invisible against `$surfaceStrong`, so its ladder re-points at the bar's
 * foreground token (paper outline at rest, paper fill + ink label on hover).
 * `color` lands on the frame and the label tracks it via `color: inherit` —
 * the intersection type grafts just that key on. Same fix as SignupsTab.
 */
type InvertedState = NonNullable<
  ComponentProps<typeof Button>["hoverStyle"]
> & { color?: string };
const invertedSecondaryHover: InvertedState = {
  backgroundColor: "$onStructure",
  borderColor: "$onStructure",
  color: "$surfaceStrong",
};
const invertedSecondaryPress: InvertedState = {
  ...invertedSecondaryHover,
  scale: 0.98,
};

export function SuggestionInbox({
  scope,
  pageLimit = 20,
}: SuggestionInboxProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const handleSecondFactorRequired = useSecondFactorRequiredToast();

  // Per-instance, not a module constant: two inboxes on one page (the org
  // dashboard could grow a second) would otherwise emit duplicate DOM ids
  // and cross-wire each other's <label for>.
  const selectAllId = `${useId()}-select-all`;
  // Focus parking spot for the confirm dialog's close — see the ConfirmDialog
  // comment at the bottom of the tree.
  const bulkBarRef = useRef<HTMLDivElement | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // ── Bulk selection ─────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /** `{done,total}` while a bulk run is in flight, `null` otherwise. */
  const [bulkProgress, setBulkProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /**
   * Synchronous double-submit guard, and NOT redundant with the buttons'
   * `disabled` state. The concrete path it closes: `Modal` has no focus
   * trap, so while the approve-confirm dialog is open Tab still reaches the
   * bulk REJECT button behind it — that starts a run, and the dialog's own
   * confirm button (never disabled) then starts a second one. State reads
   * are stale inside that same tick; the ref flips immediately, so the
   * second call bails.
   */
  const bulkRunningRef = useRef(false);
  const isBulkRunning = bulkProgress !== null;
  /** Bulk APPROVE writes to live listings, so it goes through a confirm. */
  const [confirmBulkApprove, setConfirmBulkApprove] = useState(false);

  const listQuery = trpc.eventSuggestions.listForOwner.useInfiniteQuery(
    { scope, limit: pageLimit },
    {
      staleTime: 15_000,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [listQuery.data],
  );
  const selected =
    items.find((item) => item.suggestion.id === selectedId) ?? null;

  /**
   * The ids a bulk run would actually submit: the selection intersected with
   * the currently LOADED rows (select-all deliberately never reaches the
   * un-fetched pages behind "Load more"). Rows that disappeared under us —
   * decided here or elsewhere — silently drop out instead of erroring.
   */
  const selectedVisibleIds = useMemo(
    () =>
      items
        .map((item) => item.suggestion.id)
        .filter((id) => selectedIds.has(id)),
    [items, selectedIds],
  );

  // A background refetch can prune the selection to nothing while the
  // approve-confirm is open — leaving it asking "Approve 0 suggestions?",
  // where confirming is a silent no-op. Close it instead.
  useEffect(() => {
    if (selectedVisibleIds.length === 0) setConfirmBulkApprove(false);
  }, [selectedVisibleIds.length]);

  // Approved/rejected rows leave the list on the next fetch; drop their ids so
  // the selection can never accumulate ghosts.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(items.map((item) => item.suggestion.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

  const closePanel = () => {
    setSelectedId(null);
    setNote("");
  };

  const invalidate = () =>
    void utils.eventSuggestions.listForOwner.invalidate();

  const toggleSelected = (id: string, next: boolean) => {
    setSelectedIds((prev) => {
      const draft = new Set(prev);
      if (next) draft.add(id);
      else draft.delete(id);
      return draft;
    });
  };

  const allSelected =
    items.length > 0 && selectedVisibleIds.length === items.length;
  const someSelected = selectedVisibleIds.length > 0 && !allSelected;

  const toggleAll = () => {
    setSelectedIds(
      allSelected
        ? new Set<string>()
        : new Set(items.map((item) => item.suggestion.id)),
    );
  };

  const reviewMut = trpc.eventSuggestions.review.useMutation({
    // Every failure branch below shows its own toast, so opt out of
    // GlobalMutationErrorNotifier's generic danger toast — it would
    // double-toast AND run the error through formatErrorMessage, which
    // console-warns on internal-tier codes like SECOND_FACTOR_REQUIRED
    // (deliberately absent from the errors.* catalog).
    meta: { silent: true },
    onSuccess: (data, vars) => {
      if (vars.decision === "APPROVE") {
        if (data.conflictedFields.length > 0) {
          toast.warning({
            title: String(t("moderation.approvedToast")),
            message: String(
              t("moderation.approvedPartialToast", {
                applied: data.appliedFields.length,
                conflicted: data.conflictedFields.length,
              }),
            ),
          });
        } else {
          toast.success({ title: String(t("moderation.approvedToast")) });
        }
      } else {
        toast.success({ title: String(t("moderation.rejectedToast")) });
      }
      closePanel();
      invalidate();
    },
    onError: (err) => {
      // Staff-role viewer without an enrolled second factor: the server's
      // step-up gate rejects the mutation. Explain + link to enrollment
      // instead of surfacing a generic FORBIDDEN toast.
      if (handleSecondFactorRequired(err)) return;
      if (getAppErrorCode(err) === "EDIT_SUGGESTION_ALREADY_REVIEWED") {
        toast.info({ title: String(t("moderation.alreadyReviewedToast")) });
        closePanel();
        invalidate();
        return;
      }
      toast.danger({
        title: String(t("moderation.decisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  /**
   * SEPARATE instance for the bulk path, deliberately WITHOUT the callbacks
   * above: running `reviewMut` N times would fire N toasts, close the panel N
   * times and invalidate N times. `meta.silent` still keeps
   * GlobalMutationErrorNotifier out (the runner owns every failure branch);
   * the aggregate outcome is toasted once, at the end.
   */
  const bulkReviewMut = trpc.eventSuggestions.review.useMutation({
    meta: { silent: true },
  });

  const review = (decision: "APPROVE" | "REJECT") => {
    if (!selected) return;
    reviewMut.mutate({
      suggestionId: selected.suggestion.id,
      decision,
      reviewNote: note.trim() || undefined,
    });
  };

  /**
   * Bulk approve/reject over the current selection.
   *
   * SEQUENTIAL, not `Promise.all`: these writes land on the same event rows
   * and every APPROVE recomputes conflicts server-side, so a parallel burst
   * is a self-inflicted race. (It would also eat into the transport's global
   * default rate-limit floor — `defaultRateLimit`, 240 requests / 60s per
   * procedure+actor, guard.ts. The `review` procedure itself declares no
   * custom `rateLimit`; only `submit` does.)
   *
   * The outcome is reported honestly: approvals that partially applied
   * (conflicted fields) and rows someone else already reviewed are NOT
   * counted as clean successes.
   */
  const runBulk = async (decision: "APPROVE" | "REJECT") => {
    if (bulkRunningRef.current) return;
    const ids = selectedVisibleIds;
    if (ids.length === 0) return;

    bulkRunningRef.current = true;
    setBulkProgress({ done: 0, total: ids.length });

    let decided = 0;
    let conflicted = 0;
    let already = 0;
    let failed = 0;
    /** `"handled"` = the 2FA hook already toasted; otherwise the wire code. */
    let aborted: null | "handled" | "TOO_MANY_REQUESTS" | "UNAUTHORIZED" = null;
    /** Ids that stay selected: failures, plus everything after an abort. */
    const keep = new Set<string>();

    try {
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i]!;
        try {
          const result = await bulkReviewMut.mutateAsync({
            suggestionId: id,
            decision,
          });
          decided += 1;
          if (decision === "APPROVE" && result.conflictedFields.length > 0) {
            conflicted += 1;
          }
        } catch (err) {
          // Whole-run aborts. Each of these fails every REMAINING call
          // identically, so grinding through them is pure noise (and, for
          // the rate limit, actively makes it worse). Stop, keep the
          // untouched ids selected so the run can be retried, and let the
          // one toast below say what happened.
          //
          //  · SECOND_FACTOR_REQUIRED — staff step-up gate, needs enrollment.
          //    Its own hook owns the toast (with the enrollment link).
          //  · TOO_MANY_REQUESTS — the rate-limit floor; a burst of doomed
          //    retries is exactly what it is defending against.
          //  · UNAUTHORIZED — the session is gone; nothing will succeed.
          if (handleSecondFactorRequired(err)) {
            for (let j = i; j < ids.length; j += 1) keep.add(ids[j]!);
            aborted = "handled";
            break;
          }
          const wireCode = trpcErrorCode(err);
          if (wireCode === "TOO_MANY_REQUESTS" || wireCode === "UNAUTHORIZED") {
            for (let j = i; j < ids.length; j += 1) keep.add(ids[j]!);
            aborted = wireCode;
            break;
          }
          if (getAppErrorCode(err) === "EDIT_SUGGESTION_ALREADY_REVIEWED") {
            // Row is gone from the queue either way — nothing to retry.
            already += 1;
          } else {
            failed += 1;
            keep.add(id);
          }
        }
        setBulkProgress({ done: i + 1, total: ids.length });
      }
    } finally {
      bulkRunningRef.current = false;
      setBulkProgress(null);
      setSelectedIds(keep);
      // The open panel's row may have just been decided — it is about to
      // vanish from the list, so close it rather than stranding a dead diff.
      if (selectedId && ids.includes(selectedId) && !keep.has(selectedId)) {
        closePanel();
      }
      // Once, for the whole run.
      invalidate();
    }

    // The 2FA hook owns its own toast (it carries the enrollment link).
    if (aborted === "handled") return;
    if (aborted) {
      toast.warning({
        id: BULK_TOAST_ID,
        title: String(t("ownerSuggestions.bulkStoppedToast")),
        message: String(
          t(
            aborted === "TOO_MANY_REQUESTS"
              ? "ownerSuggestions.bulkStoppedRateLimited"
              : "ownerSuggestions.bulkStoppedUnauthorized",
            { decided },
          ),
        ),
      });
      return;
    }

    if (conflicted === 0 && already === 0 && failed === 0) {
      toast.success({
        id: BULK_TOAST_ID,
        title: String(
          t(
            decision === "APPROVE"
              ? "ownerSuggestions.bulkApprovedToast"
              : "ownerSuggestions.bulkRejectedToast",
            { count: decided },
          ),
        ),
      });
      return;
    }
    // `conflicted` is a SUBSET of `decided` (a partial apply still counts as
    // a decision), so the ICU string nests it in parentheses rather than
    // listing it as a fourth disjoint bucket that readers would sum. Zero
    // buckets drop out entirely (`=0 {}`), so a one-failure run does not
    // read "0 already reviewed · 0 partly applied".
    toast.warning({
      id: BULK_TOAST_ID,
      title: String(t("ownerSuggestions.bulkPartialToast")),
      message: String(
        t("ownerSuggestions.bulkPartialToastMessage", {
          decided,
          conflicted,
          already,
          failed,
        }),
      ),
    });
  };

  /**
   * Fire-and-forget entry point for the two bulk buttons. `runBulk` handles
   * every expected failure itself, but an unexpected throw (a toast helper,
   * a bad translation argument) would otherwise land as an unhandled
   * rejection: Sentry noise and NO user-visible feedback. State is already
   * consistent by then — the `finally` has run — so the catch only has to
   * speak.
   */
  const startBulk = (decision: "APPROVE" | "REJECT") => {
    void runBulk(decision).catch((err: unknown) => {
      toast.danger({
        id: BULK_TOAST_ID,
        title: String(t("moderation.decisionFailedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    });
  };

  // ── Loading ────────────────────────────────────────────────────────────
  if (listQuery.isLoading) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  // ── Error + retry ──────────────────────────────────────────────────────
  if (listQuery.isError) {
    return (
      <YStack
        gap="$3"
        padding="$4"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <Text variant="body" tone="error">
          {String(t("moderation.loadError"))}
        </Text>
        <XStack>
          <Button
            variant="outlined"
            size="$3"
            onPress={() => void listQuery.refetch()}
          >
            {String(t("moderation.retry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  // ── Empty band ─────────────────────────────────────────────────────────
  if (items.length === 0) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$6"
        gap="$3"
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surface"
      >
        <ClipboardList size={28} style={{ opacity: 0.4 }} aria-hidden />
        <Text variant="h4">{String(t("ownerSuggestions.empty"))}</Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("ownerSuggestions.emptyHint"))}
        </Text>
      </YStack>
    );
  }

  return (
    // `container-type: inline-size` lives here so the two-region grid below
    // can measure the width the inbox ACTUALLY has (the admin rail is 256px
    // and appears at 960px, which no viewport rule can account for).
    <div className="th-suggestion-inbox">
      <YStack gap="$3">
        {/* ── Bulk action bar (only while ≥1 row is selected) ─────────── */}
        {/* Variant ladder: the review panel already owns this viewport's one
          full-accent `primary` (its row-level Approve), so the bulk actions
          stay a rung below — `secondary` for approve, the inverted ghost for
          reject. A second accent fill here would also blow the ≤5% accent
          budget on a screen that is otherwise paper and ink. */}
        {/* tabIndex -1 wrapper: a focus target for after the confirm dialog
            closes. Modal restores focus to its opener, but that opener is the
            approve button, which the SAME render disables — so `focus()` on
            it is a no-op and focus would fall to <body>. */}
        <div ref={bulkBarRef} tabIndex={-1} style={bulkBarFocusStyle}>
          <BulkActionBar
            count={selectedVisibleIds.length}
            onClear={() => setSelectedIds(new Set<string>())}
            testId="owner-suggestions-bulk-bar"
          >
            <Button
              variant="secondary"
              size="$2"
              minHeight={44}
              borderColor="$onStructure"
              color="$onStructure"
              hoverStyle={invertedSecondaryHover}
              pressStyle={invertedSecondaryPress}
              // Confirmed, not one-click: APPROVE rewrites live listings
              // (title / dates / location) for every selected row, and unlike
              // the single-row path nobody has read those diffs. REJECT below
              // changes nothing, so it stays immediate.
              onPress={() => setConfirmBulkApprove(true)}
              disabled={isBulkRunning}
              testID="owner-suggestions-bulk-approve"
            >
              <Check size={14} />
              {String(t("ownerSuggestions.bulkApproveSelected"))}
            </Button>
            <Button
              variant="ghostInverted"
              size="$2"
              minHeight={44}
              onPress={() => startBulk("REJECT")}
              disabled={isBulkRunning}
              testID="owner-suggestions-bulk-reject"
            >
              <X size={14} />
              {String(t("ownerSuggestions.bulkRejectSelected"))}
            </Button>
            {/* No `aria-live` here: a live region has to be in the DOM BEFORE
            its content changes to announce at all, and this node mounts
            already-populated — it would be silent at best and once-per-item
            at worst. BulkActionBar ships the persistent region, and the
            terminal toast covers completion. */}
            {bulkProgress ? (
              <XStack gap="$2" alignItems="center">
                <Spinner size="small" />
                <Text variant="caption" color="$onStructure">
                  {String(
                    t("ownerSuggestions.bulkProgress", {
                      done: bulkProgress.done,
                      total: bulkProgress.total,
                    }),
                  )}
                </Text>
              </XStack>
            ) : null}
          </BulkActionBar>
        </div>

        {/* DS v2 §5 two-region grid — see globals.css for the template and the
          900px collapse. A plain <div> on purpose: Tamagui stacks force
          `display:flex`. */}
        <div className="th-suggestion-inbox-cols">
          {/* ── Inbox list ───────────────────────────────────────────── */}
          <YStack gap="$2">
            {/* List header. The transparent 2px border + $3 padding mirror the
              row cards below EXACTLY, so the select-all box lands on the
              same 44px gutter as every row box instead of being eyeballed
              into place with a magic offset. */}
            <YStack
              borderWidth={2}
              borderColor="transparent"
              paddingHorizontal="$3"
            >
              <div className="th-suggestion-row">
                <div className="th-suggestion-select">
                  <span
                    aria-hidden
                    className="th-suggestion-select-hit"
                    onClick={() => {
                      if (!isBulkRunning) toggleAll();
                    }}
                  />
                  <Checkbox
                    id={selectAllId}
                    label={
                      <span style={visuallyHidden}>
                        {String(t("ownerSuggestions.bulkSelectAll"))}
                      </span>
                    }
                    // Partial selection reads as indeterminate (a minus
                    // glyph), never as "none selected".
                    checked={
                      allSelected
                        ? true
                        : someSelected
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleAll}
                    disabled={isBulkRunning}
                    size="md"
                    testIdBase="owner-suggestions-select-all"
                  />
                </div>
                {/* A SECOND <label> associated with the same control, so the
                    visible text stays clickable. Two native labels normally
                    CONCATENATE into the accessible name ("Select all Select
                    all" — measured in Chromium), but Tamagui emits an
                    `aria-labelledby` on the frame at runtime pointing at the
                    DS Checkbox's own hidden label, and AccName step 2A stops
                    there without consulting either native label. So the name
                    stays "Select all", once. That is a non-obvious
                    dependency on the DS component, so it is pinned by a test
                    in packages/ui .../__tests__/Checkbox.test.tsx — if that
                    ever goes away, this must switch to an explicit
                    `aria-labelledby` at the visible text. */}
                <label htmlFor={selectAllId} style={selectAllLabelStyle}>
                  <Text
                    variant="caption"
                    tone="muted"
                    textTransform="uppercase"
                    letterSpacing={0.5}
                  >
                    {String(t("ownerSuggestions.bulkSelectAll"))}
                  </Text>
                </label>
              </div>
            </YStack>

            {items.map(({ suggestion, event, submitterName }) => {
              const isSelected = suggestion.id === selectedId;
              const isChecked = selectedIds.has(suggestion.id);
              const title =
                event?.title ?? String(t("moderation.unknownEvent"));
              const submitter = submitterName
                ? submitterName
                : suggestion.submitterHumanId
                  ? suggestion.submitterHumanId.slice(0, 8)
                  : String(t("moderation.anonymous"));
              const toggleRow = () => {
                setSelectedId(isSelected ? null : suggestion.id);
                setNote("");
              };
              const fieldKeys = orderedSuggestionFieldKeys(suggestion.fields);
              const when = fmt.dateTime(new Date(suggestion.createdAt), {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              });
              return (
                <YStack
                  key={suggestion.id}
                  padding="$3"
                  minHeight={44}
                  borderWidth={2}
                  borderColor={isSelected ? "$accent" : "$borderColor"}
                  backgroundColor="$surface"
                  hoverStyle={{ borderColor: "$accent" }}
                >
                  {/* Selection gutter + content, as SIBLING cells. The checkbox
                    is deliberately NOT inside the row button: a checkbox
                    nested in role="button" is an ARIA violation, and its
                    label would be folded into the button's computed name —
                    the row would announce "Select the suggestion for X …
                    button" while Enter actually expands it. */}
                  <div className="th-suggestion-row">
                    <div className="th-suggestion-select">
                      {/* 44px touch target around the 20px frame. Paints BELOW
                        the frame (earlier sibling, both z-index auto), so a
                        press on the box itself still goes to the real
                        control — only the ring lands here. It is confined to
                        this 44px cell, so it can never occlude the row
                        button next door. aria-hidden + no tabIndex: the
                        control keeps the single a11y identity. */}
                      <span
                        aria-hidden
                        className="th-suggestion-select-hit"
                        onClick={() => {
                          if (isBulkRunning) return;
                          toggleSelected(suggestion.id, !isChecked);
                        }}
                      />
                      <Checkbox
                        label={
                          <span style={visuallyHidden}>
                            {String(
                              // Event title alone is ambiguous — nothing stops
                              // two pending suggestions on one event — so the
                              // name carries submitter + timestamp too.
                              t("ownerSuggestions.bulkSelectRow", {
                                event: title,
                                submitter,
                                when,
                              }),
                            )}
                          </span>
                        }
                        checked={isChecked}
                        onCheckedChange={(next) =>
                          toggleSelected(suggestion.id, next === true)
                        }
                        disabled={isBulkRunning}
                        size="md"
                        testIdBase={`owner-suggestion-select-${suggestion.id}`}
                      />
                    </div>

                    {/* Native interactive wrapper: keyboard activation + focus
                      outline (Tamagui onPress only maps to click on web). */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={isSelected}
                      style={{ cursor: "pointer" }}
                      onClick={toggleRow}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleRow();
                        }
                      }}
                    >
                      <YStack gap="$2" minHeight={44} justifyContent="center">
                        <XStack
                          justifyContent="space-between"
                          alignItems="center"
                          gap="$2"
                          flexWrap="wrap"
                        >
                          <XStack
                            gap="$2"
                            alignItems="center"
                            flex={1}
                            minWidth={0}
                          >
                            <Badge tone="warning" size="sm">
                              {String(
                                t("moderation.pendingBadge"),
                              ).toUpperCase()}
                            </Badge>
                            <Text
                              variant="body"
                              weight="bold"
                              style={{
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {title}
                            </Text>
                          </XStack>
                          <Text variant="caption" tone="muted">
                            {when}
                          </Text>
                        </XStack>

                        <Text variant="caption" tone="muted">
                          {String(
                            t("moderation.submittedBy", { name: submitter }),
                          )}
                        </Text>

                        {/* Proposed-field chips */}
                        <XStack gap="$2" flexWrap="wrap">
                          {fieldKeys.map((key) => (
                            <XStack
                              key={key}
                              borderWidth={1}
                              borderColor="$borderColor"
                              paddingHorizontal="$2"
                              paddingVertical={2}
                            >
                              <Text
                                variant="caption"
                                tone="muted"
                                textTransform="uppercase"
                                letterSpacing={0.5}
                              >
                                {SUGGESTION_FIELD_LABEL_KEYS[key]
                                  ? String(t(SUGGESTION_FIELD_LABEL_KEYS[key]))
                                  : key}
                              </Text>
                            </XStack>
                          ))}
                        </XStack>
                      </YStack>
                    </div>
                  </div>
                </YStack>
              );
            })}

            {listQuery.hasNextPage ? (
              <XStack justifyContent="center" paddingVertical="$2">
                <Button
                  variant="outlined"
                  size="$3"
                  onPress={() => void listQuery.fetchNextPage()}
                  disabled={listQuery.isFetchingNextPage}
                >
                  {listQuery.isFetchingNextPage ? (
                    <Spinner size="small" />
                  ) : null}
                  {String(t("moderation.loadMore"))}
                </Button>
              </XStack>
            ) : null}
          </YStack>

          {/* ── Review panel ─────────────────────────────────────────── */}
          {selected ? (
            <YStack
              gap="$3"
              padding="$4"
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surface"
            >
              <XStack justifyContent="space-between" alignItems="center">
                <Text
                  variant="h4"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t("moderation.reviewTitle"))}
                </Text>
                <Button
                  variant="ghost"
                  size="$2"
                  icon
                  aria-label={String(t("moderation.close"))}
                  onPress={closePanel}
                >
                  <X size={14} />
                </Button>
              </XStack>

              <YStack gap="$1">
                <Text variant="bodySmall" weight="bold">
                  {selected.event?.title ??
                    String(t("moderation.unknownEvent"))}
                </Text>
                {selected.event?.slug ? (
                  <NextLinkAnchor
                    href={`/events/${selected.event.slug}`}
                    target="_blank"
                    textDecorationLine="none"
                  >
                    <XStack gap="$2" alignItems="center" minHeight={24}>
                      <ExternalLink size={12} aria-hidden />
                      <Text variant="caption" tone="accent">
                        {String(t("moderation.viewEvent"))}
                      </Text>
                    </XStack>
                  </NextLinkAnchor>
                ) : null}
                <Text variant="caption" tone="muted">
                  {String(
                    t("moderation.submittedBy", {
                      name: selected.submitterName
                        ? selected.submitterName
                        : selected.suggestion.submitterHumanId
                          ? selected.suggestion.submitterHumanId.slice(0, 8)
                          : String(t("moderation.anonymous")),
                    }),
                  )}{" "}
                  ·{" "}
                  {fmt.dateTime(new Date(selected.suggestion.createdAt), {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Text>
              </YStack>

              {selected.suggestion.note ? (
                <YStack gap="$1">
                  <Text
                    variant="caption"
                    weight="bold"
                    textTransform="uppercase"
                    letterSpacing={0.5}
                  >
                    {String(t("moderation.submitterNote"))}
                  </Text>
                  <Text variant="bodySmall">{selected.suggestion.note}</Text>
                </YStack>
              ) : null}

              {/* Per-field diffs. Conflicts are computed server-side at APPROVE
                (FR-009) — pending rows carry none, so the cards render
                unconflicted here; partial applies surface via the post-review
                toast. */}
              <YStack gap="$2">
                {orderedSuggestionFieldKeys(selected.suggestion.fields).map(
                  (key) => (
                    <SuggestionDiffCard
                      key={key}
                      fieldKey={key}
                      label={
                        SUGGESTION_FIELD_LABEL_KEYS[key]
                          ? String(t(SUGGESTION_FIELD_LABEL_KEYS[key]))
                          : key
                      }
                      before={selected.suggestion.baseVersion[key] ?? null}
                      after={selected.suggestion.fields[key] ?? null}
                      material={MATERIAL_SUGGESTION_FIELDS.has(key)}
                    />
                  ),
                )}
              </YStack>

              <YStack gap="$1">
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.5}
                >
                  {String(t("moderation.reviewNoteLabel"))}
                </Text>
                <CharCountTextarea
                  value={note}
                  onChange={setNote}
                  maxLength={1000}
                  minHeight={72}
                  placeholder={String(t("moderation.reviewNotePlaceholder"))}
                  disabled={reviewMut.isPending || isBulkRunning}
                  testIdBase="owner-suggestion-review-note"
                />
              </YStack>

              <XStack gap="$2" flexWrap="wrap">
                <Button
                  variant="primary"
                  size="$3"
                  onPress={() => review("APPROVE")}
                  disabled={reviewMut.isPending || isBulkRunning}
                >
                  <Check size={14} />
                  {String(t("moderation.approve"))}
                </Button>
                <Button
                  variant="destructive"
                  size="$3"
                  onPress={() => review("REJECT")}
                  disabled={reviewMut.isPending || isBulkRunning}
                >
                  <X size={14} />
                  {String(t("moderation.reject"))}
                </Button>
              </XStack>
            </YStack>
          ) : (
            /* Holds the second grid cell open so the list never snaps between
             full width and 7fr on every selection. CSS-hidden below the
             840px container collapse, where it would be dead vertical
             space — the REAL panel above is never hidden this way. */
            <div className="th-suggestion-inbox-placeholder">
              <YStack
                gap="$2"
                padding="$4"
                minHeight={200}
                alignItems="center"
                justifyContent="center"
                borderWidth={2}
                borderColor="$borderColor"
                backgroundColor="$surface"
              >
                <ClipboardList size={24} style={{ opacity: 0.4 }} aria-hidden />
                <Text variant="bodySmall" weight="bold" textAlign="center">
                  {String(t("ownerSuggestions.reviewPlaceholder"))}
                </Text>
                <Text variant="caption" tone="muted" textAlign="center">
                  {String(t("ownerSuggestions.reviewPlaceholderHint"))}
                </Text>
              </YStack>
            </div>
          )}
        </div>

        {/* Bulk APPROVE writes to live listings for every selected row, and
          unlike the single-row path the diffs were never opened — so it is
          confirmed, with the count named. BulkActionBar suppresses its own
          Escape-to-clear while an aria-modal dialog is open, so cancelling
          leaves the selection intact. */}
        <ConfirmDialog
          open={confirmBulkApprove}
          onCancel={() => setConfirmBulkApprove(false)}
          onConfirm={() => {
            // Move focus BEFORE the state updates that unmount the dialog.
            // Modal restores focus to its opener on close, but that opener
            // is the approve button, which this same render disables — and
            // `focus()` on a disabled button is a no-op, so focus would fall
            // to <body>. Parking it on the bulk bar keeps the keyboard user
            // where the progress and the outcome appear. (Cancel is fine:
            // nothing disables the opener on that path.)
            bulkBarRef.current?.focus();
            setConfirmBulkApprove(false);
            startBulk("APPROVE");
          }}
          title={String(
            t("ownerSuggestions.bulkApproveConfirmTitle", {
              count: selectedVisibleIds.length,
            }),
          )}
          description={String(t("ownerSuggestions.bulkApproveConfirmBody"))}
          confirmLabel={String(t("ownerSuggestions.bulkApproveConfirmCta"))}
          cancelLabel={String(t("ownerSuggestions.bulkCancel"))}
          // No `loading` prop: confirming closes the dialog before the run
          // starts, so a spinner in here would be unreachable. Progress and
          // the disabled state live on the bulk bar, which stays visible.
        />
      </YStack>
    </div>
  );
}

SuggestionInbox.displayName = "SuggestionInbox";
