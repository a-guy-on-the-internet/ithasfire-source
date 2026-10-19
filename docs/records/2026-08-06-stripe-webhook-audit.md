# Stripe webhook subsystem audit — 2026-08-06

Written alongside the fix for the Connect payout-gate outage (an org admin could
not publish a paid event while their Payments page showed the payout account
fully green).

Claim discipline: `[VERIFIED]` = read from code in this repo at this commit.
`[REASONED]` = derived by reading code; a hypothesis until measured.
`[UNKNOWN]` = needs production or Stripe-dashboard access — listed in §6 with
the exact read-only check.

---

## 1. What actually caused the incident

The structural cause is certain. The specific trigger is not, because it lives in
production state we cannot see from the repo.

**Structural cause `[VERIFIED]`:** `Payee.payoutsEnabled = true` had exactly one
writer in the entire monorepo — `PayeesRepo.syncCapabilities`, whose only
non-test caller was the `account.updated` webhook handler. There was no
reconcile job, no write-back on read
(`get-connect-status.ts` fetched live Stripe state and discarded it), and no
ordering guard. A single lost `account.updated` was therefore permanently
unrecoverable without a manual DB write, and the publish gate reads that row
while the Payments page reads live Stripe.

### Ranked shortlist of triggers

**1. The Zod guard rejected a real Stripe capability value.** `[VERIFIED — code]`
`AccountUpdatedZ` typed capability statuses as
`z.enum(["active","pending","inactive"])`. Stripe also sends `unrequested`,
`provisioning` and `disabled`. Any of those failed `safeParse`, which hit
`logger.warn` + `break` + HTTP 200 — invisible to Sentry, absent from the DLQ,
and never retried by Stripe. This is the highest-probability trigger because it
needs no misconfiguration at all: it fires on ordinary onboarding traffic, and
an account mid-onboarding is exactly when `unrequested`/`provisioning` appear.
Closing check: §6-C (search prod logs for `stripe_webhook_account_updated_parse_failed`).

**2. No Connect endpoint, or a missing/stale Connect signing secret.**
`[VERIFIED — code; UNKNOWN — prod state]` Connected-account events are delivered
only to an endpoint with "Listen to events on Connected accounts" enabled, signed
with that endpoint's own secret. `STRIPE_CONNECT_WEBHOOK_SECRET` was
`.optional()` even in prod, and Terraform omits the env var entirely when the
tfvar is empty — so absence produced no error anywhere. The resulting failure was
`logger.warn("stripe_webhook_bad_signature")` + 400: not captured by Sentry, and
not matched by the one log metric that alerts on this route. Closing check: §6-A/B/D.

**3. Out-of-order delivery clobbered a good write.** `[REASONED]`
`syncCapabilities` did an unconditional `updateMany` with no comparison against
the event's `created` time. Stripe does not guarantee ordering and retries arrive
late, so a stale "still pending" delivery could overwrite "now active"
permanently. Lower probability than 1–2 (it needs a specific interleaving) but
the same permanent outcome. Closing check: §6-A distinguishes it —
`updatedAt > createdAt` with false flags points here or at 4.

**4. The handler threw and the error was swallowed.** `[VERIFIED — code]`
`account.updated` had its own inner `catch` that reported to Sentry/Discord and
then `break`. It never reached the DLQ, so there was nothing to replay. If this
is the trigger there IS a Sentry issue for it (`stripe_webhook_account_updated_failed`).
Closing check: §6-C.

Note that 1, 2 and 4 are all consistent with the reported symptom and are
distinguished only by production logs. 4 is the only one that left a Sentry
trace, which is itself weak evidence against it — nobody noticed this outage.

### Two corrections to the incident write-up

The handoff said the reconcile job "requires un-stubbing
`apps/jobs/src/lib/container.ts:97`". That line is on
`MissingStripePaymentProcessor`, the fallback used only when `STRIPE_SECRET_KEY`
is absent `[VERIFIED — container.ts:180-188]`. The jobs service receives that
key in every deployed environment (`infra/terraform/secrets.tf:164`), so the
real Stripe adapter was already wired and nothing needed un-stubbing.


