"use client";

import { useEffect, useMemo, useRef } from "react";
import { CheckCircle2, RefreshCw, ScanLine } from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import { Button, Spinner, Text, tokens } from "@th/ui";
import type {
  ResolveScanPayloadOutput,
  ResolveScanPayloadVolunteerResult,
} from "@th/core/use-cases/scanning";

import { ToneResultState } from "./ToneResultState";
import {
  PRIMARY_ACTION_MIN_WIDTH,
  SCAN_ACTION_LABELS,
} from "./scan-action-labels";
import {
  actionTapDismissable,
  describeScanResult,
  planScanAction,
  planScanDetail,
  presentScanResult,
  primaryVolunteerCandidate,
  type ScanActionPlan,
  type ScanDetailPlan,
  type ScanPresentation,
  type ScanResultDescriptor,
} from "./scan-result-presentation";

/**
 * The door-mode verdict for the web scan page: the full-bleed tone state, its
 * below-the-fold detail, and the action row (the web's equivalent of the app's
 * one-handed control rail).
 *
 * Every branch that decides WHAT is shown lives in
 * `scan-result-presentation.ts` and is asserted in node. This file only decides
 * how it is laid out — which is the split Phase A learned the hard way, after
 * two blockers shipped inside untested JSX.
 *
 * Reading a pass never admits anyone: ADMIT is an explicit tap in the action
 * row (CHECK IN for volunteers), and the verdict block's tap-to-dismiss is
 * withheld on exactly that outcome so the most practised gesture at a door
 * cannot silently skip an admission.
 */

// ── Full bleed ──────────────────────────────────────────────────────────────

/**
 * The admin shell's `ContentArea` pads `$5` (24px) on every side of every admin
 * route (`packages/ui/src/ui/shell/NavigationShell.styles.ts`). That padding is
 * right for a page of cards and wrong for this one thing: design §1 is explicit
 * that "a full-bleed verdict with a 16pt cream gutter around it is not
 * full-bleed; it is a big card, which is the thing this FR is replacing", and
 * as built the verdict sat inside a cream gutter on both sides.
 *
 * ## Why cancel the gutter rather than reach for the viewport
 *
 * The usual full-bleed trick (`margin-left: calc(50% - 50vw)`) assumes the
 * container is centred in the VIEWPORT. Here it is not: the admin shell puts a
 * navigation rail to the left of the content area on desktop, so viewport-based
 * bleed would slide the verdict underneath the rail. Cancelling the container's
 * own padding reaches exactly the edges of the region this page owns, at every
 * width, with no measurement.
 *
 * The value is read from the token rather than typed as `-24` so it cannot
 * drift from the shell.
 *
 * ## What this does at a desktop width
 *
 * `Page` caps at 960 and centres, so above roughly 1008px of content area the
 * band is not literally edge-to-edge — it is the 960 measure plus the two
 * cancelled gutters, i.e. the verdict breaks the measure by 24px on each side
 * and everything else respects it. That is the intended desktop behaviour, not
 * a leftover: an operator works on a phone (where this IS edge-to-edge), and a
 * 1600px-wide red band on a monitor would be a worse answer than a bold block
 * that overhangs its column.
 *
 * ## What is deliberately NOT bled
 *
 * The action row keeps its padding. Those are the web's control rail, and a
 * primary button flush to the edge of a phone screen is a mis-tap, not a bold
 * choice. Full bleed applies to the SIGNAL, not to the controls.
 */
export const SHELL_CONTENT_GUTTER: number = tokens.space.$5;

export const FullBleedBand = styled(YStack, {
  name: "ScanVerdictFullBleed",
  width: "auto",
  marginHorizontal: -SHELL_CONTENT_GUTTER,
});

// ── Verdict ─────────────────────────────────────────────────────────────────

export type ScanVerdict = {
  presentation: ScanPresentation;
  action: ScanActionPlan;
  detail: ScanDetailPlan;
  /** Non-null only for a real resolve; null for the error state. */
  result: ResolveScanPayloadOutput | null;
};

const formatTime = (value: Date | string): string =>
  new Date(value).toLocaleTimeString();

