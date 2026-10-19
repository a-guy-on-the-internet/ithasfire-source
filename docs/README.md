# Ithas Fire Documentation

`docs/` holds living docs and dated records. A living doc describes how things are now; where it disagrees with the code, the code wins and the doc is fixed. A dated record sits under `records/`, is never rewritten, and describes one moment. Find a living doc below by area; read its row to decide whether it is the one you need. Specs get no rows here: see [`specs/README.md`](specs/README.md).

## Engineering

| Doc | Purpose |
| --- | --- |
| [Engineering Standards](engineering-standards.md) | Architecture rules, error handling and naming conventions for backend work. Read before building or reviewing any backend change. |
| [Building Through the Layers](layers.md) | Recipe per layer (core, ports, adapters, tRPC transport, UI) with the use-case template and checklists. Read before adding a capability end to end. |
| [Hot Paths](hot-paths.md) | Review checklist for money, idempotency, security, schema guards and kill switches. Read before merging a change in a high-risk path. |
| [DB Setup](db-setup.md) | Safe workflows for local Docker, managed dev DB, migrations, reset or wipe, and seeding. Read before any database or Prisma command, above all a destructive one. |
| [Event Gating](event-gating.md) | How an event's public page and tickets are restricted until a viewer is unlocked (gate types, unlock paths). Read when touching gated or invite-only events. |
| [Account Deletion](account-deletion.md) | What self-serve and staff-initiated deletion delete, retain and detach. Read when touching `deleteMyAccount`, `deleteHuman` or anything that stores personal data. |
| [Scanner PII Retention](scanner-pii.md) | What personal data the scanner caches on the device, where, and when it is wiped. Read when changing scanner storage or answering a retention question. |

## Auth and security

| Doc | Purpose |
| --- | --- |
| [Auth](auth.md) | Sign-in methods, sessions and tokens, how the AuthUser relates to Human and EntityPage, and which actions need a verified email. Read before touching sign-in, tokens or verification gates. |
| [Roles](roles.md) | RBAC model: org roles, platform roles and what each may do. Read before adding or changing a permission check. |
| [Passkey Testing](runbooks/passkey-testing.md) | Testing web and scanner passkeys locally, plus app-association files and keystore fingerprints. Read before testing or touching passkeys. |
| [SMS Registration](runbooks/sms-registration.md) | Getting US texts approved on AWS: the 10DLC campaign form, the production-access case reply, owner steps and the post-approval check. Read before touching AWS SMS, `enable_aws` or SMS opt-in copy. |
| [Rotate `UNSUBSCRIBE_SECRET`](runbooks/rotate-unsubscribe-secret.md) | What the secret keys and the steps to rotate it in the API and jobs service. Read when rotating or debugging unsubscribe links, open-call status links or public location circles. |

## Money

| Doc | Purpose |
| --- | --- |
| [Ticketing and Stripe](ticketing-and-stripe.md) | The product contract for paid and free tiers, Stripe Connect, checkout and webhooks. Read before changing checkout, payouts or what needs Stripe. |
| [Stripe Fee Reference](stripe-fee-reference.md) | The Stripe numbers the money model depends on, each with a source and a checked-on date. Read when a Stripe rate changes or fee copy needs a figure. |
| [Stripe Platform Payout Settings](runbooks/stripe-platform-payout-settings.md) | The platform account payout setting that settlement transfers rely on; live values unverified. Read when payouts fail for lack of balance or before changing the platform payout schedule. |
| [Legal and Tax Questions](legal-and-tax-questions.md) | Open questions for a lawyer, tax professional or accountant, each with what depends on it and the default in use until answered. Read when work turns up a legal, tax or accounting question, and add it there. |
| [Tax Nexus Threshold Watch](runbooks/tax-nexus-threshold-watch.md) | Finance runbook for watching per-jurisdiction tax nexus thresholds (US states, Canadian GST/HST). Read when asked whether a new jurisdiction needs collection. |

## Deploy and ops

