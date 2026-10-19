"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { keepPreviousData } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { XStack, YStack, styled } from "tamagui";
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  CheckCircle2,
  Crosshair,
  Info,
  ScanLine,
  Search,
  SearchX,
  Smartphone,
  XCircle,
} from "lucide-react";

import { Button, Input, Spinner, StyledSelect, Text } from "@th/ui";
import type { StyledSelectOption } from "@th/ui";
import type {
  ResolveScanPayloadOutput,
  ResolveScanPayloadVolunteerResult,
} from "@th/core/use-cases/scanning";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";

import { toneVar } from "./scan-tone";

import {
  ScanResultState,
  useScanVerdict,
  verdictSignature,
} from "./ScanResultState";
import { resolveAdmitOutcome } from "./scan-admit-outcome";
import { describeScanFailure } from "./scan-failure-copy";
import { vibrateForVerdict } from "./scan-feedback";
import type { ScanResultDescriptor } from "./scan-result-presentation";
import {
  EMPTY_SCAN_SESSION_TALLY,
  tallyAdmitOutcome,
  tallyResolvedResult,
  type ScanSessionTally,
} from "./scan-session-tally";
import { useBrowserCamera } from "./use-browser-camera";

/**
 * The web scan surface — the no-install fallback organizers run on a phone
 * browser (FR-011 / FR-013 / FR-014).
 *
 * It is deliberately THINNER than the scanner app: no offline manifest, no
 * admit queue, no torch, no express mode. The page says so, once, and links to
 * the app (install links live in
 * `docs/decisions/scanner-distribution-native-internal-tracks.md` and on the Scanner
 * Setup page — referenced here, never duplicated).
 *
 * Everything that decides WHAT an outcome means lives in the pure modules
 * beside this file and is asserted in node. This component owns interaction and
 * layout only.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Badge vocabulary for the SEARCH rows. Not the verdict tone families. */
type Tone = "success" | "warning" | "danger" | "neutral";

// ── Styled primitives ───────────────────────────────────────────────────────

/**
 * The page frame carries NO horizontal padding: the verdict band has to reach
 * the edges, and a full-bleed state with a gutter around it is not full-bleed,
 * it is a big card — which is the thing FR-013 replaces. Everything that is NOT
 * the band sits inside `Padded`.
 *
 * That alone was not enough: the admin shell's `ContentArea` pads every route
 * 24px, so the band still rendered inside a cream gutter. `FullBleedBand`
 * (`ScanResultState.tsx`) cancels the shell's padding; this frame's job is only
 * to not add a SECOND one.
 */
const Page = styled(YStack, {
  name: "UnifiedScanPage",
  gap: "$5",
  paddingVertical: "$4",
  width: "100%",
  maxWidth: 960,
  marginHorizontal: "auto",
  $gtMd: { paddingVertical: "$6" },
});

const Padded = styled(YStack, {
  name: "UnifiedScanPadded",
  paddingHorizontal: "$4",
  $gtMd: { paddingHorizontal: "$6" },
});

const SectionNumber = styled(Text, {
  name: "UnifiedScanSectionNumber",
  color: "$brandSecondary",
  fontSize: "$2",
  letterSpacing: 2,
  textTransform: "uppercase",
});

const Card = styled(YStack, {
  name: "UnifiedScanCard",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  padding: "$5",
  gap: "$4",
});

const Badge = styled(XStack, {
  name: "UnifiedScanBadge",
  paddingHorizontal: "$3",
  paddingVertical: "$1",
  alignItems: "center",
  gap: "$2",
  borderWidth: 2,
  variants: {
    tone: {
      success: { borderColor: "$success", backgroundColor: "$surface" },
      warning: { borderColor: "$warning", backgroundColor: "$surface" },
      danger: { borderColor: "$danger", backgroundColor: "$surface" },
      neutral: {
        borderColor: "$borderColorStrong",
        backgroundColor: "$surface",
      },
    },
  } as const,
});

const RowButton = styled(XStack, {
  name: "UnifiedScanRowButton",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  padding: "$4",
  gap: "$3",
  alignItems: "center",
  cursor: "pointer",
  minHeight: 56,
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
    borderColor: "$borderColorStrong",
  },
  pressStyle: {
    backgroundColor: "$surfaceMuted",
    scale: 0.99,
  },
  focusStyle: {
    borderColor: "$brandSecondary",
  },
  variants: {
    disabled: {
      true: {
        opacity: 0.5,
        cursor: "default",
        hoverStyle: {},
        pressStyle: {},
      },
    },
  } as const,
});

const CameraSurface = styled(YStack, {
  name: "UnifiedScanCameraSurface",
  width: "100%",
  height: 320,
  overflow: "hidden",
  backgroundColor: "$surfaceMuted",
  position: "relative",
  borderWidth: 2,
  borderColor: "$borderColor",
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  neutral: Info,
};

const TONE_TEXT_COLOR: Record<Tone, string> = {
  success: "$success",
  warning: "$warning",
  danger: "$danger",
  neutral: "$borderColorStrong",
};

/*
 * There is NO screen-reader-only live region on this page.
 *
 * The verdict block IS the live region — `role="alert"` +
 * `aria-live="assertive"`, the one place in the design system where
 * interruption is correct (DS D-125). A second polite `role="status"` span
 * used to sit here mirroring the same text, and running both reads every
 * verdict twice. Double-announcing was a defect already fixed on this page
 * once; do not reintroduce it in the other direction.
 */

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <Badge tone={tone}>
      <Icon
        size={14}
        color={`var(--${TONE_TEXT_COLOR[tone].slice(1)})`}
        aria-hidden
      />
      <Text
        variant="bodySmall"
        weight="bold"
        fontSize="$1"
        textTransform="uppercase"
        letterSpacing={1}
        color={TONE_TEXT_COLOR[tone]}
      >
        {label}
      </Text>
    </Badge>
  );
}