The handoff described the co-payee gate (`Gate 2`) as arming only when a payout
line has `requiresConfirmation: true`. That is true of the *trigger*, but Gate 2
then iterates **every** line including the owner's own `requiresConfirmation:
false` line `[VERIFIED — publish-event.ts:605-620]`. So once any co-payee exists,
a stale **owner** row surfaces as `payee_not_active` ("This payee is no longer
active.") rather than `STRIPE_NOT_CONNECTED_OWNER`. The reported copy tells us
this particular org had no confirmation-requiring line. See §5.

---

## 2. Registration & coverage

| Question | Answer |
| --- | --- |
| Endpoints per environment | `[UNKNOWN]` — §6-B |
| Account-level vs Connect | One route, `POST /webhooks/stripe`, accepts **either** signing secret and dispatches on `event.type`. `[VERIFIED]` |
| Handled event types | 11: `payment_intent.succeeded`, `.processing`, `.payment_failed`; `account.updated`, `account.application.deauthorized`; `charge.refunded`, `charge.refund.updated`; `charge.dispute.created/updated/funds_withdrawn/closed`. `[VERIFIED]` |
| Subscribed events | `[UNKNOWN]` — §6-B |
| Subscribed-but-unhandled | Falls to `default:` → `logger.info("stripe_webhook_ignored_event")` + 200. Deliberate and correct: Stripe endpoints commonly subscribe to more than a consumer handles. The right control is at the endpoint config, not the code. `[VERIFIED]` |

**Fragility, ranked by blast radius:** the single-route/two-secrets design means a
missing Connect secret degrades *silently and partially* — platform events keep
working, connected-account events all 400. That is the worst shape of failure:
the system looks healthy. Now mitigated (§3) but not eliminated; only §6-B
confirms the endpoint exists at all.

---

## 3. What changed in this pass

| Area | Before | After |
| --- | --- | --- |
| Capability source of truth | Webhook derived from `capabilities`; page read `charges_enabled`/`payouts_enabled`. Two answers. | One core use case, `deriveConnectCapabilities`, used by both — and the live read now fetches `capabilities` too, so both paths see identical inputs. Account-level flags lead; `transfers` is ANDed in (below). The page returns what it just persisted. |
| Stale row recovery | None. Permanent. | `getConnectStatus` writes live state back on every read. Self-heals on any Payments-page or event-builder load. |
| Ordering | Unconditional write. | `Payee.capabilitiesSyncedAt` + `observedAt`; writes apply only when at least as new. |
| Guard breadth | 3-value enum → unknown status dropped the event. | `z.string()` + `.loose()`; unknown statuses read as not-active. |
| Parse failures (8 sites) | warn + break + 200. Invisible, unrecoverable. | Throw → Sentry + Discord + DLQ, with the raw payload. |
| Inner catches (5 sites) | Sentry + Discord, then break. Never DLQ'd. | Throw → the single sink. Stage context preserved. |
| Missing `orderId` (2 sites) | warn + 200. Order never cancelled / never marked processing. | Throw → DLQ. |
| Missing mailer | warn + 200. Buyer paid, got no ticket email. | Throw → DLQ, replayable once SMTP is fixed. |
| Bad signature | warn + 400. Not in Sentry, not alerted. | `logger.error` + 400 (Sentry-captured). Deliberately **not** DLQ'd — see below. |
| Foreign PaymentIntents | warn + 200. | Ignored with an info log when no local order references the PI. They must not take slots in a queue that evicts genuine failures. |
| Recovery for orgs who never load a page | None — the row stayed wrong until someone opened Payments settings. | Nightly `stripe-connect.reconcile-capabilities` sweep re-reads the stalest accounts from Stripe through the same derivation and reports how many had drifted. |
| Dropped `Payee` writes | Silent; the caller logged a success it never got. | `syncCapabilities` returns an outcome; `skipped_restricted` logs at error level, and the Payments page reports the ROW (what the gate reads), never Stripe's rosier answer. |
| Failed replay | n/a (no replay existed). | Does not re-push, so the original error, `receivedAt` and TTL survive; logged at error level. |
| "Payouts enabled: No" | n/a. | Carries a `payoutsBlockedReason` so the organizer sees why, instead of a bare "No" beside an empty requirements list. |
| DLQ replay | None. Delete-only; recovery meant re-sending from the Stripe dashboard. | `platform.replayWebhookDlqItem` re-drives the stored event through the same dispatch; removed only on success. |
| Connect secret | `.optional()` in prod; Terraform silently omitted it. | Required in prod (empty string rejected); Terraform precondition fails a prod apply without it. |
| Dev/prod parity | Module-level `NODE_ENV` bypass inside the adapter, untestable. | Explicit `STRIPE_CONNECT_FORCE_CAPABILITIES`, threaded as a parameter, unit-tested, hard-`false` in prod. |

### `payoutsEnabled` is stricter than Stripe's `payouts_enabled`

Worth knowing before reading the code. `Payee.payoutsEnabled` is not a mirror of
Stripe's account-level flag — it is ANDed with the `transfers` capability.

The two answer different questions. `payouts_enabled` means "can Stripe pay this
account's balance out to its bank?". What we need is "can WE move money to it?",
which additionally requires an active `transfers` capability. And
`Payee.payoutsEnabled` is the only local precondition before `createTransfer`
(`settlements/execute-transfer.ts:125`, `settlements/run-batch.ts:603`) as well
as being the publish gate — so trusting the account-level flag alone would let a
paid event publish and sell, then fail at settlement with "destination account
needs the transfers capability": sold inventory, no payout. `[REASONED]` — the
guard removal was confirmed by reading both call sites; whether Stripe actually
emits that combination is unproven, so the conservative reading stands.

When capabilities are absent entirely (a stub/e2e processor) this does NOT read
as "inactive" — absent information must not manufacture a restriction, or those
environments would silently lose the ability to publish paid events.

**Deliberate deviation from the brief:** signature failures are made visible but
are **not** written to the DLQ. The payload is unauthenticated, so anyone who can
reach the endpoint could push 500 entries and evict every genuinely-failed event
from the fixed-size queue. Visibility (Sentry) achieves the goal; replayability
of an unverified payload is not something we want to exist.

---

## 4. Standing risks, ranked by blast radius

### R0 — The reconcile sweep is a backstop, not a fix `[VERIFIED]`
`stripe-connect.reconcile-capabilities` runs nightly at 22:20 America/Chicago
(1h40m before the payout batch, so a healed payee is payable the same night). It
re-reads the stalest 200 connected accounts from Stripe and writes them back
through `syncConnectAccount` — the same derivation the webhook uses, so the pull
path cannot drift from the push path.

Its second job matters more than its first: **it measures**. `drifted` counts
rows whose live state differed from what we had stored, and a non-zero value is
the standing answer to "are we still losing webhooks?" — the question nobody
could answer during the incident. `healedToPayable` (drift in the blocking
direction) escalates to Sentry + Discord, because a row we corrected that way
means an organizer *was* blocked and nobody knew. **A successful run of this job
is not "resolved" — it is "the outage was absorbed."** The fix for recurring
drift is at the Stripe webhook endpoint.

Known bounds, all deliberate:
- **Self-bounded at 120s** (`maxDurationMs`), under Cloud Scheduler's 180s
  attempt deadline. A scheduler-truncated run would lose everything after the
  loop including the alert, so the sweep stops itself first and the cursor
  resumes next run.
- **Cursor**: `capabilitiesSyncedAt` doubles as the cursor — a reconciled row is
  stamped and sorts to the back. Worst-case time to visit every payee is
  `ceil(N / 200)` nights. Revisit the limit when N approaches ~2000.
- **Starvation, bounded not eliminated**: an account deleted in Stripe keeps
  failing, never gets stamped, and holds its slot every night. Two guards: the
  never-synced query is capped at half the batch, so such rows can never crowd
  out the stale set entirely (without the cap they eventually fill every batch
  and the sweep silently covers nothing while reporting a full scan); and
  per-account reporting is latched (3 samples + 1 summary) so a global failure
  can't flood Sentry. The clean fix — stamp on a definitive `resource_missing`
  so the row rotates out — is not built.
- **Per-account read deadline** of 20s. The wall-clock budget is only checked
  between rows, and the Stripe SDK's default request timeout is 80s plus
  retries, so one hung call could otherwise overshoot the scheduler deadline
  the budget exists to respect.
- **Disabled on dev** (`jobs_scheduler_overrides` in `dev.tfvars`): dev's payees
  are seeded Custom accounts that never onboard, so the sweep would correctly
  demote them all and make seeded paid events unsellable. The dev capability
  override can't neutralise it because that flag is hard-`false` whenever
  `NODE_ENV=production`, which deployed dev sets — a guarantee worth keeping.

### R1 — The DLQ silently evicts, and its depth is unmonitored `[VERIFIED]`
`webhook-dlq.ts` trims to `MAX_ITEMS = 500` and expires entries at 30 days, with
no log, metric, or alert on either. Nothing scrapes `count()`. After this change
the DLQ receives strictly more traffic (all the previously-swallowed failures),
so eviction is now *more* likely, not less. Expired hashes also leave their ids
in the sorted set, so `count()` and `list()` disagree.
**Fix:** log + counter on trim and on expiry-skip; alert on depth and on
time-in-queue, not just on push.

### R2 — No record of received Stripe event ids `[VERIFIED]`
There is no `StripeEvent`/`WebhookEvent` receipt table. Four of eleven handlers
use the generic `Idempotency` keyspace (`stripe_evt:<id>`,
`stripe-dispute:<id>`), and those entries expire after 24h. Beyond that window a
duplicate is a cache miss and the handler re-executes. Nothing anywhere gives a
complete audit trail of what Stripe sent us.
**Assessment:** no money path double-applies — the durable guards are order
status preconditions and DB unique constraints, not the cache (see R3).
**Recommendation:** add a `StripeEventReceipt` table (`stripeEventId @unique`,
type, receivedAt, appliedAt, outcome). Cheap, and it converts "was this event
ever delivered?" from an unanswerable question into a lookup — which is precisely
the question this incident could not answer.

### R3 — Replay is money-safe but not notification-safe `[VERIFIED]`
Per-handler durable guards:

| Event | Durable guard | Replay |
| --- | --- | --- |
| `payment_intent.succeeded` | `order.status === "SUCCEEDED"` precondition inside the tx | safe |
| `payment_intent.processing` | `status === "PENDING"` precondition | safe |
| `payment_intent.payment_failed` | `PROCESSING`/`PENDING` preconditions | safe |
| `account.updated` | absolute write + `status != RESTRICTED` + (new) ordering guard | safe |
| `account.application.deauthorized` | absolute write + `status: "pending"` filter | safe; re-alerts |
| `charge.refunded` | in-tx `status === "REFUNDED"` re-check (closes the TOCTOU) | safe |
| `charge.dispute.*` (4) | `Dispute.stripeDisputeId @unique` + `PayeeLedgerEntry.idempotencyKey @unique` + terminal-status ladder | safe |
| `charge.refund.updated` (succeeded) | inherits the reconcile precondition | safe |
| `charge.refund.updated` (**failed**) | **none** | **double-applies** |

Three residuals:
- A replay of an event whose PaymentIntent has neither `metadata.orderId` nor a
  linked order is dropped with an info log rather than DLQ'd. It carries no
  association to anything on either side, so neither a DLQ entry nor a replay
  could recover it — see `isOrphanPaymentIntent`.
- `refund_anomaly` audit rows have no unique constraint, so a replay writes a
  duplicate. Impact is duplicated manual-reconciliation work, not money.
- Notification emails are deduped by a **120-second** mailer TTL, so any replay
  minutes later re-sends the receipt. The admin UI now says so; a longer
  `keepSec` on ticket-issued / resale sends would remove it properly.

### R3a — Replay is available but bounded `[VERIFIED]`
Replay re-drives the stored event through the same dispatch, so it cannot drift
from the live path. It removes the DLQ row only on success; a failed replay
leaves the row untouched (original error and timestamp intact) and logs at error
level. Two events are deliberately NOT replayable: an unverified payload (never
stored) and a PaymentIntent with neither `metadata.orderId` nor a linked order
(carries no association to anything on either side).

### R3b — A RESTRICTED payee still cannot recover `[VERIFIED]`
(The sweep now surfaces these as a count — `restrictedWithAccount` — computed
before the loop so even a truncated run reports it.)

`markDeauthorized` sets `status: "RESTRICTED"`, and the repo's guard means no
`account.updated` and no live-read write-back can ever promote it again. But
re-onboarding goes through `upsertForSubject`, whose update branch only writes
`stripeAccountId` — so an org that was deauthorized and then re-onboarded is
permanently unable to publish or be paid, with a green Payments page. That is
this incident's exact shape, reached by a different door. Pre-existing and not
fixed here, but it is no longer silent: `syncConnectAccount` logs
`stripe_connect_account_sync_skipped_restricted` at error level (Sentry-captured)
with a remediation hint.
**Fix:** decide deliberately whether a completed re-onboarding clears RESTRICTED,
and give staff a supported way to reset it.

### R4 — Thirteen failure paths were warn-only `[VERIFIED, now largely fixed]`
Before this change ~13 of ~28 failure paths in the route were `logger.warn` and
therefore invisible to Sentry, including three that destroyed user value (no
ticket email, order never cancelled, order never marked processing). Fixed here.
Still warn-only and worth a follow-up sweep, all outside this route:
`onAccountDeauthorized` payee-not-found, `reconcileStripeFullRefund`
order-not-found and manual-review-required.

### R5 — The one production alert is narrow `[VERIFIED]`
`infra/terraform/monitoring.tf`'s `stripe_webhook_failures` log metric matches
only `stripe_webhook_unhandled_error_dlq` and `stripe_webhook_dlq_store_failed`.
It does not match `stripe_webhook_bad_signature` — the exact signal of a missing
Connect secret. Those two strings are now load-bearing and are asserted by a
test. **Follow-up:** extend the filter to bad-signature, and confirm
`var.alerts_email` is actually set in prod (§6-E).

### R6 — Terraform's "absent means fine" pattern is repo-wide `[VERIFIED]`
`local.app_secret_keys` drops any secret whose tfvar is empty. That is right for
genuinely optional integrations and catastrophic for required ones. Only the
Connect secret is guarded here; the same shape applies to every other entry.
**Follow-up:** audit `app_secret_keys` for other prod-required values.

### R7 — Dev/prod parity `[VERIFIED, improved]`
The bug class was unreproducible outside prod: local dev force-wrote everything
true, and deployed dev (which runs `NODE_ENV=production`) is rescued by the seed
writing the row green. `STRIPE_CONNECT_FORCE_CAPABILITIES=false` now reproduces
production semantics locally, and the derivation is a pure, unit-tested function.
Deployed dev remains masked by the seed; the honest test is a real onboarding
against dev, not a seeded account.

---

## 5. Adjacent: the co-payee publish trap (assessed, not fixed)

`[VERIFIED]` `publish-event.ts` Gate 2 arms when **any** payout line has
`requiresConfirmation: true`, then blocks on **every** line's payee — including
lines that were `DECLINED` with zero allocation, and including the owner's own
line. Co-payees are minted `PENDING/false/false` by `update-event-splits.ts` and,
before this change, could only ever be flipped by that co-payee personally
completing Connect onboarding. The error carries `data.payeeIds`, but the
transport layer drops `data`, so the organizer sees "This payee is no longer
active." — no name, no count, no remedy. The only escape is deleting the
collaborator's revenue share.

**Severity: high.** Not permanently blocking (deleting the line disarms it) but
undiscoverable and destructive, and prod-only.

**Partially mitigated by this change:** the owner's own row now self-heals, which
removes the case where a healthy owner is blocked by their own stale row *via*
Gate 2. A genuinely un-onboarded co-payee still blocks, correctly — the remaining
work is discoverability, not gating: surface `payeeIds` through transport, name
the payee in the copy, and give the organizer a "remind" action.

---

## 6. Needs production / Stripe-dashboard access

Every check below is read-only. Do not write to production.

**A. Which failure mode fired.**
```sql
SELECT p.status, p."payoutsEnabled", p."chargesEnabled", p."stripeAccountId",
       p."createdAt", p."updatedAt"
