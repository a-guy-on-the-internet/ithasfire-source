# Ithas Fire — TicketHunter

## Architecture

Hexagonal monorepo: `core` (use cases, entities) → `ports` (interfaces) → `adapters` (implementations) → `transport` (tRPC routers) → `ui-*` (apps).

## Error Reporting Convention (Sentry)

Two capture paths exist; use them deliberately:

- **Deliberate swallows use `ReporterPort`.** Any use case that catches a failure and returns a fallback/degraded result (instead of throwing) MUST declare `reportError?: ReporterPort` (`packages/ports/src/reporter.ts`) in its deps and call `deps.reportError?.(err, { tags, extra })` in the swallow branch — guarded so a throwing reporter never changes behaviour. The composition roots wire it to `Sentry.captureException` (`apps/api/src/lib/dep.ts`, jobs). Add regression tests for the report (pattern: `packages/core/src/use-cases/search/__tests__/`).
- **Everything else rides the backstops.** Thrown errors are captured by the fastify/tRPC integrations; `logger.error(msg, { err })` is captured via Sentry's pinoIntegration. Do NOT rely on `logger.warn` for anything that must be visible — warn is not captured.
- **Migration is opportunistic, not big-bang.** When already editing a use case that swallows-and-logs, move it from `logger.error` to `reportError` (keep the log line). Never demote a swallow-site's `logger.error` to `warn` without first adding `reportError` — that silently un-Sentries it (the exact bug behind the Jun 2026 4-day silent search outage).

Reviewers: flag new catch-and-fallback branches lacking `reportError` as `[BLOCKING]`.

## Local Dev

Dev login credentials and seeded users/orgs (including the `dev-login` admin slug) live in `apps/api/src/scripts/seed/ids.ts` (imported by `seed-data.ts`). Check there for the email/password to sign in locally.

### Testing passkeys

The `/sign-in` flow is passkey-first via Better Auth's WebAuthn plugin. To test in local dev without a real device:

1. Open Chrome DevTools → ⋮ menu → **More tools → WebAuthn**.
2. Toggle **"Enable virtual authenticator environment"** on.
3. Click **"Add"** → leave defaults (`internal`, `ctap2`, `resident-key: yes`, `user-verification: yes`).
4. On `/account/settings`, expand **Security** and click **"Add a passkey"** to enroll one against the virtual authenticator.
5. Sign out, hit `/sign-in`, click **"Continue with Passkey"** — DevTools logs the assertion and signs you in.

The "Use password instead" expander still works for accounts without an enrolled passkey.

### Testing scanner passkeys

Scanner passkeys piggyback on the same `passkey()` server plugin. Cross-device credential sharing relies on:

- `apps/web/public/.well-known/apple-app-site-association` claims `FJG7F43395.com.ithasfire.scan` for `webcredentials` AND `FJG7F43395.com.ithasfire.app` (consumer) for both `webcredentials` and `applinks` (`/events/*`, `/event/*`, `/orgs/*`, `/places/*`, `/p/*`, `/my-tickets*`, `/tickets/qr/*`) on `ithasfire.com`. (Team `FJG7F43395` = business account; the old `5J9DRDR2TB.com.ithasfire(.scanner)` bundle IDs were burned in App Store Connect and re-registered as `com.ithasfire.app` / `com.ithasfire.scan`.)
- `apps/web/public/.well-known/assetlinks.json` claims `com.ithasfire.scan` for Credential Manager. The Android SHA-256 fingerprint is the EAS-managed production keystore. To re-verify, run `cd apps/scanner && eas credentials -p android` and compare the Production keystore's SHA-256 against `assetlinks.json`. Update both whenever the keystore is rotated. **TODO before consumer mobile launch:** add a second entry for `com.ithasfire` (Android consumer package) with its EAS production SHA-256 (omit until real; invalid fingerprints break App Links auto-verification for the whole file).
- `apps/scanner/app.config.ts` — `ios.associatedDomains` + `android.intentFilters` reference `ithasfire.com`.