/**
 * Stable ids so focus can be restored to a real control after a verdict is
 * dismissed. Door mode takes the page chrome out of the DOM, so the element
 * focus SHOULD return to does not exist at the moment dismiss is called — a
 * captured ref would be stale by definition, which is why this goes by id after
 * a paint.
 */
const PASTE_INPUT_ID = "scan-paste-input";
const SEARCH_INPUT_ID = "scan-search-input";
const CAMERA_TOGGLE_ID = "scan-mode-camera";

/**
 * Fresh per-scan idempotency key.
 *
 * `scanTicket`'s idempotency window is 10s, keyed on `clientKey`. A key that is
 * constant for the session means (a) a second tap on one card replays the
 * cached ACCEPTED, and (b) two different tickets admitted inside the same 10s
 * collide on one key with different payloads — an `IDEMPOTENCY_KEY_CONFLICT` at
 * a door. One key per resolved card gives the retry semantics the mechanism was
 * built for and nothing else.
 */
const mintClientKey = (): string => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/** `navigator.onLine`, defensively — it does not exist server-side. */
const isOnline = (): boolean | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.onLine;

/**
 * A resolve is a POINT-IN-TIME reading of a bearer credential, never a
 * cacheable list.
 *
 * `makeQueryClient` defaults every query to `staleTime: 60_000` and
 * `utils.*.fetch` merges those defaults, so the same `(eventId, raw)` inside a
 * minute never reached the server. Verified in the browser: resolving one
 * payload twice fired exactly one request. At a door that means attendee A is
 * admitted at 21:00:05 and attendee B presents a screenshot of the same QR at
 * 21:00:40 to a green ADMIT with a live Admit button — the ALREADY IN state,
 * which is the entire mechanism by which pass-sharing gets caught, is invisible
 * for the rest of the minute.
 *
 * `gcTime: 0` is the second half: ticket codes and volunteer JWTs are bearer
 * credentials with no business sitting in a retained cache after the card is
 * dismissed (NFR-005). `apps/web/src/hooks/useSurpriseMe.ts` documents the same
 * trap and the same fix.
 */
export const RESOLVE_FETCH_OPTIONS = { staleTime: 0, gcTime: 0 } as const;

/**
 * One half of the camera/search toggle.
 *
 * Extracted because the two halves were copy-pasted, and the copy is how the
 * active label came to be `$colorInverted` while the comment two lines above it
 * said `$onStructure`: on Ember, `$colorInverted` against `$backgroundStrong`
 * measures **1.22:1** — the label was invisible on that theme. `$onStructure`
 * is 14.60:1 there and is the repo's established foreground for a
 * `$backgroundStrong` fill.
 * One implementation, one token, no way for the glyph and its label to disagree
 * again.
 */
