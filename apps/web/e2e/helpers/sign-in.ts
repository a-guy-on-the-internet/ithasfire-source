import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The one place the e2e suite knows how to sign in.
 *
 * Before this file, ~19 specs copy-pasted the same ritual inline. When
 * `/sign-in` was restructured from a single view into a two-step flow, all 19
 * broke at once — including `auth.setup.ts`, which mints the shared
 * `storageState` most of the suite runs on. The duplication was the reason a
 * single UI change could take the whole suite down, so the fix and the
 * de-duplication are the same commit.
 *
 * ── The flow these helpers drive ─────────────────────────────────────────
 *
 * Step 1 — `ACCESS · 01`. `auth-sign-in-email` (an identifier: email OR
 * username) is visible immediately, with `auth-sign-in-continue` as the card's
 * one accent fill. Passkey / Google / Apple sit under an `OR` rule as peers.
 * There is no "Use password instead" disclosure any more; do not look for one.
 *
 * Step 2 — `ACCESS · 02`. `auth-sign-in-password` plus `auth-sign-in-submit`,
 * with `auth-sign-in-back` above the title to change the identifier and
 * `auth-email-code-toggle` below the CTA for the no-password path.
 *
 * `auth-sign-in-form` wraps the field + CTA on BOTH steps, so "the form is
 * visible" no longer implies "the password field is fillable".
 *
 * ── Locator policy ───────────────────────────────────────────────────────
 *
 * Test ids, never accessible names. Two reasons, both load-bearing:
 *
 *  1. The overlay co-mounts `LoginCard` and `SignUpCard` across its slide
 *     transition, and BOTH render a control whose accessible name is
 *     "Sign in" (the sign-in submit, and sign-up's footer link back). A
 *     `getByRole("button", { name: "Sign in" })` is ambiguous there — several
 *     of the inline copies this replaces were one render away from strict-mode
 *     violations.
 *  2. Button labels now render through Tamagui's `ButtonText`, which uppercases
 *     in CSS. The accessible name stays sentence case ("Sign in", not
 *     "SIGN IN") — a name-based selector that matched the painted text would
 *     be wrong, and one written against the painted text would fail.
 *
 * Placeholders are avoided for the same class of reason: they come from the
 * i18n catalogs, which are user WIP.
 */

/** Field/CTA ids, so a future rename has exactly one place to land. */
export const SIGN_IN_TEST_IDS = {
  form: "auth-sign-in-form",
  card: "auth-sign-in-card",
  identifier: "auth-sign-in-email",
  continue: "auth-sign-in-continue",
  password: "auth-sign-in-password",
  submit: "auth-sign-in-submit",
  back: "auth-sign-in-back",
  createAccount: "auth-sign-in-create-account",
} as const;

export const SIGN_UP_TEST_IDS = {
  card: "auth-sign-up-card",
  form: "auth-sign-up-form",
  // Step 1 of 4 is email + password ONLY. The disclosure that used to hide
  // the form (`auth-sign-up-expand-form`), display name, username and
  // confirm-password are gone: identity moved to the profile step (4 of 4)
  // and confirm-password was dropped outright.
  email: "auth-sign-up-email",
  password: "auth-sign-up-password",
  submit: "auth-sign-up-submit",
  signIn: "auth-sign-up-sign-in",
} as const;

/** Step 2 of 4 — verify email. */
export const VERIFY_EMAIL_TEST_IDS = {
  card: "auth-verify-email-card",
  otp: "auth-verify-email-otp",
  continue: "auth-verify-email-continue",
} as const;

/** Step 3 of 4 — secure (passkey / authenticator / email codes). */
export const SECURE_TEST_IDS = {
  card: "auth-setup-2fa-card",
  skip: "auth-2fa-skip",
} as const;

/** Step 4 of 4 — profile. */
export const PROFILE_TEST_IDS = {
  card: "welcome-profile-card",
  displayName: "auth-profile-display-name",
  username: "auth-profile-username",
  submit: "auth-profile-submit",
  skip: "auth-profile-skip",
} as const;

/**
 * Timing budgets. `DEFAULT_TIMEOUT_MS` is the per-step visibility budget a
 * caller can override; `NAVIGATION_TIMEOUT_MS` covers the post-submit hand-off
 * (a network round trip plus a panel swap or a route change) and is
 * deliberately longer, since a dev-mode first compile can sit inside it.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

export type Credentials = {
  email: string;
  password: string;
};

export type SignInOptions = Credentials & {
  /** Per-step visibility budget. Defaults to 20s. */
  timeout?: number;
};

