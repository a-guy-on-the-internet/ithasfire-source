import { useEffect, type ReactNode } from "react";
import { AccessibilityInfo, View } from "react-native";
import {
  Ban,
  CalendarX2,
  CheckCheck,
  CheckCircle2,
  CircleDollarSign,
  HelpCircle,
  SearchX,
  ShieldAlert,
  ShieldQuestion,
  Tag,
  UserCheck,
  WifiOff,
  XCircle,
  type LucideIcon,
} from "lucide-react-native";

import {
  MetaChip,
  SquarePrimaryButton,
  SquareSecondaryButton,
  StatusBadge,
  Text,
  ToneResultState,
  useStyles,
  type BadgeTone,
} from "@th/ui-native";

import { safeTimeString } from "../lib/format";
import { formatManifestProvenance } from "../lib/manifest-provenance";
import {
  planResultDetail,
  type ResultDetailPlan,
} from "../lib/result-detail-plan";
import type {
  ScanGlyphId,
  ScanPresentation,
} from "../lib/scan-result-presentation";
import {
  provenanceOf,
  type AlsoTicket,
  type AnyScanResult,
  type Candidate,
  type SameOrderTicket,
  type VolunteerResult,
} from "../lib/scan-result-types";

// Types moved to `../lib/scan-result-types` so the pure decision layer can be
// node-tested. Re-exported here because several screens import them from this
// module and the indirection buys nothing.
export type {
  AlsoTicket,
  AnyScanResult,
  Candidate,
  SameOrderTicket,
  TicketResult,
  UnifiedResolveResult,
  UnknownResult,
  VolunteerResult,
  WrongEventResult,
} from "../lib/scan-result-types";

/**
 * FR-003 — the full-bleed door-mode result state.
 *
 * This replaced a bordered card in a scroll region. The card was a perfectly
 * good desk UI and a poor door one: at arm's length, in the dark, out of the
 * corner of an eye, the operator needs the whole screen to change colour. All
 * five redundancy channels survive the move (fill, fill LIGHTNESS, hero glyph,
 * verdict WORD, status badge) — see `ToneResultState`, which owns them.
 *
 * Everything that was small text — same-order bulk admit, also-volunteering,
 * scan history — moved BELOW the fold onto `surface`, where it reads at
 * 15–16:1 instead of competing with the verdict.
 *
 * Auto-dismiss is not implemented HERE and deliberately never will be: FR-004's
 * express dwell is a timer the SCREEN owns (`use-express-dwell.ts`), because a
 * component that dismisses itself cannot be stopped by the thing that knows an
 * admit just failed. This view only renders what it is handed — the zone-⑨
 * `footer`, the hold handlers, and the `· CONFIRM MANUALLY` suffix.
 */

/** `ScanGlyphId` → icon. Lives here so the decision table stays node-pure. */
const GLYPHS: Record<ScanGlyphId, LucideIcon> = {
  CheckCircle2,
  CheckCheck,
  CircleDollarSign,
  Ban,
  Tag,
  XCircle,
  CalendarX2,
  HelpCircle,
  SearchX,
  ShieldAlert,
  UserCheck,
  WifiOff,
  ShieldQuestion,
};

const announce = (message: string) => {
  AccessibilityInfo.announceForAccessibility(message);
};

const isVipType = (name: string | null | undefined): boolean =>
  name ? /vip|backstage|premium/i.test(name) : false;

