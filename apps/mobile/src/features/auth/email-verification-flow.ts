import { formatAuthErrorMessage } from "@th/errors";

/**
 * The send-a-code-then-enter-it flow behind `EmailVerificationPrompt`, kept
 * free of React and of the Better Auth client so it runs under vitest with
 * fakes. Email verification is a 6-digit code (`emailOTP` plugin,
 * `type: "email-verification"`), the same flow as web's `VerifyEmailCard`.
 */

export const OTP_LENGTH = 6;
/** Server codes live 10 minutes; a resend inside a minute is refused here. */
export const RESEND_COOLDOWN_MS = 60_000;

export const sanitizeOtp = (raw: string): string =>
  raw.replace(/\D/g, "").slice(0, OTP_LENGTH);

type AuthResult = {
  error?: { code?: string; message?: string; status?: number } | null;
};

/** The three calls the flow needs. The app binds them to `authClient`. */
export type EmailVerificationClient = {
  sendCode: (email: string) => Promise<AuthResult>;
  verifyCode: (email: string, otp: string) => Promise<AuthResult>;
  /** Re-read the session so `user.emailVerified` is current. */
  refreshSession: () => Promise<unknown>;
};

export type FlowOutcome = { ok: true } | { ok: false; message: string };

const OTP_MESSAGES: Record<string, string> = {
  INVALID_OTP: "That code didn't match. Check it and try again.",
  OTP_EXPIRED: "That code has expired. Send a new one.",
  TOO_MANY_ATTEMPTS: "Too many tries with that code. Send a new one.",
};

const messageFor = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && OTP_MESSAGES[code]) return OTP_MESSAGES[code];
  return formatAuthErrorMessage(error);
};

export async function sendVerificationCode(
  client: EmailVerificationClient,
  email: string,
): Promise<FlowOutcome> {
  try {
    const { error } = await client.sendCode(email);
    if (error) return { ok: false, message: messageFor(error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: messageFor(err) };
  }
}

/**
 * Check the code; on success refresh the session and invalidate every tRPC
 * query so the gated reads run again and the tickets appear. The session
 * refresh is best effort: the server reads `emailVerified` from the database,
 * not the JWT, so the refetch succeeds without it.
 */
export async function confirmVerificationCode(
  client: EmailVerificationClient,
  input: { email: string; otp: string; invalidate: () => Promise<unknown> | void },
): Promise<FlowOutcome> {
  try {
    const { error } = await client.verifyCode(input.email, input.otp);
    if (error) return { ok: false, message: messageFor(error) };
  } catch (err) {
    return { ok: false, message: messageFor(err) };
  }
  try {
    await client.refreshSession();
  } catch {
    // Non-fatal, see above.
  }
  void input.invalidate();
  return { ok: true };
}

// ── State ───────────────────────────────────────────────────────────────────

export type VerifyFlowState = {
  phase: "idle" | "code" | "verified";
  sending: boolean;
  submitting: boolean;
  code: string;
  /** When the last code went out, for the resend cooldown. */
  sentAt: number | null;
  error: string | null;
  /** Bumped on every failure, so the same message twice is announced twice. */
  errorSeq: number;
};

export const INITIAL_VERIFY_FLOW: VerifyFlowState = {
  phase: "idle",
  sending: false,
  submitting: false,
  code: "",
  sentAt: null,
  error: null,
  errorSeq: 0,
};

export type VerifyFlowAction =
  | { type: "send-start" }
  | { type: "send-ok"; at: number }
  | { type: "send-fail"; message: string }
  | { type: "code-change"; raw: string }
  | { type: "submit-start" }
  | { type: "submit-fail"; message: string }
  | { type: "submit-ok" };

export const verifyFlowReducer = (
  state: VerifyFlowState,
  action: VerifyFlowAction,
): VerifyFlowState => {
  switch (action.type) {
    case "send-start":
      return { ...state, sending: true, error: null };
    case "send-ok":
      // A resend keeps the code step; the old code is dead, so clear it.
      return { ...state, phase: "code", sending: false, code: "", sentAt: action.at };
    case "send-fail":
      return {
        ...state,
        sending: false,
        error: action.message,
        errorSeq: state.errorSeq + 1,
      };
    case "code-change":
      return { ...state, code: sanitizeOtp(action.raw), error: null };
    case "submit-start":
      return { ...state, submitting: true, error: null };
    case "submit-fail":
      return {
        ...state,
        submitting: false,
        code: "",
        error: action.message,
        errorSeq: state.errorSeq + 1,
      };
    case "submit-ok":
      return { ...state, phase: "verified", submitting: false, error: null };
  }
};

/** Seconds until another code may be sent, or 0. */
export const resendSecondsLeft = (sentAt: number | null, now: number): number =>
  sentAt === null
    ? 0
    : Math.min(
        RESEND_COOLDOWN_MS / 1000,
        // Clamped above too: on the render right after a send, `now` can
        // still be the clock's previous tick.
        Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_MS - now) / 1000)),
      );

/**
 * The session says the email is now verified and this prompt did not do it
 * (verified on web or another device, picked up by a session refetch): the
 * gated queries should run again. A verify through this prompt invalidates on
 * its own, so it is excluded while one is in flight or done.
 */
export const verifiedElsewhere = (
  wasVerified: boolean,
  isVerified: boolean,
  state: VerifyFlowState,
): boolean =>
  !wasVerified && isVerified && !state.submitting && state.phase !== "verified";

/** The code is complete and nothing is in flight: submit it. */
export const shouldSubmitCode = (state: VerifyFlowState): boolean =>
  state.phase === "code" &&
  state.code.length === OTP_LENGTH &&
  !state.submitting &&
  !state.sending;