const isVisible = (locator: Locator) =>
  locator.isVisible().catch(() => false);

/**
 * Fill and submit the two-step form that is ALREADY on screen.
 *
 * Use this when the card is somewhere the helpers below don't put it (an
 * overlay opened by a bespoke CTA, a claim page, a second browser context).
 * Everything else should call `signInWithPassword` or
 * `signInViaAccountOverlay`, which navigate first and wait for the result.
 *
 * Resilience is structural, not timed — there is not a single fixed sleep in
 * here. Step 1 is retried as ONE unit (fill → assert value → click → assert the
 * password field arrived) because a `fill()` that lands before Next's dev
 * hydration sets the DOM value without React ever seeing the change: `identifier`
 * stays `""` in state, `canContinue` stays false, and the CTA never leaves its
 * disabled state. Retrying the whole unit rides that out, whereas retrying the
 * click alone would spin against a button that is disabled for a reason.
 */
export async function submitSignInForm(
  page: Page,
  { email, password, timeout = DEFAULT_TIMEOUT_MS }: SignInOptions,
): Promise<void> {
  const form = page.getByTestId(SIGN_IN_TEST_IDS.form);
  await expect(form).toBeVisible({ timeout });

  const identifier = form.getByTestId(SIGN_IN_TEST_IDS.identifier);
  const continueButton = form.getByTestId(SIGN_IN_TEST_IDS.continue);
  const passwordField = form.getByTestId(SIGN_IN_TEST_IDS.password);
  const submit = form.getByTestId(SIGN_IN_TEST_IDS.submit);
  const back = page.getByTestId(SIGN_IN_TEST_IDS.back);

  // ── Land on step 1, whoever we are ──────────────────────────────────────
  // `initialIdentifier` (set when sign-up bounces an existing account here)
  // opens the card straight on step 2, already addressed to SOMEBODY. Signing
  // in as whoever that is would be a silent wrong-account bug, so step back and
  // type our own identifier rather than trusting the one on screen.
  if (!(await isVisible(identifier)) && (await isVisible(back))) {
    await back.click();
    await expect(identifier).toBeVisible({ timeout });
  }

  // ── Step 1: identify ────────────────────────────────────────────────────
  await expect(async () => {
    // Already advanced on a previous attempt — the step-1 field is unmounted,
    // so re-filling it would fail forever. Bail out successfully instead.
    if (await isVisible(passwordField)) return;

    await expect(identifier).toBeEditable();
    await identifier.fill(email);
    await expect(identifier).toHaveValue(email);

    // Asserted, not just clicked: a regression in `canContinue` should fail
    // HERE with a readable message rather than as an opaque click timeout.
    await expect(continueButton).toBeEnabled({ timeout: 2_000 });
    await continueButton.click();

    await expect(passwordField).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout });

  // ── Step 2: authenticate ────────────────────────────────────────────────
  await expect(async () => {
    await expect(passwordField).toBeEditable();
    await passwordField.fill(password);
    await expect(passwordField).toHaveValue(password);
    await expect(submit).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout });

  await submit.click();
}

/**
 * Copy the sign-in card shows when the server REJECTED the credentials.
 *
 * The same set `auth.setup.ts` has always screened for. Verification-gate copy
 * is deliberately NOT here: that setup treats a gated environment as a skip,
 * not a failure, and screens for it itself.
 */
const SIGN_IN_REJECTED =
  /couldn't find your account|data breach|reset your password/i;

