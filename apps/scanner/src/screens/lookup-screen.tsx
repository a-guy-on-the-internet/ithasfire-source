import { useCallback, useState } from "react";
import { AccessibilityInfo } from "react-native";

import type { ScannerSessionContext } from "../features/auth/use-scanner-session";
import { triggerFeedback } from "../lib/feedback";
import { newClientKey } from "../lib/ids";
import { markTicketScannedLocally } from "../lib/local-db";
import { showErrorToastFromError } from "../lib/toast";
import { trpc } from "../trpc";
import { UnifiedSearchScreen } from "./unified-search-screen";

/**
 * Standalone attendee/volunteer lookup. Wraps {@link UnifiedSearchScreen}
 * with admit + check-in handlers so the operator can find people by name,
 * email, or ticket code without having to enter the camera flow first.
 *
 * Reuses the same local-first / network-augment search hook as the unified
 * scan flow, so results show up offline (from the cached people index) and
 * hydrate to actionable rows when online.
 */
export const LookupScreen = ({
  eventId,
  eventName,
  sessionContext,
  onBack,
}: {
  eventId: string;
  eventName?: string | null;
  sessionContext: ScannerSessionContext | null;
  onBack: () => void;
}) => {
  const scanTicketMutation = trpc.tickets.scanTicket.useMutation();
  const checkInMutation = trpc.volunteer.signups.checkIn.useMutation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const ctx = sessionContext as { operator: { humanId: string } } | null;

  const handleAdmit = useCallback(
    (ticketCode: string) => {
      const clientKey = newClientKey(
        `lookup-${eventId}-${ctx?.operator.humanId ?? "anon"}-${ticketCode}`,
      );
      markTicketScannedLocally(ticketCode);
      void scanTicketMutation
        .mutateAsync({ eventId, ticketCode, clientKey })
        .then(() => {
          void triggerFeedback("valid");
        })
        .catch((err: unknown) => {
          const friendly = showErrorToastFromError(err);
          setErrorMessage(friendly.message);
          AccessibilityInfo.announceForAccessibility(
            `${friendly.title}. ${friendly.message}`,
          );
          void triggerFeedback("rejected");
        });
    },
    [eventId, scanTicketMutation, ctx?.operator.humanId],
  );

  const handleCheckIn = useCallback(
    (signupId: string) => {
      void checkInMutation
        .mutateAsync({ signupId })
        .then(() => {
          void triggerFeedback("valid");
        })
        .catch((err: unknown) => {
          const friendly = showErrorToastFromError(err);
          setErrorMessage(friendly.message);
          AccessibilityInfo.announceForAccessibility(
            `${friendly.title}. ${friendly.message}`,
          );
          void triggerFeedback("rejected");
        });
    },
    [checkInMutation],
  );

  if (errorMessage) {
    // Surface error via the screen's own banner mechanism (UnifiedSearchScreen
    // shows it via resolveError), but we don't have a hook into that here, so
    // we rely on the haptic + a11y announcement above. Errors clear when the
    // operator runs the next admit/check-in.
  }

  return (
    <UnifiedSearchScreen
      eventId={eventId}
      eventName={eventName}
      sessionContext={sessionContext}
      onBack={onBack}
      onAdmit={handleAdmit}
      onCheckIn={handleCheckIn}
      backLabel="Back to home"
    />
  );
};