/**
 * One computation of "what is on screen".
 *
 * It carries no `announcement` string: the verdict block itself is the live
 * region (`role="alert"` / `aria-live="assertive"`, DS D-125), so the DOM the
 * operator sees and the text a screen reader hears are the same nodes and
 * cannot describe different things. A second composed announcement would read
 * every verdict twice.
 *
 * An `override` OUTRANKS a live result, deliberately. The dangerous case is a
 * failed admit while the VALID state is still up: the operator has been told
 * "admitted", the server said no, and an error rendered *under* the verdict is
 * an error nobody sees.
 *
 * The override is a DESCRIPTOR, not a message string. That is what lets a
 * server-side admit rejection (`{ kind: "admit_rejected" }`) and a thrown round
 * trip (`{ kind: "failure" }`) travel the same path as every other outcome,
 * each resolving to a shared verdict key with its own state line, word and
 * glyph, instead of both collapsing into one "SCAN FAILED" with a raw string
 * under it.
 */
export function useScanVerdict(input: {
  result: ResolveScanPayloadOutput | null;
  override: ScanResultDescriptor | null;
  /**
   * THIS operator just admitted the card on screen. Turns a `SCANNED` ticket
   * into the `pass`/DONE confirmation instead of the `fail`/STOP "already
   * used" — see `presentScanResult` for why those must not look alike.
   */
  admitted?: boolean;
  selectedEventName: string | null;
  canCheckInVolunteer: boolean;
}): ScanVerdict | null {
  const {
    result,
    override,
    admitted = false,
    selectedEventName,
    canCheckInVolunteer,
  } = input;

  return useMemo(() => {
    if (!override && !result) return null;

    const descriptor =
      override ??
      describeScanResult(result!, { selectedEventName, formatTime, admitted });
    const presentation = presentScanResult(descriptor);
    const liveResult = override ? null : result;
    const action = planScanAction({
      result: liveResult,
      admittable: presentation.admittable,
      canCheckInVolunteer,
    });
    const detail = planScanDetail(liveResult);

    return { presentation, action, detail, result: liveResult };
  }, [result, override, admitted, selectedEventName, canCheckInVolunteer]);
}

/**
 * WHICH verdict is on screen, as a string: the shared verdict key plus its
 * subject (the ticket code, or the result kind for a volunteer pass or an
 * error).
 *
 * It changes when what the operator is being TOLD changes (a new pass, an
 * admit landing, a rejection) and stays put when the same verdict is merely
 * re-derived. A volunteer check-in edits the same verdict in place and does
 * not change it. Re-derivation matters because the `ScanVerdict` object is
 * rebuilt whenever the owner query settles `canCheckInVolunteer` or the event
 * name arrives, so its object identity is not this.
 *
 * Two consumers, one definition, so they cannot drift: the haptic cue fires
 * once per signature, and the band's stamp (`ToneResultState`'s `stampKey`)
 * replays once per signature. Two scans in a row with the SAME signature are
 * separated by a dismiss, which unmounts the band, so the second still stamps.
 */
export function verdictSignature(verdict: ScanVerdict): string {
  const subject =
    verdict.result?.kind === "ticket"
      ? verdict.result.ticketCode
      : (verdict.result?.kind ?? "error");
  return `${verdict.presentation.key}|${subject}`;
}

// ── State ───────────────────────────────────────────────────────────────────

