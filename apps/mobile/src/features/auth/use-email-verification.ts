import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { trpc } from "@/lib/trpc";

import { authClient } from "./better-auth-client";
import {
  INITIAL_VERIFY_FLOW,
  confirmVerificationCode,
  resendSecondsLeft,
  sendVerificationCode,
  shouldSubmitCode,
  verifiedElsewhere,
  verifyFlowReducer,
  type EmailVerificationClient,
} from "./email-verification-flow";

const client: EmailVerificationClient = {
  sendCode: (email) =>
    authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
    }),
  verifyCode: (email, otp) => authClient.emailOtp.verifyEmail({ email, otp }),
  refreshSession: () =>
    authClient.getSession({ query: { disableCookieCache: true } }),
};

/**
 * React binding for `email-verification-flow`: the reducer, a once-a-second
 * clock for the resend cooldown, auto-submit on the sixth digit, and the
 * whole-cache tRPC invalidation after a verify, here or (seen through the
 * session's `emailVerified`) anywhere else.
 */
export const useEmailVerification = (
  email: string | null,
  emailVerified: boolean,
) => {
  const [state, dispatch] = useReducer(verifyFlowReducer, INITIAL_VERIFY_FLOW);
  const utils = trpc.useUtils();

  const wasVerified = useRef(emailVerified);
  useEffect(() => {
    if (verifiedElsewhere(wasVerified.current, emailVerified, state)) {
      void utils.invalidate();
    }
    wasVerified.current = emailVerified;
  }, [emailVerified, state, utils]);

  const [now, setNow] = useState(() => Date.now());
  const secondsLeft = resendSecondsLeft(state.sentAt, now);
  useEffect(() => {
    if (state.sentAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (resendSecondsLeft(state.sentAt, t) === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [state.sentAt]);

  const sendCode = useCallback(async () => {
    if (!email) return;
    dispatch({ type: "send-start" });
    const outcome = await sendVerificationCode(client, email);
    dispatch(
      outcome.ok
        ? { type: "send-ok", at: Date.now() }
        : { type: "send-fail", message: outcome.message },
    );
  }, [email]);

  const submit = useCallback(
    async (otp: string) => {
      if (!email) return;
      dispatch({ type: "submit-start" });
      const outcome = await confirmVerificationCode(client, {
        email,
        otp,
        invalidate: () => utils.invalidate(),
      });
      dispatch(
        outcome.ok
          ? { type: "submit-ok" }
          : { type: "submit-fail", message: outcome.message },
      );
    },
    [email, utils],
  );

  const setCode = useCallback(
    (raw: string) => dispatch({ type: "code-change", raw }),
    [],
  );

  // The sixth digit (typed, pasted or filled by the OS from the mail)
  // submits; a wrong code clears the field, so this cannot loop.
  const ready = shouldSubmitCode(state);
  useEffect(() => {
    if (ready) void submit(state.code);
  }, [ready, state.code, submit]);

  return { state, secondsLeft, sendCode, setCode, submit };
};