FROM "Payee" p
JOIN "Organization" o ON o.id = p."subjectId" AND p."subjectType" = 'ORGANIZATION'
WHERE o.slug = '<ORG-SLUG>';
```
`updatedAt == createdAt` ⇒ no `account.updated` ever landed (trigger 1 or 2).
`updatedAt > createdAt` with false flags ⇒ one landed and wrote false (trigger 3
or 4).

**B. Stripe Dashboard → Developers → Webhooks.** Does a prod endpoint exist with
**"Listen to events on Connected accounts"** enabled? Filter its deliveries by
`account.updated` and the `acct_…`:
- no deliveries ⇒ the endpoint is missing or not subscribed;
- 400 bad-signature ⇒ missing/stale secret;
- 200 with the flags still false ⇒ ordering or capability semantics.

**C. Production logs (last 90 days).** Search for, in this order:
`stripe_webhook_account_updated_parse_failed` (trigger 1),
`stripe_webhook_bad_signature` (trigger 2),
`stripe_webhook_account_updated_failed` (trigger 4),
`stripe_webhook_account_updated` (confirms any landed at all).

**D. Is the secret actually deployed?**
```
gcloud run services describe <prod-api> --region <region> --format=yaml
```
Look for `STRIPE_CONNECT_WEBHOOK_SECRET` in the container env. **Do this before
deploying this change** — the env var is now required at boot, so an empty
Forgejo secret turns a silent outage into a failed deploy. Also confirm the
`STRIPE_CONNECT_WEBHOOK_SECRET_PROD` secret is populated in **Forgejo's** secret
store (Forgejo Actions runs `.github/workflows/`; the GitHub mirror's secrets are
not what deploys).

**E. Alerting health.** Confirm `var.alerts_email` is set in the prod workspace
and that the `stripe_webhook_failures` alert policy + notification channel exist
and are healthy.

**F. Are any prod payees stuck RESTRICTED after re-onboarding?** (R3b — same
symptom as this incident, different cause, and not fixed by the write-back.)
```sql
SELECT p.id, p."subjectType", p."subjectId", p."stripeAccountId", p."updatedAt"
FROM "Payee" p
WHERE p.status = 'RESTRICTED' AND p."stripeAccountId" IS NOT NULL;
```
Cross-check each `acct_` in the Stripe dashboard: if the account is live and
authorized, the row is wrong and needs a deliberate reset.

**G. Current DLQ depth.** `/platform/webhook-dlq` — if it is at or near 500,
entries have already been evicted.

---

## 7. Backfill

**No data backfill is required, and that is deliberate.**

The migration adds `Payee.capabilitiesSyncedAt` as nullable and leaves every
existing row `NULL`. `NULL` means "never synced", which makes the next
observation from any source apply unconditionally. Stamping a synthetic
timestamp would pin currently-stale rows against older-but-real Stripe events —
the opposite of what we want.

Existing stale rows heal by themselves via the new write-back. All three
`stripeConnect.getStatus` call sites now persist what they read `[VERIFIED]`:
`PaymentsView.tsx:122`, `EventsManager.tsx:1292` (the admin events list), and
`EventBuilder.tsx:812`. An organizer therefore cannot reach the Publish button
without having healed the row on the way — the events list alone does it. **The
affected org's row will heal the moment an admin opens any of those screens.** If
you want it fixed before they do, the supported manual step is to load that org's
Payments page as a staff member — not a DB write.

One caveat `[REASONED]`: rows whose `stripeAccountId` is `NULL` (co-payees minted
as placeholders) are not reachable by either the webhook or the live read, so
they stay `PENDING/false/false` until that subject completes onboarding. That is
correct behaviour, not stale data.


---

## 8. Review record

Two adversarial review rounds; both returned `CHANGES_REQUESTED` and both found
something real.

**Round 1 — 1 blocking, 8 warnings.** The blocking one was mine: preferring
account-level `payouts_enabled` over `capabilities` made `capabilities.transfers`
dead in production, and that field is the only local guard before a destination
transfer. Fixed by carrying `capabilities` through the live-read path too and
ANDing `transfers` into `payoutsEnabled`. The warnings covered DLQ flooding from
foreign PaymentIntents and mail-less environments, a replay that overwrote its
own DLQ history, a 500-`hgetall` scan, silently dropped `Payee` writes, an
over-claimed ordering guarantee, and over-claimed UI copy.

**Round 2 — 1 blocking, 6 warnings.** The blocking one was that **two of three
round-1 replay edits never landed**: a batch edit script asserted and exited
before writing, and `pnpm typecheck` reported green because
`tsconfig.base.json` excludes `apps/**`. That gate gap is now recorded in
CLAUDE.md's "Gates That Look Real And Are Not" — typechecking this repo takes at
least two commands. The warnings produced the outcome-aware page rendering, the
`payoutsBlockedReason` explanation, real coverage for `isOrphanPaymentIntent`
(its only test had been passing via a `TypeError` rather than the branch under
test), and the help-center corrections.

Worth stating plainly: the second round exists because the first round's fixes
were reported as applied without being re-verified against a gate that actually
covers `apps/`.

**Reconcile job — two more rounds.** Round 1 blocked on a `void logAndReport`:
the healed-payee alert was fire-and-forget on a Cloud Run service with no
`cpu_idle = false` and `min_instance_count = 0`, so the Discord POST and Sentry
flush could be cut off the moment the response was written — the one run that
most needed to page someone would page nobody. It also found that the counters
credited heals for writes the repo had refused (a phantom "we restored payouts"
alert), that `syncConnectAccount`'s error-level escalations are invisible from
apps/jobs because that process has no Sentry pino integration, and that the
index could not serve `ASC NULLS FIRST` at all — a default btree is
ASC NULLS LAST and neither scan direction produces it, so the query would have
planned a full sort every night while a comment claimed the opposite. Round 2
verified the fixes.

Rounds 3 and 4 (the reconcile job) also produced the alert-fidelity fixes worth
knowing about: drift was being measured against the *batch* snapshot, which for
the last rows of a 200-row run is minutes stale — a webhook that arrived
perfectly on time could be reported as "lost webhook detected". It now re-reads
the row immediately before comparing. And `scanned` counted rows *listed* rather
than *processed*, so a truncated run would render "Scanned: 200" into the alert
having reached 60.

Two defects in that batch I found before review, worth recording because both
were silent: `observedAt` was being stamped *after* the Stripe read in both the
sweep and the live-read write-back, so a webhook for a change landing during the
read window would lose the ordering guard to our already-stale snapshot; and the
sweep's ordering column had no index at all.

## Addendum — 2026-08-10 (post-QA fixes)

Local QA (real webhooks via `stripe listen`, forced DLQ entries, live replay,
`EXPLAIN ANALYZE` on a 50k-row clone) surfaced six defects; all are fixed as of
this addendum. What changed, for anyone reading the sections above:

- **Batch under-fill.** `listForCapabilityReconcile` capped the never-synced arm
  at half the batch but never handed unused stale-arm budget back — measured:
  limit 10 against 6 never-synced rows scanned 5. The first run after the
  migration (every row never-synced) would have covered 100 of a limit-200
  sweep. The adapter now refills from the never-synced arm when the stale arm
  runs short.
- **The migration's index comment overstates arm 1.** Only the ordered arm is
  the clean early-stopping Index Scan; the `IS NULL` arm carries Prisma's
  implicit `ORDER BY id` (pkey walk under backlog, Bitmap + small Sort in
  steady state; both <41ms at 50k). The migration file cannot be edited — its
  checksum is recorded on deployed databases — so the correction lives on the
  `@@index` in `finance.prisma` and in the adapter.
- **DLQ rows are now actionable.** Parse failures carry the failing Zod paths
  in the row's `error` field (previously "…parse_failed: …parse_failed" with
  the detail only in Sentry extra), and non-Error throwables (Prisma driver
  errors) no longer render as `[object Object]`.
- **Unknown accounts no longer mint placeholder Payees.** The old create branch
  (`subjectType HUMAN, subjectId ""`) was unfindable by subject, re-read by
  every nightly reconcile, and P2002'd the *second* unknown account into a
  permanent DLQ entry. `syncCapabilities` now returns
  `skipped_unknown_account` (info-logged, no DLQ) — mirroring the foreign-PI
  policy. The `"created"` outcome is gone.
- **`getConnectStatus` re-reads the row when its write is refused** (the
  `skipped_stale` window), so a webhook landing during the Stripe read can no
  longer make the page render a snapshot the publish gate has already moved
  past.
- **Webhook failure alerting is awaited.** The Discord/Sentry report in the
  failure sink (and the deauthorized-account alert) were `void`ed; on Cloud Run
  the CPU is throttled the moment the response is written, so those POSTs could
  simply never run. Both are now awaited — bounded, since the Discord fetch
  carries `AbortSignal.timeout(2000)` and `logAndReport` never rejects.

- **Demotions now page, on a clock.** The sweep alerted only on
  `healedToPayable` (promotions). A demotion is time-critical in a way a
  promotion is not: this job runs 22:20 America/Chicago, `settlements.run-batch`
  runs 00:00 in the same timezone, and a payee demoted here hits
  `if (!payee.payoutsEnabled)` in run-batch 100 minutes later → `failItem` →
  `bulkMarkFailed`. `listDueForPayout` selects `status: "pending"` only, so
  those settlements are never retried on a later night; recovery is an operator
  running `settlements.resetFailed`. New `demotedFromPayable` counter, its own
  error-level escalation and its own Discord alert (deliberately NOT an `else`
  of the heal branch — one run can do both, and they need different responders).
  This matters more after the batch under-fill fix above, which doubles how many
  rows the first post-deploy run re-evaluates.

Still open from §7: DLQ evicts silently at 500; no event-receipt table;
RESTRICTED recovery is manual; §6-B (prod Connect endpoint) and §6-D (Forgejo
`STRIPE_CONNECT_WEBHOOK_SECRET`) remain unverified from a dev machine.