export function ScanResultState({
  verdict,
  onDismiss,
  onAdmitTicket,
  admitPending,
  onCheckInVolunteer,
  checkInPending,
  onScanCrossTicket,
  resolvePending,
}: {
  verdict: ScanVerdict;
  onDismiss: () => void;
  onAdmitTicket: (ticketCode: string) => void;
  admitPending: boolean;
  onCheckInVolunteer: (signupId: string) => void;
  checkInPending: boolean;
  onScanCrossTicket: (ticketCode: string) => void;
  resolvePending: boolean;
}) {
  const { presentation, action, detail, result } = verdict;
  const ticket = result?.kind === "ticket" ? result : null;
  const volunteer = result?.kind === "volunteer" ? result : null;

  const name = ticket
    ? ticket.holderDisplay || null
    : (volunteer?.displayName ?? null);

  /**
   * The DS's `tier` slot — the second half of "Dana Whitfield · GA".
   *
   * For a volunteer it is the ROLE, not a ticket type. That word used to have
   * its own badge; with the badge gone it belongs here, beside the person,
   * because "Marisol · Door" is the single most useful line on the screen for a
   * volunteer and the shift below it is detail.
   */
  const typeName =
    ticket?.ticketTypeName ??
    (volunteer ? (primaryVolunteerCandidate(volunteer)?.roleLabel ?? null) : null);

  /**
   * Door mode takes the page chrome OUT of the document while a verdict is up,
   * so without this the browser resets focus to `<body>` on every single scan
   * and a keyboard or switch-control operator has to traverse the whole page
   * again to reach ADMIT.
   *
   * Focus moves to the row, not to a specific button, and the row hands it to
   * whichever control is first — which is always the primary action for the
   * outcome. Re-focus is keyed on the verdict SUBJECT, so the volunteer
   * check-in rewriting its envelope in place does not yank focus mid-tap.
   */
  const actionRowRef = useRef<HTMLElement | null>(null);
  const focusKey = `${action.kind}|${presentation.key}|${
    ticket?.ticketCode ?? volunteer?.humanId ?? ""
  }`;
  useEffect(() => {
    const row = actionRowRef.current;
    if (!row || typeof document === "undefined") return;
    // Never steal focus from an operator already interacting with the state
    // (e.g. reading the detail band, or tabbed onto Skip).
    if (row.contains(document.activeElement)) return;
    const target = row.querySelector<HTMLElement>(
      'button, [role="button"], [tabindex]:not([tabindex="-1"])',
    );
    target?.focus?.();
  }, [focusKey]);

  /**
   * `hasDetail` and `children` are a UNION on `ToneResultState`, so they are
   * passed as two literal call shapes rather than a conditional spread: a spread
   * widens `children` to `Element | undefined`, which satisfies neither arm and
   * is exactly the looseness that let Phase A ship `hasDetail = !!children`.
   */
  const bandProps = {
    tone: presentation.tone,
    glyph: presentation.glyph,
    state: presentation.state,
    word: presentation.word,
    name,
    typeName,
    code: ticket?.ticketCode ?? null,
    detail: presentation.detail,
    supportRef: presentation.supportRef,
    onDismiss: actionTapDismissable(action) ? onDismiss : undefined,
    stampKey: verdictSignature(verdict),
    testID: "scan-result-state",
  };

  return (
    <YStack width="100%" gap="$4">
      <FullBleedBand data-testid="scan-verdict-bleed">
        {detail.hasDetail ? (
          <ToneResultState {...bandProps} hasDetail>
            <ScanResultDetail
              detail={detail}
              volunteer={volunteer}
              alsoVolunteering={ticket?.alsoVolunteering ?? []}
              onScanCrossTicket={onScanCrossTicket}
              resolvePending={resolvePending}
            />
          </ToneResultState>
        ) : (
          <ToneResultState {...bandProps} />
        )}
      </FullBleedBand>

      {/* The action row — the web's control rail. It sits BELOW the fill on the
          page background so each button keeps the Button atom's own measured
          fill/label pair instead of inventing one on a tone fill.

          Labels come from `SCAN_ACTION_LABELS`, which is where the 320px width
          budget is documented and guarded: "DISMISS AND SCAN NEXT" was observed
          clipped to "DISMISS AND …" on a 320×640 phone. */}
      <XStack
        ref={actionRowRef as never}
        gap="$3"
        paddingHorizontal="$4"
        flexWrap="wrap"
        $gtSm={{ paddingHorizontal: "$5" }}
        data-testid="scan-action-row"
      >
        {action.kind === "admit" ? (
          <>
            <Button
              variant="primary"
              size="$4"
              flex={1}
              minWidth={PRIMARY_ACTION_MIN_WIDTH}
              onPress={() => onAdmitTicket(action.ticketCode)}
              disabled={admitPending}
            >
              {admitPending ? <Spinner size="sm" /> : <ScanLine size={16} />}
              {SCAN_ACTION_LABELS.admit}
            </Button>
            <Button variant="secondary" size="$4" onPress={onDismiss}>
              {SCAN_ACTION_LABELS.skip}
            </Button>
          </>
        ) : action.kind === "check-in" ? (
          <>
            <Button
              variant="primary"
              size="$4"
              flex={1}
              minWidth={PRIMARY_ACTION_MIN_WIDTH}
              onPress={() => onCheckInVolunteer(action.signupId)}
              disabled={checkInPending || action.locked}
            >
              {checkInPending ? <Spinner size="sm" /> : <CheckCircle2 size={16} />}
              {SCAN_ACTION_LABELS.checkIn}
            </Button>
            <Button variant="secondary" size="$4" onPress={onDismiss}>
              {SCAN_ACTION_LABELS.dismissSecondary}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="$4"
            flex={1}
            onPress={onDismiss}
            data-testid="scan-dismiss-action"
          >
            <RefreshCw size={16} />
            {SCAN_ACTION_LABELS.dismiss}
          </Button>
        )}
      </XStack>

      {action.kind === "check-in" && action.locked ? (
        <Text
          variant="bodySmall"
          tone="muted"
          paddingHorizontal="$4"
          $gtSm={{ paddingHorizontal: "$5" }}
        >
          Edit role required to check in volunteers.
        </Text>
      ) : null}
    </YStack>
  );
}

