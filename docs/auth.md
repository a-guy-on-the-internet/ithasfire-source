# Auth

How sign-in, sessions and tokens work, how the AuthUser (the login) relates to domain identity (`Human` /
`EntityPage`), and which actions need a verified email. Roles and authorization are in `docs/roles.md`; passkey
and app-association testing is in `docs/runbooks/passkey-testing.md`.

## Better Auth server

Better Auth runs inside the API at `/api/auth/*`, configured in `apps/api/src/auth/better-auth.ts`. Its base URL is
`BETTER_AUTH_BASE_URL`, falling back to `APP_BASE_URL`.

Sign-in methods (plugins and providers in that file):

- **Email and password** (`emailAndPassword`). Sign-in does not require a verified email. Better Auth's own
  `/change-email` is disabled; email changes go through the API's OTP flow (see "Not gated yet" below).
- **Username** (`username()`), for username-based password sign-in.
- **Email code** (`emailOTP`) and **magic link** (`magicLink`). Both sign in an existing AuthUser only
  (`disableSignUp: true`); an unknown address never creates one. The scanner and consumer mobile apps use
  magic links.
- **Phone number code** (`phoneNumber`).
- **Passkey** (`@better-auth/passkey`). The relying party is pinned to the web origin, not the API:
  `rpID` = hostname of `PUBLIC_WEB_URL`, `origin` = `PUBLIC_WEB_URL`.
- **Google and Apple** (`socialProviders`). Each is enabled only when its client id and secret env vars are set.
  Callbacks land on the API (`/api/auth/callback/google|apple`) and the `oAuthProxy` plugin forwards the user to
  the web origin. Provider linking is on with Google and Apple as trusted providers, so they link onto an existing
  AuthUser with the same email even when its email is unverified (guest logins created at checkout).
- **Two-factor** (`twoFactor`): TOTP, with a code by SMS or email as fallback; the mailed or texted code counts as
  the second factor, also for an account with an authenticator app (owner ruling 2026-10-14). The plugin raises its
  challenge only on `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`, so an account with two-factor
  on gets a session only on the routes in `SECOND_FACTOR_SATISFIED_ROUTES`
  (`apps/api/src/auth/second-factor-bypass.ts`, checked in `databaseHooks.session.create.before`): those three, the
  three challenge-verify routes, a passkey that verified the user, and `/change-password`. Everything else, among
  them email code, magic link, phone verify and Google or Apple, is refused with
  `TWO_FACTOR_ACCOUNT_USE_PRIMARY_SIGN_IN`, and a Google or Apple account is not linked onto it. A platform staff
  account whose only second factor is a passkey has no plugin challenge, so it gets a session only from a passkey
  that verified the user (or `/change-password`, `/two-factor/disable` on a session it holds); every other route is
  refused with `STAFF_ACCOUNT_USE_PASSKEY`. A staff account is never given staff authority through Google or Apple alone. The
  file's header tables list every route that mints a session and why. A new staff role signs its holder out
  everywhere (`admin-grant-human-role.ts`), so a session minted before the grant gains no staff authority. Sessions
  minted before this gate deployed are ended once by `apps/api/src/scripts/ops/revoke-second-factor-staff-sessions.ts`
  (dry run by default, `--apply` to sign out).

Every session Better Auth mints passes `databaseHooks.session.create.before`, which refuses a session for a human
who is not `ACTIVE` (suspended or banned).

## Sessions, tokens and JWKS

- **Session.** A Better Auth database session (`AuthSession`). Its cookie is host-only on the API host unless an
  explicit `SESSION_COOKIE_DOMAIN` passes validation (`apps/api/src/auth/cookie-domain.ts`).
- **tRPC never reads the session cookie.** A client exchanges its session for a short-lived JWT at
  `GET /api/auth/token` (the `jwt` plugin) and sends `Authorization: Bearer <jwt>`. The web server mints it in
  `apps/web/src/server/trpc-client.ts`. The scanner keeps its session token in SecureStore and presents it as a
  Bearer token to the same endpoint (`bearer()` plugin; `apps/scanner/src/features/auth/auth-token-store.ts`).
- **JWT contents.** The plugin's default payload plus `sid`, the id of the session it was minted from
  (`definePayload`).
- **Verification.** The AuthN adapter (`packages/adapters/src/authn/better-auth-authn-adapter.ts`) verifies the JWT
  against the JWKS at `BETTER_AUTH_JWKS_URL` (optional `BETTER_AUTH_ISSUER` / `BETTER_AUTH_AUDIENCE`), takes `sub`
  as the AuthUser id, and in one read resolves the `humanId`, refuses a JWT whose `sid` session no longer exists,
  and refuses a human who is not `ACTIVE`. Deleting a human's sessions therefore cuts off their JWTs on the next
  request. `BETTER_AUTH_JWKS_URL` is required in production; elsewhere, without it, the API wires a
  `MissingAuthNAdapter` and authenticated calls fail.