| Doc | Purpose |
| --- | --- |
| [Deploy and Operate](deploy.md) | How code reaches dev and prod, env vars and secrets (add, rotate, traps), Terraform state surgery, Cloud Run debugging, mobile releases. Read before any deploy, secret or infra change. |
| [Rollback](runbooks/rollback.md) | Cloud Run prod rollback, with the procedure in Deploy and Operate, and why the database does not roll back. Read when a prod release must be reverted. |
| [DB Backup and Restore](runbooks/db-backup-restore.md) | Daily `pg_dump` to GCS, retention, and the restore drill. Read to restore data or check backups. |
| [Android Keystore](runbooks/android-keystore.md) | Which key signs each Android build and where each fingerprint is registered. Read before a release signing or Play upload change. |
| [App Store Connect Metadata](runbooks/app-store-connect-metadata.md) | Field-by-field cheat sheet for both apps in App Store Connect. Read when filling out or updating store listings. |

## Jobs

| Doc | Purpose |
| --- | --- |
| [Jobs on Cloud Run](jobs.md) | The `apps/jobs` runtime: one `POST /jobs/<name>` route, Scheduler, Pub/Sub and Cloud Tasks callers. Read before adding, scheduling or changing a job handler (only a throw counts as a failure). |
| [Jobs DLQ Ops](runbooks/jobs-dlq.md) | Inspect, rerun and clear failed jobs runs, and how the Stripe webhook DLQ differs. Read when a job fails or a DLQ grows. |

## Testing

| Doc | Purpose |
| --- | --- |
| [E2E Checkout Pricing](runbooks/e2e-checkout-pricing.md) | How the checkout pricing E2E checks one price across the paid flow, and how to run it. It wipes the dev database. Read before changing checkout pricing or that spec. |
| [Stripe Testing](runbooks/stripe-testing.md) | Testing Stripe locally, in CI and live: test mode, webhooks, fixtures. Read before writing or debugging a Stripe-touching test. |
| [Community Events QA Baseline](qa/community-events-testing.md) | Shared environment, access, seed data and known-open baseline for agent-driven QA of community event listings. Read before a QA run on that feature. |

## Product

| Doc | Purpose |
| --- | --- |
| [Pro-social](pro-social.md) | The tiebreaker for product and design calls, plus the mission with honesty as a floor. Read before recommending any product, UX or design option. |

## Agents

| Doc | Purpose |
| --- | --- |
| [Codex Workflow](codex-workflow.md) | How a Codex session maps to the dev loop, specialist agents and skills. Read when running work from Codex instead of Claude Code. |

## Subdirectories

| Folder | What lives here |
| --- | --- |
| [`design/`](design/README.md) | Design system v2 (source of truth for UI), its browsable companion and the style guide. Read before UI work. |
| [`decisions/`](decisions/README.md) | Decisions, one file per call (proposed or settled), with the reason. Read before reopening or changing one. |
| [`records/`](records/) | Dated, never-rewritten records: audits, deploy logs, legal and market research. Read for what was true at one moment. |
| [`specs/`](specs/README.md) | Feature and system specs in date folders; the README holds the naming and header conventions. Read to find what was decided for a feature. |
| [`ops/`](ops/) | Machine-maintained status: automation health, error log, resource burn. Read for current scheduled-run and headroom status, or known prod error signatures (ERR-NNNN). |
| `curation/` | Gitignored output of the scheduled curation agents, in date folders. |

## Docs that live outside this directory

| File | What |
| --- | --- |
| `infra/README.md` | Map of `infra/` (Terraform, local compose), pointing to [Deploy and Operate](deploy.md) |
| `.github/workflows/DEPLOYMENT_SECRETS.md` | Pointer to the [secrets section](deploy.md#secrets) of Deploy and Operate, and the grep that lists the workflows' secrets and variables |
| `CLAUDE.md`, `AGENTS.md` | AI coding agent guardrails (Claude Code, Codex) |
| `packages/db/README.md` | Prisma schema and migration workflow |
| `packages/ui-email/README.md` | Email template development |
| `apps/*/README.md` | Per-app setup and run instructions |