Local + dev limitations: the iOS Simulator and Android emulator don't honour AASA / assetlinks the same way real devices do. To smoke-test cross-device passkey sign-in, build via `eas build --profile preview` and install on a physical device. Locally you can still test the **CTA wiring** by running the scanner against an API host that's reachable over HTTPS.

Server side requires no extra setup — `passkey()` is mounted in `better-auth.ts` and Better Auth derives the relying party from `PUBLIC_WEB_URL`.

## Prose & Vocabulary

- **All prose follows the `unslop` skill's avoid-list** — chat replies to the user included, not just artifacts. Load it before writing any substantial human-facing text.
- **`CONTEXT.md` (repo root) is the canonical glossary** once it exists: use its terms — and honour its `_Avoid_` lists — in code, delegation prompts, and copy. When terminology is being debated or a term is fuzzy, load the `domain-modeling` skill and resolve it into `CONTEXT.md` right there.
- **Editing any agent-consumed doc** (a skill, this file, `.claude/agents/*`) → load the `writing-for-agents` skill first.

## Dev Orchestrator

For any implementation task, use the **dev loop**: plan → route → build → review → fix → approve. Invoke `[skill:dev]` to run the full loop.

### Specialist Skills

| Skill                         | When to use                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `[skill:coder]`               | Backend: use cases, adapters, transports, tests, bug fixes                         |
| `[skill:reviewer]`            | Code review after implementation (always runs in the dev loop)                     |
| `[skill:ui]`                  | UI pages, components, layouts, styling, design system                              |
| `[skill:mobile]`              | Expo / React Native work in `apps/mobile`, `apps/scanner`, `apps/audio-transcoder` |
| `[skill:infra]`               | Terraform, Docker, CI/CD, Cloud Run, DNS, secrets                                  |
| `[skill:refactor]`            | Code cleanup, module reorganization, dead code removal                             |
| `[skill:context-map]`         | Understand unfamiliar areas before changing them                                   |
| `[skill:security-review]`     | Security audit (run on-demand, not scheduled)                                      |
| `[skill:implementation-plan]` | Break a feature into a layer-ordered build plan                                    |
| `[skill:feature-scoping]`     | Turn a vague idea into a structured spec                                           |
| `[skill:sentry-triage]`       | Investigate unresolved Sentry errors, map to code, diagnose root cause             |
| `[skill:codex-delegate]`      | Delegate to Codex (GPT) for a cross-model second-opinion review, mechanical offload, or screenshot UI verification |

### Model Selection (be deliberate, not default-everything)

Subagents inherit the session model unless overridden. Use that lever:

- **Downgrade to `haiku`** for cheap, mechanical, low-judgment work — recon
  greps, single-file fixes with a fully-specified diff, boilerplate test/fixture
  additions, fleets of near-identical small tasks. Pass `model: "haiku"` on the
  `Task`/`Agent` call.
- **Keep review at full strength.** Never downgrade the `reviewer` /
  `security-reviewer` pass — this codebase's best catches (a TOCTOU race, a
  Turbopack prod bug, an incomplete auth allowlist) came from strong review
  reasoning a weak model waves through. Bump the hardest adversarial re-review
  to `opus` when the diff is high-stakes (money, auth, migrations, concurrency).
- **Omit the override** (inherit) for everything in between — usually correct.

**Cross-model diversity (Codex / GPT).** For high-stakes diffs, run a Codex
second-opinion review *alongside* the Claude `reviewer` and reconcile both —
a different model lineage catches different classes of bug. Use `[skill:codex-delegate]`
(wraps `scripts/codex-headless.sh`), which enforces a hang/crash watchdog
(default 600s hard cap = "10-minute check", plus stall detection), killing by
PID/PGID — never a pattern kill. Codex is **additive**, not a replacement:
Claude subagents stay the primary path (structured schemas, harness-tracked,
shared context). The watchdog **investigates, doesn't reflexively kill** — on
cap/stall it diagnoses and leaves the run alive (exit 125) since a reasoning
model legitimately goes quiet; `--kill-on-cap` opts into a hard kill.
**Prefer gpt-5.6 for cheap/mechanical/computer-use work** to save Claude tokens
(user's standing preference). Codex handles **computer-use** (`--computer-use` —
drives live Mac apps; the dangerous-bypass it needs is user-authorized, don't
re-ask; keep prompts scoped since it drops the sandbox) and mechanical checks.
Model defaults to `gpt-5.6-terra` (balanced; `gpt-5.6-luna` for fast/cheap bulk).
Runs on the user's subscription (external cost) — scoped.
**TASTE STAYS WITH CLAUDE (hard rule):** never delegate UI/design/visual/
product-taste judgment to Codex/GPT-5.5 — Claude leads all UI work and owns the
verdict. When unsure if something is "taste," treat it as taste.

