import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SearchX } from "lucide-react-native";

import type { ScannerSessionContext } from "../features/auth/use-scanner-session";
import { canCheckInVolunteers } from "../lib/role-gates";
import { trpc } from "../trpc";
import {
  Panel,
  ScreenSurface,
  SquareCard,
  SquarePrimaryButton,
  SquareSecondaryButton,
  StatusBadge,
  Text,
  TopBar,
  useColors,
  useStyles,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";
import { feedbackKindForOutcome } from "../lib/feedback-signatures";
import { safeTimeString } from "../lib/format";
import { presentScanResult } from "../lib/scan-result-presentation";
import { describeScanResult } from "../lib/scan-result-types";
import { triggerFeedback } from "../lib/feedback";
import {
  usePeopleSearch,
  type PeopleSearchResult,
  type VolunteerCandidate,
} from "../lib/use-people-search";
import {
  UnifiedResultView,
  type UnifiedResolveResult,
} from "./unified-result-view";

// ── Inline session type (tsconfig-alias workaround, see slice 2 notes) ──────
type TypedSessionContext = {
  operator: { humanId: string; displayName: string; email: string };
  orgs: Array<{ orgId: string; orgName: string; role: string }>;
  currentEvent?: {
    eventId: string;
    orgId: string;
    eventName: string;
    role: string;
    startAt: Date | null;
    endAt: Date | null;
    status: string;
  };
};

/**
 * Format a `synced_at` timestamp as a coarse relative-time string for the
 * offline banner ("just now", "4 minutes ago"). Inline to avoid pulling
 * date-fns or dayjs in for a one-liner.
 */
const formatRelative = (ms: number, now: number = Date.now()): string => {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
};

const VOLUNTEER_STATUS_TONE: Record<
  string,
  "success" | "warning" | "danger" | "neutral"
> = {
  APPROVED: "success",
  CHECKED_IN: "success",
  PENDING: "warning",
  REJECTED: "danger",
  NO_SHOW: "danger",
};

/**
 * Manual fallback for the unified scan flow. Local-first / network-augment:
 * every keystroke (debounced 150ms, gated to ≥2 chars) reads from the
 * SQLite people index for instant results. When online, `scan.searchUnified`
 * fires in parallel and merges into the visible set, hydrating each row
 * with its rich `ticket` / `volunteer` payload so it becomes tappable.
 *
 * Local-only rows (no network hydration) remain visible but disabled — they
 * lack the ticket code / scan token the resolver needs. The offline banner
 * surfaces this honestly to the operator.
 */
export const UnifiedSearchScreen = ({
  eventId,
  eventName,
  sessionContext,
  onBack,
  onAdmit,
  onCheckIn,
  backLabel = "Back to camera",
}: {
  eventId: string;
  eventName?: string | null;
  sessionContext: ScannerSessionContext | null;
  onBack: () => void;
  onAdmit: (ticketCode: string) => void;
  onCheckIn: (signupId: string) => void;
  backLabel?: string;
}) => {
  const shared = useStyles();
  const colors = useColors();
  const offlineStyles = useThemedSheet(makeOfflineStyles);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [result, setResult] = useState<UnifiedResolveResult | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Same decision table as the scan screen (FR-003), so a ticket resolved by
  // NAME reads identically to the same ticket resolved by CAMERA. Rendered
  // `inline` rather than full-bleed: this screen is a scrolling document with
  // a keyboard, a query field and a result list on screen at once.
  const presentation = useMemo(
    () =>
      result
        ? presentScanResult(
            describeScanResult(result, {
              selectedEventName: eventName ?? null,
              scannedAtLabel:
                result.kind === "ticket"
                  ? safeTimeString(result.scannedAt)
                  : null,
            }),
          )
        : null,
    [result, eventName],
  );

  const ctx = sessionContext as TypedSessionContext | null;
  const role = ctx?.currentEvent?.role ?? null;
  const canCheckIn = canCheckInVolunteers(role);

  const utils = trpc.useUtils();
  const mintScanTokenMutation =
    trpc.volunteer.signups.mintScanToken.useMutation();

  const { results, isOffline, isFetching, syncedAt } = usePeopleSearch({
    eventId,
    query: draft,
  });

  const trimmed = draft.trim();
  const minLengthMet = trimmed.length >= 2;

  const resolveByRaw = useCallback(
    async (raw: string) => {
      setResolveError(null);
      setResolving(true);
      try {
        const next = (await utils.scan.resolvePayload.fetch({
          eventId,
          raw,
        })) as UnifiedResolveResult;
        setResult(next);
        // No announce here: `UnifiedResultView` announces the composed verdict
        // (provenance first, then verdict, holder, type, guidance). Announcing
        // "Result kind ticket." alongside it just made TalkBack say a word
        // that means nothing to an operator, twice per scan.
        void triggerFeedback(
          feedbackKindForOutcome(
            next.kind === "ticket"
              ? { kind: "ticket", status: next.status }
              : { kind: next.kind },
          ),
        );
      } catch (err) {
        setResolveError(err instanceof Error ? err.message : "Resolve failed.");
        void triggerFeedback("rejected");
      } finally {
        setResolving(false);
      }
    },
    [eventId, utils.scan.resolvePayload],
  );

  /**
   * Round-trip a volunteer search result through `scan.resolvePayload` so the
   * unified result view receives the same composed envelope as a QR scan
   * (including the cross-context `alsoHoldsTicket` array). For APPROVED
   * signups we mint a short-lived scan token and resolve it; for other
   * statuses (CHECKED_IN / NO_SHOW) the resolver path is not applicable —
   * mintScanToken would fail with `signup_not_approved` — so we fall back to
   * an informational synthesized envelope.
   */
  const resolveVolunteerCandidate = useCallback(
    async (candidate: VolunteerCandidate) => {
      setResolveError(null);
      setResolving(true);
      try {
        if (candidate.status === "APPROVED") {
          const { token } = (await mintScanTokenMutation.mutateAsync({
            signupId: candidate.signupId,
            kind: "short",
          })) as { token: string };
          const next = (await utils.scan.resolvePayload.fetch({
            eventId,
            raw: token,
          })) as UnifiedResolveResult;
          setResult(next);
          // See `resolveByRaw` — `UnifiedResultView` owns the announcement.
          void triggerFeedback(
            feedbackKindForOutcome(
              next.kind === "ticket"
                ? { kind: "ticket", status: next.status }
                : { kind: next.kind },
            ),
          );
          return;
        }
        setResult({
          kind: "volunteer",
          humanId: candidate.humanId,
          displayName: candidate.humanDisplayName,
          candidates: [candidate],
          alsoHoldsTicket: [],
        });
        // See `resolveByRaw` — `UnifiedResultView` owns the announcement.
        void triggerFeedback("valid");
      } catch (err) {
        setResolveError(err instanceof Error ? err.message : "Resolve failed.");
        void triggerFeedback("rejected");
      } finally {
        setResolving(false);
      }
    },
    [eventId, mintScanTokenMutation, utils.scan.resolvePayload],
  );

  const dismissResult = () => {
    setResult(null);
    setResolveError(null);
  };

  const handleRowPress = (row: PeopleSearchResult) => {
    if (row.kind === "attendee") {
      if (!row.ticket) return;
      void resolveByRaw(row.ticket.ticketCode);
    } else {
      if (!row.volunteer) return;
      void resolveVolunteerCandidate(row.volunteer);
    }
  };

  const showEmpty = minLengthMet && !isFetching && results.length === 0;

  return (
    <ScreenSurface testID="unified-search-screen">
      <TopBar
        title="Manual search"
        subtitle={eventName ?? "Selected event"}
        onBack={onBack}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ gap: 16, paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Panel>
            <Text accessibilityRole="header" variant="subtitle" weight="bold">
              SEARCH BY NAME, EMAIL, OR CODE
            </Text>
            <Text variant="bodySmall" tone="muted">
              Searches both tickets and volunteer signups for this event.
            </Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Taylor, taylor@example.com, or TKT-ABC123"
              placeholderTextColor={colors.placeholder}
              keyboardType="default"
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              accessibilityLabel="Search query"
              accessibilityHint="Type to search by name, email, or ticket code. Results appear as you type."
              style={[shared.input, focused ? shared.inputFocused : null]}
              testID="unified-search-input"
            />
            {!minLengthMet ? (
              <Text variant="bodySmall" tone="muted">
                Type at least 2 characters to search.
              </Text>
            ) : null}
          </Panel>

          {isOffline && minLengthMet ? (
            <View
              style={offlineStyles.banner}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              testID="unified-search-offline-banner"
            >
              <Text
                variant="bodySmall"
                weight="bold"
                color={colors.warningSoft}
              >
                {syncedAt
                  ? `Offline — showing locally cached results from ${formatRelative(syncedAt)}.`
                  : "Offline — full search uses the network."}
              </Text>
            </View>
          ) : null}

          {isFetching ? (
            <SquareCard muted testID="unified-search-pending">
              <ActivityIndicator />
              <Text variant="body">Searching…</Text>
            </SquareCard>
          ) : null}

          {showEmpty ? (
            <SquareCard muted testID="unified-search-empty">
              <View style={shared.emptyState}>
                <SearchX size={40} color={colors.colorMuted} aria-hidden />
                <Text
                  accessibilityRole="header"
                  variant="subtitle"
                  weight="bold"
                  letterSpacing={1}
                  textTransform="uppercase"
                >
                  No matches
                </Text>
                <Text variant="bodySmall" tone="muted" textAlign="center">
                  {isOffline
                    ? "Try again when back online — full search uses the network."
                    : "Check spelling, or try the ticket code printed on the holder's confirmation."}
                </Text>
                <SquareSecondaryButton
                  label={backLabel}
                  onPress={onBack}
                  testID="unified-search-empty-back-button"
                />
              </View>
            </SquareCard>
          ) : null}

          {results.length > 0 ? (
            <SquareCard testID="unified-search-results-section">
              <Text
                accessibilityRole="header"
                variant="bodySmall"
                weight="bold"
                letterSpacing={1}
                textTransform="uppercase"
              >
                Results
              </Text>
              {results.map((row, idx) => (
                <View key={`${row.kind}:${row.humanId}`}>
                  {idx > 0 ? <View style={shared.rowSeparator} /> : null}
                  <ResultRow
                    row={row}
                    disabled={resolving}
                    onPress={() => handleRowPress(row)}
                  />
                </View>
              ))}
            </SquareCard>
          ) : null}

          {/*
            No `accessibilityLiveRegion` here either: the error card below
            carries its own assertive region, and `UnifiedResultView` fires one
            explicit, deliberately-ordered announcement. A polite region around
            both re-read the whole verdict a second time in tree order —
            provenance LAST, which is the one ordering that misleads.
          */}
          <View testID="unified-search-result-region">
            {resolveError ? (
              <SquareCard
                tone="danger"
                testID="unified-search-resolve-error"
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
              >
                <StatusBadge label="Error" tone="danger" />
                <Text variant="body">{resolveError}</Text>
              </SquareCard>
            ) : null}

            {result && presentation ? (
              <UnifiedResultView
                result={result}
                presentation={presentation}
                layout="inline"
                canCheckInVolunteer={canCheckIn}
                onAdmitTicket={onAdmit}
                admitPending={false}
                onCheckInVolunteer={onCheckIn}
                checkInPending={false}
                onScanCrossTicket={(code) => {
                  void resolveByRaw(code);
                }}
                resolvePending={resolving}
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <SafeAreaView edges={["bottom"]} style={shared.stickyFooter}>
        {result || resolveError ? (
          <SquarePrimaryButton
            label="Dismiss result"
            onPress={dismissResult}
            testID="unified-search-dismiss-button"
            accessibilityHint="Clears the current result."
          />
        ) : (
          <SquareSecondaryButton
            label={backLabel}
            onPress={onBack}
            testID="unified-search-back-to-camera-button"
          />
        )}
      </SafeAreaView>
    </ScreenSurface>
  );
};

/**
 * One row in the unified results list. Hydrated rows (with rich
 * `ticket` / `volunteer` payload) are tappable buttons; un-hydrated local-
 * only rows are non-tappable text rows with a "Bring online to admit"
 * caption — honest UX about the limits of an offline result set.
 */
const ResultRow = ({
  row,
  disabled,
  onPress,
}: {
  row: PeopleSearchResult;
  disabled: boolean;
  onPress: () => void;
}) => {
  const hydrated = row.kind === "attendee" ? !!row.ticket : !!row.volunteer;
  const displayName =
    row.displayName?.trim() ||
    (row.kind === "attendee" ? "(unnamed attendee)" : "(unnamed volunteer)");
  const email = row.email;
  const eventTitle =
    row.kind === "attendee"
      ? (row.ticket?.eventTitle ?? null)
      : (row.volunteer?.eventTitle ?? null);

  const kindLabel = row.kind === "attendee" ? "Ticket" : "Volunteer";
  // Kind is a category, not a health signal — keep neutral so it doesn't
  // collide with the success-toned APPROVED status badge on volunteer rows.
  const kindTone = "neutral" as const;

  const volunteerStatus =
    row.kind === "volunteer" && row.signupStatus
      ? row.signupStatus.replace(/_/g, " ")
      : null;
  const volunteerStatusTone =
    row.kind === "volunteer" && row.signupStatus
      ? (VOLUNTEER_STATUS_TONE[row.signupStatus] ?? "neutral")
      : "neutral";

  const a11yLabel = [
    displayName,
    eventTitle,
    email ?? null,
    kindLabel,
    volunteerStatus,
    hydrated ? null : "offline result, not yet available for admit",
  ]
    .filter(Boolean)
    .join(", ");

  const rowStyles = useThemedSheet(makeRowStyles);

  if (!hydrated) {
    return (
      <View
        style={[rowStyles.row, rowStyles.rowDisabled]}
        accessibilityRole="text"
        accessibilityLabel={a11yLabel}
        accessibilityHint="Bring this device online to admit."
        testID={`unified-search-row-${row.kind}-${row.humanId}`}
      >
        <RowBody
          displayName={displayName}
          email={email}
          eventTitle={eventTitle}
          kindLabel={kindLabel}
          kindTone={kindTone}
          volunteerStatus={volunteerStatus}
          volunteerStatusTone={volunteerStatusTone}
          muted
        />
        <Text variant="caption" tone="muted">
          Bring online to admit
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint="Opens the unified result view for this person."
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        rowStyles.row,
        pressed ? rowStyles.rowPressed : null,
        disabled ? rowStyles.rowDisabled : null,
      ]}
      testID={`unified-search-row-${row.kind}-${row.humanId}`}
    >
      {({ pressed }) => (
        <RowBody
          displayName={displayName}
          email={email}
          eventTitle={eventTitle}
          kindLabel={kindLabel}
          kindTone={kindTone}
          volunteerStatus={volunteerStatus}
          volunteerStatusTone={volunteerStatusTone}
          muted={false}
          inverted={pressed}
        />
      )}
    </Pressable>
  );
};

const RowBody = ({
  displayName,
  email,
  eventTitle,
  kindLabel,
  kindTone,
  volunteerStatus,
  volunteerStatusTone,
  muted,
  inverted = false,
}: {
  displayName: string;
  email: string | null;
  eventTitle: string | null;
  kindLabel: string;
  kindTone: "neutral" | "success" | "warning" | "danger";
  volunteerStatus: string | null;
  volunteerStatusTone: "neutral" | "success" | "warning" | "danger";
  muted: boolean;
  inverted?: boolean;
}) => {
  const colors = useColors();
  const rowStyles = useThemedSheet(makeRowStyles);
  // Swiss color inversion on press: text flips to the row background color
  // so it stays readable against the now-inverted row surface.
  const invertedColor = inverted ? colors.background : undefined;
  return (
    <View style={rowStyles.body}>
      <Text
        variant="body"
        weight="bold"
        tone={muted ? "muted" : undefined}
        color={invertedColor}
      >
        {displayName}
      </Text>
      {eventTitle ? (
        <Text variant="bodySmall" tone="muted" truncate color={invertedColor}>
          {eventTitle}
        </Text>
      ) : null}
      {email ? (
        <Text variant="bodySmall" tone="muted" truncate color={invertedColor}>
          {email}
        </Text>
      ) : null}
      <View style={rowStyles.badges}>
        <StatusBadge label={kindLabel} tone={kindTone} />
        {volunteerStatus ? (
          <StatusBadge label={volunteerStatus} tone={volunteerStatusTone} />
        ) : null}
      </View>
    </View>
  );
};

const makeRowStyles = (colors: NativePalette) =>
  StyleSheet.create({
    row: {
      minHeight: 56,
      paddingVertical: 12,
      paddingHorizontal: 4,
      gap: 8,
    },
    rowPressed: {
      // Swiss color inversion — full row flips to the foreground color on
      // press; RowBody mirrors this by overriding text to colors.background.
      backgroundColor: colors.color,
    },
    // An offline row is inert but still has to be READ — it names the person
    // so the operator knows the match exists even though it can't be admitted.
    // `opacity: 0.6` put that name at 2.85:1; a muted surface keeps the row's
    // own text tokens at full contrast.
    rowDisabled: {
      backgroundColor: colors.surfaceMuted,
    },
    body: {
      gap: 4,
    },
    badges: {
      flexDirection: "row",
      gap: 8,
      flexWrap: "wrap",
    },
  });

const makeOfflineStyles = (colors: NativePalette) =>
  StyleSheet.create({
    banner: {
      backgroundColor: colors.surface,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderLeftWidth: 4,
      // `warningSoft`, NOT `support`. `support` (#F59E0B) on Stub `surface`
      // measures 2.06:1 against a 3:1 graphic floor — the same defect this
      // pass fixed on Home and in `StatsStrip`. The rule: `support` is a FILL
      // (it carries `onSupport`); `warningSoft` is a rule/glyph/label. The
      // label beside this border already uses `warningSoft`.
      borderLeftColor: colors.warningSoft,
    },
  });
