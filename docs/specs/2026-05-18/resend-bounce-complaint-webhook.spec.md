# Resend Bounce / Complaint Webhook + Email Deliverability Guardrails

> Not built yet (2026-10-08 docs consolidation): Phase 5 admin override UI, 6 unverified-signup bounce fix, 7 storm circuit-breaker, 8 GDPR erasure (Phase 4 secret wiring appears done though unticked)

**Date:** 2026-05-18
**Status:** in-progress
**Priority:** P2 (pre-launch sender-reputation hygiene; not strictly launch-blocking at zero volume, but trivial to ship)
**Depends on:** `packages/adapters/src/comms/mail/resend-mailer.ts`, `apps/api/src/auth/better-auth.ts`, `apps/api` Hono route layout (cf. `apps/api/src/routes/stripe/`), Terraform secrets (`infra/terraform/secrets.tf`).

---

## Status checklist

- [x] **Phase 1** — DB column + migration; pre-send guard in mailer; structured logging only (no webhook yet).
- [x] **Phase 2** — Webhook route at `POST /webhooks/resend` with Svix signature verification, idempotency, event dispatch.
- [x] **Phase 3** — In-app "Update your email address" notification + settings flow (covers users locked out by bounce).
- [ ] **Phase 4** — Terraform / Forgejo / GCP Secret Manager wiring for `RESEND_WEBHOOK_SECRET`; configure webhook in Resend dashboard pointing at `https://api.hearthfire.community/webhooks/resend`.
- [ ] **Phase 5** — Admin override UI — platform-admin page lists flagged users + clear-flag button.
- [ ] **Phase 6** — Unverified-account inline bounce correction (signup-bounce death-loop fix) + 24h abandoned-account cleanup cron.
- [ ] **Phase 7** — Bounce-storm circuit-breaker (>50 bounces in 5 min → pause auto-flagging + Discord alert).
- [ ] **Phase 8** — GDPR erasure hooks (anonymize `EmailDeliveryEvent` on account deletion).

Flip top-line `Status:` `draft → in-progress → complete` as phases land. Move file to `docs/specs/2026-05-18/completed/` once all phases ship.

## Premise

Resend fires `email.bounced` and `email.complained` webhooks when a recipient mailbox permanently rejects an email or marks it as spam. Continuing to send to those addresses degrades our sender reputation at Gmail/Outlook, which then degrades deliverability **to every user**, not just the affected one.

We need three things:

1. **Persistent flag** on the user (`AuthUser`) so we know the address is bad.
2. **Pre-send guard** in the mailer so we stop sending automatically.
3. **In-app notification** so the user actually finds out their address is broken and can update it — otherwise they're invisibly locked out of password resets, ticket receipts, 2FA email-OTP, etc.

The third item is the one that's easy to forget. A flag without a remediation path just hides the user. They need to see _"We can't email you anymore — update your address"_ the next time they log in.

## Resend payload reference (verbatim from `resend.com/docs`)

### `email.bounced`

Triggered when the recipient mail server **permanently rejected** the email.

```json
{
  "type": "email.bounced",
  "created_at": "2026-11-22T23:41:12.126Z",
  "data": {
    "broadcast_id": "8b146471-e88e-4322-86af-016cd36fd216",
    "created_at": "2026-11-22T23:41:11.894719+00:00",
    "email_id": "56761188-7520-42d8-8898-ff6fc54ce618",
    "from": "Ithas Fire <transactional@hearthfire.community>",
    "to": ["recipient@example.com"],
    "subject": "Your ticket for Night Market Sessions",
    "template_id": "...",
    "bounce": {
      "message": "...",
      "subType": "Suppressed" | "MessageRejected" | "General" | ...,
      "type": "Permanent" | "Temporary",
      "diagnosticCode": ["smtp; 550 5.1.1 ..."]
    },
    "tags": { "category": "ticket_issued", "user_id": "..." }
  }
}
```

Treat `bounce.type === "Permanent"` as a flagging event. `Temporary` is logged only — Resend retries internally.

### `email.complained`

Triggered when the email was **delivered successfully but marked as spam** by the recipient.

```json
{
  "type": "email.complained",
  "created_at": "2026-02-22T23:41:12.126Z",
  "data": {
    "broadcast_id": "...",
    "created_at": "...",
    "email_id": "...",
    "from": "...",
    "to": ["recipient@example.com"],
    "subject": "...",
    "template_id": "...",
    "tags": { "category": "ticket_issued" }
  }
}
```