**Visual-defect critique → Antigravity/Gemini (`[skill:visual-critique]`).** The
one UI job that goes to another model: an *objective* visual-defect pass over
rendered screenshots (truncation, overflow, misalignment, contrast/a11y,
safe-area collisions, broken responsive states) via `scripts/agy-headless.sh`
(Gemini, multimodal, free Antigravity tier). Gemini *judges*; Claude still owns
generation/taste and **triages the findings** — verify each against the
screenshot (Gemini can hallucinate defects) before acting. Never ask it "does
this look good" — objective defects only.

### When to Use `spawn_session` vs Inline Skills

**Use inline skills (default)** when:

- The task is sequential — each step depends on the previous one
- You need to carry context between build and review phases
- It's the standard dev loop (plan → build → review → fix)
- The task is a single feature or bug fix

**Use `spawn_session`** when:

- Work is genuinely parallel and independent (e.g., backend + frontend with no shared state yet)
- You need isolation — one subtask shouldn't pollute context for another
- Long-running tasks where you want to report partial progress
- Running a review or security scan while continuing other work

Rule of thumb: if the tasks share files or need each other's output, keep them inline. If they're independent workstreams, spawn.

## Dev Loop (Default Posture)

For **any** implementation task — even without an explicit `/dev` invocation — act as the **development orchestrator**: analyze the task, route it to the right specialist subagent, then run it through code review before declaring it done. Produce reviewed, production-ready code. `/dev <task>` runs this same loop explicitly; this section makes it the default.

### Delegation
Delegate to specialists with the **Task tool**, setting `subagent_type` to the specialist's name (`coder`, `reviewer`, `ui`, `infra`, `refactor`, `mobile` — defined in `.claude/agents/`). Delegations are **stateless**: each subagent starts fresh, so every prompt must be detailed and self-contained — what to implement, which files/packages, the constraints/patterns to follow, which docs to read, and exactly what to report back. Pass full context every time; when relaying review feedback, restate the original intent plus the findings verbatim.

### Agent Roster & Routing
| Agent | When to use |
|-------|------------|
| `coder` | Backend features, use cases, adapters, transports, tests, bug fixes, applying review feedback |
| `reviewer` | Code review after any implementation step (always runs; read-only) |
| `ui` | Web/shared UI pages, components, layouts, styling, design system, accessibility, responsive design |
| `infra` | Terraform, Docker, CI/CD, Cloud Run, DNS, secrets, deployment, env config |
| `refactor` | Code cleanup, deduplication, module reorganization, dead code removal, barrel exports |
| `mobile` | Expo / React Native in `apps/mobile`, `apps/scanner`, `apps/audio-transcoder` |

Classify before delegating:
- **Expo / React Native app** (`apps/mobile`, `apps/scanner`, `apps/audio-transcoder`) → load the `ui` skill for visible screens, then route to `mobile` (mobile UI stays with `mobile`; `ui` runs the design-review pass after the mobile engineering review).
- **Non-mobile UI** (web pages, components, styling, tokens) → load the `ui` skill, then route to `ui`.
- **Infra** (Terraform, Docker, CI, Cloud Run, env vars, secrets) → `infra`.
- **Pure cleanup** (no new behavior) → `refactor`.
- **Everything else** (use cases, adapters, transports, tests, bug fixes) → `coder`.
- **Cross-cutting** → split into steps and route each (run sequentially: e.g. `coder` → `reviewer` → `ui` → `reviewer`).