function ModeToggleHalf({
  id,
  label,
  icon: Icon,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  icon: typeof Camera;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <XStack
      flex={1}
      paddingHorizontal="$4"
      paddingVertical="$3"
      gap="$2"
      alignItems="center"
      justifyContent="center"
      cursor="pointer"
      minHeight={44}
      backgroundColor={active ? "$backgroundStrong" : "transparent"}
      onPress={onSelect}
      aria-pressed={active}
      {...({
        id,
        role: "button",
        tabIndex: 0,
        onKeyDown: (e: ReactKeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        },
      } as unknown as Record<string, unknown>)}
    >
      <Icon
        size={16}
        color={active ? toneVar("onStructure") : undefined}
        aria-hidden
      />
      <Text
        variant="bodySmall"
        weight={active ? "bold" : "medium"}
        textTransform="uppercase"
        letterSpacing={1}
        color={active ? "$onStructure" : "$color"}
      >
        {label}
      </Text>
    </XStack>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// ─────────────────────────────────────────────────────────────────────────────
// UnifiedScanView
// ─────────────────────────────────────────────────────────────────────────────

export function UnifiedScanView() {
  const params = useParams();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const { data: session } = authClient.useSession();
  const operatorHumanId = session?.user?.id ?? "anon";

  // ── Resolve orgId from slug ─────────────────────────────────────────────
  const ownerEntitiesQuery = trpc.events.listEventOwnerEntities.useQuery(
    {},
    { staleTime: 60_000 },
  );

  const currentOwner = useMemo(() => {
    if (!ownerEntitiesQuery.data?.owners) return null;
    const normalizedSlug = slug.toLowerCase().replace(/^@/, "");
    return ownerEntitiesQuery.data.owners.find((owner) => {
      if (owner.kind === "human") {
        const candidates = [
          owner.humanUsername?.toLowerCase() ?? null,
          owner.humanProfileSlug?.toLowerCase() ?? null,
          owner.humanId.toLowerCase(),
        ];
        return candidates.some((c) => c === normalizedSlug);
      }
      const orgSlug = owner.orgSlug ?? owner.orgId;
      return orgSlug.toLowerCase().replace(/^@/, "") === normalizedSlug;
    });
  }, [ownerEntitiesQuery.data, slug]);

  const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : null;
  /**
   * Volunteer check-in is `ORG_EDIT_ROLES` server-side
   * (`packages/core/src/lib/rbac.ts`). This used to be `kind === "org"`, which
   * is true for a SCANNER-role operator too — so the design's "this is the
   * action, and it is not yours" locked state could never render in production
   * and a scanner-only operator tapped a live button into a 403.
   */
  const canCheckInVolunteer =
    currentOwner?.kind === "org" &&
    (["OWNER", "ADMIN", "EDITOR"] as readonly string[]).includes(
      currentOwner.role,
    );

  // ── Event picker ────────────────────────────────────────────────────────
  const eventsQuery = trpc.events.listMine.useQuery(
    {
      ownerType: "ORGANIZATION" as const,
      ownerId: orgId ?? "",
      status: ["PUBLISHED"],
      limit: 50,
    },
    { staleTime: 60_000, enabled: !!orgId },
  );

  const events = useMemo(
    () => eventsQuery.data?.items ?? [],
    [eventsQuery.data],
  );

  const [eventId, setEventId] = useState<string | null>(null);

  // Auto-select the soonest upcoming event so the operator lands ready to
  // scan. We never overwrite an explicit choice.
  useEffect(() => {
    if (eventId || events.length === 0) return;
    const now = Date.now();
    const upcoming = events
      .filter(
        (e): e is typeof e & { startsAt: Date } =>
          e.startsAt != null &&
          e.startsAt.getTime() >= now - 6 * 60 * 60 * 1000,
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const next = upcoming[0] ?? events[0];
    if (next) setEventId(next.id);
  }, [events, eventId]);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === eventId) ?? null,
    [events, eventId],
  );

  const eventOptions = useMemo<StyledSelectOption[]>(
    () =>
      events.map((evt) => {
        // `title` is nullable on a draft row; an unlabelled <option> is an
        // unpickable event.
        const title = evt.title ?? "Untitled event";
        return {
          value: evt.id,
          label: evt.startsAt
            ? `${title} — ${new Date(evt.startsAt).toLocaleString()}`
            : title,
        };
      }),
    [events],
  );

  // ── Result + capture state ──────────────────────────────────────────────
  const [result, setResult] = useState<ResolveScanPayloadOutput | null>(null);
  /**
   * A verdict that OUTRANKS the live resolve envelope: a thrown round trip, or
   * a `scanTicket` the server answered REJECTED. A descriptor rather than a
   * string, so each of those keeps its own glyph / verdict word / badge instead
   * of collapsing into one "SCAN FAILED".
   */
  const [override, setOverride] = useState<ScanResultDescriptor | null>(null);
  /**
   * The card on screen is the one THIS operator just admitted.
   *
   * A ticket is `SCANNED` both when we admit it and when it comes back already
   * used, and the envelope is byte-identical in the two cases — so the fact has
   * to be carried, not inferred. It exists to keep the green ADMITTED
   * confirmation and the amber ALREADY IN warning from ever looking the same
   * (`ADMITTED_PRESENTATION`).
   *
   * Written ONLY through {@link showCard}, so it cannot drift from `result`.
   */
  const [admitted, setAdmitted] = useState(false);
  const [resolving, setResolving] = useState(false);
  const inFlightRef = useRef(false);

  /**
   * Which verdict the screen currently OWNS.
   *
   * Bumped whenever the operator moves on (dismiss, event switch). Every async
   * path captures it before awaiting and drops its result if it no longer
   * matches, so a slow round trip cannot resurrect a verdict on a screen that
   * has already moved to the next person. Phase A shipped exactly this bug in
   * the other direction; the fix belongs at every await, not at one of them.
   */
  const verdictSeqRef = useRef(0);
  /** Per-scan idempotency key, minted with each new card. */
  const clientKeyRef = useRef<string>(mintClientKey());

  /**
   * The ONE way a card reaches the screen.
   *
   * `result`, `override` and `admitted` describe a single thing — what the
   * operator is looking at — and three independent setters is how they drift.
   * A resolve that forgot `setAdmitted(false)` would paint the next person's
   * pass as "ADMITTED" in green.
   *
   * The reset here is an INVARIANT, not a live bug fix: nothing can currently
   * swap the card without a dismiss (which clears it) in between, so a plant
   * that removes this reset leaves the suite green. It stays because the day
   * something can — a cross-ticket jump, an express mode — the failure would be
   * a green ADMITTED on a pass nobody admitted, and that is not a defect worth
   * discovering in production.
   */
  const showCard = useCallback(
    (next: ResolveScanPayloadOutput, opts?: { admitted?: boolean }) => {
      setOverride(null);
      setResult(next);
      setAdmitted(opts?.admitted === true);
    },
    [],
  );

  /** The ONE way a card leaves the screen. Retires any resolve still in flight. */
  const clearCard = useCallback(() => {
    verdictSeqRef.current += 1;
    setResult(null);
    setOverride(null);
    setAdmitted(false);
  }, []);

  const [view, setView] = useState<"camera" | "search">("camera");
  const [pasteDraft, setPasteDraft] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const debouncedSearch = useDebouncedValue(searchDraft.trim(), 300);

  /**
   * FR-014 — replaces the old `scanCount` ("resolved this session"), which
   * incremented on every lookup, every re-resolve after an admit and every
   * wrong-event scan, so it always over-reported. The rules live in
   * `scan-session-tally.ts` and are asserted in node; this is just the state.
   */
  const [tally, setTally] = useState<ScanSessionTally>(EMPTY_SCAN_SESSION_TALLY);

  // ── tRPC handles ────────────────────────────────────────────────────────
  //
  // Every scan mutation is `meta: { silent: true }`. The full-bleed verdict is
  // the design's primary signal for a scan outcome, and the global notifier
  // firing a "SOMETHING WENT WRONG" toast on top of it gave one failure two
  // voices — one of which said less than the other and covered part of the
  // screen. One channel, and it is the one the design specifies.
  const utils = trpc.useUtils();
  const mintScanToken = trpc.volunteer.signups.mintScanToken.useMutation({
    meta: { silent: true },
  });
  const scanTicketMutation = trpc.tickets.scanTicket.useMutation({
    meta: { silent: true },
  });
  const checkInMutation = trpc.volunteer.signups.checkIn.useMutation({
    meta: { silent: true },
  });

  /**
   * One place a thrown scan call becomes a verdict.
   *
   * Sentry is called explicitly because `meta: { silent: true }` short-circuits
   * `GlobalQueryErrorLogger` BEFORE its capture, not just before its toast —
   * silencing the toast without this would silently un-Sentry the whole scan
   * surface.
   */
  const failVerdict = useCallback(
    (
      err: unknown,
      op: "resolve" | "resolve-volunteer" | "admit" | "volunteer-check-in",
    ) => {
      try {
        Sentry.captureException(err, {
          tags: { area: "scan", surface: "web-scan", scanOp: op },
        });
      } catch {
        // A throwing reporter must never change what the operator is shown.
      }
      const failure = describeScanFailure(err, { online: isOnline() });
      setOverride({
        kind: "failure",
        // A lookup that threw reads SCAN FAILED; only a write that threw reads
        // NOT RECORDED — the same split as `apps/scanner`.
        stage:
          op === "resolve" || op === "resolve-volunteer" ? "lookup" : "record",
        // The CLASSIFIED sentence becomes the verdict's `detail` (the WHY); the
        // raw server string can only ever reach the screen as `supportRef`.
        detail: failure.guidance,
        supportRef: failure.detail,
      });
    },
    [],
  );

  const searchEnabled =
    !!eventId &&
    view === "search" &&
    debouncedSearch.length >= 2 &&
    !result &&
    !override;

  const searchQuery = trpc.scan.searchUnified.useQuery(
    {
      eventId: eventId ?? "",
      query: debouncedSearch,
      limit: 20,
    },
    {
      enabled: searchEnabled,
      staleTime: 5_000,
      placeholderData: keepPreviousData,
    },
  );

  const tickets = searchQuery.data?.tickets.items ?? [];
  const volunteers = searchQuery.data?.volunteers ?? [];

  // ── Camera enabled gate ─────────────────────────────────────────────────
  // Three-tier guard, ordered most-restrictive first:
  // 1. eventId required (resolver requires it)
  // 2. view must be camera (not search)
  // 3. no live result, no resolve in flight, and no override verdict (a
  //    failure or a rejected admit still owns the screen until it is dismissed)
  const cameraEnabled =
    !!eventId && view === "camera" && !result && !resolving && !override;

  // ── Resolver ────────────────────────────────────────────────────────────

  const resolveByRaw = useCallback(
    async (raw: string) => {
      if (!eventId) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const seq = verdictSeqRef.current;
      setResolving(true);
      setOverride(null);
      try {
        const next = await utils.scan.resolvePayload.fetch(
          { eventId, raw },
          RESOLVE_FETCH_OPTIONS,
        );
        // The tally is a durable count of what happened and is recorded even if
        // the screen has moved on; the VERDICT belongs to whoever owns the
        // screen now.
        setTally((prev) => tallyResolvedResult(prev, next));
        if (verdictSeqRef.current !== seq) return;
        clientKeyRef.current = mintClientKey();
        showCard(next);
      } catch (err) {
        if (verdictSeqRef.current !== seq) return;
        failVerdict(err, "resolve");
      } finally {
        inFlightRef.current = false;
        setResolving(false);
      }
    },
    [eventId, failVerdict, showCard, utils.scan.resolvePayload],
  );

  /**
   * The decoded string goes to the server VERBATIM.
   *
   * This used to upper-case anything that parsed as a bare ticket code. Real
   * minted codes are lowercase `tk_<hex>` and `Ticket.code` is a case-sensitive
   * unique column, so every upper-cased camera decode MISSED the unique index
   * and fell through to the repo's `lower(code)` tolerance path — a sequential
   * scan of the whole `Ticket` table, in the admission hot loop, on every
   * scan. The native scanner has always sent the payload as decoded, which is
   * why it hits the fast path. Normalisation is now strictly a hand-typed-input
   * concern (`handlePasteSubmit` trims, and nothing else).
   */
  const handleCameraDecode = useCallback(
    (data: string) => {
      void resolveByRaw(data);
    },
    [resolveByRaw],
  );

  const { videoRef, cameraError } = useBrowserCamera({
    enabled: cameraEnabled,
    onScan: handleCameraDecode,
  });

  const handlePasteSubmit = useCallback(() => {
    // Trim only: a volunteer pass is a signed JWT (case-sensitive) and a
    // ticket code is compared byte-for-byte, so changing case here would break
    // one and slow the other.
    const trimmed = pasteDraft.trim();
    if (trimmed.length < 4) return;
    void resolveByRaw(trimmed);
    setPasteDraft("");
  }, [pasteDraft, resolveByRaw]);

  /**
   * Put the caret back in the live code field, and bring it on screen.
   *
   * The door case this exists for is a USB/Bluetooth barcode wedge: it types
   * into whatever has focus, so one stray tap on the page and every scan goes
   * nowhere with no error to show for it. Secondarily it is the way back to
   * the camera after scrolling down to the app hint on a phone.
   *
   * Addressed by element id rather than a ref because both inputs already
   * carry stable ids for their labels, and `Input` is a Tamagui/RNW component
   * whose ref is not contractually the DOM node.
   */
  const focusScanner = useCallback(() => {
    const el = document.getElementById(
      view === "camera" ? PASTE_INPUT_ID : SEARCH_INPUT_ID,
    ) as HTMLInputElement | null;
    if (!el) return;
    // `center` keeps the camera surface (directly above the paste field) in
    // frame too, so this reads as "back to scanning", not "jump to a textbox".
    el.scrollIntoView({ block: "center" });
    el.focus();
    el.select();
  }, [view]);

  /**
   * Dismiss, and give the keyboard somewhere to land.
   *
   * Door mode unmounts the page chrome while a verdict is up, so on dismiss the
   * browser drops focus to `<body>`: a keyboard or switch-control operator has
   * to traverse the entire admin shell again between every single scan. The
   * chrome does not exist yet at the moment this runs, hence the post-paint
   * lookup by id rather than a (necessarily stale) ref.
   */
  const dismissResult = useCallback(() => {
    clearCard();
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const next =
        document.getElementById(PASTE_INPUT_ID) ??
        document.getElementById(SEARCH_INPUT_ID) ??
        document.getElementById(CAMERA_TOGGLE_ID);
      next?.focus?.();
    });
  }, [clearCard]);

  // ── Volunteer search row → resolve ──────────────────────────────────────

  const resolveVolunteerCandidate = useCallback(
    async (
      candidate: ResolveScanPayloadVolunteerResult["candidates"][number],
    ) => {
      if (!eventId) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const seq = verdictSeqRef.current;
      setOverride(null);
      setResolving(true);
      try {
        if (candidate.status === "APPROVED") {
          const { token } = await mintScanToken.mutateAsync({
            signupId: candidate.signupId,
            kind: "short",
          });
          const next = await utils.scan.resolvePayload.fetch(
            { eventId, raw: token },
            RESOLVE_FETCH_OPTIONS,
          );
          if (verdictSeqRef.current !== seq) return;
          clientKeyRef.current = mintClientKey();
          showCard(next);
          return;
        }
        // Non-APPROVED: minting would 4xx. Synthesize an informational
        // envelope so the same result path renders, just without a check-in
        // CTA — the operator can still confirm "already checked in" or
        // "marked no-show".
        if (verdictSeqRef.current !== seq) return;
        clientKeyRef.current = mintClientKey();
        showCard({
          kind: "volunteer",
          humanId: candidate.humanId,
          displayName: candidate.humanDisplayName,
          candidates: [candidate],
          alsoHoldsTicket: [],
        });
      } catch (err) {
        if (verdictSeqRef.current !== seq) return;
        failVerdict(err, "resolve-volunteer");
      } finally {
        inFlightRef.current = false;
        setResolving(false);
      }
    },
    [eventId, failVerdict, mintScanToken, showCard, utils.scan.resolvePayload],
  );

  // ── Action handlers ─────────────────────────────────────────────────────

  /**
   * Admit, and let the ADMIT OUTCOME win the screen.
   *
   * There is no re-resolve here any more, and that is the fix, not a shortcut.
   * The old code admitted, then re-fetched the ticket purely to repaint the
   * card as SCANNED — and when that decorative fetch failed it replaced a
   * successful admission with a full-bleed red SCAN FAILED. Observed at a door:
   * the tally read 1 ADMITTED, the database read `SCANNED`, and the operator
   * was looking at an error, from which the only sane-looking actions are to
   * turn the person away or re-scan them.
   *
   * `scanTicket`'s response already carries everything the post-admit card
   * needs, and admitting a ticket changes nothing else about it, so the next
   * state is derived synchronously from the answer we already trust
   * (`resolveAdmitOutcome`). Nothing is left in flight that could overwrite it.
   *
   * A REJECTED outcome is a 200, not a throw, and used to be dropped on the
   * floor — no message, no tally change, the button simply re-enabled. It now
   * gets its own verdict.
   *
   * The resulting card is flagged `admitted` on ACCEPTED (and only then), which
   * is what turns it into the green ADMITTED confirmation rather than the amber
   * ALREADY IN warning. A REPLAY keeps the amber, because a replay genuinely
   * means someone had already let this person in.
   */
  const admitTicketCode = useCallback(
    async (ticketCode: string) => {
      if (!eventId) return;
      const seq = verdictSeqRef.current;
      try {
        const outcome = await scanTicketMutation.mutateAsync({
          eventId,
          ticketCode,
          clientKey: `unified-scan-${operatorHumanId}-${clientKeyRef.current}`,
        });
        // FR-014 — count what the SERVER did, not what we asked it to do. The
        // count is durable and is recorded even if the screen has moved on.
        setTally((prev) => tallyAdmitOutcome(prev, outcome, ticketCode));
        if (verdictSeqRef.current !== seq) return;
        const next = resolveAdmitOutcome(result, outcome, ticketCode);
        if (next.kind === "result") {
          showCard(next.result, { admitted: next.admitted });
        } else {
          setOverride(next.descriptor);
        }
      } catch (err) {
        if (verdictSeqRef.current !== seq) return;
        failVerdict(err, "admit");
      }
    },
    [
      eventId,
      failVerdict,
      operatorHumanId,
      result,
      scanTicketMutation,
      showCard,
    ],
  );

  const checkInVolunteer = useCallback(
    async (signupId: string) => {
      const seq = verdictSeqRef.current;
      try {
        await checkInMutation.mutateAsync({ signupId });
        if (verdictSeqRef.current !== seq) return;
        // No token in hand to re-resolve with, so update the envelope locally.
        // Not through `showCard`: this is the SAME card being edited in place,
        // and a volunteer envelope can never carry the `admitted` flag anyway
        // (that is a ticket concept).
        setResult((prev) => {
          if (prev?.kind !== "volunteer") return prev;
          return {
            ...prev,
            candidates: prev.candidates.map((c) =>
              c.signupId === signupId
                ? {
                    ...c,
                    status: "CHECKED_IN" as const,
                    checkedInAt: new Date().toISOString(),
                  }
                : c,
            ),
          };
        });
      } catch (err) {
        if (verdictSeqRef.current !== seq) return;
        failVerdict(err, "volunteer-check-in");
      }
    },
    [checkInMutation, failVerdict],
  );

  // ── Verdict ─────────────────────────────────────────────────────────────

  const verdict = useScanVerdict({
    result,
    override,
    admitted,
    selectedEventName: selectedEvent?.title ?? null,
    canCheckInVolunteer,
  });

  /**
   * Haptic feedback. Visual is the only REQUIRED channel (iOS Safari has no
   * vibration API at all); vibration is additive where the platform allows.
   * NFR-006: a throw from a present API is reported, never swallowed.
   *
   * Keyed on the shared VERDICT KEY, not on the tone — there are two tones and
   * four signatures, because the visual system no longer separates "seen this
   * pass" from "wrong show" and in a dark room the haptic is the only channel
   * left that does.
   *
   * Fires once per VERDICT, not once per render of one. Several things
   * re-derive the verdict object without changing what the operator is being
   * told — a volunteer check-in rewriting the envelope in place, the owner
   * query settling `canCheckInVolunteer` — and buzzing the phone again for a
   * state that did not change teaches the operator to ignore the cue.
   */
  const lastCueRef = useRef<string | null>(null);
  useEffect(() => {
    if (!verdict) {
      lastCueRef.current = null;
      return;
    }
    // Shared with the band's stamp, so the buzz and the stamp mark the same
    // verdicts.
    const signature = verdictSignature(verdict);
    if (lastCueRef.current === signature) return;
    lastCueRef.current = signature;
    vibrateForVerdict(verdict.presentation.key, {
      reportError: (err) =>
        Sentry.captureException(err, {
          tags: { area: "scan", surface: "web-scan-feedback" },
        }),
    });
  }, [verdict]);

  return (
    <Page>
      {verdict ? (
        /*
          Door mode: while a verdict is up, the page chrome (title, picker,
          mode toggle, camera) is OUT of the document, not merely below it. At
          375px the header + picker + toggle is ~300px, which would push the
          verdict below the fold — and the verdict is the only thing the
          operator is looking at.
        */
        <>
          <Padded>
            <SessionTally
              tally={tally}
              eventTitle={selectedEvent?.title ?? null}
            />
          </Padded>
          <ScanResultState
            verdict={verdict}
            onDismiss={dismissResult}
            onAdmitTicket={(code) => void admitTicketCode(code)}
            admitPending={scanTicketMutation.isPending}
            onCheckInVolunteer={(id) => void checkInVolunteer(id)}
            checkInPending={checkInMutation.isPending}
            onScanCrossTicket={(code) => void resolveByRaw(code)}
            resolvePending={resolving}
          />
        </>
      ) : (
        <>
          {/* Header */}
          <Padded>
            <YStack gap="$2">
              <SectionNumber weight="bold">01. Unified scan</SectionNumber>
              <XStack
                gap="$3"
                alignItems="center"
                justifyContent="space-between"
                flexWrap="wrap"
              >
                <XStack gap="$3" alignItems="center">
                  <ScanLine size={28} strokeWidth={2.5} aria-hidden />
                  <Text
                    weight="bold"
                    fontSize="$8"
                    textTransform="uppercase"
                    letterSpacing={-1}
                  >
                    Scan
                  </Text>
                </XStack>
                {eventId ? (
                  <Button
                    variant="secondary"
                    size="$3"
                    onPress={focusScanner}
                    data-testid="scan-focus-btn"
                  >
                    <Crosshair size={16} aria-hidden />
                    Focus scanner
                  </Button>
                ) : null}
              </XStack>
              <Text variant="body" tone="muted">
                Scan ticket QR codes or volunteer passes. Search by name, email,
                or code if scanning isn&apos;t working.
              </Text>
              <SessionTally tally={tally} eventTitle={null} />
              <ScannerAppHint slug={slug} />
            </YStack>
          </Padded>

          {/* Event picker */}
          <Padded>
            {!orgId ? (
              <XStack gap="$3" alignItems="center" padding="$4">
                <Spinner size="sm" />
                <Text variant="body" tone="muted">
                  {ownerEntitiesQuery.isLoading
                    ? "Resolving group…"
                    : "This page is only available for group admins."}
                </Text>
              </XStack>
            ) : (
              <Card>
                <SectionNumber weight="bold">02. Event</SectionNumber>
                {eventsQuery.isLoading ? (
                  <XStack gap="$3" alignItems="center">
                    <Spinner size="sm" />
                    <Text variant="body" tone="muted">
                      Loading events…
                    </Text>
                  </XStack>
                ) : events.length === 0 ? (
                  <Text variant="body" tone="muted">
                    No published events found for this group.
                  </Text>
                ) : (
                  <YStack gap="$2">
                    {/*
                      A wrapping <label> is what actually names the control:
                      `StyledSelect` renders its own hidden native <select>, and
                      an aria-label passed from here would land on the styled
                      FRAME, leaving the focusable element unnamed.
                    */}
                    <label>
                      <YStack gap="$2">
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          textTransform="uppercase"
                          letterSpacing={1}
                          tone="muted"
                        >
                          Select event
                        </Text>
                        <StyledSelect
                          value={eventId ?? ""}
                          options={eventOptions}
                          onChange={(value) => {
                            setEventId(value || null);
                            // A verdict belongs to the event it was resolved
                            // against; switching events retires it, and
                            // `clearCard` also drops any resolve in flight.
                            clearCard();
                            setSearchDraft("");
                          }}
                          fullWidth
                          // 44px minimum touch target: `lg` is 42.
                          height={44}
                          minHeight={44}
                          testId="scan-event-select"
                        />
                      </YStack>
                    </label>
                    {selectedEvent ? (
                      <Text variant="bodySmall" tone="muted">
                        Scanning for{" "}
                        <Text weight="bold">{selectedEvent.title}</Text>
                      </Text>
                    ) : null}
                  </YStack>
                )}
              </Card>
            )}
          </Padded>

          {/* Mode toggle */}
          {eventId ? (
            <Padded>
              <XStack gap={0} borderWidth={2} borderColor="$borderColor">
                <ModeToggleHalf
                  id={CAMERA_TOGGLE_ID}
                  label="Camera"
                  icon={Camera}
                  active={view === "camera"}
                  onSelect={() => {
                    setView("camera");
                    setSearchDraft("");
                  }}
                />
                <ModeToggleHalf
                  id="scan-mode-search"
                  label="Search"
                  icon={Search}
                  active={view === "search"}
                  onSelect={() => {
                    setView("search");
                    clearCard();
                  }}
                />
              </XStack>
            </Padded>
          ) : null}

          {/* Camera view */}
          {eventId && view === "camera" ? (
            <Padded>
              <Card>
                <SectionNumber weight="bold">03. Camera</SectionNumber>
                {cameraError ? (
                  <Text variant="body" tone="error" role="alert">
                    {cameraError}
                  </Text>
                ) : null}
                <CameraSurface>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                  {resolving ? (
                    <XStack
                      position="absolute"
                      top={0}
                      left={0}
                      right={0}
                      bottom={0}
                      backgroundColor="rgba(0,0,0,0.45)"
                      alignItems="center"
                      justifyContent="center"
                      gap="$3"
                    >
                      <Spinner size="md" />
                      {/* This scrim paints on the CAMERA FEED, which is dark in
                          every theme — so the foreground is judged by that
                          surface, not by the theme it happens to sit inside.
                          `$onStructure` is the only light-in-all-three-themes
                          foreground token (#FFFFFF / #FFFFFF / #FDFAF3);
                          `$colorInverted` is DARK on Ember and this label was
                          invisible there. */}
                      <Text variant="body" color="$onStructure" weight="bold">
                        Resolving…
                      </Text>
                    </XStack>
                  ) : null}
                </CameraSurface>

                {/* Manual paste fallback */}
                <YStack gap="$2">
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    textTransform="uppercase"
                    letterSpacing={1}
                    tone="muted"
                  >
                    Or paste a code
                  </Text>
                  <XStack gap="$2" alignItems="center">
                    <Input
                      id={PASTE_INPUT_ID}
                      placeholder="Ticket code or volunteer pass"
                      value={pasteDraft}
                      onChangeText={setPasteDraft}
                      onSubmitEditing={handlePasteSubmit}
                      size="$4"
                      flex={1}
                      autoCapitalize="none"
                      autoCorrect={false}
                      aria-label="Paste a code"
                    />
                    <Button
                      variant="secondary"
                      size="$4"
                      onPress={handlePasteSubmit}
                      disabled={pasteDraft.trim().length < 4 || resolving}
                    >
                      Resolve
                    </Button>
                  </XStack>
                </YStack>
              </Card>
            </Padded>
          ) : null}

          {/* Search view */}
          {eventId && view === "search" ? (
            <Padded>
              <Card>
                <SectionNumber weight="bold">03. Search</SectionNumber>
                <XStack gap="$3" alignItems="center">
                  <Search size={20} style={{ flexShrink: 0 }} aria-hidden />
                  <Input
                    id={SEARCH_INPUT_ID}
                    placeholder="Name, email, or ticket code"
                    value={searchDraft}
                    onChangeText={setSearchDraft}
                    size="$4"
                    flex={1}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    aria-label="Search query"
                  />
                </XStack>
                {debouncedSearch.length < 2 ? (
                  <Text
                    variant="bodySmall"
                    tone="muted"
                    textTransform="uppercase"
                    letterSpacing={0.5}
                  >
                    Type at least 2 characters to search.
                  </Text>
                ) : searchQuery.isFetching ? (
                  <XStack justifyContent="center" padding="$4">
                    <Spinner size="md" />
                  </XStack>
                ) : tickets.length === 0 && volunteers.length === 0 ? (
                  <YStack alignItems="center" gap="$3" padding="$6">
                    <SearchX size={40} strokeWidth={1.5} aria-hidden />
                    <Text
                      weight="bold"
                      textTransform="uppercase"
                      letterSpacing={1}
                    >
                      No matches
                    </Text>
                    <Text variant="bodySmall" tone="muted" textAlign="center">
                      Check spelling, or try the ticket code printed on the
                      holder&apos;s confirmation.
                    </Text>
                    <Button
                      variant="secondary"
                      size="$4"
                      onPress={() => setView("camera")}
                    >
                      Back to camera
                    </Button>
                  </YStack>
                ) : (
                  <YStack gap="$4">
                    {tickets.length > 0 ? (
                      <YStack gap="$2">
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          textTransform="uppercase"
                          letterSpacing={1}
                          tone="muted"
                        >
                          Tickets
                        </Text>
                        <YStack gap="$2">
                          {tickets.map((tk) => (
                            <RowButton
                              key={tk.ticketId}
                              onPress={() => void resolveByRaw(tk.ticketCode)}
                              disabled={resolving}
                              role="button"
                              aria-label={`Open ticket ${tk.ticketCode}`}
                            >
                              <YStack flex={1} gap="$1">
                                <Text weight="bold" fontSize="$3">
                                  {tk.ownerName ?? "Ticket"}
                                </Text>
                                <Text variant="bodySmall" tone="muted">
                                  {tk.ticketCode}
                                  {tk.ticketTypeName
                                    ? ` · ${tk.ticketTypeName}`
                                    : ""}
                                </Text>
                              </YStack>
                              <StatusBadge
                                tone={
                                  tk.status === "VALID"
                                    ? "success"
                                    : tk.status === "SCANNED"
                                      ? "warning"
                                      : "danger"
                                }
                                label={tk.status}
                              />
                              <ArrowRight size={16} aria-hidden />
                            </RowButton>
                          ))}
                        </YStack>
                      </YStack>
                    ) : null}

                    {volunteers.length > 0 ? (
                      <YStack gap="$2">
                        <Text
                          variant="bodySmall"
                          weight="bold"
                          textTransform="uppercase"
                          letterSpacing={1}
                          tone="muted"
                        >
                          Volunteers
                        </Text>
                        <YStack gap="$2">
                          {volunteers.map((c) => (
                            <RowButton
                              key={c.signupId}
                              onPress={() => void resolveVolunteerCandidate(c)}
                              disabled={resolving}
                              role="button"
                              aria-label={`Open volunteer ${c.humanDisplayName}`}
                            >
                              <YStack flex={1} gap="$1">
                                <Text weight="bold" fontSize="$3">
                                  {c.humanDisplayName}
                                </Text>
                                <Text variant="bodySmall" tone="muted">
                                  {c.roleLabel} · {c.shiftLabel}
                                </Text>
                              </YStack>
                              <StatusBadge
                                tone={
                                  c.status === "APPROVED"
                                    ? "success"
                                    : c.status === "CHECKED_IN"
                                      ? "neutral"
                                      : "warning"
                                }
                                label={c.status.replace("_", " ")}
                              />
                              <ArrowRight size={16} aria-hidden />
                            </RowButton>
                          ))}
                        </YStack>
                      </YStack>
                    ) : null}
                  </YStack>
                )}
              </Card>
            </Padded>
          ) : null}
        </>
      )}
    </Page>
  );
}