/**
 * Wait for the submitted sign-in to RESOLVE, one way or the other.
 *
 * Racing the success signal against the rejection alert, rather than waiting
 * for success and separately asserting no alert. The separate assertion was
 * the shape every inline copy had, and it is vacuous: fired immediately after
 * the click, it runs before the alert can render and always passes, so a bad
 * credential still surfaced as an unexplained 30s timeout. Polling both means
 * the failure message carries the alert's own words.
 */
async function awaitSignInSettled(
  page: Page,
  isSettled: () => Promise<boolean>,
): Promise<void> {
  const rejection = page.getByRole("alert").getByText(SIGN_IN_REJECTED);

  await expect
    .poll(
      async () => {
        if (await isSettled()) return "signed-in";
        if ((await rejection.count()) > 0) {
          const text = await rejection
            .first()
            .innerText()
            .catch(() => "");
          return `rejected: ${text || "(alert had no readable text)"}`;
        }
        return "pending";
      },
      {
        timeout: NAVIGATION_TIMEOUT_MS,
        message: "sign-in never resolved after the credentials were submitted",
      },
    )
    .toBe("signed-in");
}

/** True once the browser has left `/sign-in`. */
const leftSignInPage = (page: Page) => () =>
  Promise.resolve(!new URL(page.url()).pathname.startsWith("/sign-in"));

/**
 * Go to `/sign-in`, sign in with a password, and wait for the redirect away.
 *
 * The standalone-page flavour: the destination is a navigation, so success is
 * "the URL is no longer /sign-in".
 */
export async function signInWithPassword(
  page: Page,
  options: SignInOptions & {
    /** Defaults to `/sign-in`. Pass e.g. `/sign-in?redirect=/account`. */
    signInUrl?: string;
  },
): Promise<void> {
  const { signInUrl = "/sign-in", ...credentials } = options;
  await page.goto(signInUrl);
  await submitSignInForm(page, credentials);
  await awaitSignInSettled(page, leftSignInPage(page));
}

/**
 * Sign in only if the card is actually asking.
 *
 * Replaces the `if (await signInForm.isVisible({ timeout: 5_000 }))` guard the
 * checkout/settlement specs wrap their sign-in in: they arrive already
 * authenticated from the sign-up they just ran, and `/sign-in` bounces them
 * straight back out. Returns whether it signed in, so a caller can assert on
 * that if it cares.
 */
export async function signInWithPasswordIfPrompted(
  page: Page,
  options: SignInOptions & { signInUrl?: string },
): Promise<boolean> {
  const { signInUrl = "/sign-in", timeout = 5_000, ...credentials } = options;
  await page.goto(signInUrl);

  const form = page.getByTestId(SIGN_IN_TEST_IDS.form);
  const prompted = await form
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (!prompted) return false;

  await submitSignInForm(page, credentials);
  await awaitSignInSettled(page, leftSignInPage(page));
  return true;
}

/**
 * Sign in through the navbar account overlay.
 *
 * The overlay flavour: there is no navigation, so success is the card closing.
 * Callers that were on `/` stay on `/`.
 */
export async function signInViaAccountOverlay(
  page: Page,
  { email, password, timeout = DEFAULT_TIMEOUT_MS }: SignInOptions,
): Promise<void> {
  const form = page.getByTestId(SIGN_IN_TEST_IDS.form);

  if (!(await isVisible(form))) {
    await page.getByTestId("navbar-account").click();
    await expect(form).toBeVisible({ timeout });
  }

  await submitSignInForm(page, { email, password, timeout });
  await awaitSignInSettled(page, async () => !(await isVisible(form)));
}

export type SignUpOptions = {
  email: string;
  password: string;
  /**
   * Applied on the PROFILE step (4 of 4) by `completeSignUpOnboarding`, not
   * at sign-up. `signUpWithPassword` alone ignores them — step 1 no longer
   * asks — and they stay optional so the ~19 call sites that predate the
   * four-step flow keep compiling.
   */
  username?: string;
  displayName?: string;
  timeout?: number;
};

/**
 * Bring the sign-up FORM on screen, from wherever the page currently is.
 *
 * Step 1 IS the form now — there is no disclosure to open. So this only has
 * to get onto a sign-up card: either it is already showing, or the sign-in
 * card is (take its footer link), or nothing is (open the overlay first).
 */
