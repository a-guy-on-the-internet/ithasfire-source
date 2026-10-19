"use client";

import {
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { ArrowLeft, Fingerprint } from "lucide-react";
import {
  Button,
  LabeledPasswordInput,
  LabeledTextInput,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";
import { XStack, YStack, styled } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { appendRedirectParam, readRedirectParam } from "@/lib/redirect";
import { normalizeError } from "@th/errors";
import { formatAuthErrorMessage, isWebAuthnCancel } from "./auth-helpers";
import { signInRefusalMessage } from "./sign-in-refusal-message";
import { useFormErrors } from "@/hooks/useFormErrors";
import { loginSchema, validateForm } from "@/lib/validation";
import { OAuthProviderButtons } from "./OAuthProviderButtons";
import { OrDivider } from "./OrDivider";
import { AuthCardShell } from "./AuthCardShell";
import {
  AUTH_FOCUS_RING,
  AUTH_FOOTER_LINK,
  AUTH_FOOTER_LINK_TEXT,
  AUTH_FOOTER_RULE,
  RECEDING_DISABLED,
} from "./auth-card-chrome";
import { EmailCodeSignIn } from "./EmailCodeSignIn";
import { useAuthRedirect } from "./useAuthRedirect";

/**
 * The footer rule. A hairline at 20% ink, not a 2px full-ink structural line —
 * see `AUTH_FOOTER_RULE`.
 */
const Separator = styled(YStack, {
  name: "AuthFooterRule",
  ...AUTH_FOOTER_RULE,
});

const SIGN_UP_URL = "/sign-up";

/**
 * Fields each step is allowed to block on.
 *
 * Both steps run the SAME `loginSchema`, so the two can never disagree about
 * what an acceptable identifier is — step 1 simply ignores the password
 * complaint the schema also raises, because that field is not on screen yet.
 * (Deliberately not `loginSchema.pick(...)`: that reaches into the schema
 * object at module scope, which is exactly what a test that stubs
 * `@/lib/validation` cannot provide.)
 */
const STEP_FIELDS = {
  identify: ["identifier"],
  authenticate: ["identifier", "password"],
} as const satisfies Record<string, readonly ("identifier" | "password")[]>;

const IDENTIFIER_INPUT_ID = "email";
const PASSWORD_INPUT_ID = "password";

/** Swiss focus ring, matching the Button atom's. See `AUTH_FOCUS_RING` in
 *  `auth-card-chrome.ts` for why the ink panel's ring is `$support`. */
const FOCUS_RING = AUTH_FOCUS_RING;

/**
 * Field geometry, applied identically to BOTH steps' inputs.
 *
 * One object rather than two prop sets, because the two fields drifting apart
 * is the defect this replaces: the email box and the password box were tuned
 * separately and rendered at different weights beside each other.
 *
 * Why this is not simply deleted in favour of `TextInput`'s own defaults: those
 * defaults are `minHeight: 36`, which is under the 44px touch floor — while
 * `PasswordInput` independently floors ITS input at 44. Dropping the metrics
 * here would therefore not converge the two fields, it would split them by 8px.
 * `fontSize: 16` is the iOS Safari focus-zoom threshold; below it the whole page
 * zooms when the reader taps the field.
 *
 * Border and fill are deliberately NOT set: `TextInput`'s `boxed` variant is
 * already the 2px `$borderColor` box on `$surface`, so the old `borderWidth={2}`
 * / `paddingHorizontal={16}` at these call sites were restating the default.
 */
const FIELD_METRICS = {
  height: 52,
  fontSize: 16,
} as const;

/** Shared chrome for the card's hand-rolled text-link buttons. */
const TEXT_LINK_PROPS = {
  // `tag="button"`, not a bare `role="button"` div. Tamagui's `onPress` maps to
  // a CLICK handler and a div fires click only from a pointer, so role+tabIndex
  // alone announces as a button, takes focus, and then does nothing on Enter or
  // Space. Rendering a real <button> restores native activation for free.
  tag: "button",
  alignItems: "center",
  alignSelf: "flex-start",
  minHeight: 44,
  gap: "$2",
  // Reset the UA button chrome the tag brings with it. NOTE: no `textAlign`.
  // `textAlign="left"` on one of these is what fired "React does not recognize
  // the textAlign prop on a DOM element" on every /sign-in load — Tamagui has
  // no frame-level textAlign, so it fell straight through to the DOM.
  backgroundColor: "transparent",
  borderWidth: 0,
  paddingHorizontal: 0,
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: { opacity: 0.75 },
  focusStyle: FOCUS_RING,
} as const;

/**
 * Better Auth surfaces "email not verified" in several shapes depending on
 * which plugin path (email vs. username) handled the request and whether the
 * client returned `{ error }` or threw. This helper consolidates the
 * detection + routing so both code paths in `attemptSignIn` stay symmetric.
 *
 * Returns `true` when the error was consumed (caller should bail without
 * also showing the generic error toast), `false` otherwise.
 */
function routeUnverifiedEmailToCard(
  err: unknown,
  password: string,
  onEmailNotVerifiedAction:
    | ((email: string, password: string) => void)
    | undefined,
): boolean {
  if (!onEmailNotVerifiedAction) return false;

  // Pull fields from any shape: thrown Error, plain object, nested .body, etc.
  const e = err as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== "object") return false;

  // Detection now flows through the shared resolver instead of a hand-rolled
  // code/status/regex check. Note: the resolver intentionally no longer treats
  // a bare 403 as unverified — a 403 without a verify-email signal is a plain
  // FORBIDDEN, so this fires more precisely than the old heuristic.
  if (normalizeError(err).code !== "EMAIL_NOT_VERIFIED") return false;

  // The API attaches `email` to the EMAIL_NOT_VERIFIED error body so the
  // client doesn't need a second round-trip. See the `after` hook in
  // apps/api/src/auth/better-auth.ts.
  const body = (e.body as Record<string, unknown> | undefined) ?? {};
  const email =
    (body.email as string | undefined) ?? (e.email as string | undefined);
  if (!email) return false;

  onEmailNotVerifiedAction(email, password);
  return true;
}

/**
 * Neither WebAuthn support nor "has hydrated" changes after it is first read:
 * nothing to subscribe to.
 */
const subscribeNever = () => () => {};

export type LoginCardProps = {
  redirectOverride?: string | null;
  onDismissAction?: () => void;
  onRequestCreateAccountAction?: () => void;
  onStatusChangeAction?: (status: "idle" | "submitting") => void;
  onSignInSuccessAction?: () => void;
  onErrorMessageChangeAction?: (message: string | null) => void;
  /** Called when sign-in succeeds but 2FA verification is required. */
  onTwoFactorRequiredAction?: () => void;
  /**
   * Called when sign-in succeeded but the user's email is not yet verified.
   * The overlay should route to the verify-email panel so the user can
   * verify before being dropped into the app. Receives the password so
   * downstream onboarding steps (2FA setup) can run without re-prompting.
   */
  onEmailNotVerifiedAction?: (email: string, password: string) => void;
  /** Called when the user taps "Forgot password?". Opens the forgot-password panel. */
  onRequestForgotPasswordAction?: () => void;
  /**
   * Pre-fills the email/username field. Used when the user is routed here from
   * the sign-up flow because their account already exists.
   */
  initialIdentifier?: string;
  /**
   * Friendly inline notice rendered above the form (e.g. "Looks like you
   * already have an account — sign in with your password."). Shown when the
   * user lands on sign-in from a redirected flow rather than directly.
   */
  noticeMessage?: ReactNode;
};

/**
 * Sign-in, as TWO steps on one stub.
 *
 * **Step 1 — identify.** The email-or-username field with the card's single
 * accent fill on `CONTINUE`, then an `OR` rule and three ink-outline peers
 * (passkey · Google · Apple).
 *
 * **Step 2 — authenticate.** The card swaps in place (never navigates) to the
 * credential step for that identifier: a back affordance naming it, the
 * password field, the accent `SIGN IN`, and `FORGOT YOUR PASSWORD?` /
 * `EMAIL ME A CODE INSTEAD` as text links under it.
 *
 * This replaces five competing peers, two of them collapsed behind disclosures
 * that could BOTH be open at once (measured: a 1074px page with two disabled
 * CTAs on screen). It kills the accent-budget breach, the two-open-disclosures
 * state, the 320px label truncation and the chevron collision structurally
 * rather than by patching each one.
 */
export const LoginCard = ({
  redirectOverride,
  onDismissAction,
  onRequestCreateAccountAction,
  onStatusChangeAction,
  onSignInSuccessAction,
  onErrorMessageChangeAction,
  onTwoFactorRequiredAction,
  onEmailNotVerifiedAction,
  onRequestForgotPasswordAction,
  initialIdentifier,
  noticeMessage,
}: LoginCardProps = {}) => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { destination, oauthCallbackUrl } = useAuthRedirect(redirectOverride);
  const signUpUrl = useMemo(() => {
    return appendRedirectParam(SIGN_UP_URL, readRedirectParam(searchParams));
  }, [searchParams]);
  const toggleLabel = String(t("auth.lcTogglePw"));
  const visibleStateLabel = String(t("auth.lcPwVisible"));
  const hiddenStateLabel = String(t("auth.lcPwHidden"));

  const [identifier, setIdentifier] = useState(initialIdentifier ?? "");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting">("idle");
  const { fieldErrors, setError, setFieldError, clearField, clearAll } =
    useFormErrors<"identifier" | "password">();
  const [oauthLoading, setOauthLoading] = useState<"google" | "apple" | null>(
    null,
  );
  /**
   * Which step the card is showing.
   *
   * Starts on step 2 when the caller pre-filled an identifier — that is the
   * "looks like you already have an account" route, where the staged email and
   * its notice have to line up with a usable password field rather than with a
   * field the reader has to re-fill.
   */
  const [step, setStep] = useState<"identify" | "authenticate">(
    initialIdentifier ? "authenticate" : "identify",
  );
  const [emailCodeOpen, setEmailCodeOpen] = useState(false);
  const [passkeyState, setPasskeyState] = useState<"idle" | "pending">("idle");
  // Email-code (OTP) panel's in-flight state, lifted so it folds into `isBusy`
  // and can't race the OAuth/passkey/password paths.
  const [emailCodeBusy, setEmailCodeBusy] = useState(false);
  /** Field that should take focus once it is mounted and live. */
  const [focusTarget, setFocusTarget] = useState<
    "identifier" | "password" | null
  >(null);
  const formRef = useRef<HTMLFormElement>(null);
  /**
   * False in the server HTML and during hydration, true from then on (and at
   * once for a client-only mount such as the overlays).
   *
   * The sign-in form is in /login's server HTML, and before hydration it is a
   * plain `<form>` with no action, no method and no `onSubmit`. Someone on a
   * slow phone who typed an email and pressed Go then had the browser GET
   * `/login?email=…` natively: the address in CDN and Cloud Run logs, history
   * and Sentry URLs, and `redirect_url` dropped. The form is `inert` until
   * React owns it, which blocks typing as well as submitting, so nothing typed
   * before hydration can drift out of the controlled state either. `inert`
   * changes no layout, so the first paint still matches.
   *
   * Declared up here because the focus latch below waits on it.
   */
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  /**
   * Whether this card was server-rendered (true only on /login's hydration
   * pass). Read once: a client-only mount (the overlays) is `false` and never
   * runs the autofocus fallback below.
   */
  const serverRenderedRef = useRef(!hydrated);

  const isSubmitting = status === "submitting";

  /**
   * Busy-ness owned by THIS component (password submit, OAuth, passkey) — i.e.
   * everything except the email-code panel's own in-flight state.
   *
   * The distinction is not cosmetic. `emailCodeBusy` arrives from
   * `EmailCodeSignIn` via an effect, so it lands one render AFTER that panel
   * has already finished. Feeding the combined flag back down as its `disabled`
   * prop echoed the panel's own work at it a beat late, leaving its buttons
   * dead for one extra commit — long enough that "Change email" straight after
   * a rejected code silently did nothing. The panel ORs in its own `busy`
   * locally, so it loses no protection from being handed the narrower flag.
   */
  const isBusyExceptEmailCode =
    status === "submitting" ||
    oauthLoading !== null ||
    passkeyState === "pending";

  const isBusy = isBusyExceptEmailCode || emailCodeBusy;

  // The sign-in and sign-up panels stay co-mounted across the overlay slide
  // transition, so this card can already be mounted when a *second*
  // sign-up→"already exists" round-trip pushes a freshly-prefilled
  // `initialIdentifier`. A `useState` initializer only reads its argument on
  // first mount, so we sync here when a new non-empty prefill arrives. We key
  // the effect on the prefill value (not the live `identifier`) so it fires
  // once per prefill and never clobbers text the user has typed afterwards.
  //
  // Seeded EMPTY, not with `initialIdentifier`. Seeding it with the prefill
  // made the FIRST mount look like a repeat — the effect's
  // `next === lastPrefillRef.current` check matched and it returned early — so
  // `setFocusTarget("password")` never fired on the one route that most needs
  // it: sign-up with an existing address bounces here straight onto step 2,
  // whose `autoFocus` lives on the now-unmounted step-1 field. Focus sat on
  // <body> and the reader had to Tab in from the top of the document to reach
  // the only field on screen. The other two writes below are no-ops on that
  // first pass (same identifier, same step), so this costs one render.
  const lastPrefillRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next = initialIdentifier?.trim();
    if (!next) return;
    if (next === lastPrefillRef.current?.trim()) return;
    lastPrefillRef.current = initialIdentifier;
    setIdentifier(initialIdentifier ?? "");
    setStep("authenticate");
    setFocusTarget("password");
  }, [initialIdentifier]);

  /**
   * Move focus to whichever field the step change just mounted.
   *
   * A latch (state + effect) rather than an imperative `.focus()` at the call
   * site, because every call site sits next to the `setStep` that mounts the
   * target — the input does not exist yet when the handler runs. The request is
   * held, not dropped, while the field is disabled: `.focus()` on a disabled
   * input is a silent no-op, and `isBusy` can still be true on the commit that
   * swaps the step.
   *
   * Scoped to `formRef` rather than `document`, because the overlay co-mounts
   * this card with `SignUpCard` and both use short, generic input ids.
   */
  useEffect(() => {
    if (!focusTarget) return;
    // Held while the form is `inert` (pre-hydration): `.focus()` on an inert
    // descendant is a silent no-op, exactly like a disabled one.
    if (!hydrated) return;
    const id =
      focusTarget === "password" ? PASSWORD_INPUT_ID : IDENTIFIER_INPUT_ID;
    const field = formRef.current?.querySelector<HTMLInputElement>(`#${id}`);
    if (!field || field.disabled) return;
    field.focus({ preventScroll: true });
    setFocusTarget(null);
  }, [focusTarget, step, hydrated]);

  /**
   * Restore the identifier's autofocus on a server-rendered card.
   *
   * The `autoFocus` field arrives in /login's HTML inside the `inert` form.
   * The browser's native autofocus skips a candidate that cannot take focus and
   * only tries once per document, and React does not re-apply `autoFocus` on
   * hydration, so once `inert` came off nothing focused the field: focus sat on
   * <body> and typing went nowhere. So when the card goes live on step 1, ask
   * the latch above for the identifier — but only if focus is still on
   * nothing: someone who already tabbed to "Return home" or a provider button
   * keeps their place.
   */
  useEffect(() => {
    if (!hydrated || !serverRenderedRef.current) return;
    serverRenderedRef.current = false;
    if (step !== "identify") return;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      return;
    }
    setFocusTarget("identifier");
  }, [hydrated, step]);

  // ── Passkey / WebAuthn ────────────────────────────────────────────────────
  const passkeySupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return typeof window.PublicKeyCredential !== "undefined";
  }, []);
  /**
   * Whether to RENDER the passkey button — not the same question as
   * `passkeySupported`, which gates the ceremonies and stays honest.
   *
   * /login server-renders this card, and on the server `passkeySupported` is
   * always false. Rendering from it painted the card without the button, and
   * then either mismatched hydration or (if deferred to an effect) pushed the
   * provider row down by a button's height once it mounted. Every browser this
   * app supports has WebAuthn, so the server assumes "yes":
   * `useSyncExternalStore` hydrates from the server snapshot and then settles
   * on the real one, so only a browser without WebAuthn drops the button after
   * hydration. Client-only mounts (the overlays) read the real value at once.
   */
  const showPasskeyButton = useSyncExternalStore(
    subscribeNever,
    () => passkeySupported,
    () => true,
  );

  /**
   * What "signed in" means for this card, in one place.
   *
   * All four credential paths (password, passkey button, conditional-UI
   * autofill, OAuth return) end the same way — tell the host, close the
   * overlay, then navigate only if we are not already there. It was written
   * out three times and the fourth (conditional UI) simply forgot to, which
   * is how a SUCCESSFUL autofill sign-in left the reader sitting on the card.
   */
  const completeSignIn = useCallback(() => {
    onSignInSuccessAction?.();
    onDismissAction?.();
    if (destination !== pathname) router.replace(destination);
  }, [destination, onDismissAction, onSignInSuccessAction, pathname, router]);

  // Held in a ref so the conditional-UI effect below can keep its
  // `[passkeySupported, step]` deps. Listing the callbacks directly would tear
  // the effect down and re-arm a fresh WebAuthn request every time a parent
  // handed us a new closure.
  const completeSignInRef = useRef(completeSignIn);
  useEffect(() => {
    completeSignInRef.current = completeSignIn;
  }, [completeSignIn]);

  /**
   * Conditional UI: ask the browser to surface enrolled passkeys in the
   * identifier field's autofill drop-down.
   *
   * Requires the field carrying `autocomplete="username webauthn"` to be
   * mounted (Better Auth + the WebAuthn spec), which is step 1 — so this arms
   * on step 1, and re-arms when step 1 comes back TO A SETTLED ceremony. The
   * ref latch is load-bearing, not defensive: `navigator.credentials.get({
   * mediation: "conditional" })` rejects an overlapping request, so a second
   * call while the first is still pending would abort the live one. Set BEFORE
   * the await so StrictMode's double invoke can't slip a second call in.
   *
   * It is released when the ceremony SETTLES, not in the effect cleanup, and
   * the difference is observable. A conditional-UI ceremony belongs to the
   * page, not to the input element, so it survives the identifier field
   * unmounting on step 2 and is still serving that field when Back re-mounts
   * it. Releasing on cleanup therefore re-armed on Back over a ceremony that
   * was still live — SimpleWebAuthn's module-level abort service killed the
   * first one to start the second, and Better Auth logged the corpse:
   * `Error verifying passkey AbortError: Authentication ceremony was sent an
   * abort signal`, reproducible 3/3 on a cold path and captured by Sentry's
   * console integration in production. Releasing on settle keeps the original
   * ceremony serving the re-mounted field and re-arms only once it is genuinely
   * gone — which is also what the spec's "passkey keeps conditional-UI autofill
   * on the step-1 identifier field" actually asks for. Never move this release
   * back into the cleanup.
   *
   * The `AbortController` guards OUR continuation, not the ceremony: Better
   * Auth hands `autoFill` to SimpleWebAuthn's `startAuthentication`, which owns
   * the ceremony through its own module-level abort service and takes no
   * signal from us (`@simplewebauthn/browser` is not a declared dependency of
   * this app, so we do not reach past Better Auth to cancel it). What the
   * signal buys is that a resolution arriving after the card has moved on —
   * the user is now on step 2, or the panel unmounted — cannot navigate or
   * close the overlay out from under them.
   */
  const conditionalUiArmedRef = useRef(false);
  useEffect(() => {
    if (!passkeySupported) return;
    if (step !== "identify") return;
    if (conditionalUiArmedRef.current) return;
    conditionalUiArmedRef.current = true;

    const controller = new AbortController();
    void (async () => {
      try {
        const isAvailable = await (
          window.PublicKeyCredential as unknown as {
            isConditionalMediationAvailable?: () => Promise<boolean>;
          }
        ).isConditionalMediationAvailable?.();
        if (controller.signal.aborted || !isAvailable) return;

        const result = await authClient.signIn.passkey({ autoFill: true });
        if (controller.signal.aborted) return;
        // Errors stay silent — conditional UI is opportunistic and the reader
        // did not ask for it, so a failure must not toast over the form they
        // are still filling in. A SUCCESS, though, has already set the
        // session, and dropping it on the floor left them staring at a
        // sign-in card they were signed in behind.
        if (result?.error) return;
        completeSignInRef.current();
      } catch {
        // No-op: conditional UI is opportunistic.
      } finally {
        // Settled — the ceremony is gone, so step 1 may arm a fresh one. This
        // runs even when the continuation above bailed on `signal.aborted`,
        // because what matters here is the CEREMONY's lifetime, not this
        // effect's.
        conditionalUiArmedRef.current = false;
      }
    })();
    return () => {
      controller.abort();
    };
  }, [passkeySupported, step]);

  const handlePasskeySignIn = useCallback(async () => {
    if (!passkeySupported) return;
    setPasskeyState("pending");
    onErrorMessageChangeAction?.(null);
    try {
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        onErrorMessageChangeAction?.(formatAuthErrorMessage(result.error, t));
        return;
      }
      completeSignIn();
    } catch (error) {
      // User-cancelled the prompt → don't toast (WebAuthn throws a
      // NotAllowedError DOMException on dismiss/timeout).
      if (!isWebAuthnCancel(error))
        onErrorMessageChangeAction?.(formatAuthErrorMessage(error, t));
    } finally {
      setPasskeyState("idle");
    }
  }, [completeSignIn, onErrorMessageChangeAction, passkeySupported, t]);

  const identifierValue = identifier.trim();
  const canContinue = Boolean(identifierValue);
  const canSubmit =
    Boolean(identifierValue) && password.length > 0 && status !== "submitting";

  const attemptSignIn = async () => {
    setStatus("submitting");
    onStatusChangeAction?.("submitting");
    clearAll();
    onErrorMessageChangeAction?.(null);

    // Hoisted so the catch block can reach it for the unverified-email route.
    const isEmail = identifierValue.includes("@");

    try {
      // Fire sign-out early so the network round-trip overlaps with any microtask
      // work. We only need it to settle before issuing the sign-in call.
      // signOut() rejects when there's no active session — that's expected
      // and benign here (we're clearing stale state before signing in).
      // The `() => true` predicate skips telemetry entirely for this site.
      const clearSession = authClient
        .signOut({
          fetchOptions: { disableSignal: true },
        })
        .catch(traceIgnoredError("auth.login.preSignOut", () => true));

      await clearSession;

      const result = isEmail
        ? await authClient.signIn.email({
            email: identifierValue,
            password,
          })
        : await authClient.signIn.username({
            username: identifierValue,
            password,
          });

      if (result.error) {
        const handled = routeUnverifiedEmailToCard(
          result.error,
          password,
          onEmailNotVerifiedAction,
        );
        if (handled) return;
        // A second-factor refusal answers with English from the API; show
        // our translated copy for it instead.
        const refusal = signInRefusalMessage(result.error, t);
        setError(refusal ?? result.error);
        onErrorMessageChangeAction?.(
          refusal ?? formatAuthErrorMessage(result.error, t),
        );
        return;
      }

      // Better Auth returns twoFactorRedirect: true when 2FA is enabled
      const data = result.data as Record<string, unknown> | null;
      if (data?.twoFactorRedirect === true) {
        onTwoFactorRequiredAction?.();
        return;
      }

      // We no longer bounce unverified users back to the verify-email
      // panel here. Sign-in is allowed for unverified accounts so buyers
      // can recover into their account; the verification gate now lives at
      // checkout (see Checkout.tsx `onEmailVerificationRequired`), the
      // only place an unverified email actually matters (ticket delivery).
      completeSignIn();
    } catch (error) {
      // Some Better Auth client errors throw instead of returning { error }.
      // Re-check here so the unverified-email card route fires even when the
      // failure comes back through the throw path.
      const handled = routeUnverifiedEmailToCard(
        error,
        password,
        onEmailNotVerifiedAction,
      );
      if (handled) return;
      const refusal = signInRefusalMessage(error, t);
      setError(refusal ?? error);
      onErrorMessageChangeAction?.(refusal ?? formatAuthErrorMessage(error, t));
    } finally {
      setStatus("idle");
      onStatusChangeAction?.("idle");
    }
  };

  /** Swiss shake on a rejected submit — the form's own "no". */
  const shakeForm = () => {
    const el = formRef.current;
    if (!el) return;
    el.classList.remove("th-auth-shake");
    void el.offsetWidth;
    el.classList.add("th-auth-shake");
  };

  /**
   * One `<form>`, two submit behaviours.
   *
   * Both fields live in the SAME form element across the two steps — the e2e
   * suite keys on `auth-sign-in-form`, and a single form is what makes Enter
   * submit on each step without a keydown handler.
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // The submitting CTA deliberately does NOT take `disabled` (see below), so
    // a second Enter is reachable. Guard it here rather than dimming the
    // spinner that IS the progress feedback.
    //
    // `isBusy`, not `isSubmitting`: Enter must not start a password attempt
    // while OAuth, a passkey ceremony or an email-code request is in flight
    // either. `SignUpCard` has always used the wider flag; the two disagreeing
    // is the kind of asymmetry that survives a refactor and then doesn't.
    if (isBusy) return;

    const result = validateForm({
      schema: loginSchema,
      data: { identifier, password },
      t,
    });

    const blocking = STEP_FIELDS[step].flatMap((field) => {
      const message = result.fieldErrors?.[field];
      return message ? [[field, message] as const] : [];
    });

    if (blocking.length > 0) {
      for (const [field, message] of blocking) setFieldError(field, message);
      shakeForm();
      return;
    }

    clearAll();

    if (step === "identify") {
      setStep("authenticate");
      setFocusTarget("password");
      return;
    }

    void attemptSignIn();
  };

  /** Back to step 1, identifier intact, email-code panel closed behind us. */
  const handleBack = () => {
    setEmailCodeOpen(false);
    clearField("password");
    setStep("identify");
    setFocusTarget("identifier");
  };

  const handleCreateAccountPress = () => {
    if (onRequestCreateAccountAction) {
      onRequestCreateAccountAction();
      return;
    }

    router.push(signUpUrl);
  };

  const handleForgotPasswordPress = () => {
    if (onRequestForgotPasswordAction) {
      onRequestForgotPasswordAction();
      return;
    }
    router.push("/forgot-password");
  };

  // Memoized because `EmailCodeSignIn` lists it in the dependency array of the
  // `useCallback` that verifies a code; a fresh closure every render would
  // rebuild that handler on every keystroke.
  const handleEmailCodeNavigate = useCallback(
    (href: string) => router.replace(href),
    [router],
  );

  const handleOAuth = useCallback(
    async (provider: "google" | "apple") => {
      setOauthLoading(provider);
      clearAll();
      onErrorMessageChangeAction?.(null);

      try {
        const result = await authClient.signIn.social({
          provider,
          callbackURL: oauthCallbackUrl,
        });

        // Better Auth returns { data, error }. If there's an error (e.g. provider
        // not configured on the server, or a network failure), surface it to the
        // user instead of silently doing nothing.
        if (result?.error) {
          const msg = formatAuthErrorMessage(result.error, t);
          setError(msg);
          onErrorMessageChangeAction?.(msg);
          return;
        }

        // On success, signIn.social triggers a full-page redirect to the OAuth
        // provider. Close the overlay so the user doesn't land back in a stale
        // auth modal after the OAuth round-trip.
        onDismissAction?.();
      } catch (err) {
        const errorMsg = formatAuthErrorMessage(err, t);
        setError(errorMsg);
        onErrorMessageChangeAction?.(errorMsg);
      } finally {
        setOauthLoading(null);
      }
    },
    [oauthCallbackUrl, t, onDismissAction, onErrorMessageChangeAction],
  );

  const identifying = step === "identify";

  return (
    <AuthCardShell
      testId="auth-sign-in-card"
      // Sign-in is TWO steps and says so up front. The emailed-code panel is a
      // SWAP of step 2, never a third: somebody with no password is not
      // further from the end than somebody with one, and a count that grows
      // when you open a disclosure is a count nobody can trust.
      step={{
        kind: "counted",
        index: identifying ? 1 : 2,
        total: 2,
        name: identifying
          ? "Identify"
          : emailCodeOpen
            ? "Emailed code"
            : "Password",
      }}
    >
      {/* The back affordance sits ABOVE the title, naming the identifier the
          reader gave us — the ticket's "this stub is for X" line. */}
      {!identifying ? (
        <XStack
          {...TEXT_LINK_PROPS}
          data-testid="auth-sign-in-back"
          // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
          type="button"
          maxWidth="100%"
          minWidth={0}
          aria-label="Change email or username"
          disabled={isBusy}
          onPress={handleBack}
        >
          <ArrowLeft
            size={14}
            color="var(--colorMuted, #5C544A)"
            // Beside flexible text: pin it, or the flex row squeezes the glyph
            // to zero width before the label gives up a pixel.
            style={{ flexShrink: 0 }}
            aria-hidden="true"
          />
          <Text variant="overline" color="$colorMuted" flexShrink={1} truncate>
            {identifierValue}
          </Text>
        </XStack>
      ) : null}

      {/* The page's only h1 — `tag` overrides the variant's default element,
          so the document gets its heading without the type having to inflate
          to match.

          `h4` (24px), not `h2` (40px): at 40 the title wrapped to two lines at
          EVERY viewport, spending 88px at the top of a card whose whole job is
          one field and one button. And the copy is "Sign in", not "Sign in to
          Ithas Fire" (`auth.lcTitle`) — the brand mark is printed in the head
          register three lines above it, so the long form was a caption for a
          logo the reader can already see. */}
      <Text variant="h4" tag="h1">
        {String(t("auth.signInTitle"))}
      </Text>

      {/* Friendly inline notice — e.g. when the user is routed here from
          sign-up because their account already exists. Swiss content style:
          square corners, thick accent edge, no shadow. */}
      {noticeMessage ? (
        <YStack
          role="status"
          aria-live="polite"
          data-testid="auth-sign-in-notice"
          backgroundColor="$surfaceMuted"
          borderLeftWidth={4}
          borderLeftColor="$brandSecondary"
          borderRadius={0}
          paddingVertical="$3"
          paddingHorizontal="$4"
        >
          <Text variant="bodySmall" color="$color">
            {noticeMessage}
          </Text>
        </YStack>
      ) : null}

      {/* Form-level errors are surfaced via Sonner toast (see SignInOverlay).
          Keep field-level errors inline (helperText) so users see exactly which
          input failed validation.

          noValidate: we handle validation in JS. */}
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        noValidate
        inert={!hydrated}
        data-testid="auth-sign-in-form"
      >
        <YStack gap="$4">
          {identifying ? (
            <>
              <LabeledTextInput
                label={String(t("auth.lcIdentifier"))}
                labelVariant="overline"
                testId="auth-sign-in-email"
                id={IDENTIFIER_INPUT_ID}
                name="email"
                // Dual email-OR-username field, so it must stay type="text"
                // (type="email" would reject plain usernames via native
                // validation). Do NOT add inputMode="email"/keyboardType here:
                // RNW maps those to DOM type="email", which fights the
                // imperatively-applied type="text" on every render and resets
                // the caret to 0 — i.e. the field "types backwards".
                type="text"
                value={identifier}
                onChangeText={(v) => {
                  setIdentifier(v);
                  if (fieldErrors.identifier) clearField("identifier");
                  // A password typed for the PREVIOUS identifier must not
                  // survive a change of identifier. `handleBack` clears the
                  // password field's ERROR (`clearField`), never its value, so
                  // back → type a different address → Enter submitted account
                  // A's password against account B: a guaranteed-wrong attempt
                  // that spends one of Better Auth's rate-limited tries. The
                  // guard makes this fire once, on the first keystroke after a
                  // staged password exists, not on every character.
                  if (password) {
                    setPassword("");
                    if (fieldErrors.password) clearField("password");
                  }
                }}
                // `lcEmailPlaceholder` ("you@example.com"), not
                // `lcIdentifierPlaceholder` ("you@example.com or username"):
                // the long one truncated to "you@example.com or usernan" at
                // 320px, i.e. the half that carried the extra information was
                // the half that got cut. The label above the field is already
                // "Email or username", so the placeholder restating it bought
                // nothing even when it fit — a placeholder is an example, and
                // the example is the address.
                placeholder={t("auth.lcEmailPlaceholder") as string}
                autoCapitalize="none"
                // "webauthn" enables conditional-UI passkey autofill at this field.
                // RNW's autoComplete typing is narrower than the DOM spec, so cast.
                autoComplete={"username webauthn" as never}
                autoCorrect={false}
                autoFocus
                disabled={isBusy}
                status={fieldErrors.identifier ? "error" : undefined}
                // `TextInput` styles the error state but does not announce it
                // — it never sets `aria-invalid` itself. Setting it here gives
                // the field its invalid state in the a11y tree, and it is what
                // the auth-scoped focus rule in `globals.css` keys off to step
                // aside and leave an errored border red.
                aria-invalid={fieldErrors.identifier ? true : undefined}
                helperText={fieldErrors.identifier}
                {...FIELD_METRICS}
              />

              {/* THE card's one accent fill on this step (v2 §4: one primary
                  button per viewport). Everything under the OR rule is an ink
                  outline precisely so this stays the only one. */}
              <Button
                data-testid="auth-sign-in-continue"
                // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
                type="submit"
                size="$4"
                width="100%"
                disabled={!canContinue || isBusy}
                disabledStyle={RECEDING_DISABLED}
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              <LabeledPasswordInput
                label={String(t("auth.lcPassword"))}
                labelVariant="overline"
                testId="auth-sign-in-password"
                id={PASSWORD_INPUT_ID}
                name="password"
                value={password}
                onChangeText={(v) => {
                  setPassword(v);
                  if (fieldErrors.password) clearField("password");
                }}
                placeholder={t("auth.lcPasswordPlaceholder") as string}
                autoCapitalize="none"
                autoComplete="current-password"
                disabled={isBusy}
                status={fieldErrors.password ? "error" : undefined}
                aria-invalid={fieldErrors.password ? true : undefined}
                helperText={fieldErrors.password}
                toggleLabel={toggleLabel}
                visibleStateLabel={visibleStateLabel}
                hiddenStateLabel={hiddenStateLabel}
                toggleTestId="auth-sign-in-password-toggle"
                {...FIELD_METRICS}
              />

              {/* The credential block: CTA + its two escape hatches, on a
                  `$2` gap rather than the form's `$4`, so the three read as
                  one group instead of three peers. */}
              <YStack gap="$2">
                {/* THE card's one accent fill on THIS step.
                    While submitting it deliberately keeps its live colour and
                    takes `aria-busy` + `aria-disabled` instead of `disabled`:
                    `disabled` applies the atom's opacity treatment, which would
                    dim the very spinner that is the progress feedback (v2:
                    loading is a live state, never styled as disabled). The press
                    is guarded in `handleSubmit`. */}
                <Button
                  data-testid="auth-sign-in-submit"
                  // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
                  type="submit"
                  size="$4"
                  width="100%"
                  disabled={isSubmitting ? undefined : !canSubmit || isBusy}
                  aria-busy={isSubmitting ? true : undefined}
                  aria-disabled={isSubmitting ? true : undefined}
                  disabledStyle={RECEDING_DISABLED}
                >
                  {isSubmitting ? (
                    <Spinner size="sm" indicatorColor="$onBrandSecondary" />
                  ) : null}
                  {isSubmitting
                    ? String(t("auth.lcSigningIn"))
                    : String(t("auth.lcSignIn"))}
                </Button>

                {/* The two escape hatches.

                    They used to hang off the card body's own `$4` gap with a
                    `$1` between them, which — once each 44px hit area padded its
                    14px label by 15px top and bottom — measured ~31px from the
                    button and ~48px between the two labels. A reader parsed
                    three separate things where there is one credential block.

                    NO gap between the links now: the hit areas abut, so the
                    labels sit one 44px row apart, which is the ordinary rhythm
                    of a stacked link list. Both keep the full 44px target — the
                    tightening is in the gaps, never in the thing a thumb has to
                    land on. */}
                <YStack gap="$0">
                  <XStack
                    {...TEXT_LINK_PROPS}
                    // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
                    type="button"
                    disabled={isBusy}
                    onPress={handleForgotPasswordPress}
                  >
                    {/* `$accentText` + underline, not muted: measured on the
                        running card, these two read as byte-identical to the
                        static field labels beside them — same colour, same
                        11px/600 mono, no underline — so nothing said they were
                        controls. Contrast was never the problem (8.24:1); the
                        affordance was. Now they match `Create account` in the
                        footer, which is the card's other text link. */}
                    <Text
                      variant="overline"
                      color="$accentText"
                      textDecorationLine="underline"
                      style={{ textUnderlineOffset: 3 }}
                    >
                      {String(t("auth.lcForgotPassword"))}
                    </Text>
                  </XStack>

                  {/* Keeps the `auth-email-code-toggle` id, now on the control
                      that actually opens the panel. This is where somebody with
                      no password looks: they have already said who they are, and
                      the card is asking for a credential they do not have. */}
                  <XStack
                    {...TEXT_LINK_PROPS}
                    data-testid="auth-email-code-toggle"
                    // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
                    type="button"
                    aria-expanded={emailCodeOpen}
                    aria-controls="auth-email-code-panel"
                    disabled={isBusyExceptEmailCode}
                    onPress={() => setEmailCodeOpen((v) => !v)}
                  >
                    <Text
                      variant="overline"
                      color="$accentText"
                      textDecorationLine="underline"
                      style={{ textUnderlineOffset: 3 }}
                    >
                      Email me a code instead
                    </Text>
                  </XStack>
                </YStack>
              </YStack>
            </>
          )}
        </YStack>
      </form>

      {identifying ? (
        <>
          <OrDivider />

          {/* Three ink-outline PEERS, as 1 + 2 at EVERY width: passkey on its
              own full-width line, then Google | Apple sharing the next.

              Passkey keeps conditional-UI autofill on the field above, so it
              is still the fastest path for anyone enrolled — it just no longer
              spends the page's only accent fill.

              The equal-thirds row this replaces was gated to `$gtXs`, so the
              1+2 break only happened on phones — where three buttons are
              obviously impossible — and the desktop kept the arrangement that
              actually fails: measured at 1440, the providers rendered `GOO…`
              and `APP…`. Three `$4` buttons cannot hold glyph + label across a
              480px card, and `ellipse` on Tamagui's `ButtonText` truncates
              instead of wrapping, so it fails silently. Two can, at 320. */}
          <YStack gap="$3">
            {showPasskeyButton ? (
              <Button
                data-testid="auth-sign-in-passkey"
                variant="secondary"
                size="$4"
                width="100%"
                minWidth={0}
                paddingHorizontal="$2"
                aria-busy={passkeyState === "pending" ? true : undefined}
                aria-disabled={passkeyState === "pending" ? true : undefined}
                disabled={passkeyState === "pending" ? undefined : isBusy}
                onPress={() => {
                  if (isBusy) return;
                  void handlePasskeySignIn();
                }}
              >
                {passkeyState === "pending" ? (
                  <Spinner size="sm" />
                ) : (
                  // currentColor, not a pinned token: `secondary` inverts to an
                  // ink fill on hover and the glyph has to travel with it.
                  <Fingerprint
                    size={16}
                    color="currentColor"
                    style={{ flexShrink: 0 }}
                    aria-hidden="true"
                  />
                )}
                Passkey
              </Button>
            ) : null}

            <OAuthProviderButtons
              disabled={isBusy}
              loading={oauthLoading}
              onPress={handleOAuth}
              testIdPrefix="auth-sign-in"
              containerProps={{ width: "100%", minWidth: 0 }}
            />
          </YStack>
        </>
      ) : (
        <>
          {/* Email-code (OTP) fallback. A guest-checkout buyer has no password,
              no OAuth and no passkey, so without this the sign-in card is a
              dead end for them (their ticket email points at the auth-gated
              `/my-tickets/{orderId}`). */}
          <EmailCodeSignIn
            open={emailCodeOpen}
            initialEmail={identifierValue}
            destination={destination}
            pathname={pathname}
            onNavigateAction={handleEmailCodeNavigate}
            disabled={isBusyExceptEmailCode}
            onBusyChangeAction={setEmailCodeBusy}
            onSignInSuccessAction={onSignInSuccessAction}
            onDismissAction={onDismissAction}
          />
        </>
      )}

      {/* Overlay dismiss. OUTSIDE the <form> on purpose: the Button atom
          renders a <button> with no `type`, which inside a form defaults to
          submit — so as a form child this fired a sign-in attempt on its way to
          closing the overlay. */}
      {onDismissAction ? (
        <Button
          variant="secondary"
          size="$3"
          width="100%"
          onPress={onDismissAction}
          disabled={isBusy}
        >
          {String(t("common.cancel"))}
        </Button>
      ) : null}

      <Separator />

      {/* Footer — navigation, not the page's action, so it is a mono text
          LINK and not a bordered control. As a `secondary` Button it carried
          the same 2px frame and the same uppercase-700 label as the sign-in
          CTA a few pixels above it: two controls of equal weight, one of which
          leaves the flow the reader just started. */}
      <XStack
        justifyContent="center"
        alignItems="center"
        flexWrap="wrap"
        gap="$2"
      >
        <Text variant="overline" color="$colorMuted">
          {String(t("auth.lcNeedAccount"))}
        </Text>
        <XStack
          {...AUTH_FOOTER_LINK}
          data-testid="auth-sign-in-create-account"
          // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
          type="button"
          disabled={isBusy}
          onPress={handleCreateAccountPress}
        >
          <Text {...AUTH_FOOTER_LINK_TEXT}>
            {String(t("auth.lcCreateAccount"))}
          </Text>
        </XStack>
      </XStack>
    </AuthCardShell>
  );
};