// ── Session tally (FR-014) ──────────────────────────────────────────────────

/**
 * Two numbers, both meaning something: how many people this session let in, and
 * how many passes came back a second time. The event title rides along in door
 * mode, where the picker is off screen and "which show am I scanning?" is
 * otherwise unanswerable without dismissing the verdict.
 */
function SessionTally({
  tally,
  eventTitle,
}: {
  tally: ScanSessionTally;
  eventTitle: string | null;
}) {
  const { admitted, alreadyIn } = tally;
  if (admitted === 0 && alreadyIn === 0 && !eventTitle) return null;
  return (
    <XStack
      gap="$4"
      alignItems="center"
      flexWrap="wrap"
      data-testid="scan-session-tally"
    >
      <Tally label="Admitted" value={admitted} testId="scan-tally-admitted" />
      <Tally
        label="Already in"
        value={alreadyIn}
        testId="scan-tally-already-in"
      />
      {eventTitle ? (
        <Text variant="bodySmall" tone="muted" flexShrink={1}>
          {eventTitle}
        </Text>
      ) : null}
    </XStack>
  );
}

function Tally({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <XStack gap="$2" alignItems="center" data-testid={testId}>
      <XStack
        /**
         * `$structure` / `$onStructure`, not the brand orange.
         *
         * The previous pairing was `$colorInverted` on `$brandSecondaryHover`,
         * and its comment only measured Stub (5.68:1). On `swiss` it is
         * **3.85:1** against a 4.5 floor — a 12px bold numeral is not large
         * text, so it fails. `$structure`/`$onStructure` measures 6.97 / 14.60 /
         * 16.22 across swiss / ember / stub and is the same pair the REDIRECT
         * verdict already uses, so it is guarded by
         * `scan-tone-contrast.test.ts` rather than by a comment.
         *
         * It also stops the tally competing with the verdict: a small orange
         * plate a few pixels from a full-bleed ADMIT or STOP fill was the second
         * loudest thing on a screen whose whole job is to have exactly one.
         */
        backgroundColor="$structure"
        paddingHorizontal="$3"
        paddingVertical="$1"
        minWidth={36}
        justifyContent="center"
      >
        <Text
          weight="bold"
          fontSize="$2"
          color="$onStructure"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </Text>
      </XStack>
      <Text
        variant="bodySmall"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={1}
      >
        {label}
      </Text>
    </XStack>
  );
}

// ── "This page is the thin one" (FR-013) ────────────────────────────────────

/**
 * One line, once. The browser page cannot do offline manifests, a retrying
 * admit queue, or the torch — and an organizer who does not know that will
 * discover it at a door with no signal. The install links live on the Scanner
 * Setup page (and in the distribution memo); they are referenced here, never
 * copied.
 */
function ScannerAppHint({ slug }: { slug: string }) {
  return (
    <XStack gap="$2" alignItems="flex-start" flexWrap="wrap">
      <Smartphone size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <Text variant="bodySmall" tone="muted" flexShrink={1}>
        This page needs a connection and has no torch or offline queue. For a
        busy or patchy door, use the scanner app —{" "}
        <Link
          href={`/admin/${slug}/scanner-setup`}
          // Inherit the muted ink and mark the link with an underline rather
          // than a colour: a UA-default blue is off-palette on warm paper.
          style={{ color: "inherit", textDecoration: "underline" }}
        >
          get it here
        </Link>
        .
      </Text>
    </XStack>
  );
}