// ── Below the fold ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      variant="bodySmall"
      weight="bold"
      textTransform="uppercase"
      letterSpacing={1}
      tone="muted"
    >
      {children}
    </Text>
  );
}

function ScanResultDetail({
  detail,
  volunteer,
  alsoVolunteering,
  onScanCrossTicket,
  resolvePending,
}: {
  detail: ScanDetailPlan;
  volunteer: ResolveScanPayloadVolunteerResult | null;
  alsoVolunteering: NonNullable<
    Extract<ResolveScanPayloadOutput, { kind: "ticket" }>["alsoVolunteering"]
  >;
  onScanCrossTicket: (ticketCode: string) => void;
  resolvePending: boolean;
}) {
  const primary = volunteer ? primaryVolunteerCandidate(volunteer) : null;

  return (
    <>
      {detail.isVolunteer ? (
        <YStack gap="$2">
          {primary ? (
            <>
              <Text variant="body">
                {primary.roleLabel} — {primary.shiftLabel}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {primary.scanWindowNote}
              </Text>
              {primary.status === "CHECKED_IN" && primary.checkedInAt ? (
                <Text variant="bodySmall" tone="muted">
                  Checked in at{" "}
                  {new Date(primary.checkedInAt).toLocaleTimeString()}
                </Text>
              ) : null}
            </>
          ) : (
            <Text variant="body">No eligible signups for this event.</Text>
          )}
        </YStack>
      ) : null}

      {volunteer && detail.alsoHoldsTicketCount > 0 ? (
        <YStack
          gap="$2"
          borderTopWidth={2}
          borderColor="$borderColor"
          paddingTop="$3"
        >
          <SectionLabel>Also has tickets for this event</SectionLabel>
          {volunteer.alsoHoldsTicket.map((tk) => (
            <YStack key={tk.ticketId} gap="$2" paddingTop="$2">
              <XStack gap="$2" alignItems="center" flexWrap="wrap">
                <Text variant="body" weight="bold">
                  {tk.status}
                </Text>
                <Text variant="body">{tk.ticketCode}</Text>
              </XStack>
              {tk.scannedAt ? (
                <Text variant="bodySmall" tone="muted">
                  Scanned at {new Date(tk.scannedAt).toLocaleTimeString()}
                </Text>
              ) : null}
              {tk.status === "VALID" ? (
                <Button
                  variant="secondary"
                  size="$4"
                  alignSelf="flex-start"
                  onPress={() => onScanCrossTicket(tk.ticketCode)}
                  disabled={resolvePending}
                >
                  Open this ticket
                </Button>
              ) : null}
            </YStack>
          ))}
        </YStack>
      ) : null}

      {detail.alsoVolunteeringCount > 0 ? (
        <YStack gap="$2">
          <SectionLabel>Also volunteering</SectionLabel>
          {alsoVolunteering.map((c) => (
            <YStack key={c.signupId} gap="$1" paddingTop="$2">
              <Text variant="body">
                {c.roleLabel} — {c.shiftLabel}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {c.scanWindowNote}
              </Text>
            </YStack>
          ))}
        </YStack>
      ) : null}
    </>
  );
}