### Orchestrator Skills Toolkit
Before building: `feature-scoping` (vague idea → spec; opens by running the `grilling` interview to an empty frontier) → `implementation-plan` (spec → ordered steps) → `context-map` (before any multi-file change). For UI work, load the `ui` skill first. `grilling` also stands alone for stress-testing any plan or decision outside scoping. After building: `help-center-authoring` (if user-facing) and `release-notes`. Use `doc-coauthoring` for substantial written artifacts, `domain-modeling` when a session shifts the domain language (update `CONTEXT.md` / `docs/decisions/`), and `/handoff` to compact a session for the next agent to continue.

### The 9-Step Loop
```
1. PLAN    → Break down the task, classify each step, set up todos (TodoWrite)
2. ROUTE   → Pick the right specialist for each step
3. BUILD   → Delegate to the specialist (Task tool)
4. REVIEW  → Delegate to `reviewer` to audit the output
5. FIX     → If CHANGES_REQUESTED, send findings back to the SAME specialist
6. REPEAT  → Steps 4–5 until APPROVED (max 3 rounds per step)
7. NEXT    → Move to the next step (if cross-cutting), repeat from step 3
8. RUN     → Drive the REAL app and look at it (see "Run it" below)
9. REPORT  → Summarize what was built, reviewed, and validated
```

### Hard Constraints
- **Never skip review.** Every implementation gets reviewed by `reviewer`.
- **Max 3 review rounds per step.** If unresolved after 3, stop and escalate to the user.
- **One feature/fix per loop.** Don't combine unrelated changes in one iteration.
- **Pass full context between agents** — delegations are stateless; restate intent and findings each time.
- **Track progress with TodoWrite.**
- **Run final validation yourself** (typecheck, tests) after approval, as a sanity check.
- **Run the app yourself** for anything user-facing. Green tests are not evidence that a page works.

### Run It (step 8)

Any change with a visible surface is NOT done until it has been driven in the real app. Unit tests here mock the design system away and render components in isolation, so an entire class of defect is invisible to them by construction: accessible-name collisions with the rest of the page, SSR/hydration mismatches, reflow and overflow, and anything about how a component sits among its neighbours.

This is not hypothetical. A passkey rename UI went through the full loop — layer-ordered delegation, two review rounds, 405 green tests — and shipped three real defects that fell out within twenty minutes of running it: two "Save" buttons with identical accessible names on one page, a full hydration failure on the route, and a horizontal overflow at 320px whose cause a subagent had guessed at with arithmetic (and got wrong).

**Run e2e WITHOUT wiping your dev database:**
```bash
cd apps/web && E2E_USE_LIVE_STACK=1 pnpm exec playwright test e2e/<spec>.spec.ts --project=chromium --reporter=list
```
`E2E_USE_LIVE_STACK=1` reuses an already-running dev stack (:3000 + :3001) and skips the readiness step that runs `prisma migrate reset --force`. **Without it, the harness WIPES the local dev database.** It also now blocks the ~54 specs that call `resetE2eState()` in `beforeEach`: that endpoint `deleteMany`s every order, event, org and auth user in whatever DB the API points at, so under the flag those specs fail fast instead of destroying your seed data. Pass `E2E_ALLOW_LIVE_RESET=1` to wipe a live stack on purpose. Never work around Prisma's agent guardrail, and never set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` — if a reset seems necessary, stop and ask.

Trade-off: your DB is not pristine in this mode, so fixture-dependent specs may fail, and any spec you run this way must clean up what it creates. Use the default (wiping) path for money, settlement, and journey suites.

`fullyParallel: true` is set, so specs that mutate the SAME account collide when run together — and the symptom looks like a product bug, not a harness one. Measured: the two passkey specs together → 2 failed; `--workers=1` → 4 passed. When running more than one spec that touches shared account state, pass `--workers=1`.

Minimum bar for a UI change: load the page, exercise the interaction, check **zero new console errors**, and check a 320px viewport. The `test` fixture in `e2e/fixtures.ts` fails a spec on console errors automatically — trust it only as far as `e2e/helpers/console-errors.ts`'s ignore list allows (read it; it has swallowed real failures before).