export const UnifiedResultView = ({
  result,
  presentation,
  canCheckInVolunteer,
  onAdmitTicket,
  admitPending,
  onCheckInVolunteer,
  checkInPending,
  onScanCrossTicket,
  resolvePending,
  sameOrderTickets,
  onBulkAdmit,
  bulkAdmitPending,
  onDismiss,
  confirmManually = false,
  onHoldStart,
  onHoldEnd,
  footer,
  layout,
  testID,
}: {
  result: AnyScanResult;
  /** From `presentScanResult(describeScanResult(result))` — computed once by
   * the screen so the rail and the state cannot disagree about the outcome. */
  presentation: ScanPresentation;
  canCheckInVolunteer: boolean;
  onAdmitTicket: (ticketCode: string) => void;
  admitPending: boolean;
  onCheckInVolunteer: (signupId: string) => void;
  checkInPending: boolean;
  onScanCrossTicket: (ticketCode: string) => void;
  resolvePending: boolean;
  sameOrderTickets?: SameOrderTicket[];
  onBulkAdmit?: (tickets: SameOrderTicket[]) => void;
  bulkAdmitPending?: boolean;
  /** Tap-to-dismiss. Withheld on VALID — see `ToneResultState`. */
  onDismiss?: () => void;
  /**
   * FR-004 §3 — append `· CONFIRM MANUALLY` to the provenance chip. The VISIBLE
   * half of express mode's 10-minute manifest-freshness gate: without it the
   * operator just notices that express stopped working on some scans and has no
   * way to find out why.
   */
  confirmManually?: boolean;
  /** Design §6 — press-and-hold pauses the express dwell. */
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  /** Zone ⑨ — the express dwell indicator. */
  footer?: ReactNode;
  /** `inline` for the manual-search screen — see `ToneResultState`. */
  layout?: "fill" | "inline";
  testID?: string;
}) => {
  const provenance = provenanceOf(result);
  const provenanceLabel = provenance
    ? formatManifestProvenance({
        ageMs: provenance.manifestAgeMs,
        syncedAt: provenance.manifestSyncedAt,
        confirmManually,
      })
    : null;

  useEffect(() => {
    // This is the ONLY announcement for a result. `ToneResultState` no longer
    // carries `accessibilityLiveRegion` (TalkBack read every verdict twice),
    // and hosts must not add a second `announceForAccessibility` — the
    // ordering below is the whole point and a live region cannot express it.
    //
    // Provenance FIRST: it qualifies everything after it, so a screen-reader
    // user hears "Offline result…" before they hear a verdict.
    const parts: Array<string | null> = [
      provenanceLabel?.announce ?? null,
      presentation.verdict,
      result.kind === "ticket" ? `Holder ${result.holderDisplay}.` : null,
      result.kind === "volunteer" ? `${result.displayName}.` : null,
      result.kind === "ticket" && result.ticketTypeName
        ? `${result.ticketTypeName}.`
        : null,
      presentation.guidance,
    ];
    announce(parts.filter(Boolean).join(" "));
    // `presentation` is derived from `result`; keying on both would re-announce
    // on every parent render that rebuilds the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const ticketFields =
    result.kind === "ticket"
      ? {
          name: result.holderDisplay || null,
          typeName: result.ticketTypeName,
          code: result.ticketCode ? `Code ${result.ticketCode}` : null,
        }
      : { name: null, typeName: null, code: null };

  const volunteerName = result.kind === "volunteer" ? result.displayName : null;

  /**
   * Detail presence is decided ONCE, by a pure predicate, and handed to both
   * consumers — the "⌄ MORE" affordance and the panel itself. Deriving it from
   * `!!children` is what shipped a dead affordance and an empty cream band on
   * ten of the eleven states: a React element is truthy even when the
   * component renders `null`. See `lib/result-detail-plan.ts`.
   */
  const detailPlan = planResultDetail({
    kind: result.kind,
    admittable: presentation.admittable,
    // The scan screen's control rail owns the primary action (FR-007). An
    // `inline` host — the manual-search screen — has no rail, so the state
    // must carry it or admitting by NAME becomes impossible.
    showAdmitAction: layout === "inline",
    status: result.kind === "ticket" ? result.status : null,
    scannedAtLabel:
      result.kind === "ticket" ? safeTimeString(result.scannedAt) : null,
    sameOrderCount: sameOrderTickets?.length ?? 0,
    canBulkAdmit: !!onBulkAdmit,
    alsoVolunteeringCount:
      result.kind === "ticket" ? (result.alsoVolunteering?.length ?? 0) : 0,
  });

  return (
    <ToneResultState
      tone={presentation.tone}
      glyph={GLYPHS[presentation.glyph]}
      verdict={presentation.verdict}
      badge={presentation.badge}
      name={ticketFields.name ?? volunteerName}
      typeName={ticketFields.typeName}
      typeEmphasis={isVipType(ticketFields.typeName)}
      code={ticketFields.code}
      guidance={presentation.guidance}
      onDismiss={onDismiss}
      onHoldStart={onHoldStart}
      onHoldEnd={onHoldEnd}
      footer={footer}
      layout={layout}
      provenance={
        provenanceLabel ? (
          <MetaChip
            label={provenanceLabel.text}
            glyph={WifiOff}
            variant={provenanceLabel.variant}
            on={presentation.tone}
            accessibilityLabel={provenanceLabel.announce}
            testID="scan-result-offline-badge"
          />
        ) : null
      }
      testID={testID ?? `scan-result-kind-${result.kind}`}
      hasDetail={detailPlan.hasDetail}
    >
      <ResultDetail
        result={result}
        plan={detailPlan}
        canCheckInVolunteer={canCheckInVolunteer}
        onAdmitTicket={onAdmitTicket}
        admitPending={admitPending}
        onCheckInVolunteer={onCheckInVolunteer}
        checkInPending={checkInPending}
        onScanCrossTicket={onScanCrossTicket}
        resolvePending={resolvePending}
        sameOrderTickets={sameOrderTickets}
        onBulkAdmit={onBulkAdmit}
        bulkAdmitPending={bulkAdmitPending}
      />
    </ToneResultState>
  );
};

// ── Below the fold (on `surface`, never a dismiss target) ───────────────────

/**
 * Renders exactly what {@link planResultDetail} said would be here — and
 * nothing when it said there is nothing. The plan is computed by the PARENT
 * and passed down rather than recomputed here, because the "⌄ MORE"
 * affordance is driven by the same object: two derivations of "is there
 * detail?" is precisely the drift that shipped a dead affordance on ten of
 * the eleven states.
 */
const ResultDetail = ({
  result,
  plan,
  canCheckInVolunteer,
  onAdmitTicket,
  admitPending,
  onCheckInVolunteer,
  checkInPending,
  onScanCrossTicket,
  resolvePending,
  sameOrderTickets,
  onBulkAdmit,
  bulkAdmitPending,
}: {
  result: AnyScanResult;
  plan: ResultDetailPlan;
  canCheckInVolunteer: boolean;
  onAdmitTicket: (ticketCode: string) => void;
  admitPending: boolean;
  onCheckInVolunteer: (signupId: string) => void;
  checkInPending: boolean;
  onScanCrossTicket: (ticketCode: string) => void;
  resolvePending: boolean;
  sameOrderTickets?: SameOrderTicket[];
  onBulkAdmit?: (tickets: SameOrderTicket[]) => void;
  bulkAdmitPending?: boolean;
}) => {
  const shared = useStyles();

  if (!plan.hasDetail) return null;

  if (result.kind === "volunteer") {
    return (
      <VolunteerDetail
        result={result}
        showCheckInAction={plan.showAdmitAction}
        canCheckInVolunteer={canCheckInVolunteer}
        onCheckInVolunteer={onCheckInVolunteer}
        checkInPending={checkInPending}
        onScanCrossTicket={onScanCrossTicket}
        resolvePending={resolvePending}
      />
    );
  }

  if (result.kind !== "ticket") return null;

  const bulk =
    plan.bulkCount > 0 && sameOrderTickets && onBulkAdmit
      ? sameOrderTickets
      : null;
  const alsoVolunteering = result.alsoVolunteering ?? [];
  const scannedAt = safeTimeString(result.scannedAt);
  const admitAction = plan.showAdmitAction;

  return (
    <View style={{ gap: 12 }}>
      {admitAction ? (
        <SquarePrimaryButton
          label="Admit"
          onPress={() => onAdmitTicket(result.ticketCode)}
          disabled={admitPending}
          testID="scan-result-admit-button"
          accessibilityHint="Records this ticket as admitted."
        />
      ) : null}

      {plan.showScanHistory ? (
        <Text variant="bodySmall" tone="muted">
          Already scanned at {scannedAt}
        </Text>
      ) : null}

      {bulk && onBulkAdmit ? (
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            variant="bodySmall"
            weight="bold"
            letterSpacing={1}
            textTransform="uppercase"
          >
            {bulk.length} more from this order
          </Text>
          {bulk.map((t) => (
            <View
              key={t.ticketCode}
              style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
            >
              <StatusBadge label="VALID" tone="success" />
              <Text variant="bodySmall">{t.ticketCode}</Text>
              {t.ticketTypeName ? (
                <Text variant="caption" tone="muted">
                  {t.ticketTypeName}
                </Text>
              ) : null}
            </View>
          ))}
          <SquareSecondaryButton
            label={`Admit all ${bulk.length + 1} tickets`}
            onPress={() =>
              // Ticket IDS travel with the codes: without them every row a
              // bulk admit writes to `recent_scans` is un-undoable (FR-006a).
              onBulkAdmit([
                {
                  ticketCode: result.ticketCode,
                  ticketTypeName: result.ticketTypeName,
                  ticketId: result.ticketId,
                },
                ...bulk,
              ])
            }
            disabled={!!bulkAdmitPending || admitPending}
            testID="scan-result-bulk-admit-button"
            accessibilityHint={`Admits this ticket plus ${bulk.length} others from the same order.`}
          />
        </View>
      ) : null}

      {alsoVolunteering.length > 0 ? (
        <View>
          <View style={shared.divider} />
          <Text
            accessibilityRole="header"
            variant="bodySmall"
            weight="bold"
            letterSpacing={1}
            textTransform="uppercase"
            style={{ marginBottom: 8 }}
          >
            Also volunteering
          </Text>
          {alsoVolunteering.map((candidate: Candidate) => (
            <View key={candidate.signupId} style={{ marginTop: 8 }}>
              <CandidateRow candidate={candidate} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
};

const VolunteerDetail = ({
  result,
  showCheckInAction,
  canCheckInVolunteer,
  onCheckInVolunteer,
  checkInPending,
  onScanCrossTicket,
  resolvePending,
}: {
  result: VolunteerResult;
  /**
   * False on the scan screen: the control rail owns CHECK IN there (FR-007,
   * design §5), and rendering it here as well would put two controls with the
   * identical accessible name on one screen. True for an `inline` host, which
   * has no rail.
   */
  showCheckInAction: boolean;
  canCheckInVolunteer: boolean;
  onCheckInVolunteer: (signupId: string) => void;
  checkInPending: boolean;
  onScanCrossTicket: (ticketCode: string) => void;
  resolvePending: boolean;
}) => {
  const shared = useStyles();
  const primary =
    result.candidates.find((c) => c.status === "APPROVED") ??
    result.candidates[0] ??
    null;
  const isApproved = primary?.status === "APPROVED";

  return (
    <View style={{ gap: 12 }}>
      {primary ? (
        <CandidateRow candidate={primary} />
      ) : (
        <Text variant="body">No eligible signups for this event.</Text>
      )}

      {showCheckInAction && isApproved && primary ? (
        <View style={{ gap: 6 }}>
          <SquarePrimaryButton
            label="Check in volunteer"
            onPress={() => onCheckInVolunteer(primary.signupId)}
            disabled={checkInPending}
            // `locked` keeps the orange border (so the operator still reads
            // "this is THE primary action, currently locked") while muting
            // only the fill + text. Distinct from `disabled`.
            locked={!canCheckInVolunteer}
            testID="scan-result-check-in-button"
            accessibilityHint={
              canCheckInVolunteer
                ? "Marks this volunteer as checked in."
                : "Volunteer check-in is disabled because your role does not include OWNER, ADMIN, or EDITOR. Ask an org admin to upgrade your role."
            }
          />
          {!canCheckInVolunteer ? (
            <Text variant="bodySmall" tone="muted">
              Volunteer check-in needs OWNER, ADMIN, or EDITOR. Ask an org
              admin.
            </Text>
          ) : null}
        </View>
      ) : null}

      {result.alsoHoldsTicket.length > 0 ? (
        <View>
          <View style={shared.divider} />
          <Text
            accessibilityRole="header"
            variant="bodySmall"
            weight="bold"
            letterSpacing={1}
            textTransform="uppercase"
            style={{ marginBottom: 8 }}
          >
            Also has tickets for this event
          </Text>
          {result.alsoHoldsTicket.map((ticket) => (
            <AlsoHoldsTicketRow
              key={ticket.ticketId}
              ticket={ticket}
              pending={resolvePending}
              onScan={onScanCrossTicket}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
};

const CandidateRow = ({ candidate }: { candidate: Candidate }) => (
  <View style={{ gap: 4 }}>
    <Text variant="body">
      {candidate.roleLabel} — {candidate.shiftLabel}
    </Text>
    <Text variant="bodySmall" tone="muted">
      {candidate.scanWindowNote}
    </Text>
    {candidate.status === "CHECKED_IN" &&
    safeTimeString(candidate.checkedInAt) ? (
      <Text variant="bodySmall" tone="muted">
        Checked in at {safeTimeString(candidate.checkedInAt)}
      </Text>
    ) : null}
  </View>
);

const AlsoHoldsTicketRow = ({
  ticket,
  pending,
  onScan,
}: {
  ticket: AlsoTicket;
  pending: boolean;
  onScan: (ticketCode: string) => void;
}) => {
  const tone: BadgeTone = ticket.status === "VALID" ? "success" : "warning";
  const scannedAt = safeTimeString(ticket.scannedAt);
  return (
    <View style={{ gap: 8, marginTop: 12 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <StatusBadge label={ticket.status} tone={tone} />
        <Text variant="body">{ticket.ticketCode}</Text>
      </View>
      {scannedAt ? (
        <Text variant="bodySmall" tone="muted">
          Scanned at {scannedAt}
        </Text>
      ) : null}
      {ticket.status === "VALID" ? (
        <SquareSecondaryButton
          label="Scan this ticket"
          onPress={() => onScan(ticket.ticketCode)}
          disabled={pending}
          testID="scan-result-also-holds-ticket-cta"
          accessibilityHint="Resolves this ticket so it can be admitted in the same flow."
        />
      ) : null}
    </View>
  );
};