- **API keys.** A request with an `x-api-key` header resolves its human through `ensureAuthedHumanFromApiKey`
  instead of a JWT (`packages/transport/trpc/src/guard.ts`).
- **`BETTER_AUTH_SECRET` encrypts the JWKS private keys.** At boot, `validateJwks`
  (`apps/api/src/auth/validate-jwks.ts`, called from `apps/api/src/app.ts`) deletes every JWKS row when the newest
  key no longer decrypts under the current secret, so a rotated secret makes Better Auth generate new signing keys
  and every outstanding JWT stops verifying.

Session revocation paths in code:

- **Password reset** deletes every session the AuthUser has (`revokeSessionsOnPasswordReset: true` in
  `better-auth.ts`). It covers all three reset routes: the reset link, the email code and the phone code.
- **First proof of the inbox.** When an unverified AuthUser's email is first proven (a Google or Apple link, an
  email-code sign-in, a magic-link sign-in), `revokeUnprovenCredentials` (`apps/api/src/auth/account-security.ts`)
  removes everything that could have been attached without proof: password, sessions, passkeys, two-factor, API
  keys, phone number, delegate grants and pending invitations. It runs from `databaseHooks.account.create.before`
  and `databaseHooks.user.update.before`.
- **Staff status change** to `SUSPENDED` or `BANNED` (`packages/core/src/use-cases/platform/admin-set-human-status.ts`).
- **Staff unlinking an auth account** (`admin-unlink-auth-account.ts`, same folder).
- **Password change** in account settings, which signs out other sessions (`revokeOtherSessions: true` in
  `apps/web/src/app/account/settings/_components/PasswordSection.tsx`).

There is no session list or "sign out other devices" control in the web app.

## Key concepts

### AuthUser (authentication identity)

**AuthUser** is the identity managed by the auth provider (Better Auth).

- Source of truth for: signing in/out, session validity, MFA, email verification, password resets, OAuth.
- Not the source of truth for: display identity (name/avatar), org roles, domain permissions.

### Human (domain identity)

`Human` is Ithas Fire's domain representation of a person.

- A `Human` is **provisioned** when its AuthUser is created: `databaseHooks.user.create.after` calls
  `provisionHumanForAuthUser`. If provisioning fails, the new AuthUser is deleted. `customSession` re-runs the
  same provisioning for any AuthUser still missing a `humanId`.
- Most backend access control is scoped and enforced using domain identifiers (e.g. `actorHumanId`).

### EntityPage (presentation identity)

`EntityPage` is the canonical source of user-facing identity and public page fields. It replaces the former `Profile` system with an entity-agnostic model that works for Humans, Organizations, and Places.

- Source of truth for: `displayName`, `avatarUrl`, `bannerUrl`, `slug`, and page block content.
- Owned by Ithas Fire (not the auth provider).
- Each entity (Human, Org, Place) has at most one `EntityPage`, identified by `ownerType` + `ownerId`.
- Public pages render at `/p/[slug]`; admin editing at `/account/page` (humans) or `/admin/[slug]/page` (orgs).

## EntityPage vs AuthUser (source of truth)

This is the rule that prevents "identity drift" and weird edge cases across clients:

- `EntityPage` is the canonical source for UI identity fields like `displayName` and `avatarUrl`.
- Auth provider user data ("AuthUser") is authentication-only and should not be used as the display identity source.
- To render the current user's name/avatar, call `entityPages.getMyProfile` (below). Inside core, read the page
  with `repos.entityPages.getByOwner("HUMAN", humanId)`.

## Request flow (high level)

At runtime we treat auth in two layers:

1. **Transport authenticates** the request: a Bearer JWT or an `x-api-key` header resolves to an `actorHumanId`.
2. **Use cases authorize and operate** using domain IDs (require `actorHumanId`, check roles through the AuthZ port).

### What each layer should do

- **Transport (tRPC)**
  - `createContextFactory` (`packages/transport/trpc/src/context.ts`) reads `ctx.authToken` (the Bearer token) and
    `ctx.apiKey`, and starts every request at `actorHumanId: null`.
  - The `requireAuth` / `optionalAuth` middleware (`packages/transport/trpc/src/guard.ts`) resolves
    `ctx.actorHumanId`. `authedProcedure` throws UNAUTHORIZED without one; `optionalProcedure` continues anonymous.
  - Keep business logic out of the transport. It should call core use cases.

- **Core use-cases**
  - Parse inputs via Zod.
  - Authorize through the AuthZ port and the role helpers (`docs/roles.md`).
  - Read/write domain tables (including `EntityPage`).

## "Get me" endpoints

For UI identity, one call:

- `entityPages.getMyProfile` returns `humanId`, `displayName`, `avatarUrl`, `slug` and `visibility` for the signed-in
  human. The page's own content comes from `entityPages.getMyPage`.

Clients should avoid treating the auth provider as the "profile service".

## Avatar uploads (R2)

Avatar uploads take three steps:

