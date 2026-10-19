# Testing passkeys locally

Passkeys come from the `@better-auth/passkey` plugin. The `/sign-in` card (`apps/web/src/components/auth/LoginCard.tsx`) offers a **Passkey** button beside Google and Apple, and also offers enrolled passkeys in the email field's autofill (WebAuthn conditional UI). To test in local dev without a real device:

1. Open Chrome DevTools → ⋮ menu → **More tools → WebAuthn**.
2. Toggle **"Enable virtual authenticator environment"** on.
3. Click **"Add"** → leave defaults (`internal`, `ctap2`, `resident-key: yes`, `user-verification: yes`).
4. On `/account/settings/security`, click **"Add a passkey"** to enroll one against the virtual authenticator. The passkeys card shows for every signed-in account, OAuth-only included.
5. Sign out, open `/sign-in`, click **Passkey** (or pick the passkey from the email field's autofill). DevTools logs the assertion and signs you in.

Password sign-in is the card's second step: enter the email or username, press **Continue**, then the password.

A staff account (the seeded `dev-login` admin included) that enrols a passkey without an authenticator app can then sign in only with that passkey: password, email code, magic link and Google or Apple answer `STAFF_ACCOUNT_USE_PASSKEY`. `DEV_BYPASS_STAFF_2FA` does not relax this sign-in gate. To get the password back, enrol an authenticator app too, or delete the passkey.

## Testing scanner passkeys

Scanner passkeys piggyback on the same `passkey()` server plugin. Cross-device credential sharing relies on:

- `apps/web/public/.well-known/apple-app-site-association` claims `FJG7F43395.com.ithasfire.scan` for `webcredentials` AND `FJG7F43395.com.ithasfire.app` (consumer) for both `webcredentials` and `applinks` (`/events/*`, `/event/*`, `/orgs/*`, `/places/*`, `/p/*`, `/my-tickets*`, `/tickets/qr/*`) on `ithasfire.com`. (Team `FJG7F43395` = business account; the old `5J9DRDR2TB.com.ithasfire(.scanner)` bundle IDs were burned in App Store Connect and re-registered as `com.ithasfire.app` / `com.ithasfire.scan`.)
- `apps/web/public/.well-known/assetlinks.json` claims `com.ithasfire.scan` for Credential Manager (`get_login_creds`) and App Links (`handle_all_urls`). It lists two SHA-256 fingerprints and does not say which signing key each belongs to. To re-verify, compare them against the EAS production keystore (`cd apps/scanner && eas credentials -p android`) and the Play app-signing key; `docs/runbooks/android-keystore.md` says where to read each. Update the file whenever either key changes. **TODO before consumer mobile launch:** add a second entry for `com.ithasfire` (Android consumer package) with its SHA-256 fingerprints (omit until real; invalid fingerprints break App Links auto-verification for the whole file).
- `apps/scanner/app.config.ts` — `ios.associatedDomains` (`webcredentials:ithasfire.com` only, no universal links) + `android.intentFilters` reference `ithasfire.com`.

Local + dev limitations: the iOS Simulator and Android emulator don't honour AASA / assetlinks the same way real devices do. To smoke-test cross-device passkey sign-in, build via `eas build --profile preview` and install on a physical device. Locally you can still test the **CTA wiring** by running the scanner against an API host that's reachable over HTTPS.

Server side requires no extra setup. `passkey()` is mounted in `apps/api/src/auth/better-auth.ts` with the relying party pinned to the web origin: `rpID` is the hostname of `PUBLIC_WEB_URL` and `origin` is `PUBLIC_WEB_URL`. (Left to itself the plugin would derive them from the API's base URL, which is the wrong origin.) Locally that makes the relying party `localhost`.
