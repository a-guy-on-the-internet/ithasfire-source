import { useCallback, useRef, useState } from "react";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import * as Sentry from "@sentry/react-native";

import { getWebBaseUrl } from "@/config/api";
import { trpc } from "@/lib/trpc";

import {
  VALIDATE_PASSWORD_MUTATION_OPTIONS,
  noticeForOutcome,
  submitEventPassword,
  type PasswordNotice,
} from "./event-password-challenge";

/**
 * Wires `submitEventPassword` to tRPC, the system browser, and the query
 * cache. `isBusy` spans the whole flow, browser session included, so the
 * sheet can't be closed or resubmitted while the challenge is open.
 */
export const useEventPasswordSubmit = ({
  eventId,
  onUnlocked,
}: {
  eventId: string;
  onUnlocked: () => void;
}) => {
  const utils = trpc.useUtils();
  // `retry: false` overrides the app-wide `retry: 1`; see the constant.
  const { mutateAsync } = trpc.events.validatePassword.useMutation(
    VALIDATE_PASSWORD_MUTATION_OPTIONS,
  );
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<PasswordNotice | null>(null);
  // State updates are async; the ref stops a double `onSubmitEditing` + tap.
  const inFlight = useRef(false);

  const submit = useCallback(
    async (password: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setIsBusy(true);
      setNotice(null);
      try {
        const outcome = await submitEventPassword(
          { eventId, password },
          {
            validate: (input) => mutateAsync(input),
            // Ephemeral: Turnstile needs no shared cookies, and iOS should
            // skip the "wants to use … to Sign In" consent alert. The sheet
            // keeps showing "Checking..." behind the browser.
            openChallenge: (challengeUrl, returnUrl) =>
              WebBrowser.openAuthSessionAsync(challengeUrl, returnUrl, {
                preferEphemeralSession: true,
              }),
            webBaseUrl: getWebBaseUrl(),
            // `ithasfire://challenge` in builds; `exp://…/--/challenge` in Expo Go.
            returnUrl: Linking.createURL("challenge"),
            // `context` carries tags + scheme/query KEY names, never a token.
            reportError: (err, context) =>
              Sentry.captureException(err, context),
          },
        );

        if (outcome.kind !== "unlocked") {
          setNotice(noticeForOutcome(outcome));
          return;
        }
        setNotice(null);
        // Gate state flips passwordRequired → false, which re-enables the
        // gated detail queries (SEO, body, ticket types, waiver).
        await Promise.all([
          utils.events.getGateState.invalidate({ eventId }),
          utils.events.getEventSeo.invalidate(),
          utils.events.getPublicEventBody.invalidate(),
          utils.events.listEventTicketTypes.invalidate({ eventId }),
          utils.waivers.getEventWaiver.invalidate({ eventId }),
        ]);
        onUnlocked();
      } finally {
        inFlight.current = false;
        setIsBusy(false);
      }
    },
    [eventId, mutateAsync, onUnlocked, utils],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  return { submit, isBusy, notice, clearNotice };
};