async function revealSignUpForm(page: Page, timeout: number): Promise<Locator> {
  const form = page.getByTestId(SIGN_UP_TEST_IDS.form);
  if (await isVisible(form)) return form;

  const createAccount = page.getByTestId(SIGN_IN_TEST_IDS.createAccount);
  if (!(await isVisible(createAccount))) {
    await page.getByTestId("navbar-account").click();
    await expect(createAccount).toBeVisible({ timeout });
  }
  await createAccount.click();
  await expect(form).toBeVisible({ timeout });
  return form;
}

/**
 * Create an account through the UI (step 1 of 4) and wait for the card to
 * hand off to step 2.
 *
 * Fills by test id rather than by placeholder — placeholders come from the
 * i18n catalogs and are ordinal, so a copy edit silently retargets a field.
 *
 * Does NOT verify the email or walk the rest of onboarding; see
 * `completeSignUpOnboarding` for that. Success is the FORM going away, not
 * the URL changing: on the standalone page the shell swaps to the in-place
 * verify-email panel and the path stays `/sign-up`.
 */
export async function signUpWithPassword(
  page: Page,
  { email, password, timeout = DEFAULT_TIMEOUT_MS }: SignUpOptions,
): Promise<void> {
  await page.goto("/sign-up");

  const form = await revealSignUpForm(page, timeout);

  await form.getByTestId(SIGN_UP_TEST_IDS.email).fill(email);
  await form.getByTestId(SIGN_UP_TEST_IDS.password).fill(password);

  await page.getByTestId(SIGN_UP_TEST_IDS.submit).click();

  await expect(form).not.toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS });
}

export type OnboardingOptions = {
  /**
   * The 6-digit code from the verification email. The caller reads it (from
   * Mailpit) — this helper only types it. Omit when already past step 2.
   */
  otp?: string;
  /** Written on step 4. Omitted → that field keeps its prefill / stays empty. */
  displayName?: string;
  username?: string;
  timeout?: number;
};

/**
 * Walk a freshly signed-up account through the rest of onboarding:
 * step 2 (verify, if an `otp` is supplied) → step 3 (secure — always skipped
 * here; enrolling a passkey or TOTP is its own concern) → step 4 (profile —
 * filled if identity was given, otherwise skipped, so a spec that only needs
 * *a* signed-in user pays for nothing it did not ask for).
 *
 * Resolves once the profile card is gone, i.e. the flow has handed off to
 * its destination. Tolerant of starting on any of steps 2–4.
 */
export async function completeSignUpOnboarding(
  page: Page,
  {
    otp,
    displayName,
    username,
    timeout = DEFAULT_TIMEOUT_MS,
  }: OnboardingOptions = {},
): Promise<void> {
  const otpInput = page.getByTestId(VERIFY_EMAIL_TEST_IDS.otp);
  if (otp && (await isVisible(otpInput))) {
    await otpInput.fill(otp);
    // The card auto-submits on the sixth digit; the button is the fallback.
    const cont = page.getByTestId(VERIFY_EMAIL_TEST_IDS.continue);
    if (await isVisible(cont)) await cont.click().catch(() => undefined);
    await expect(otpInput).not.toBeVisible({ timeout });
  }

  const secureSkip = page.getByTestId(SECURE_TEST_IDS.skip);
  await expect(secureSkip).toBeVisible({ timeout });
  await secureSkip.click();

  const profile = page.getByTestId(PROFILE_TEST_IDS.card);
  await expect(profile).toBeVisible({ timeout });

  if (displayName !== undefined || username !== undefined) {
    if (displayName !== undefined) {
      await profile.getByTestId(PROFILE_TEST_IDS.displayName).fill(displayName);
    }
    if (username !== undefined) {
      await profile.getByTestId(PROFILE_TEST_IDS.username).fill(username);
    }
    await profile.getByTestId(PROFILE_TEST_IDS.submit).click();
  } else {
    await profile.getByTestId(PROFILE_TEST_IDS.skip).click();
  }

  await expect(profile).not.toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS });
}
