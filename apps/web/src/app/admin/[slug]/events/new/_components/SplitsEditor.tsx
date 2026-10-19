"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useParams } from "next/navigation";
import { styled, XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  RangeSlider,
  Spinner,
  Text,
  TextInput,
  useFormatters,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";
import {
  ChevronDown,
  Lock,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";

import { trpc } from "@/trpc";
import {
  DealEditor,
  ResaleClause,
  classifyDealReadError,
  recipientPortions,
  type DealTarget,
  type PortionLine,
} from "@/components/deals";
// Direct, not via the barrel: pure helpers the tests' barrel mock lacks.
import { joinNames, namesToTell } from "@/components/deals/deal-names";
import { useViewerHuman } from "@/components/deals/use-viewer-human";
import { getAppErrorCode } from "@/lib/app-error";
import { adminAgreementHref } from "@/lib/agreement-routes";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { formatErrorMessage } from "@/lib/format-error-message";
import styles from "./SplitsEditor.module.css";
import { parsePercentInputToBasisPoints } from "@/lib/money/parse-percent-input";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { useIsMobile } from "@/hooks/useIsMobile";
import { HumanSearchCombobox } from "./HumanSearchCombobox";
import { eventDealParty, lineupSuggestionsOf } from "./splits-deal";
import {
  EditorCard,
  EditorCardActions,
  EditorCardMeta,
  EditorCardTitle,
} from "./_mobile-bits";

type SplitKind = "PRIMARY" | "RESALE" | "MERCH";

type SplitLine = {
  id?: string;
  payeeRef: { kind: "org" | "human"; id: string };
  ticketTypeId: string | null;
  percentBps: number;
  floorCents: number;
  priority: number;
  /**
   * Stored as read and sent back as is: the editor has no cap control, and
   * the server stores `capPercent ?? null`, so leaving it out of a save
   * silently removed a cap the deal set.
   */
  capPercent?: number | null;
  /**
   * The read could not name this line's payee (its Payee row is gone), so
   * there is no subject id to send back. Sending anything else would mint a
   * payee for nobody; the line blocks Save until it is removed.
   */
  payeeUnknown?: boolean;
  // Display-only fields hydrated from the read.
  displayName?: string | null;
  source?: "owner" | "lineup-picker" | "manual";
  requiresConfirmation?: boolean;
  confirmationStatus?:
    | "PENDING"
    | "CONFIRMED"
    | "COUNTERED"
    | "DECLINED"
    | null;
  payeeStatus?: "missing" | "pending_setup" | "active";
  /**
   * What the organiser has actually TYPED in this row's percent box, kept
   * verbatim until it parses.
   *
   * Without it the box is `String(percentBps / 100)`, so every keystroke that
   * doesn't yet form a number is erased on the spot: `12.` renders back as
   * `12` and `12,` (es) used to render back as `0`. You could not type a
   * decimal share at all. `undefined` means "no draft — show the committed
   * value", which is what a slider drag or a fresh read restores.
   */
  percentText?: string;
  /** i18n key for a draft that could not be read; blocks Save while set. */
  percentErrorKey?: string | null;
};

/** A line as the save sends it: the fields the server stores. */
type WrittenLine = Pick<
  SplitLine,
  "id" | "payeeRef" | "ticketTypeId" | "percentBps"
> & { floorCents?: number; priority?: number; capPercent?: number | null };

/**
 * The buffer as the server would store it: the lines a save sends (owner
 * lines are auto-managed and never sent), only the fields it stores. Two
 * buffers with the same key are the same terms, whatever is typed but not
 * yet read in a percent box.
 */
function writtenKey(lines: readonly WrittenLine[]): string {
  return JSON.stringify(
    lines.map((l) => [
      l.id ?? null,
      l.payeeRef.kind,
      l.payeeRef.id,
      l.ticketTypeId,
      l.percentBps,
      l.floorCents ?? null,
      l.priority ?? null,
      l.capPercent ?? null,
    ]),
  );
}
/**
 * Is this line the auto-managed owner remainder? Only on ticket sales. On
 * RESALE nothing is left for an owner: finalize splits the whole resale share
 * over the stored lines alone (`computeOrderSplits`), so a line whose payee is
 * the event owner is an ordinary recipient there, edited and saved like any
 * other. Treating it as the remainder would drop it from every save and move
 * its money to the other lines.
 */
const isAutoOwner = (line: Pick<SplitLine, "source">, tab: SplitKind) =>
  tab !== "RESALE" && line.source === "owner";
const writableLines = (lines: readonly SplitLine[], tab: SplitKind) =>
  lines.filter((l) => !isAutoOwner(l, tab));

/** A line's key in the RESALE portion map: its id, or its place while unsaved. */
const resaleLineKey = (line: SplitLine, idx: number) => line.id ?? `new-${idx}`;

/**
 * How a typed share is read. Blank keeps its long-standing meaning — 0% — so
 * clearing the box still zeroes the row; everything else is either a number or
 * a REFUSAL. It is never silently zeroed: `Number("12,5")` is `NaN`, and the
 * old `NaN → 0` fallback wrote a 0-bps share that paid the payee NOTHING at
 * settlement, with no error anywhere.
 *
 * WHY A FRACTIONAL SHARE IS REFUSED
 * ---------------------------------
 * The editor talks in basis points because that is what `getEventSplits`
 * surfaces, but the STORE is whole percent: `PayoutTermsLine.percent` is an
 * `Int` (packages/db/prisma/finance.prisma), the read multiplies it by 100,
 * and `update-event-splits` divides it back. Hand that path 1250 and it
 * persists 13 — the payee is paid 13%, not 12.5%, and the audit log records
 * the post-rounding 1300, so nothing on the system can tell you it happened.
 * On a $10k net that is $50 an event, moved off the owner's remainder.
 *
 * `12,5` is therefore READ (the locale fix stands — it must never silently
 * become 0 again) and then refused with the reason that is actually true:
 * shares are whole percent. The wire schema enforces the same rule, so no
 * client can reach the rounder either.
 */
export type SplitPercentField =
  | { kind: "bps"; basisPoints: number }
  | { kind: "error"; messageKey: string };

export function resolveSplitPercentField(raw: string): SplitPercentField {
  const parsed = parsePercentInputToBasisPoints(raw);
  if (parsed.ok) {
    // A whole percent is the only thing the store can hold exactly.
    if (parsed.basisPoints % 100 !== 0) {
      return { kind: "error", messageKey: "admin.ebSplitsPercentWhole" };
    }
    return { kind: "bps", basisPoints: parsed.basisPoints };
  }
  if (parsed.reason === "empty") return { kind: "bps", basisPoints: 0 };
  return {
    kind: "error",
    messageKey:
      parsed.reason === "ambiguous"
        ? "admin.ebSplitsPercentAmbiguous"
        : parsed.reason === "out_of_range"
          ? "admin.ebSplitsPercentRange"
          : "admin.ebSplitsPercentInvalid",
  };
}

// Canonical block-section width — matches LineupEditor / EventWaiverSection / FormSection.
const SectionContainer = styled(YStack, {
  padding: 32,
  gap: 24,
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

// NOT styled(Button): re-styling the DS Button detaches its string-child
// wrapping, so labels land as raw text nodes in the frame View and spam
// "Unexpected text node" on every render. Compose with props instead.
const TabButton = ({
  active,
  ...props
}: ComponentPropsWithoutRef<typeof Button> & { active?: boolean }) => (
  <Button
    variant="ghost"
    size="$2"
    backgroundColor={active ? "$surfaceMuted" : undefined}
    {...props}
  />
);

const LineRow = styled(XStack, {
  gap: 12,
  alignItems: "center",
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  variants: {
    flagged: {
      true: { backgroundColor: "rgba(239,68,68,0.06)" },
    },
  } as const,
});

// Deterministic DATA palette — an identity color per payee, not chrome. These
// are the marks that link a payee's slider fill to its allocation-bar segment,
// its legend dot, and its row chip; there is no semantic token for "payee #3",
// so raw hex is correct here (see eslint-hex-allowlist.mjs).
const PAYEE_PALETTE = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#84cc16", // lime
  "#f97316", // orange
];

// The owner isn't an identity in the palette — it's "the rest", so it reads as
// the muted neutral rather than taking a slot. Theme-tracking (Stub #5C544A).
const OWNER_COLOR = "var(--colorMuted, #5C544A)";

function colorForLine(line: SplitLine, idx: number): string {
  if (line.source === "owner") return OWNER_COLOR;
  return PAYEE_PALETTE[idx % PAYEE_PALETTE.length];
}

function formatBps(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2)}%`;
}

function buildClientKey(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

// ── Stacked allocation bar ──────────────────────────────────────────
type BarSegment = {
  key: string;
  widthPct: number;
  color: string;
  label: string;
  striped?: boolean;
};

function LegendDot({ color, label }: { color: string; label: string }) {
  // Shrinkable with minWidth 0 so a long payee name wraps inside its own
  // item instead of pushing the legend past the panel at 320px.
  return (
    <XStack gap={6} alignItems="center" flexShrink={1} minWidth={0}>
      <div
        aria-hidden
        style={{ width: 10, height: 10, background: color, flexShrink: 0 }}
      />
      <Text
        variant="caption"
        tone="muted"
        flexShrink={1}
        minWidth={0}
        style={{ overflowWrap: "anywhere" }}
      >
        {label}
      </Text>
    </XStack>
  );
}

function AllocationBar({ segments }: { segments: BarSegment[] }) {
  return (
    <XStack
      height={14}
      width="100%"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surface"
      overflow="hidden"
    >
      {segments.map((seg) => {
        const style: CSSProperties = {
          width: `${Math.min(100, seg.widthPct)}%`,
          height: "100%",
          background: seg.striped
            ? `repeating-linear-gradient(45deg, ${seg.color} 0 6px, rgba(0,0,0,0.15) 6px 10px)`
            : seg.color,
          transition: "width 180ms ease",
        };
        return (
          <div
            key={seg.key}
            style={style}
            title={seg.label}
            aria-label={seg.label}
          />
        );
      })}
    </XStack>
  );
}

export function SplitsEditor({ eventId }: { eventId: string }) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<SplitKind>("PRIMARY");

  // `resale` feature gate — off by default until resale is vetted (same gate
  // TicketTypeEditor uses for the per-ticket "Allow resale" controls). While
  // gates are still loading `gates` is undefined, so this reads false: the tab
  // fails CLOSED rather than flashing in and disappearing.
  const { gates } = useFeatureGates();
  const resaleEnabled = gates?.resale === true;

  // Belt-and-braces: the tab is unreachable by click while gated off, but the
  // gate can flip under a session that is already sitting on it (gates refetch,
  // or staff toggles it in /platform). Without this the editor would keep
  // fetching and saving RESALE splits with no tab rendered to say so.
  useEffect(() => {
    if (!resaleEnabled && activeTab === "RESALE") {
      setActiveTab("PRIMARY");
    }
  }, [resaleEnabled, activeTab]);

  // Read state for the active tab. RESALE is force-treated as PRIMARY while
  // the gate is off so a stale `activeTab` can never fetch resale splits in
  // the render that happens before the effect above lands.
  const effectiveTab: SplitKind =
    activeTab === "RESALE" && !resaleEnabled ? "PRIMARY" : activeTab;

  const splitsQuery = trpc.events.getEventSplits.useQuery(
    { eventId, kind: effectiveTab === "MERCH" ? "PRIMARY" : effectiveTab },
    { enabled: effectiveTab !== "MERCH", staleTime: 30_000 },
  );

  // Local edit buffer. Seeded from the query, mutated by row controls.
  const [lines, setLines] = useState<SplitLine[]>([]);
  // The terms the buffer last matched (tab + `writtenKey`): the last read
  // poured in, or the last save sent. A buffer that differs from them holds
  // unsaved edits, and a read landing over those (a deal save above, another
  // tab) is held in `heldLines`, not poured over them: the editor says so and
  // offers to load it.
  const seededRef = useRef<{ tab: SplitKind; key: string } | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const [heldLines, setHeldLines] = useState<SplitLine[] | null>(null);
  // The last read, as lines: what "Discard changes" on a frozen deal restores.
  const lastReadLinesRef = useRef<SplitLine[] | null>(null);
  useEffect(() => {
    if (!splitsQuery.data) return;
    const next: SplitLine[] = splitsQuery.data.lines.map((l) => ({
      id: l.id,
      // The SUBJECT id: what a save sends back as `payeeRef.id`. The Payee
      // row id (`payeeId`) sent there resolved to no subject and minted a new
      // Payee, moving the line's money, on every re-save. With no subject id
      // the line is marked and blocks Save; no other id is ever sent.
      payeeRef: { kind: l.payeeKind, id: l.payeeSubjectId ?? "" },
      payeeUnknown: l.payeeSubjectId === null,
      capPercent: l.capPercent,
      ticketTypeId: l.ticketTypeId,
      percentBps: l.percentBps,
      floorCents: l.floorCents,
      priority: l.priority,
      displayName: l.payeeDisplayName,
      source: l.source,
      requiresConfirmation: l.requiresConfirmation,
      confirmationStatus: l.confirmationStatus,
      payeeStatus: l.payeeStatus,
    }));
    lastReadLinesRef.current = next;
    const seeded = seededRef.current;
    const dirty =
      seeded !== null &&
      seeded.tab === effectiveTab &&
      writtenKey(writableLines(linesRef.current, effectiveTab)) !== seeded.key;
    if (dirty) {
      setHeldLines(next);
      return;
    }
    seededRef.current = {
      tab: effectiveTab,
      key: writtenKey(writableLines(next, effectiveTab)),
    };
    setHeldLines(null);
    setLines(next);
  }, [splitsQuery.data, effectiveTab]);
  const loadHeldLines = () => {
    if (!heldLines) return;
    seededRef.current = {
      tab: effectiveTab,
      key: writtenKey(writableLines(heldLines, effectiveTab)),
    };
    setLines(heldLines);
    setHeldLines(null);
  };

  // ── The deal (board P1): the ticket-money terms, as "The deal" ─────────
  // Ticket sales are edited as a deal; the line-by-line editor below stays
  // reachable for what the deal sends back to it, and for resale (step C2).
  const params = useParams<{ slug?: string }>();
  const adminSlug = typeof params?.slug === "string" ? params.slug : null;
  const dealTarget = useMemo<DealTarget>(
    () => ({ kind: "EVENT", eventId }),
    [eventId],
  );
  // Same key and options as DealEditor's own read: one request, one cache.
  const dealRead = trpc.deals.getTermsDeal.useQuery(
    { target: dealTarget },
    { retry: false, meta: { silent: true } },
  );
  // The booking's terms: the deal links to the agreement, and the lines here
  // would only be refused (updateEventSplits refuses booking-owned terms).
  const dealOwnedByBooking =
    !!dealRead.error &&
    classifyDealReadError(dealRead.error).kind === "OWNED_BY_BOOKING";
  // Same key as EventBuilder's read, so this is served from its cache.
  const eventForEditQuery = trpc.events.getEventForEdit.useQuery({ eventId });
  const { ownersWithSlugs } = useEventOwnerEntities();
  const unnamed = String(t("deals.unnamed"));
  const dealOwner = eventDealParty(
    eventForEditQuery.data,
    ownersWithSlugs,
    effectiveTab === "PRIMARY"
      ? splitsQuery.data?.lines.find((l) => l.source === "owner")
          ?.payeeDisplayName
      : null,
    unnamed,
  );
  const dealParties = dealOwner ? [dealOwner] : [];
  const dealSuggestions = lineupSuggestionsOf(
    effectiveTab === "PRIMARY"
      ? (splitsQuery.data?.lineupSuggestions ?? [])
      : [],
    dealOwner,
    unnamed,
  );
  // null = follow the blockers (open when publish is blocked); else the
  // organiser's own toggle.
  const [linesOpenChoice, setLinesOpenChoice] = useState<boolean | null>(null);
  // After a deal save: the lines editor re-reads the same terms.
  const refreshLines = () => {
    void utils.events.getEventSplits.invalidate({ eventId, kind: "PRIMARY" });
  };

  // ── The freeze (freeze-the-deal FR-010) ────────────────────────────────
  // A frozen deal's lines are read-only until "Change the frozen terms";
  // then the buffer edits as before and one save (`frozenChange: true`)
  // records the change and tells every payee. `frozenRefused`: the deal read
  // could not say (a booked event's resale lines), but a save was refused.
  const locale = useLocale();
  const [frozenRefused, setFrozenRefused] = useState(false);
  const linesFrozen =
    !!dealRead.data?.dealFreeze?.dealFrozenAt || frozenRefused;
  // On Ticket sales the deal is on the page above: its "Change the frozen
  // terms" is the one way in, and these lines (the same terms) stay
  // read-only and point there. One change, one notice. Resale has no deal
  // editor above it, so its lines open their own change.
  const linesFollowDeal = effectiveTab === "PRIMARY";
  const linesCanChange = linesFrozen && !linesFollowDeal;
  const [linesChangingChoice, setLinesChanging] = useState(false);
  const linesChanging = linesChangingChoice && linesCanChange;
  useEffect(() => {
    setLinesChanging(false);
  }, [effectiveTab]);
  const linesLocked = linesFrozen && !linesChanging;
  // A frozen change with nothing changed yet: its save would tell nobody
  // anything, so it waits for an edit.
  const frozenUnchanged =
    linesChanging &&
    seededRef.current !== null &&
    seededRef.current.tab === effectiveTab &&
    writtenKey(writableLines(lines, effectiveTab)) === seededRef.current.key;
  const discardLineChanges = () => {
    setLinesChanging(false);
    const read = heldLines ?? lastReadLinesRef.current;
    if (!read) return;
    seededRef.current = {
      tab: effectiveTab,
      key: writtenKey(writableLines(read, effectiveTab)),
    };
    setHeldLines(null);
    setLines(read);
  };
  // The frame locks (a freeze above, a refused save, a change closed) over
  // edits never saved: drop them for the read, so the locked lines show the
  // deal as it stands, and re-read in case the refusal means it moved. A
  // buffer that matches what was last read or sent is left as it is.
  const wasLockedRef = useRef(linesLocked);
  useEffect(() => {
    const was = wasLockedRef.current;
    wasLockedRef.current = linesLocked;
    if (!linesLocked || was) return;
    const seeded = seededRef.current;
    // Nothing seeded yet (a fresh load of a frozen event): nothing to drop.
    const clean =
      seeded === null ||
      (seeded.tab === effectiveTab &&
        writtenKey(writableLines(linesRef.current, effectiveTab)) ===
          seeded.key);
    if (clean) return;
    void utils.events.getEventSplits.invalidate({
      eventId,
      kind: effectiveTab === "MERCH" ? "PRIMARY" : effectiveTab,
    });
    discardLineChanges();
    // Runs on the lock turning on; the rest is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesLocked]);

  // What the last frozen save sent over: nothing new, or to nobody.
  const frozenSendRef = useRef<{
    unchanged: boolean;
    tellsNobody: boolean;
  } | null>(null);
  const updateMutation = trpc.events.updateEventSplits.useMutation({
    onSuccess: (_data, sent) => {
      const frozenSend = sent.frozenChange ? frozenSendRef.current : null;
      if (sent.frozenChange) {
        setLinesChanging(false);
        const eventIdOfFreeze = dealRead.data?.dealFreeze?.eventId ?? eventId;
        void utils.deals.listDealChanges.invalidate({
          eventId: eventIdOfFreeze,
        });
      }
      // The buffer now matches what was sent. Recorded here rather than left
      // to the re-read: a save that changed nothing can come back as the
      // same cached object, which re-runs nothing, and edits made after it
      // must still count as unsaved.
      seededRef.current = {
        tab: sent.kind,
        key: writtenKey(sent.lines),
      };
      toast.success({
        id: "splits-saved",
        title: String(
          t(
            !frozenSend
              ? "admin.ebSplitsSavedTitle"
              : frozenSend.unchanged
                ? "deals.freeze.savedNothingToast"
                : frozenSend.tellsNobody
                  ? "deals.freeze.savedToastNobody"
                  : "deals.freeze.savedToast",
          ),
        ),
      });
      void utils.events.getEventSplits.invalidate({
        eventId,
        kind: effectiveTab === "MERCH" ? "PRIMARY" : effectiveTab,
      });
      // The deal reads the same ticket-money terms.
      if (effectiveTab === "PRIMARY") {
        void utils.deals.getTermsDeal.invalidate({ target: dealTarget });
        void utils.deals.projectTermsDeal.invalidate({ target: dealTarget });
      }
      // The resale clause block reads these lines as its recipients, and the
      // RESALE terms' version moves with them: a cached read would send a
      // stale expectedVersion on the clause's next save.
      if (sent.kind === "RESALE") {
        void utils.deals.getResaleClause.invalidate({ target: dealTarget });
      }
    },
    onError: (err) => {
      if (getAppErrorCode(err) === "DEAL_FROZEN") {
        setFrozenRefused(true);
        // Lines with their own change (Resale): keep what was typed and open
        // the change, so the next save goes as a frozen change and the footer
        // names who it tells. Lines that follow the deal lock and drop it.
        if (!linesFollowDeal) setLinesChanging(true);
        void utils.deals.getTermsDeal.invalidate({ target: dealTarget });
        void utils.events.getEventSplits.invalidate({
          eventId,
          kind: effectiveTab === "MERCH" ? "PRIMARY" : effectiveTab,
        });
      }
      toast.danger({
        id: "splits-save-failed",
        title: String(t("admin.ebSplitsSaveFailedTitle")),
        message: formatErrorMessage(err, t),
      });
    },
  });

  // Splits divide the ticket money: the full ticket price on sales since the
  // 2026-10-11 ruling (orders sold before it were credited the price minus the
  // platform fee). The platform fee and Stripe's fee are paid by the buyer on
  // top, so they don't belong in this editor. Target is always the full
  // 10000 bps of that pool; the owner line absorbs whatever's left.
  //
  // RESALE has no owner remainder: finalize pays the whole share over the
  // lines (each its percentage, the rest handed round them evenly). So no
  // derived owner share there, and each line shows the portion it will
  // actually receive. The lines may not claim more than 100% together; that
  // is a save blocker here (`resaleOverTotal`) and a refusal in
  // `updateEventSplits` (RESALE_SPLITS_OVER_TOTAL), not the ticket-sales
  // over-allocation notice.
  const isResale = effectiveTab === "RESALE";
  const target = 10000;
  const nonOwnerAllocatedBps = useMemo(
    () =>
      lines
        .filter((l) => !isAutoOwner(l, effectiveTab))
        .reduce((sum, l) => sum + l.percentBps, 0),
    [lines, effectiveTab],
  );
  const ownerDerivedBps = isResale
    ? 0
    : Math.max(0, target - nonOwnerAllocatedBps);
  const overAllocated = !isResale && nonOwnerAllocatedBps > target + 100; // ±1pt tolerance
  const overByBps = nonOwnerAllocatedBps - target;
  const reconciles = !overAllocated;

  // RESALE: what each line will actually receive, from the same split the
  // resale clause block shows (`recipientPortions` over `computeOrderSplits`),
  // so the two never disagree. A line not yet saved has no payee id; its
  // subject id stands in, which can only move a single odd cent of the
  // ordering, below what a one-decimal portion can show.
  const fmt = useFormatters();
  const storedLines = splitsQuery.data?.lines;
  const resalePortions = useMemo(() => {
    if (!isResale) return null;
    const byId = new Map((storedLines ?? []).map((l) => [l.id, l]));
    const portionLines: PortionLine[] = lines.map((l, idx) => {
      const read = l.id ? byId.get(l.id) : undefined;
      return {
        lineId: resaleLineKey(l, idx),
        payeeId: read?.payeeId ?? l.payeeRef.id,
        // Whole percent by construction (a fractional draft is refused and
        // leaves percentBps at its last whole value).
        percent: Math.round(l.percentBps / 100),
        capPercent: l.capPercent ?? null,
        priority: l.priority,
        ticketTypeId: l.ticketTypeId,
      };
    });
    return recipientPortions(portionLines);
  }, [isResale, lines, storedLines]);
  const portionLabel = useCallback(
    (portion: "all" | number | undefined): string => {
      if (portion === undefined) return String(t("deals.resale.portionVaries"));
      if (portion === "all") return String(t("deals.resale.portionAll"));
      return String(
        t("deals.resale.percentOfShare", {
          percent: fmt.number(portion, { maximumFractionDigits: 1 }),
        }),
      );
    },
    [t, fmt],
  );

  const segments = useMemo<BarSegment[]>(() => {
    const segs: BarSegment[] = [];
    // RESALE: each line's real portion of the share.
    if (resalePortions) {
      lines.forEach((line, idx) => {
        const portion = resalePortions.get(resaleLineKey(line, idx));
        const pct = portion === "all" ? 100 : (portion ?? 0);
        if (pct <= 0) return;
        segs.push({
          key: resaleLineKey(line, idx),
          widthPct: pct,
          color: colorForLine(line, idx + 1),
          label: `${line.displayName ?? String(t("admin.ebSplitsPayeeFallback"))} · ${portionLabel(portion)}`,
        });
      });
      return segs;
    }
    // Non-owner payees first.
    lines
      .filter((l) => !isAutoOwner(l, effectiveTab) && l.percentBps > 0)
      .forEach((line, idx) => {
        segs.push({
          key: line.id ?? `line-${idx}`,
          widthPct: Math.min(100, line.percentBps / 100),
          color: colorForLine(line, idx + 1), // +1 keeps owner's slate distinct
          label: `${line.displayName ?? String(t("admin.ebSplitsPayeeFallback"))} · ${formatBps(line.percentBps)}`,
        });
      });
    // Owner segment — the auto-derived remainder.
    const ownerLine = lines.find((l) => isAutoOwner(l, effectiveTab));
    if (ownerDerivedBps > 0 && ownerLine) {
      segs.push({
        key: "owner",
        widthPct: ownerDerivedBps / 100,
        color: OWNER_COLOR,
        label: `${ownerLine.displayName ?? String(t("admin.ebSplitsOwnerFallback"))} (auto) · ${formatBps(ownerDerivedBps)}`,
      });
    }
    // Over-allocation: render a striped red bar on top.
    if (overAllocated) {
      segs.push({
        key: "over",
        widthPct: Math.min(20, overByBps / 100),
        color: "var(--danger, #B91C1C)",
        label: String(
          t("admin.ebSplitsOverBy", { amount: formatBps(overByBps) }),
        ),
        striped: true,
      });
    }
    return segs;
  }, [
    lines,
    ownerDerivedBps,
    overAllocated,
    overByBps,
    t,
    effectiveTab,
    resalePortions,
    portionLabel,
  ]);

  // ── Add-line picker state ──────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [searchSelection, setSearchSelection] = useState<{
    humanId: string;
    displayName: string;
  } | null>(null);
  const [newLinePercent, setNewLinePercent] = useState("");

  const handleAddFromLineup = (suggestion: {
    humanId: string;
    displayName: string | null;
    alreadyOnTerms: boolean;
    payeeStatus: "missing" | "pending_setup" | "active";
  }) => {
    if (suggestion.alreadyOnTerms) return;
    setLines((prev) => [
      ...prev,
      {
        payeeRef: { kind: "human", id: suggestion.humanId },
        ticketTypeId: null,
        percentBps: 0,
        floorCents: 0,
        priority: prev.length,
        displayName: suggestion.displayName,
        source: "lineup-picker",
        requiresConfirmation: true,
        confirmationStatus: "PENDING",
        payeeStatus: suggestion.payeeStatus,
      },
    ]);
  };

  // Adjudicated on every keystroke so the organiser sees the refusal before
  // pressing Add — and so Add can be blocked rather than banking a fallback.
  const newLinePercentField = useMemo(
    () => resolveSplitPercentField(newLinePercent),
    [newLinePercent],
  );
  const newLinePercentError =
    newLinePercentField.kind === "error"
      ? String(t(newLinePercentField.messageKey))
      : null;

  const handleAddFromSearch = () => {
    if (!searchSelection) return;
    // Blank still means 0% (add the payee now, set the share with the slider).
    // Unreadable does NOT: it refuses, where it used to add a 0% line.
    if (newLinePercentField.kind !== "bps") return;
    const pctBps = newLinePercentField.basisPoints;
    setLines((prev) => [
      ...prev,
      {
        payeeRef: { kind: "human", id: searchSelection.humanId },
        ticketTypeId: null,
        percentBps: pctBps,
        floorCents: 0,
        priority: prev.length,
        displayName: searchSelection.displayName,
        source: "manual",
        requiresConfirmation: true,
        confirmationStatus: "PENDING",
        payeeStatus: "missing",
      },
    ]);
    setSearchInput("");
    setSearchSelection(null);
    setNewLinePercent("");
  };

  const handleRemove = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  /**
   * The slider. It can only emit a whole in-range percent, so it commits
   * directly — and clears any draft/error the text box left behind, since
   * dragging is an unambiguous statement of intent that supersedes it.
   */
  const handlePercentSlide = (idx: number, pct: number) => {
    const bps = Math.max(0, Math.min(10000, Math.round(pct * 100)));
    setLines((prev) =>
      prev.map((l, i) =>
        i === idx
          ? { ...l, percentBps: bps, percentText: undefined, percentErrorKey: null }
          : l,
      ),
    );
  };

  /**
   * The text box. The draft is always kept (so `12,5` survives the keystroke
   * that used to wipe it) but `percentBps` is only advanced when the draft
   * READS. On a refusal the committed share stays at its last good value —
   * the allocation bar and the running total never see a half-parsed number —
   * and the row is flagged, which blocks Save until it is fixed.
   */
  const handlePercentText = (idx: number, text: string) => {
    const field = resolveSplitPercentField(text);
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        if (field.kind === "error") {
          return { ...l, percentText: text, percentErrorKey: field.messageKey };
        }
        return {
          ...l,
          percentText: text,
          percentBps: field.basisPoints,
          percentErrorKey: null,
        };
      }),
    );
  };

  // A row whose typed share can't be read must never reach the mutation: its
  // `percentBps` is stale by construction, so saving would bank a number the
  // organiser has already replaced on screen.
  const unreadableShareCount = lines.filter(
    (l) => !isAutoOwner(l, effectiveTab) && l.percentErrorKey,
  ).length;
  const hasUnreadableShare = unreadableShareCount > 0;
  // A line that would be sent with no payee to name (see `payeeUnknown`).
  const unknownPayeeCount = writableLines(lines, effectiveTab).filter(
    (l) => l.payeeUnknown,
  ).length;
  // RESALE: the lines share the whole resale share, so together they can
  // claim at most 100%. Over that, finalize takes the excess back from the
  // last lines and someone who agreed to a percentage is paid less.
  // `updateEventSplits` refuses it too (RESALE_SPLITS_OVER_TOTAL).
  const resaleOverTotal = isResale && nonOwnerAllocatedBps > target;
  const saveBlocked =
    hasUnreadableShare || unknownPayeeCount > 0 || resaleOverTotal;

  const onSave = () => {
    if (hasUnreadableShare) {
      toast.danger({
        id: "splits-percent-unreadable",
        title: String(t("admin.ebSplitsSaveBlockedTitle")),
        message: String(
          t("admin.ebSplitsPercentBlocker", { count: unreadableShareCount }),
        ),
      });
      return;
    }
    if (unknownPayeeCount > 0) {
      toast.danger({
        id: "splits-save-blocked",
        title: String(t("deals.splits.payeeUnknownTitle")),
        message: String(t("deals.splits.payeeUnknown")),
      });
      return;
    }
    if (resaleOverTotal) {
      toast.danger({
        id: "splits-save-blocked",
        title: String(t("admin.ebSplitsSaveBlockedTitle")),
        message: String(
          t("deals.resale.lines.overTotal", {
            total: formatBps(nonOwnerAllocatedBps),
          }),
        ),
      });
      return;
    }
    // On ticket sales the owner line is the auto-managed remainder and is
    // not sent. On RESALE every line is sent: the owner can be a recipient
    // like anyone else, and the server stores exactly the lines it is given.
    const writable = writableLines(lines, effectiveTab);
    // A frozen save's toast says whether anyone was told, as on the deal.
    frozenSendRef.current = linesFrozen
      ? {
          unchanged: frozenUnchanged,
          tellsNobody: linesTellNames.length === 0,
        }
      : null;
    updateMutation.mutate({
      eventId,
      kind: effectiveTab === "MERCH" ? "PRIMARY" : effectiveTab,
      lines: writable.map((l) => ({
        id: l.id,
        payeeRef: l.payeeRef,
        ticketTypeId: l.ticketTypeId,
        percentBps: l.percentBps,
        floorCents: l.floorCents,
        priority: l.priority,
        capPercent: l.capPercent ?? null,
      })),
      clientKey: buildClientKey(),
      ...(linesFrozen ? { frozenChange: true } : {}),
    });
  };
  // Who a frozen save tells: everyone on these lines before or after it,
  // less whoever saves (the notice skips them).
  const viewer = useViewerHuman();
  const linesTellNames = namesToTell(
    [
      ...(splitsQuery.data?.lines ?? []).map((l) => ({
        kind: l.payeeKind,
        id: l.payeeSubjectId,
        name: l.payeeDisplayName,
      })),
      ...lines.map((l) => ({
        kind: l.payeeRef.kind,
        id: l.payeeRef.id || null,
        name: l.displayName,
      })),
    ],
    viewer,
  );

  const rawBlockers = splitsQuery.data?.publishGateBlockers ?? [];
  // Translate enum codes into human-readable, situational copy.
  const inactivePayeeCount = lines.filter(
    (l) => l.payeeStatus && l.payeeStatus !== "active",
  ).length;

  // Two lists. What stops a SAVE (this buffer can't be sent) is not what
  // stops publishing (the stored terms aren't ready), so they are headed
  // apart: a save problem under "Before you can publish" read as if saving
  // were fine.
  const saveBlockerMessages: string[] = [];
  const blockerMessages: string[] = [];
  // Unreadable typed shares come first: nothing else can be saved until they
  // are fixed, so leading with them is the honest ordering.
  if (hasUnreadableShare) {
    saveBlockerMessages.push(
      String(
        t("admin.ebSplitsPercentBlocker", { count: unreadableShareCount }),
      ),
    );
  }
  // Only surface the "totals invalid" blocker when non-owner shares overflow
  // the allocatable pool. Under-allocation is handled by the auto-derived
  // owner share, so it's never a blocker on the editor side.
  if (overAllocated) {
    blockerMessages.push(
      String(
        t("admin.ebSplitsBlockerOverAllocated", {
          amount: formatBps(Math.abs(overByBps)),
        }),
      ),
    );
  }
  if (unknownPayeeCount > 0) {
    saveBlockerMessages.push(String(t("deals.splits.payeeUnknown")));
  }
  if (resaleOverTotal) {
    saveBlockerMessages.push(
      String(
        t("deals.resale.lines.overTotal", {
          total: formatBps(nonOwnerAllocatedBps),
        }),
      ),
    );
  }
  if (rawBlockers.includes("payee_not_active")) {
    blockerMessages.push(
      inactivePayeeCount === 1
        ? String(t("admin.ebSplitsBlockerConnectOne"))
        : String(
            t("admin.ebSplitsBlockerConnectMany", {
              count: inactivePayeeCount,
            }),
          ),
    );
  }

  // Locked, nothing here can fix a save blocker: only publish blockers open
  // the fold.
  const linesNeedAttention = linesLocked
    ? blockerMessages.length > 0
    : saveBlockerMessages.length > 0 || blockerMessages.length > 0;
  // What blocks publishing: shown under the lines, locked or not.
  const publishBlockersNode =
    blockerMessages.length > 0 ? (
      <YStack
        gap={6}
        padding={12}
        borderWidth={1}
        borderColor="$warning"
        backgroundColor="rgba(250,204,21,0.06)"
        data-testid="eb-splits-publish-blockers"
      >
        <Text variant="caption" weight="bold" tone="warning">
          {String(t("admin.ebSplitsPublishBlockersTitle"))}
        </Text>
        {blockerMessages.map((msg) => (
          <Text key={msg} variant="caption" tone="muted">
            • {msg}
          </Text>
        ))}
      </YStack>
    ) : null;
  // A line's name, or a plain "not found" when its payee row is gone (an
  // unnamed row is the one the save blocker points at).
  const lineName = (line: SplitLine) =>
    line.displayName ??
    (line.payeeUnknown
      ? String(t("deals.splits.payeeNotFound"))
      : line.payeeRef.id.slice(0, 8));

  return (
    <SectionContainer
      {...(isMobile
        ? { paddingVertical: 20, paddingHorizontal: 16, gap: 20 }
        : {})}
    >
      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap={8}
      >
        <Text variant="h4" weight="bold">
          {String(t("admin.ebRevenueSplits"))}
        </Text>
        {/* "Ready" only when the stored terms pass AND the lines on screen
            can be saved: an unsaveable buffer is not ready. */}
        {rawBlockers.length === 0 && !saveBlocked && lines.length > 0 ? (
          <Badge tone="success" size="sm">
            {String(t("admin.ebSplitsReady"))}
          </Badge>
        ) : rawBlockers.length > 0 || saveBlocked ? (
          <Badge tone="warning" size="sm">
            {String(t("admin.ebSplitsNeedsAttention"))}
          </Badge>
        ) : null}
      </XStack>

      {/* Tabs */}
      <XStack
        gap={4}
        flexWrap="wrap"
        borderBottomWidth={2}
        borderBottomColor="$borderColor"
      >
        <TabButton
          active={activeTab === "PRIMARY"}
          onPress={() => setActiveTab("PRIMARY")}
        >
          {String(t("admin.ebSplitsTabTickets"))}
        </TabButton>
        {resaleEnabled ? (
          <TabButton
            active={activeTab === "RESALE"}
            onPress={() => setActiveTab("RESALE")}
          >
            {String(t("admin.ebSplitsTabResale"))}
          </TabButton>
        ) : null}
        <TabButton active={false} disabled>
          {String(t("admin.ebSplitsTabMerch"))}
        </TabButton>
      </XStack>

      {/* Ticket sales: "The deal" (board P1). The event's own terms are
          edited here; booking-owned terms link to the agreement. */}
      {effectiveTab === "PRIMARY" ? (
        <DealEditor
          target={dealTarget}
          parties={dealParties}
          suggestions={dealSuggestions}
          agreementHref={
            adminSlug
              ? (agreementId) => adminAgreementHref(adminSlug, agreementId)
              : undefined
          }
          onSaved={refreshLines}
          resaleSlot={
            <ResaleClause
              target={dealTarget}
              onChangeRecipients={() => setActiveTab("RESALE")}
              agreementHref={
                adminSlug
                  ? (agreementId) => adminAgreementHref(adminSlug, agreementId)
                  : undefined
              }
              testIdBase="eb-deal"
            />
          }
          testIdBase="eb-deal"
        />
      ) : null}

      {/* The line-by-line editor: resale as before; for ticket sales folded
          under the deal, for what the deal sends back to it (a line scoped to
          one ticket type) and the payout-setup blockers. Booking-owned terms
          have no lines to edit here. */}
      {effectiveTab === "PRIMARY" && dealOwnedByBooking ? null : (
      <LinesFrame
        folded={effectiveTab === "PRIMARY"}
        open={linesOpenChoice ?? linesNeedAttention}
        onToggle={() =>
          setLinesOpenChoice(!(linesOpenChoice ?? linesNeedAttention))
        }
        label={String(t("deals.splits.linesToggle"))}
        // Frozen, the lines can't change here: the band inside says where.
        hint={linesFrozen ? null : String(t("deals.splits.linesHint"))}
        testId="eb-deal-lines"
      >
      {effectiveTab === "MERCH" ? null : splitsQuery.isLoading ? (
        <YStack alignItems="center" padding={32}>
          <Spinner size="small" />
        </YStack>
      ) : splitsQuery.error ? (
        <Text variant="body" tone="error">
          {formatErrorMessage(splitsQuery.error, t)}
        </Text>
      ) : (
        <>
          {heldLines ? (
            <XStack
              gap={8}
              alignItems="center"
              flexWrap="wrap"
              role="status"
              data-testid="eb-splits-lines-changed"
            >
              <Text variant="caption" tone="muted">
                {String(t("deals.splits.linesChanged"))}
              </Text>
              <Button
                variant="outlined"
                size="$2"
                onPress={loadHeldLines}
                data-testid="eb-splits-lines-reload"
              >
                {String(t("deals.splits.linesReload"))}
              </Button>
            </XStack>
          ) : null}
          {/* Stacked allocation bar */}
          <YStack gap={10}>
            <AllocationBar segments={segments} />
            <XStack
              gap={16}
              alignItems="center"
              flexWrap="wrap"
              justifyContent="space-between"
            >
              {/* The web XStack defaults to flex-shrink 0, so as an item of the
                  wrapping row above this legend kept its one-line width and
                  never wrapped its own dots. Letting it shrink (minWidth 0)
                  caps it at the panel width; its dots then wrap. */}
              <XStack
                gap={14}
                alignItems="center"
                flexWrap="wrap"
                flexShrink={1}
                minWidth={0}
              >
                {isResale ? null : (
                  <LegendDot
                    color={OWNER_COLOR}
                    label={String(
                      t("admin.ebSplitsOwnerLegend", {
                        amount: formatBps(ownerDerivedBps),
                      }),
                    )}
                  />
                )}
                {resalePortions
                  ? lines.map((l, idx) => (
                      <LegendDot
                        key={resaleLineKey(l, idx)}
                        color={colorForLine(l, idx + 1)}
                        label={`${l.displayName ?? String(t("admin.ebSplitsPayeeFallback"))} · ${portionLabel(resalePortions.get(resaleLineKey(l, idx)))}`}
                      />
                    ))
                  : lines
                      .filter(
                        (l) =>
                          !isAutoOwner(l, effectiveTab) && l.percentBps > 0,
                      )
                      .map((l, idx) => (
                        <LegendDot
                          key={l.id ?? `legend-${idx}`}
                          color={colorForLine(l, idx + 1)}
                          label={`${l.displayName ?? String(t("admin.ebSplitsPayeeFallback"))} ${formatBps(l.percentBps)}`}
                        />
                      ))}
              </XStack>
              {isResale ? null : (
                <Text
                  variant="bodySmall"
                  weight="bold"
                  tone={reconciles ? "default" : "error"}
                >
                  {reconciles
                    ? String(t("admin.ebSplitsBalanced"))
                    : String(
                        t("admin.ebSplitsOverBy", {
                          amount: formatBps(Math.abs(overByBps)),
                        }),
                      )}
                </Text>
              )}
            </XStack>
            {/* Ticket sales only: a resale splits the markup above face, and
                carries no platform fee, so the caption would be false there. */}
            {effectiveTab === "PRIMARY" ? (
              <Text variant="caption" tone="muted">
                {String(t("admin.ebSplitsCaption"))}
              </Text>
            ) : null}
            {/* Resale: no owner remainder. The lines share the whole share. */}
            {isResale ? (
              <Text
                variant="caption"
                tone="muted"
                data-testid="eb-splits-resale-caption"
              >
                {String(t("deals.resale.lines.caption"))}
              </Text>
            ) : null}
          </YStack>

          {linesFrozen ? (
            <div
              className={styles.frozenLines}
              role="region"
              aria-label={String(t("deals.freeze.linesTitle"))}
              data-testid="eb-splits-frozen"
            >
              <YStack gap={4} flex={1} minWidth={0}>
                <Text variant="overline">
                  {String(
                    t(
                      linesChanging
                        ? "deals.freeze.changingTitle"
                        : "deals.freeze.linesTitle",
                    ),
                  )}
                </Text>
                <Text variant="bodySmall" data-testid="eb-splits-frozen-body">
                  {linesChanging
                    ? String(t("deals.freeze.changingBody"))
                    : linesFollowDeal
                      ? String(t("deals.freeze.linesBody"))
                      : linesTellNames.length > 0
                        ? String(
                            t("deals.freeze.frozenBody", {
                              names: joinNames(linesTellNames, locale),
                            }),
                          )
                        : String(t("deals.freeze.frozenBodyNobody"))}
                </Text>
              </YStack>
              {linesChanging || !linesCanChange ? null : (
                <div className={styles.frozenLinesAction}>
                  <Button
                    variant="secondary"
                    size="$3"
                    // The label wraps at 320; grow with it, never clip.
                    height="auto"
                    minHeight={36}
                    paddingVertical="$2"
                    onPress={() => setLinesChanging(true)}
                    data-testid="eb-splits-change-frozen"
                  >
                    {String(t("deals.freeze.change"))}
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {linesLocked ? (
            // Frozen: the lines as text, nothing to press. They open for
            // editing only through "Change the frozen terms".
            <div
              className={styles.lockable}
              data-locked="true"
              data-testid="eb-splits-lines-body"
            >
              {lines.length > 0 ? (
                <ul
                  className={styles.frozenList}
                  data-testid="eb-splits-frozen-lines"
                >
                  {lines.map((line, idx) => {
                    const isOwner = isAutoOwner(line, effectiveTab);
                    const inactive =
                      line.payeeStatus && line.payeeStatus !== "active";
                    const share = formatBps(
                      isOwner ? ownerDerivedBps : line.percentBps,
                    );
                    return (
                      <li
                        key={line.id ?? `frozen-${idx}`}
                        className={styles.frozenLine}
                        data-testid={`splits-frozen-line-${idx}`}
                      >
                        <div className={styles.frozenLineWho}>
                          <Text variant="bodySmall" weight="bold">
                            {lineName(line)}
                          </Text>
                          {inactive ? (
                            <Text variant="caption" tone="warning">
                              {line.payeeStatus === "missing"
                                ? String(t("admin.ebSplitsNoPayee"))
                                : String(t("admin.ebSplitsConnectPending"))}
                            </Text>
                          ) : null}
                        </div>
                        <div className={styles.frozenLineShare}>
                          <Text
                            variant="bodySmall"
                            weight="bold"
                            data-testid={`splits-frozen-share-${idx}`}
                          >
                            {share}
                          </Text>
                          {isResale ? (
                            <Text
                              variant="caption"
                              tone="muted"
                              data-testid={`splits-portion-${idx}`}
                            >
                              {portionLabel(
                                resalePortions?.get(resaleLineKey(line, idx)),
                              )}
                            </Text>
                          ) : null}
                          {line.requiresConfirmation &&
                          line.confirmationStatus ? (
                            <Badge
                              tone={
                                line.confirmationStatus === "CONFIRMED"
                                  ? "success"
                                  : line.confirmationStatus === "DECLINED"
                                    ? "danger"
                                    : "info"
                              }
                              size="sm"
                            >
                              {line.confirmationStatus}
                            </Badge>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <Text variant="caption" tone="muted">
                  {isResale
                    ? String(t("deals.resale.lines.empty"))
                    : String(t("admin.ebSplitsEmpty"))}
                </Text>
              )}
              {publishBlockersNode}
            </div>
          ) : (
          <div
            className={styles.lockable}
            data-testid="eb-splits-lines-body"
          >
          {/* Line rows. Desktop keeps the bordered table of LineRows; mobile
              renders each line as a discrete stacked EditorCard so the name,
              slider, numeric input, and status don't cram at 360px. */}
          {lines.length > 0 ? (
            <YStack
              {...(isMobile
                ? { gap: 8 }
                : { borderWidth: 1, borderColor: "$borderColor" })}
            >
              {lines.map((line, idx) => {
                const isOwner = isAutoOwner(line, effectiveTab);
                // RESALE: what this line will actually receive of the share.
                const portionNode = isResale ? (
                  <Text
                    variant="caption"
                    tone="muted"
                    data-testid={`splits-portion-${idx}`}
                  >
                    {portionLabel(resalePortions?.get(resaleLineKey(line, idx)))}
                  </Text>
                ) : null;
                const inactivePayee =
                  line.payeeStatus && line.payeeStatus !== "active";
                // Owner uses the muted neutral to match the bar; other lines use
                // the rotating palette. We pass `idx + 1` so the first non-owner
                // doesn't collide with the owner's slot.
                const color = isOwner ? OWNER_COLOR : colorForLine(line, idx + 1);
                const displayPercentBps = isOwner
                  ? ownerDerivedBps
                  : line.percentBps;
                // Show what was typed while a draft is live; fall back to the
                // committed share once it clears (or after a slider drag).
                const percentText =
                  line.percentText ?? String(line.percentBps / 100);
                const percentError = line.percentErrorKey
                  ? String(t(line.percentErrorKey))
                  : null;

                const sourceLabel = isOwner
                  ? String(t("admin.ebSplitsOwnerDesc"))
                  : line.source === "owner"
                    ? String(t("deals.resale.lines.ownerSource"))
                    : line.source === "lineup-picker"
                      ? String(t("admin.ebSplitsFromLineup"))
                      : String(t("admin.ebSplitsManual"));
                const statusBadge =
                  line.requiresConfirmation && line.confirmationStatus ? (
                    <Badge
                      tone={
                        line.confirmationStatus === "CONFIRMED"
                          ? "success"
                          : line.confirmationStatus === "DECLINED"
                            ? "danger"
                            : "info"
                      }
                      size="sm"
                    >
                      {line.confirmationStatus}
                    </Badge>
                  ) : null;

                // ── Mobile: stacked EditorCard ──────────────────────────
                if (isMobile) {
                  return (
                    <EditorCard
                      key={line.id ?? `new-${idx}`}
                      alignItems="flex-start"
                      backgroundColor={
                        inactivePayee ? "$surfaceMuted" : "$surface"
                      }
                      actions={
                        !isOwner ? (
                          <EditorCardActions>
                            <Button
                              variant="ghost"
                              size="$4"
                              icon
                              minWidth={44}
                              onPress={() => handleRemove(idx)}
                              aria-label={String(t("admin.ebSplitsRemoveLine"))}
                              data-testid={`splits-remove-${idx}`}
                            >
                              <Trash2 size={18} />
                            </Button>
                          </EditorCardActions>
                        ) : undefined
                      }
                    >
                      {/* Name row: color chip + ellipsized name (+ lock for owner) */}
                      <XStack gap={8} alignItems="center" minWidth={0}>
                        <div
                          aria-hidden
                          style={{
                            width: 10,
                            height: 18,
                            background: color,
                            flexShrink: 0,
                          }}
                        />
                        <EditorCardTitle>
                          {lineName(line)}
                        </EditorCardTitle>
                        {isOwner ? (
                          <Lock
                            size={12}
                            style={{ opacity: 0.6, flexShrink: 0 }}
                            aria-label={String(t("admin.ebSplitsAutoCalculated"))}
                          />
                        ) : null}
                        {statusBadge}
                      </XStack>

                      <EditorCardMeta>
                        {sourceLabel}
                        {inactivePayee ? (
                          <>
                            {" · "}
                            <Text variant="caption" tone="warning">
                              {line.payeeStatus === "missing"
                                ? String(t("admin.ebSplitsNoPayee"))
                                : String(t("admin.ebSplitsConnectPending"))}
                            </Text>
                          </>
                        ) : null}
                      </EditorCardMeta>

                      {/* Share controls — full-width slider + numeric input,
                          or the Auto badge + derived value for the owner. */}
                      {isOwner ? (
                        <XStack gap={8} alignItems="center" paddingTop={4}>
                          <Badge tone="info" size="sm">
                            Auto
                          </Badge>
                          <Text variant="body" weight="bold">
                            {formatBps(displayPercentBps)}
                          </Text>
                        </XStack>
                      ) : (
                        <YStack gap={8} width="100%" paddingTop={4}>
                          <div
                            style={
                              {
                                width: "100%",
                                // Match this row's slider fill to its bar segment.
                                ["--accent" as never]: color,
                              } as CSSProperties
                            }
                          >
                            <RangeSlider
                              value={Math.round(line.percentBps / 100)}
                              onValueChange={(v) => handlePercentSlide(idx, v)}
                              min={0}
                              max={100}
                              step={1}
                              label={String(
                                t("admin.ebSplitsSharePercentAria", {
                                  name:
                                    line.displayName ??
                                    String(t("admin.ebSplitsPayeeFallback")),
                                }),
                              )}
                            />
                          </div>
                          <XStack gap={8} alignItems="center" width={140}>
                            <TextInput
                              value={percentText}
                              onChangeText={(v: string) =>
                                handlePercentText(idx, v)
                              }
                              placeholder="0"
                              inputMode="decimal"
                              fullWidth
                              minHeight={44}
                              fontSize={16}
                              aria-invalid={percentError ? true : undefined}
                              testId={`splits-percent-${idx}`}
                            />
                            <Text variant="bodySmall" tone="muted">
                              %
                            </Text>
                          </XStack>
                          {percentError ? (
                            <Text variant="caption" tone="error">
                              {percentError}
                            </Text>
                          ) : null}
                          {portionNode}
                        </YStack>
                      )}
                    </EditorCard>
                  );
                }

                // ── Desktop: bordered LineRow (unchanged) ───────────────
                return (
                  <LineRow
                    key={line.id ?? `new-${idx}`}
                    flagged={Boolean(inactivePayee)}
                  >
                    {/* Color chip + name */}
                    <XStack flex={2} minWidth={0} gap={10} alignItems="center">
                      <div
                        aria-hidden
                        style={{
                          width: 10,
                          height: 24,
                          background: color,
                          flexShrink: 0,
                        }}
                      />
                      <YStack minWidth={0} gap={2}>
                        <XStack gap={6} alignItems="center">
                          <Text
                            variant="body"
                            weight="bold"
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {lineName(line)}
                          </Text>
                          {isOwner ? (
                            <Lock
                              size={11}
                              style={{ opacity: 0.6 }}
                              aria-label={String(t("admin.ebSplitsAutoCalculated"))}
                            />
                          ) : null}
                        </XStack>
                        <Text variant="caption" tone="muted">
                          {sourceLabel}
                          {inactivePayee ? (
                            <>
                              {" · "}
                              <Text variant="caption" tone="warning">
                                {line.payeeStatus === "missing"
                                  ? String(t("admin.ebSplitsNoPayee"))
                                  : String(t("admin.ebSplitsConnectPending"))}
                              </Text>
                            </>
                          ) : null}
                        </Text>
                      </YStack>
                    </XStack>

                    {/* Share controls — owner shows an Auto badge + derived value;
										    everyone else gets the slider + numeric input. */}
                    <YStack flex={3} minWidth={180} gap={4}>
                      <XStack gap={10} alignItems="center">
                        {isOwner ? (
                          <XStack
                            flex={1}
                            minWidth={0}
                            gap={10}
                            alignItems="center"
                            justifyContent="flex-end"
                          >
                            <Badge tone="info" size="sm">
                              Auto
                            </Badge>
                            <Text variant="body" weight="bold">
                              {formatBps(displayPercentBps)}
                            </Text>
                          </XStack>
                        ) : (
                          <>
                            <div
                              style={
                                {
                                  flex: 1,
                                  minWidth: 0,
                                  // Override RangeSlider's CSS var so each row's fill
                                  // matches its segment color in the bar above.
                                  ["--accent" as never]: color,
                                } as CSSProperties
                              }
                            >
                              <RangeSlider
                                value={Math.round(line.percentBps / 100)}
                                onValueChange={(v) => handlePercentSlide(idx, v)}
                                min={0}
                                max={100}
                                step={1}
                                label={String(
                                  t("admin.ebSplitsSharePercentAria", {
                                    name:
                                      line.displayName ??
                                      String(t("admin.ebSplitsPayeeFallback")),
                                  }),
                                )}
                              />
                            </div>
                            <XStack gap={4} alignItems="center" width={86}>
                              <TextInput
                                value={percentText}
                                onChangeText={(v: string) =>
                                  handlePercentText(idx, v)
                                }
                                placeholder="0"
                                inputMode="decimal"
                                fullWidth
                                aria-invalid={percentError ? true : undefined}
                                testId={`splits-percent-${idx}`}
                              />
                              <Text variant="bodySmall" tone="muted">
                                %
                              </Text>
                            </XStack>
                          </>
                        )}
                      </XStack>
                      {/* The refusal sits under the whole share cell, not in
                          the 86px numeric column, so it has room to read. */}
                      {percentError && !isOwner ? (
                        <Text variant="caption" tone="error">
                          {percentError}
                        </Text>
                      ) : null}
                      {portionNode}
                    </YStack>

                    {/* Status */}
                    <XStack
                      flex={1}
                      minWidth={0}
                      alignItems="center"
                      justifyContent="flex-end"
                      gap={4}
                    >
                      {line.requiresConfirmation && line.confirmationStatus ? (
                        <Badge
                          tone={
                            line.confirmationStatus === "CONFIRMED"
                              ? "success"
                              : line.confirmationStatus === "DECLINED"
                                ? "danger"
                                : "info"
                          }
                          size="sm"
                        >
                          {line.confirmationStatus}
                        </Badge>
                      ) : (
                        <Text variant="caption" tone="muted">
                          —
                        </Text>
                      )}
                    </XStack>

                    {!isOwner ? (
                      <Button
                        variant="ghost"
                        size="$1"
                        icon
                        onPress={() => handleRemove(idx)}
                        aria-label="Remove line"
                      >
                        <Trash2 size={14} />
                      </Button>
                    ) : (
                      <XStack width={28} />
                    )}
                  </LineRow>
                );
              })}
            </YStack>
          ) : (
            <Text variant="caption" tone="muted">
              {isResale
                ? String(t("deals.resale.lines.empty"))
                : String(t("admin.ebSplitsEmpty"))}
            </Text>
          )}

          {/* Lineup quick-pick chips */}
          {splitsQuery.data && splitsQuery.data.lineupSuggestions.length > 0 ? (
            <YStack gap={8}>
              <Text variant="caption" tone="muted">
                {String(t("admin.ebSplitsFromLineup"))}
              </Text>
              <XStack gap={8} flexWrap="wrap">
                {splitsQuery.data.lineupSuggestions.map((s) => (
                  <Button
                    key={s.eventHumanId}
                    size="$1"
                    variant="secondary"
                    onPress={() => handleAddFromLineup(s)}
                    disabled={s.alreadyOnTerms}
                  >
                    <Users size={11} />
                    {s.displayName ?? "—"} · {s.role}
                    {s.alreadyOnTerms ? " ✓" : ""}
                  </Button>
                ))}
              </XStack>
            </YStack>
          ) : null}

          {/* Search Human/Org + add. Wraps on desktop; stacks full-width on
              mobile so the combobox, % field, and Add button each get a row. */}
          <XStack
            gap={8}
            flexWrap="wrap"
            flexDirection={isMobile ? "column" : "row"}
            alignItems={isMobile ? "stretch" : "flex-end"}
          >
            <YStack
              gap={4}
              {...(isMobile ? { width: "100%" } : { flex: 2, minWidth: 240 })}
            >
              <Text
                variant="caption"
                tone="muted"
                style={{ textTransform: "uppercase" }}
              >
                {String(t("admin.ebSplitsSearchLabel"))}
              </Text>
              <HumanSearchCombobox
                selectedHumanId={searchSelection?.humanId ?? null}
                selectedDisplayName={searchSelection?.displayName ?? null}
                inputValue={searchInput}
                onInputChange={setSearchInput}
                onSelect={(humanId, displayName) =>
                  setSearchSelection({ humanId, displayName })
                }
                onClear={() => setSearchSelection(null)}
                placeholder={String(t("admin.ebSplitsPayeePlaceholder"))}
                fullWidth={isMobile}
              />
            </YStack>
            <YStack
              gap={4}
              {...(isMobile ? { width: "100%" } : { flex: 1, minWidth: 120 })}
            >
              <Text
                variant="caption"
                tone="muted"
                style={{ textTransform: "uppercase" }}
              >
                %
              </Text>
              <TextInput
                value={newLinePercent}
                onChangeText={setNewLinePercent}
                placeholder="0"
                inputMode="decimal"
                fullWidth
                aria-invalid={newLinePercentError ? true : undefined}
                testId="splits-new-percent"
                {...(isMobile ? { minHeight: 44, fontSize: 16 } : {})}
              />
              {newLinePercentError ? (
                <Text variant="caption" tone="error">
                  {newLinePercentError}
                </Text>
              ) : null}
            </YStack>
            <Button
              variant="secondary"
              size={isMobile ? "$4" : "$2"}
              onPress={handleAddFromSearch}
              // An unreadable share blocks the add rather than quietly
              // landing the payee on 0% — which is what `Number(NaN) → 0` did.
              disabled={!searchSelection || newLinePercentError !== null}
              data-testid="splits-add-from-search"
              {...(isMobile ? { width: "100%" } : {})}
            >
              <Plus size={14} />
              {String(t("admin.ebSplitsAdd"))}
            </Button>
          </XStack>

          {saveBlockerMessages.length > 0 ? (
            <YStack
              gap={6}
              padding={12}
              borderWidth={1}
              borderColor="$warning"
              backgroundColor="rgba(250,204,21,0.06)"
              data-testid="eb-splits-save-blockers"
            >
              <Text variant="caption" weight="bold" tone="warning">
                {String(t("deals.splits.saveBlockersTitle"))}
              </Text>
              {saveBlockerMessages.map((msg) => (
                <Text key={msg} variant="caption" tone="muted">
                  • {msg}
                </Text>
              ))}
            </YStack>
          ) : null}
          {publishBlockersNode}

          {linesChanging ? (
            <div className={styles.frozenFooter} data-testid="eb-splits-frozen-footer">
              <Text variant="body">
                {linesTellNames.length > 0
                  ? String(
                      t("deals.freeze.footerTells", {
                        names: joinNames(linesTellNames, locale),
                      }),
                    )
                  : String(t("deals.freeze.footerTellsNobody"))}
              </Text>
              <XStack gap={8} flexWrap="wrap">
                <Button
                  variant="primary"
                  size="$3"
                  onPress={onSave}
                  disabled={
                    updateMutation.isPending || saveBlocked || frozenUnchanged
                  }
                  data-testid="splits-save"
                >
                  {String(t("deals.freeze.save"))}
                </Button>
                <Button
                  variant="ghost"
                  size="$3"
                  onPress={discardLineChanges}
                  disabled={updateMutation.isPending}
                  data-testid="splits-discard"
                >
                  {String(t("deals.freeze.discard"))}
                </Button>
              </XStack>
            </div>
          ) : (
          <XStack justifyContent="flex-end">
            <Button
              variant="primary"
              size="$2"
              onPress={onSave}
              // Disabled AND guarded in `onSave`: a stale share must not reach
              // settlement, and the guard is what a test can prove.
              disabled={updateMutation.isPending || saveBlocked}
              data-testid="splits-save"
            >
              <Save size={14} />
              {String(t("admin.ebSplitsSave"))}
            </Button>
          </XStack>
          )}
          </div>
          )}

          {effectiveTab === "PRIMARY" ? (
            <XStack gap={6} alignItems="center">
              <Sparkles size={11} />
              <Text variant="caption" tone="muted">
                {String(t("admin.ebSplitsComingSoon"))}
              </Text>
            </XStack>
          ) : null}
        </>
      )}
      </LinesFrame>
      )}
    </SectionContainer>
  );
}

/**
 * Around the line-by-line editor. `folded` (ticket sales, under the deal): a
 * disclosure the organiser opens; otherwise (resale) the lines as before.
 */
function LinesFrame({
  folded,
  open,
  onToggle,
  label,
  hint,
  testId,
  children,
}: {
  folded: boolean;
  open: boolean;
  onToggle: () => void;
  label: string;
  hint: string | null;
  testId: string;
  children: ReactNode;
}) {
  if (!folded) return <>{children}</>;
  const panelId = `${testId}-panel`;
  const hintId = `${testId}-hint`;
  return (
    <YStack
      gap={12}
      borderTopWidth={2}
      borderTopColor="$borderColor"
      paddingTop={12}
      data-testid={testId}
    >
      <YStack gap={4} alignItems="flex-start">
        <Button
          variant="ghost"
          size="$3"
          onPress={onToggle}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-describedby={hint ? hintId : undefined}
          data-testid={`${testId}-toggle`}
        >
          <ChevronDown
            size={16}
            strokeWidth={2.5}
            aria-hidden
            className={styles.chevron}
            style={{ transform: open ? "rotate(180deg)" : undefined }}
          />
          {label}
        </Button>
        {hint ? (
          <Text id={hintId} variant="caption" tone="muted">
            {hint}
          </Text>
        ) : null}
      </YStack>
      {open ? (
        <YStack id={panelId} gap={16}>
          {children}
        </YStack>
      ) : null}
    </YStack>
  );
}
