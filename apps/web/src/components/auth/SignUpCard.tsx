"use client";

import {
  FormEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import {
  Button,
  LabeledPasswordInput,
  LabeledTextInput,
  NextLinkAnchor,
  ProgressBar,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";
import { XStack, YStack, styled } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { getSignInUrl } from "@/lib/auth/urls";
import {
  evaluatePasswordStrength,
  passwordStrengthLabel,
} from "@/lib/auth/password-strength";
import { appendRedirectParam, readRedirectParam } from "@/lib/redirect";
import { normalizeError } from "@th/errors";
import { formatAuthErrorMessage } from "./auth-helpers";
import { useFormErrors } from "@/hooks/useFormErrors";
import { signUpSchema, validateForm } from "@/lib/validation";
import { OAuthProviderButtons } from "./OAuthProviderButtons";
import { OrDivider } from "./OrDivider";
import { AuthCardShell } from "./AuthCardShell";
import {
  AUTH_FOOTER_LINK,
  AUTH_FOOTER_LINK_BOX,
  AUTH_FOOTER_LINK_TEXT,
  AUTH_FOOTER_RULE,
  RECEDING_DISABLED,
} from "./auth-card-chrome";
import { useAuthRedirect } from "./useAuthRedirect";

/**
 * The footer rule. A hairline at 20% ink, not a 2px full-ink structural line —
 * see `AUTH_FOOTER_RULE`.
 */
const Separator = styled(YStack, {
  name: "AuthFooterRule",
  ...AUTH_FOOTER_RULE,
});

/**
 * True when a sign-up error means the email is already registered. Detection
 * now flows through the shared `@th/errors` resolver, which collapses the
 * varying Better Auth shapes (`code`/`.body.code` of `USER_ALREADY_EXISTS*`,
 * plus the `/already (exists|in use|registered)/i` message fallback) into a
 * single `USER_ALREADY_EXISTS` code — so the routing behaviour is preserved
 * while the bespoke detector is retired.
 */
function isAccountAlreadyExistsError(error: unknown): boolean {
  return normalizeError(error).code === "USER_ALREADY_EXISTS";
}

/**
 * The stand-in `name` step 1 sends, because Better Auth's `signUp.email`
 * requires one and step 1 no longer asks.
 *
 * The email's local part — `jane.doe` from `jane.doe@example.com` — so the
 * account has a name a human would recognise as theirs until step 4 (the
 * profile panel) replaces it. Never the whole address: `name` is rendered on
 * orders, RSVPs and passkey labels, and an email address in those places
 * reads as a leak. A bare address with no `@` falls through unchanged.
 */
export function placeholderNameFromEmail(email: string): string {
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : email;
  return local.trim() || email.trim();
}

export type SignUpCardProps = {
  redirectOverride?: string | null;
  onDismissAction?: () => void;
  onRequestSignInAction?: () => void;
  onStatusChangeAction?: (status: "idle" | "submitting") => void;
  onErrorMessageChangeAction?: (message: string | null) => void;
  /** Called after a successful email+password sign-up with the email and password used. */
  onSignUpSuccessAction?: (email: string, password: string) => void;
  /**
   * Called when sign-up fails because the email is already registered. The
   * parent should route to the sign-in view, prefill this email, and surface a
   * friendly notice instead of trapping the user on the create-account form.
   */
  onAccountExistsAction?: (email: string) => void;
  /** Optional header rendered inside the card surface (e.g. step indicator). */
  cardHeader?: ReactNode;
};

/**
 * Step 1 of 4 — Create.
 *
 * Email and password, and nothing else. The card used to open on a screen
 * whose only job was a "Create your account" button that revealed the form,
 * then asked for five fields at once — display name, username, email,
 * password, confirm. The disclosure is gone for the reason sign-in's was: the
 * form IS the step. Display name and username moved to step 4, which is the
 * panel that exists for them. Confirm-password is dropped for good; the
 * reveal toggle already lets the reader check what they typed.
 *
 * What the account looks like between steps 1 and 4: `name` is a placeholder
 * derived from the email (see `placeholderNameFromEmail`) and `username` is
 * NULL. Better Auth's username plugin leaves the column empty when the field
 * is omitted, and username-login fails while it is — which is fine for the
 * three panels between here and the profile step of the same session, and
 * is exactly the state an OAuth sign-up has always been in.
 */
export const SignUpCard = ({
  redirectOverride,
  onDismissAction,
  onRequestSignInAction,
  onStatusChangeAction,
  onErrorMessageChangeAction,
  onSignUpSuccessAction,
  onAccountExistsAction,
  cardHeader,
}: SignUpCardProps = {}) => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { destination, oauthCallbackUrl } = useAuthRedirect(redirectOverride);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting">("idle");
  const { fieldErrors, setError, setFieldError, clearField, clearAll } =
    useFormErrors<"email" | "password">();
  const [oauthLoading, setOauthLoading] = useState<"google" | "apple" | null>(
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const signInUrl = useMemo(() => {
    return appendRedirectParam(getSignInUrl(), readRedirectParam(searchParams));
  }, [searchParams]);

  const isSubmitting = status === "submitting";
  const emailValue = email.trim();
  const passwordStrength = useMemo(
    () => evaluatePasswordStrength(password),
    [password],
  );
  const passwordMeetsRequirements = passwordStrength.metRequirements;
  const isBusy = isSubmitting || oauthLoading !== null;
  const canSubmit =
    Boolean(emailValue) && passwordMeetsRequirements && !isBusy;
  const toggleLabel = String(t("auth.lcTogglePw"));
  const visibleStateLabel = String(t("auth.lcPwVisible"));
  const hiddenStateLabel = String(t("auth.lcPwHidden"));

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

        // Better Auth returns { data, error }. If the server returns an error
        // (e.g. provider not configured, network failure), surface it instead
        // of silently doing nothing.
        if (result?.error) {
          const msg = formatAuthErrorMessage(result.error, t);
          setError(msg);
          onErrorMessageChangeAction?.(msg);
          return;
        }

        // Social sign-ins redirect to the provider — close the overlay so
        // the user doesn't land back in an onboarding stepper.
        onDismissAction?.();
      } catch (err) {
        const errorMsg = formatAuthErrorMessage(err, t);
        setError(errorMsg);
        onErrorMessageChangeAction?.(errorMsg);
      } finally {
        setOauthLoading(null);
      }
    },
    [oauthCallbackUrl, onDismissAction, t, onErrorMessageChangeAction, clearAll, setError],
  );

  const attemptSignUp = async () => {
    // Guard against double-submits (e.g. both onPress + form submit firing).
    if (isBusy) return;

    setStatus("submitting");
    onStatusChangeAction?.("submitting");
    clearAll();
    onErrorMessageChangeAction?.(null);

    try {
      if (!passwordMeetsRequirements) {
        const msg = String(
          t("auth.scPasswordNotMet", {
            suggestion: passwordStrength.suggestions[0] ?? "",
          }),
        );
        setError(msg);
        onErrorMessageChangeAction?.(msg);
        return;
      }

      // Defensive: ensure we don't have a stale session before signing up.
      await authClient
        .signOut({
          fetchOptions: {
            disableSignal: true,
          },
        })
        // signOut() rejects when there's no active session — that's expected
        // here (clearing stale state before sign-up). Predicate skips telemetry.
        .catch(traceIgnoredError("auth.signUp.preSignOut", () => true));

      const { error } = await authClient.signUp.email({
        // `name` is required by Better Auth and step 1 no longer asks for it;
        // the profile step (4 of 4) overwrites this placeholder.
        name: placeholderNameFromEmail(emailValue),
        email: emailValue,
        password,
        // `username` is deliberately NOT sent. The username plugin leaves the
        // column NULL when the field is omitted, and username-based login
        // fails while it is NULL — acceptable between step 1 and step 4 of
        // the same session, where `WelcomeProfileCard` sets it.
      });

      if (error) {
        // Don't trap the user on the create-account form when the email is
        // already registered — route them to sign-in with the email prefilled
        // and a friendly notice instead of the generic error toast.
        if (onAccountExistsAction && isAccountAlreadyExistsError(error)) {
          onAccountExistsAction(emailValue);
          return;
        }
        onErrorMessageChangeAction?.(formatAuthErrorMessage(error, t));
        return;
      }

      // signUp.email() automatically creates a session by default.
      // If the parent overlay handles post-signup flow (verify email, 2FA,
      // profile), hand off instead of closing & navigating.
      if (onSignUpSuccessAction) {
        onSignUpSuccessAction(emailValue, password);
        return;
      }

      // No host driving the flow: the account exists and is signed in, so
      // leave. Passkey enrolment used to be offered here as a fifth screen;
      // it now lives on step 3 ("Secure your account").
      onDismissAction?.();
      if (destination !== pathname) router.replace(destination);
    } catch (error) {
      onErrorMessageChangeAction?.(formatAuthErrorMessage(error, t));
    } finally {
      setStatus("idle");
      onStatusChangeAction?.("idle");
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy) return;

    const result = validateForm({
      schema: signUpSchema,
      data: { email, password },
      t,
    });

    if (!result.success) {
      for (const [field, msg] of Object.entries(result.fieldErrors)) {
        if (msg) setFieldError(field as "email" | "password", msg);
      }
      const el = formRef.current;
      if (el) {
        el.classList.remove("th-auth-shake");
        void el.offsetWidth;
        el.classList.add("th-auth-shake");
      }
      return;
    }

    clearAll();
    void attemptSignUp();
  };

  return (
    <AuthCardShell
      testId="auth-sign-up-card"
      // Sign-up is four: create → verify → secure → profile. Declared up
      // front and never changed, so the reader can see the shape of what they
      // just started rather than discovering it a panel at a time.
      step={{ kind: "counted", index: 1, total: 4, name: "Create" }}
      header={cardHeader}
      compactVerticalPadding
    >
      {/* The page's h1. "Create account" (`lcCreateAccount`), not
          "Create your Ithas Fire account" (`scTitle`): the long form wrapped
          to two lines at every viewport captioning a brand the reader can
          already see. */}
      <Text variant="h4" tag="h1">
        {String(t("auth.lcCreateAccount"))}
      </Text>

      {/* Server/network errors surface via Sonner toast
          (onErrorMessageChangeAction). Field-level validation stays inline
          on each input via helperText. */}

      <div>
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          noValidate
          data-testid="auth-sign-up-form"
        >
          <YStack gap="$4">
            <LabeledTextInput
              label={t("auth.lcEmail") as string}
              // One label idiom for the whole flow: `overline` IS the brand's
              // label idiom — IBM Plex Mono 11/2px/600 uppercase — and it is
              // what sign-in's fields wear one panel away.
              labelVariant="overline"
              testId="auth-sign-up-email"
              name="email"
              type="email"
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                if (fieldErrors.email) clearField("email");
              }}
              placeholder={t("auth.lcEmailPlaceholder") as string}
              keyboardType="email-address"
              inputMode="email"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              autoFocus
              disabled={isBusy}
              status={fieldErrors.email ? "error" : undefined}
              aria-invalid={fieldErrors.email ? true : undefined}
              helperText={fieldErrors.email}
            />

            <LabeledPasswordInput
              label={t("auth.lcPassword") as string}
              labelVariant="overline"
              testId="auth-sign-up-password"
              id="password"
              name="password"
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                if (fieldErrors.password) clearField("password");
              }}
              placeholder={t("auth.lcPasswordPlaceholder") as string}
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect={false}
              disabled={isBusy}
              status={fieldErrors.password ? "error" : undefined}
              aria-invalid={fieldErrors.password ? true : undefined}
              helperText={fieldErrors.password}
              toggleLabel={toggleLabel}
              visibleStateLabel={visibleStateLabel}
              hiddenStateLabel={hiddenStateLabel}
              toggleTestId="auth-sign-up-password-toggle"
            />

            <YStack gap="$2" marginTop="$-2">
              <ProgressBar
                size="sm"
                value={passwordStrength.score}
                min={0}
                max={4}
                trackColor="$surfaceMuted"
                fillColor={
                  password.length === 0
                    ? "$surfaceMuted"
                    : passwordStrength.level === "strong"
                      ? "$accent"
                      : passwordStrength.level === "okay"
                        ? "$warning"
                        : "$danger"
                }
              />
              {/* Full requirements list shown upfront — each row updates
                  checked as the user types. Beats the old single-line "what's
                  missing" suggestion that revealed rules one at a time and
                  felt like the bar was moving the goalposts.

                  `$accentText`, NOT `$accent`: accent as SMALL TEXT is the
                  case the token ladder exists for. On the ink card the
                  surface rebinds `accentText` to amber (7.87:1); on cream it
                  is flame-800 (5.98:1). Either way it clears where the raw
                  accent (3.89:1 / 4.17:1) does not.

                  The ✓ / ○ glyph stays: colour is never the sole carrier of
                  the met/unmet distinction. */}
              <YStack gap={2} paddingTop={2}>
                {[
                  { label: "At least 10 characters", met: password.length >= 10 },
                  { label: "Upper & lowercase letters", met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
                  { label: "A number", met: /\d/.test(password) },
                  { label: "A symbol", met: /[^A-Za-z0-9]/.test(password) },
                ].map((req) => (
                  <Text
                    key={req.label}
                    variant="bodySmall"
                    color={req.met ? "$accentText" : "$colorMuted"}
                  >
                    {req.met ? "✓" : "○"} {req.label}
                  </Text>
                ))}
              </YStack>
              {password.length > 0 && (
                <YStack gap={2}>
                  <Text variant="bodySmall" color="$colorMuted">
                    Strength: {passwordStrengthLabel(passwordStrength.level)}
                  </Text>
                  {/* The four rows above check length and character classes.
                      `evaluatePasswordStrength` ALSO penalises common words and
                      repeated patterns — two whole points — and that penalty was
                      computed into `suggestions` and then never rendered.

                      Result, observed: `Str0ngPassword!` ticks all four rows and
                      reports "Weak", because it contains "password". The score is
                      right; the reader was simply never told why, which reads as
                      the meter being broken. Surfacing the remaining suggestions
                      is the whole fix — they are already written as instructions
                      ("Avoid common words and repeated patterns."). */}
                  {passwordStrength.suggestions.map((suggestion) => (
                    <Text key={suggestion} variant="bodySmall" color="$warning">
                      {suggestion}
                    </Text>
                  ))}
                </YStack>
              )}
            </YStack>

            {/* Submit CTA — explicit `onPress` (instead of relying on
                `type="submit"`) because Tamagui's Button doesn't reliably
                forward the `type` prop to the DOM <button>, so the browser
                wouldn't actually submit the form on click. */}
            <Button
              data-testid="auth-sign-up-submit"
              // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's Button typings
              type="submit"
              size="$4"
              width="100%"
              disabled={!canSubmit}
              disabledStyle={RECEDING_DISABLED}
              onPress={() => {
                // Belt + suspenders: explicitly trigger the form's submit
                // event so handleSubmit fires regardless of how Tamagui
                // renders the underlying element.
                formRef.current?.requestSubmit();
              }}
            >
              {isSubmitting ? (
                <Spinner size="sm" indicatorColor="$onBrandSecondary" />
              ) : null}
              {isSubmitting
                ? String(t("auth.scCreating"))
                : String(t("auth.scContinue"))}
            </Button>
          </YStack>
        </form>
      </div>

      <OrDivider />

      {/* OAuth peers under the rule, the same 2-up sign-in draws: the card's
          one accent fill is the Continue above, and these are ink-outline
          alternatives to it, not competitors. */}
      <OAuthProviderButtons
        disabled={isBusy}
        loading={oauthLoading}
        onPress={(provider) => void handleOAuth(provider)}
        testIdPrefix="auth-sign-up"
        containerProps={{ width: "100%", minWidth: 0 }}
      />

      <Separator />

      <XStack
        justifyContent="center"
        alignItems="center"
        flexWrap="wrap"
        gap="$3"
      >
        {/* The foot is navigation, not this card's action, so it is a mono
            text link. As a bordered `secondary` Button it read at the same
            weight as the card's primary CTA — two equal controls, one of which
            leaves the flow. */}
        <Text variant="overline" color="$colorMuted">
          {String(t("auth.scAlreadyHaveAccount"))}
        </Text>
        {onRequestSignInAction ? (
          <XStack
            {...AUTH_FOOTER_LINK}
            data-testid="auth-sign-up-sign-in"
            // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
            type="button"
            disabled={isBusy}
            onPress={() => onRequestSignInAction()}
          >
            <Text {...AUTH_FOOTER_LINK_TEXT}>{String(t("auth.signIn"))}</Text>
          </XStack>
        ) : (
          <NextLinkAnchor
            href={signInUrl}
            data-testid="auth-sign-up-sign-in"
            // Tamagui style props are dropped on this adapter when Next is
            // present (only `style` and DOM-safe keys survive), so the touch
            // target has to be raw CSS. The look rides the inner Text.
            style={AUTH_FOOTER_LINK_BOX}
          >
            <Text {...AUTH_FOOTER_LINK_TEXT}>{String(t("auth.signIn"))}</Text>
          </NextLinkAnchor>
        )}
      </XStack>
    </AuthCardShell>
  );
};