### Claim Discipline (subagents and orchestrator)

Subagent reports are evidence only where they are backed by a command. In every report, tag each load-bearing claim:

- `[VERIFIED: <exact command>]` — it was executed and the output is pasted.
- `[REASONED]` — it was derived by reading code. Legitimate, but it is a hypothesis.

The orchestrator **re-runs the load-bearing `[VERIFIED]` claims** and treats `[REASONED]` claims about runtime behaviour as unproven until measured. Real examples from one session: "the 320px cluster wraps" was `[REASONED]` and wrong; "`\p{...}` may crash on Hermes" was `[REASONED]` and disproved by actually running Hermes; "DOM output is byte-identical for existing callers" was true but had to be checked by grepping every call site.

Note `reviewer` and `security-reviewer` have **no Bash** — they physically cannot execute anything, so everything they report is `[REASONED]`. Their findings are leads to verify, not verdicts.

### Gates That Look Real And Are Not

Verify a gate actually fails before trusting it. Each of these was confirmed by planting a deliberate error and watching the "gate" pass:

| Command | Reality |
| --- | --- |
| `pnpm exec tsc --noEmit` **at repo root** | **No-op.** Picks up the root solution `tsconfig.json` (`files: []`), so `--noEmit` walks nothing and exits 0 even with a planted type error. Use **`pnpm typecheck`** (`-p tsconfig.base.json`), which does catch it. From inside `apps/web` the bare form is real — so the same command is a gate or a lie depending on cwd. |
| **`pnpm typecheck` alone** | **Covers `packages/**` only.** `tsconfig.base.json` ends its `exclude` with `"apps/**"`, so a type error in `apps/api`, `apps/jobs`, `apps/mobile` or `apps/scanner` exits 0. A verified miss: `dispatchStripeEvent(event, stripe, {replay: true})` against a 2-arg signature passed `pnpm typecheck` and failed `pnpm -F api exec tsc -p tsconfig.json --noEmit` with TS2554. Typechecking is **two commands minimum** — `pnpm typecheck` for packages, plus the app's own `tsc -p tsconfig.json --noEmit` for every app you touched. Note `**/*.test.ts` is excluded everywhere, so no test file is typechecked by any of them. |
| `pnpm run <script> -- <flags>` | The `--` and everything after it lands in the underlying tool's argv and is silently dropped. A bogus flag runs green. `deploy-dev.yml`'s web step passes `--retry=1` this way, so its documented flake-retry has never applied. |
| `pnpm -F <name> exec …` with a typo'd filter | Prints "No projects matched the filters" and exits **0** — a permanently-green step that looks like coverage. |
| `vitest --run` in a package with no tests | Exits **non-zero** on zero matched files. Never add a CI step for a package that has no tests. |
| e2e console-error assertion | Only as honest as `IGNORED_PATTERNS`. `/hydration-mismatch/i` matched the docs URL React appends to REAL hydration failures, so the gate reported clean on a page failing hydration on every load. |

A package's tests running locally does **not** mean CI runs them. `@th/types` had 161 tests in zero jobs; check the workflow before claiming coverage.

### Verdict Handling
The `reviewer` returns `APPROVED | CHANGES_REQUESTED` with findings tagged `[BLOCKING] / [WARNING] / [NIT]`. Any `[BLOCKING]` → `CHANGES_REQUESTED`. On `CHANGES_REQUESTED`, extract the `[BLOCKING]` and `[WARNING]` findings and send them back to the specialist that wrote the code, then re-review.

### Final Report
```
## Dev Loop Complete

### Task
<what was requested>

### Implementation
<specialist's final summary — files changed, tests written>

### Review
<reviewer's final verdict — APPROVED with any remaining notes>

### Validation
<commands run and results>

### Review Rounds: <N>
```

### Discord Narration (optional)
If `DISCORD_AGENTS_WEBHOOK` is set, POST a status embed after each major step via `curl` (colors: planning=3447003, coding=16776960, reviewing=15105570, approved=3066993, changes_requested=15158332). Only attempt if the env var exists; **never fail the loop because Discord is unavailable.**