Always treat as flagging — there's no severity gradient.

### Signature verification

Resend signs webhook requests via [Svix](https://docs.svix.com/receiving/verifying-payloads/how). Headers: `svix-id`, `svix-timestamp`, `svix-signature`. The shared secret is the webhook's "Signing Secret" surfaced in the Resend dashboard. Verify before parsing:

```ts
import { Webhook } from "svix";
const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET);
wh.verify(rawBody, {
  "svix-id": req.header("svix-id")!,
  "svix-timestamp": req.header("svix-timestamp")!,
  "svix-signature": req.header("svix-signature")!,
});
```

`Webhook#verify` throws on tampered / replayed / expired payloads (default tolerance: 5 minutes). On throw → respond `400`, do **not** ack to Resend.

## Data model

### `AuthUser` additions

```prisma
model AuthUser {
  // ... existing fields ...

  /// Email deliverability status. NULL = healthy, can send.
  ///   BOUNCED   — hard bounce; mailbox rejected. Block all sends.
  ///   COMPLAINED — user reported as spam. Block all sends + treat as
  ///                explicit unsubscribe (no non-critical email ever).
  /// Cleared via admin override or when the user updates their email
  /// address through the settings flow.
  emailDeliveryStatus     EmailDeliveryStatus? @map("email_delivery_status")
  emailDeliveryStatusAt   DateTime?            @map("email_delivery_status_at")
  /// Resend's `email_id` (vendor id) for the event that caused the flag,
  /// kept for support-ticket trace-back.
  emailDeliveryStatusRef  String?              @map("email_delivery_status_ref")
}

enum EmailDeliveryStatus {
  DELIVERABLE // audit-only: temporary bounce event, not stored on AuthUser as healthy state
  BOUNCED
  COMPLAINED
}
```

### `EmailDeliveryEvent` (audit table)

```prisma
model EmailDeliveryEvent {
  id              String   @id @default(uuid())
  /// Resend's per-event UUID when present, otherwise the verified Svix `svix-id`.
  /// Do not use `data.email_id` here; that is the Resend message id and multiple
  /// webhook events can reference the same message.
  providerEventId String   @map("provider_event_id")
  provider        String
  type            String   /// "email.bounced" | "email.complained" | "email.delivered.soft_bounce"
  recipientEmail  String   @map("recipient_email")
  /// FK soft-link to AuthUser by email at the time. May be null if no
  /// user row matches (e.g. transactional preview send).
  authUserId      String?  @map("auth_user_id")

  /// Verbatim webhook `data` object — preserves bounce.subType / diagnosticCode
  /// for forensics without us schematising every field.
  payload         Json

  occurredAt      DateTime @map("occurred_at")
  createdAt       DateTime @default(now()) @map("created_at")

  @@unique([provider, providerEventId])
  @@index([recipientEmail])
  @@index([authUserId])
  @@map("email_delivery_event")
}
```

Retention: keep indefinitely until business reason to GC (likely 24 months). Tiny rows, no PII beyond email + subject.

## Webhook handler

### Route

`POST /webhooks/resend` in `apps/api/src/routes/resend/webhook.ts`. Mirror the Stripe webhook route layout: raw-body capture, signature verification, idempotency check, dispatch.

```
POST /webhooks/resend
  └─ Verify Svix headers      (400 on fail)
  └─ Parse JSON body
  └─ Upsert EmailDeliveryEvent by provider + providerEventId (200 on conflict — replay)
  └─ Dispatch by event.type:
      ├─ email.bounced  + bounce.type === "Permanent"
      │   → set AuthUser.emailDeliveryStatus = BOUNCED for each recipient
      ├─ email.bounced  + bounce.type === "Temporary"
      │   → log only
      ├─ email.complained
      │   → set AuthUser.emailDeliveryStatus = COMPLAINED for each recipient
      │   → additionally write an unsubscribe audit row (covers CAN-SPAM /
      │     GDPR "explicit withdrawal of consent")
      └─ anything else
          → log + 200 (forward-compatible)
  └─ Respond 200
```

### Idempotency

Resend retries webhook delivery on non-2xx and may re-send during reconciliation. The `EmailDeliveryEvent(provider, providerEventId)` unique constraint is the durable idempotency key. Prefer a real provider event id if the payload includes one; otherwise use the verified Svix `svix-id`. Never use `data.email_id` as the event id because it is the message id, not the webhook event id. Use Prisma's `create` + `P2002` → return 200 fast path. Do not use an in-memory cache; multiple Cloud Run instances would split-brain.

### Multi-recipient handling

`data.to` is an array. In practice for transactional sends it's a single recipient, but we'll iterate to be safe. For each:

- Find `AuthUser` by `email = recipient` (case-insensitive).
- If found, set flag; if not (e.g. preview to non-user address), skip user-update but still write `EmailDeliveryEvent` with `authUserId: null`.

### Where the route mounts

Stripe-style: a sub-app in `apps/api/src/index.ts`. Path must remain `https://api.hearthfire.community/webhooks/resend`. Do **not** mount under tRPC — Svix verification needs the raw request body, which our tRPC router consumes.

## Mailer pre-send guard

Update `ResendMailAdapter.send` (and `sendBatch` per-item) to short-circuit when the recipient is flagged. Lookup needs to be cheap — add a port `EmailDeliverabilityPort` so we don't reach into Prisma from the adapter.

```ts
// packages/ports/comms/email-deliverability.ts
export interface EmailDeliverabilityPort {
  status(email: string): Promise<"healthy" | "bounced" | "complained">;
}

// In send():
const status = await this.deliverability?.status(input.to[0].to);
if (status && status !== "healthy") {
  this.metrics?.increment("mail.suppressed", { reason: status });
  return {
    result: errorResult("recipient_suppressed", `recipient_${status}`, {
      email: input.to[0].to,
      status,
    }),
  };
}
```

**Exemption?** Initial instinct is to exempt 2FA email-OTP (since the user may need it to recover). But: if the mailbox is dead, it's dead — there's no recovery via that channel. The right pattern is:

- Mailer always honours the flag (no exemptions).
- Auth code that _tries_ email-OTP detects the `recipient_suppressed` error and falls back to SMS OTP if a verified phone exists; otherwise surface "Your email address is no longer reachable. Update it from your settings to continue."
- This dovetails with the existing email/SMS-OTP fallback logic in `apps/api/src/auth/otp-senders.ts`.

## Unverified-account signup-bounce correction (Phase 6)

**The single largest UX hole** if not handled: a user types a typo email (`jhon@gmail.cmo`), the verification OTP bounces, the webhook flags them `BOUNCED`, and they stare at a verify-email screen forever waiting for a code that will never come.

### Decision: do not permanently flag unverified accounts

When the webhook handler is about to set `emailDeliveryStatus = BOUNCED` on an `AuthUser`, first check `emailVerified`. If `false`:

- **Skip the flag.** The flag is for healthy accounts that _became_ undeliverable. An unverified account that never deliverable in the first place isn't the same problem.
- **Write `EmailDeliveryEvent` anyway** with `authUserId` set — drives the inline correction UX.
- **The verify-email screen** (`apps/web/src/components/auth/VerifyEmailCard.tsx`) polls `accountHealth.getDeliveryStatus`. When it sees a bounce event for the current pending email, it surfaces:
  > _"We couldn't deliver the code to `<email>` — looks like a bad address. **Update email →**"_
- **Inline edit** updates `AuthUser.email` (still unverified) → re-sends OTP to the corrected address. Common typo suggestions (`.cmo→.com`, `gmial→gmail`, `yaho→yahoo`) shown as quick-replace chips, but the user can type anything.
- The OLD `EmailDeliveryEvent` row stays in the audit log keyed to the original bad address (so support can trace).

### 24h abandoned-account cleanup

A cron job (in `apps/jobs`) sweeps for `AuthUser` rows with `emailVerified=false AND createdAt < NOW() - INTERVAL '24 hours' AND ` (one or more matching `EmailDeliveryEvent` records exist for their email). Soft-delete (`status: ABANDONED` if we have that, else hard-delete). Keeps the table clean and lets legitimate users re-sign-up with the same email later.

## Guest-checkout ticket-receipt bounce

A guest buyer enters `jhon@gmail.cmo`, completes payment, gets routed to `/events/checkout/.../confirmation`, and the system emails their tickets — which bounces. There's no `AuthUser` row to flag and no logged-in session to banner.

Handling:

- `EmailDeliveryEvent` row is still written (with `authUserId: null`).
- The confirmation page polls a public endpoint `orders.getEmailDeliveryStatus({ orderId, accessToken })` keyed on the order's resume-access token (already used for `/events/checkout/.../[orderId]/resume`).
- When the poll returns `bounced`, the page surfaces an inline "Send tickets to a different email" form. Submitting updates `Order.guestEmail` and re-sends the ticket-issued email via the mailer (which is now fine because the new address isn't flagged).
- Polling stops once the user navigates away or after 5 min.

Same pattern but lighter-weight than the authed banner path.

## Bounce-storm circuit-breaker (Phase 7)

Protects against mass false-flagging when a TLD or major mailbox provider has a transient outage that surfaces to us as a wave of "Permanent" bounces.

### Mechanism

Before flagging on a `Permanent` bounce event, count recent bounces in the audit table:

```ts
const recentPermanentBounces = await db.emailDeliveryEvent.count({
  where: {
    type: "email.bounced",
    payload: { path: ["bounce", "type"], equals: "Permanent" },
    occurredAt: { gte: new Date(Date.now() - 5 * 60_000) }, // 5 min sliding window
  },
});

if (recentPermanentBounces > 50) {
  logger.error("bounce_storm_detected", { recentPermanentBounces });
  await discordAlerts.send({
    title: "Bounce storm detected",
    message: `${recentPermanentBounces} permanent bounces in last 5 min — auto-flagging paused. Investigate before clearing.`,
  });
  // Still write the audit row; just skip the AuthUser flag.
  return;
}
```

Threshold (`50 / 5 min`) is a launch starting point — adjust upward as steady-state volume grows. At launch we're sending tens of emails/day, so 50 bounces in 5 min would be a clear anomaly.

When the alert fires, on-call investigates the receiving server diagnostics (`bounce.diagnosticCode`) before clearing the alert. If it really was an outage, no users got flagged and we ignore the wave; if it really was a legit bounce surge (newsletter to a stale list), we manually backfill flags via the admin UI.

## GDPR erasure (Phase 8)

When an `AuthUser` is deleted (right-to-be-forgotten request), their `EmailDeliveryEvent` rows still hold their email address in `recipientEmail` + inside `payload.to`. That's PII.

Two options:

- **Anonymize** — overwrite `recipientEmail = "deleted-<eventId>@deleted.local"` and recursively replace any occurrence of the original email in `payload` with the same sentinel. Preserves the row for operational forensics ("we had a bounce storm on Tuesday"), just severs the link to the deleted human.
- **Hard-delete** — `DELETE FROM email_delivery_event WHERE auth_user_id = $1`.

Spec choice: **anonymize**. Bounce-storm forensics matters; per-user audit doesn't survive deletion.

Hook this into the existing account-deletion use case (`packages/core/src/use-cases/auth/delete-account.ts` or similar — confirm exact path during implementation). The deletion use case should call a new `EmailDeliveryAuditPort.anonymizeForUser(authUserId)` in the same transaction.

## Mailer guard ↔ user-set notification preferences (Phase 1 clarification)

The `emailDeliveryStatus` flag is for **hard, vendor-driven suppression** (bounce/complaint). It is independent from `UserNotificationPrefs` (or equivalent) for user-chosen opt-outs.

The mailer guard checks **both**, in order:

1. `emailDeliveryStatus !== null` → hard block, return `recipient_suppressed`. No exemptions.
2. `userNotificationPrefs.allowsCategory(emailCategory)` → opt-out for marketing/digests, but transactional (receipts, 2FA, password reset) bypasses this layer.

The two systems share nothing else. A user clearing their delivery-status flag (by verifying a new email) does not change their notification preferences, and vice versa.

## "Update your email address" notification (Phase 3)

The user needs a clear, persistent in-app surface when they're flagged. Implementation:

### 1. Reactive banner on sign-in / app load

Add a top-of-app banner in `apps/web/src/components/layout/AppChrome.tsx` (or a dedicated `EmailDeliveryBanner.tsx` that AppChrome mounts) that renders when `session.user.emailDeliveryStatus !== null`. Banner copy shows the **full email** (the user already knows their own address; masking is just visual noise):

- **BOUNCED**: _"We can't deliver email to `<email>`. Ticket receipts, password resets, and 2FA codes won't reach you. **Update your email address →**"_
- **COMPLAINED**: _"You marked Ithas Fire email as spam. We've stopped sending to `<email>`. Update your address or contact support to resume notifications. **Update email →**"_

Banner is dismissible per session but reappears on next load until status clears. Style: same `Banner` primitive used by the cookie-consent banner so we don't proliferate variants.

### 2. Settings flow change

`apps/web/src/app/account/settings/_components/ProfileSection.tsx` already has an email field. Add:

- When `emailDeliveryStatus !== null`, the email row gets a red badge ("UNDELIVERABLE" / "COMPLAINT") next to the value.
- Clicking "Change email" → existing flow → on successful **verification of the new address**, clear `emailDeliveryStatus`. _Critical: clear on verification of the new address, not on save of the new address._ Otherwise a user can re-suppress themselves by typing the same flagged address back in.

### 3. tRPC surface

Add to `packages/transport/trpc/src/routers/auth.ts` (or a new `accountHealth` router):

- `accountHealth.getDeliveryStatus` (query, authed) → `{ status: "healthy" | "bounced" | "complained", email: string, since: Date | null }`. The banner subscribes to this so cross-tab clearing propagates.
- `accountHealth.clearAfterVerifiedChange` (mutation, internal — called from the email-change verify flow, not directly from UI).

### 4. Email-fallback notice on auth flows

When email-OTP send fails with `recipient_suppressed`, the auth UI should render:

- **If user has a verified phone:** _"We can't email you right now. Send code by SMS instead →"_ (auto-pivots to existing SMS-OTP flow).
- **If no verified phone:** _"We can't email you right now. [Contact support](mailto:support@hearthfire.community) to recover your account."_ — terminal state.

## Admin clear-flag UI (Phase 5)

New platform-admin page at `/platform/email-deliverability` (scoped to `platform_support` and `platform_admin` roles per the existing role guard pattern):

- **Table** of users with `emailDeliveryStatus !== null`: email, status (BOUNCED/COMPLAINED badge), `since`, last 3 events from `EmailDeliveryEvent` (collapsible).
- **Clear flag** button per row → confirms → calls `platform.emailDeliverability.clearFlag` mutation → writes an admin audit row (who/when/why field optional textarea).
- Filterable by status, sortable by `since`, paginated.

Same auth pattern as the existing `/platform/*` admin routes. tRPC router lives at `packages/transport/trpc/src/routers/platform-email-deliverability.ts`.

The flag also clears automatically when a user verifies a new email address (see Phase 3 settings flow). This admin UI is for edge cases — the user can't get into their settings, called support, etc.

## Env / secrets wiring (Phase 4)

Mirror the existing pattern from `STRIPE_WEBHOOK_SECRET` exactly:

| Layer                   | Name                                                                             | Notes                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App env                 | `RESEND_WEBHOOK_SECRET`                                                          | Read by webhook route. Required when `RESEND_API_KEY` is set; otherwise opt-out (route returns 503).                                          |
| Zod schema              | `apps/api/src/lib/env.ts`                                                        | `RESEND_WEBHOOK_SECRET: z.string().optional()` (optional so dev works without it)                                                             |
| Terraform var           | `infra/terraform/variables.tf`                                                   | `variable "resend_webhook_secret"`                                                                                                            |
| Terraform secret wiring | `infra/terraform/secrets.tf`                                                     | Add to `app_secret_keys` (gated on var-present), `app_secret_value_lookup`, `api_secrets` (jobs doesn't need it).                             |
| Forgejo CI secret       | `TF_VAR_RESEND_WEBHOOK_SECRET` (prod) + `TF_VAR_RESEND_WEBHOOK_SECRET_DEV` (dev) | Add to `.github/workflows/{deploy-prod,deploy-dev,terraform-apply,terraform-dev-plan}.yml` next to the existing `TF_VAR_RESEND_API_KEY` lines |
| GCP Secret Manager      | `hf-prod-resend-webhook-secret` / `hf-dev-resend-webhook-secret`                 | Auto-created by terraform; first version pushed from CI                                                                                       |
| Cloud Run env mount     | API service only                                                                 | Via `api_secrets` array                                                                                                                       |

### Dashboard configuration (last — do after deploy)

**Two webhooks must be created — one per environment.** They are independent records in Resend with distinct URLs and distinct signing secrets. A single webhook cannot fan out to both envs, and using the same signing secret across envs defeats the per-env isolation that the rest of our secrets follow.

#### Prod webhook

1. resend.com → Webhooks → **Add Webhook**.
2. URL: `https://api.hearthfire.community/webhooks/resend`.
3. Events: `email.bounced`, `email.complained`. (Skip `email.delivered` — too noisy and we don't need it.)
4. Copy the Signing Secret → paste into Forgejo CI secret `TF_VAR_RESEND_WEBHOOK_SECRET` → run terraform-apply (prod) → Cloud Run picks up new env on next revision.
5. Click "Send test" in the dashboard. Verify a `200` in prod Cloud Run logs (`th-prod-api`) + a new `EmailDeliveryEvent` row in the prod DB.

#### Dev webhook

1. Same flow, separate record.
2. URL: `https://api-dev.hearthfire.community/webhooks/resend`.
3. Same events.
4. Signing Secret → Forgejo CI secret `TF_VAR_RESEND_WEBHOOK_SECRET_DEV` → terraform-apply (dev) → `th-dev-api`.
5. "Send test" → verify `200` in `th-dev-api` logs + row in dev DB.

#### Why two

- Dev sends from the `Dev` Resend API key (`re_UDhAPyZ6...`); prod from `Prod` (`re_7cCENh83...`). They're separate sender contexts — but Resend webhooks fire on **all** events from your Resend org regardless of which API key sent them. Without per-env webhooks, a dev test bounce would (a) hit prod's `/webhooks/resend` (404 — wrong URL) AND (b) hit dev's (200) — but with a single shared webhook, both would race to flag a `recipient@example.com` user in both DBs.
- Signing secrets must be env-scoped; otherwise a leaked dev secret would let an attacker forge prod webhook payloads.

## Dependencies

| Package | Version | Where                                            |
| ------- | ------- | ------------------------------------------------ |
| `svix`  | latest  | `apps/api/package.json` (signature verification) |

`svix` is a pure JS package, no native deps; safe in Cloud Run.

## Tests

### `apps/api/src/routes/resend/__tests__/webhook.test.ts`

- ✅ Valid Svix-signed `email.bounced` (Permanent) → 200; AuthUser flag set; EmailDeliveryEvent written.
- ✅ Valid Svix-signed `email.bounced` (Temporary) → 200; flag NOT set; EmailDeliveryEvent written with the verified Svix event id.
- ✅ Valid Svix-signed `email.complained` → 200; flag set; audit row written.
- ✅ Replay of identical `provider + providerEventId` → 200; only one EmailDeliveryEvent row (idempotency).
- ✅ Invalid signature → 400.
- ✅ Expired timestamp (>5min) → 400.
- ✅ Recipient with no matching AuthUser → 200; EmailDeliveryEvent written with `authUserId: null`.
- ✅ Multi-recipient `to` array → each user gets flagged.

### `packages/adapters/src/comms/mail/__tests__/resend-mailer.test.ts`

- ✅ `send()` to a `BOUNCED` recipient returns `recipient_suppressed` error result.
- ✅ `sendBatch()` partially suppresses — flagged items error, healthy items succeed.
- ✅ Metric `mail.suppressed` increments with `reason` tag.

### `packages/core/src/use-cases/auth/__tests__/send-otp.test.ts` (or wherever email-OTP lives)

- ✅ When email-OTP send returns `recipient_suppressed`, falls back to SMS OTP if phone verified.
- ✅ When no phone, returns the terminal error code surfaced by the UI.

## Migration & rollout

Phase 1+2 can land behind no flag — the table column defaults to NULL, the mailer guard short-circuits only when set, and the webhook route 503s when `RESEND_WEBHOOK_SECRET` isn't configured. There's no dual-write or backfill concern.

Phase 3 (banner + settings UI) is purely additive and lights up the moment Phase 1 ships.

Phase 4 (dashboard config) is the activation step. We can defer this until post-launch and keep the receiver dormant — but cost is roughly nil so configure on the same deploy.

## Out of scope

- **Soft-bounce auto-recovery** — a future "retry after N successful sends elsewhere" reset flow. Not needed pre-launch; admin override covers it.
- **Per-category suppression** (e.g. user opts out of marketing but still gets receipts) — handled by separate notification preferences, not this flag.
- **DMARC / SPF / DKIM tightening** beyond what Resend already sets up at domain verification.
- **Aggregate deliverability dashboards** beyond Resend's own UI.

## Acceptance criteria

- A user whose mailbox hard-bounces a Ithas Fire email never receives another Ithas Fire email until either (a) they update their address and verify the new one, or (b) an admin clears the flag.
- That user is told **in-app**, at next sign-in, exactly why and exactly what to do.
- The webhook route's idempotency guarantees no double-flagging on Resend's retry.
- The webhook signing secret is stored only in Secret Manager + Forgejo CI; never checked in.
- Soft bounces (`bounce.type: "Temporary"`) do NOT flag users.
