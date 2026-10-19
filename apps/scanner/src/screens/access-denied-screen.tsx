import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";

import {
  Column,
  Panel,
  ScreenSurface,
  SquarePrimaryButton,
  SquareSecondaryButton,
  Text,
  TopBar,
} from "@th/ui-native";

import {
  cardClearedCopy,
  type CardClearedKind,
  type LeaveRisk,
} from "../features/pos/sale-attempt";
import { reportRetentionIssue } from "../lib/report";
import type {
  AccessDeniedReason,
  CheckAgainResult,
} from "../lib/use-access-revocation";

/**
 * Read out a line that appears in place of what was tapped. Android reads it
 * from the live region it sits in; iOS has no live regions, so it is announced
 * there only (both would read it twice on Android).
 */
const announce = (message: string) => {
  if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(message);
};

/**
 * FR-009: this was the ONLY scanner screen importing `@th/ui`'s `Button`. It
 * now uses `SquareSecondaryButton` like every other secondary action in the
 * app — same neutral-outlined treatment, same 52pt target, same AA rungs — so
 * the scanner draws its buttons from one system rather than two.
 */
/**
 * `reason` picks the copy. The server refuses for two different causes with
 * the same tRPC code, and "ask for the SCANNER role" sends platform staff who
 * only lack a second factor to the wrong fix. Absent means the role copy.
 *
 * The scans still on the phone are shown, because signing out deletes them:
 * `unsentScans` (queued, still being sent) and `failedScans` (the failed-sync
 * list). With either above zero, Sign out asks first.
 *
 * `cardCleared` is the app's "don't take cash" notice (`sale-guard.ts`). A
 * denial held for an open card sale clears that sale when its time runs out,
 * and this screen is what the operator sees next, so it carries the notice.
 * `clearedSale` is the risk that clear left behind: a press still sending or
 * an unresolved key has no cancel, so the screen says the sale may stand.
 */