1. `entityPages.requestAvatarUpload` mints a short-lived presigned PUT URL.
2. The client uploads directly to object storage.
3. `entityPages.setAvatarFromUpload` finalizes the upload and sets `EntityPage.avatarUrl`.

At sign-up, provisioning copies a provider's profile picture (Google supplies one; Apple does not) into
`EntityPage.avatarUrl`. Avatars always render from `EntityPage`, never from auth provider fields.

## Email verification gates

A verified email (`identity.emailVerified`) is required before actions that move value, change ownership, mint a credential or bulk-upload PII. Sign-up does not require verification, so an unverified address may belong to someone else.

- **Source of truth is the server.** Gates call `ensureEmailVerified(tx, actorHumanId)` (`packages/core/src/use-cases/_helpers/ensure-email-verified.ts`), in the use case except for checkout, which is gated only in the transport (row below). The web banners are guidance, not a security boundary.
- **Blocked error:** `{ code: "forbidden", message: "email_verification_required" }`. A missing actor throws `{ code: "not_found", message: "actor_not_found" }`.
- **New gate:** call the helper first in the use case, so every caller inherits it, add a test beside it, and add the row below. A web guard is optional.

Gated through `ensureEmailVerified` (paths under `packages/core/src/use-cases/` unless given in full):

| Action | Where |
| --- | --- |
| Ticket transfer through `transferTicket`, any reason including `admin` (the check is unconditional) | `tickets/transfer-ticket.ts` |
| Email transfer invite (sender) and claiming one (recipient) | `tickets/initiate-email-transfer.ts`, `tickets/claim-pending-transfer.ts` |
| Transfer recipient search | `humans/search-transfer-recipients.ts` |
| Contact import (every chunk), merge (once at start), list entry add and edit (both through `authorizeContactListEdit`) | `comms/import-contacts.ts`, `comms/merge-contact-lists.ts`, `comms/add-contact-list-entry.ts`, `comms/update-contact-list-entry.ts` |
| Announcement send, test send, audience preview | `announcements/send-announcement.ts`, `announcements/send-test-announcement.ts`, `announcements/preview-audience-count.ts` |
| API key creation | `api-keys/create-api-key.ts` |
| Staff payout scheduling and due-payout listing (staff-only) | `payouts/schedule-payout.ts`, `payouts/list-due-payouts.ts` |
| Checkout create and order-item update: transport only. `createCheckout` and `updateOrderItems` are ungated in core, and embed guest checkout (`embeds/create-embed-guest-checkout.ts`) calls it for an unverified guest on purpose, so a new caller must add the gate itself. | tRPC `orders` router (`packages/transport/trpc/src/routers/orders.ts`) |

Gated with their own typed error:

- `EMAIL_NOT_VERIFIED`: accepting or previewing an org or delegate invitation (`packages/core/src/lib/invitee-identity.ts`), sending event guest invites (`events/invites/create-event-guest-invites.ts`), submitting a place claim (`places/submit-place-claim.ts`).

Skipped silently, no error: two paths match an account to an email-addressed record only when that account's email is verified. A guest event application attaches to the viewer's account only then (`events/_shared/attach-guest-application-submission.ts`), and resetting a shared invite link keeps a holder on their personal invite only then (`keepNamedGuests` in `events/invites/set-event-shared-invite.ts`).

Admin web UX (not a boundary): `AdminEmailVerificationGate` (`apps/web/src/components/auth/AdminEmailVerificationGate.tsx`) renders as a banner in `AdminShell` and, with `mode="block"`, blocks most `/admin/[slug]/*` pages (grep `mode="block"`).

Not gated yet:

- Organizer and seller payout setup: `stripe-connect/initiate-onboarding.ts` and `stripe-connect/create-connect-login-link.ts`, reached through `packages/transport/trpc/src/routers/stripe-connect.ts`. The organizer payouts page (`apps/web/src/app/admin/[slug]/payouts/page.tsx`) blocks it in the web; personal payout setup in account settings (`apps/web/src/app/account/settings/_components/PersonalPayoutsSection.tsx`) does not, and the server blocks neither.
- Resale listing creation (`resale/create-resale-listing.ts`) and resale purchase (`resale/create-resale-checkout.ts`). The resale ownership move runs in the adapter (`packages/adapters/src/db/prisma/resale-listings.ts`), not through `transferTicket`.
- Change account email: Better Auth's `/change-email` is refused, and `apps/api/src/routes/account/email-change.ts` sends an OTP to the new address, but a verified current address is not required.
- Invoice download and refund tooling, other high-impact admin actions.

## Related docs

- `docs/roles.md` (RBAC / role definitions, the staff second-factor requirement)
- `docs/runbooks/passkey-testing.md` (passkeys, AASA / assetlinks)
- `docs/layers.md` (how use cases are structured and how to add or modify one)
- `apps/api/src/lib/env.ts` (Better Auth env vars: `BETTER_AUTH_SECRET`, `BETTER_AUTH_JWKS_URL`, etc.)