export const AccessDeniedScreen = ({
  userEmail,
  onSignOut,
  onCheckAgain,
  reason = "no_scan_role",
  unsentScans = 0,
  failedScans = 0,
  cardCleared,
  clearedSale = null,
}: {
  userEmail: string | undefined;
  onSignOut: () => Promise<void>;
  /** Ask the server again; a granted answer leaves this screen by itself. */
  onCheckAgain?: () => Promise<CheckAgainResult>;
  reason?: AccessDeniedReason;
  unsentScans?: number;
  failedScans?: number;
  cardCleared?: { kind: CardClearedKind | null; amount: string | null };
  clearedSale?: LeaveRisk | null;
}) => {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckAgainResult | null>(
    null,
  );
  const secondFactor = reason === "second_factor_required";
  const atRisk = unsentScans + failedScans;
  // The queue may send or file the last scan while the confirm is open; with
  // nothing left to lose there is nothing to confirm.
  const confirmShown = confirmingSignOut && atRisk > 0;
  // Closed for good, so a later scan does not bring it back unasked.
  useEffect(() => {
    if (atRisk === 0) setConfirmingSignOut(false);
  }, [atRisk]);
  const confirmText = `Signing out deletes ${scans(atRisk)} this phone has not confirmed with the server. Those admissions may not have been recorded.`;
  const checkResultText =
    checkResult === "refused"
      ? "Still no scanner access for this account."
      : checkResult === "unreachable"
        ? "Could not reach the server. Check your connection and try again."
        : null;

  const cardNotice = cardCleared?.kind
    ? cardClearedOnDenied(cardCleared.kind, cardCleared.amount)
    : null;
  // A card clear normally leaves the card notice, which says it all. One that
  // failed before the notice started left nothing, so this line stands in.
  const saleMayStand =
    clearedSale === "sending" ||
    clearedSale === "unresolved" ||
    (clearedSale === "card" && cardNotice === null);

  // Both appear in place of what was tapped, so a screen reader would not
  // otherwise hear them.
  useEffect(() => {
    if (checkResultText) announce(checkResultText);
  }, [checkResultText]);
  useEffect(() => {
    if (confirmShown) announce(confirmText);
    // Announced once when it opens, not again as the count moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmShown]);

  const checkAgain = () => {
    if (!onCheckAgain || checking) return;
    setChecking(true);
    setCheckResult(null);
    void onCheckAgain()
      .then(setCheckResult, (err: unknown) => {
        // The app's `checkAgain` settles every failure into a result, so this
        // is a bug if it runs: say unreachable, and report it.
        reportRetentionIssue(err, {
          branch: "access_denied_check_again_rejected",
        });
        setCheckResult("unreachable");
      })
      .finally(() => setChecking(false));
  };

  return (
    <ScreenSurface testID="access-denied-screen">
      <TopBar
        title="Access denied"
        subtitle={
          secondFactor
            ? "This account needs a second sign-in step first."
            : "This account is not provisioned for the scanner app."
        }
      />

      <Column flex justify="center" gap={16}>
        {cardNotice ? (
          <Panel>
            <View
              accessibilityLiveRegion="polite"
              testID="access-denied-card-cleared"
            >
              <Text variant="body">{cardNotice.title}</Text>
              <Text variant="bodySmall" tone="muted">
                {cardNotice.body}
              </Text>
            </View>
          </Panel>
        ) : null}
        {saleMayStand ? (
          <Panel>
            <Text variant="body" testID="access-denied-sale-cleared">
              The last sale may have gone through. Check before taking cash
              for it again.
            </Text>
          </Panel>
        ) : null}
        <Panel>
          <Text variant="body">
            Signed in as {userEmail ?? "unknown operator"}.
          </Text>
          {secondFactor ? (
            <Text
              variant="bodySmall"
              tone="muted"
              testID="access-denied-second-factor"
            >
              Platform staff accounts need a passkey or an authenticator app
              before they can open the scanner. Add one in your account
              settings on the web, then check again here.
            </Text>
          ) : (
            <Text variant="bodySmall" tone="muted">
              Scanner access requires an org admin to grant you the SCANNER
              role on at least one organization. Ask the staffing lead or admin
              who invited you to add the SCANNER role to your account, then
              check again here.
            </Text>
          )}
          {onCheckAgain ? (
            <SquarePrimaryButton
              label={checking ? "Checking…" : "Check again"}
              onPress={checkAgain}
              disabled={checking}
              testID="access-denied-check-again-button"
            />
          ) : null}
          <View accessibilityLiveRegion="polite">
            {checkResultText ? (
              <Text
                variant="bodySmall"
                tone="muted"
                testID="access-denied-check-result"
              >
                {checkResultText}
              </Text>
            ) : null}
          </View>
        </Panel>

        <Panel>
          {atRisk > 0 ? (
            <Text variant="bodySmall" testID="access-denied-scans-on-phone">
              {scansOnPhone(unsentScans, failedScans)}
            </Text>
          ) : null}
          {secondFactor ? null : (
            <Text variant="bodySmall" tone="muted">
              If you believe this is a mistake, sign out and try again with the
              email tied to your scanner role.
            </Text>
          )}
          {confirmShown ? (
            <View accessibilityLiveRegion="polite">
              <Text
                variant="bodySmall"
                testID="access-denied-sign-out-confirm"
              >
                {confirmText}
              </Text>
              <SquarePrimaryButton
                label="Stay signed in"
                onPress={() => setConfirmingSignOut(false)}
                testID="access-denied-stay-button"
              />
              <SquareSecondaryButton
                label="Sign out anyway"
                onPress={() => {
                  void onSignOut();
                }}
                testID="access-denied-sign-out-anyway-button"
              />
            </View>
          ) : (
            <SquareSecondaryButton
              label="Sign out"
              onPress={() => {
                if (atRisk > 0) {
                  setConfirmingSignOut(true);
                  return;
                }
                void onSignOut();
              }}
              testID="access-denied-sign-out-button"
            />
          )}
        </Panel>
      </Column>
    </ScreenSurface>
  );
};

/**
 * The card-cleared notice's words, minus the Sell screen's "ring those tickets
 * up again": there is no till on this screen.
 */
const cardClearedOnDenied = (
  kind: CardClearedKind,
  amount: string | null,
): { title: string; body: string } =>
  kind === "cancelled"
    ? { title: "Card sale cancelled", body: "The card wasn't charged." }
    : cardClearedCopy(kind, amount);

const scans = (n: number) => `${n} ${n === 1 ? "scan" : "scans"}`;

/** "2 scans on this phone are not sent yet, and 1 failed to send." */
const scansOnPhone = (unsent: number, failed: number): string => {
  if (unsent > 0 && failed > 0) {
    return `${scans(unsent)} on this phone ${unsent === 1 ? "is" : "are"} not sent yet, and ${failed} failed to send.`;
  }
  if (unsent > 0) {
    return `${scans(unsent)} on this phone ${unsent === 1 ? "is" : "are"} not sent yet.`;
  }
  return `${scans(failed)} on this phone failed to send.`;
};
