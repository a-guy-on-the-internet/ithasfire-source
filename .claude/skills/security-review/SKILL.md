---
name: security-review
description: 'AI-powered codebase security scanner that reasons about code like a security researcher — tracing data flows, understanding component interactions, and catching vulnerabilities that pattern-matching tools miss. Use this skill when asked to scan code for security vulnerabilities, find bugs, check for SQL injection, XSS, command injection, exposed API keys, hardcoded secrets, insecure dependencies, access control issues, or any request like "is my code secure?", "review for security issues", "audit this codebase", or "check for vulnerabilities". Covers injection flaws, authentication and access control bugs, secrets exposure, weak cryptography, insecure dependencies, and business logic issues across JavaScript, TypeScript, Python, Java, PHP, Go, Ruby, and Rust.'
---

# Security Review

An AI-powered security scanner that reasons about your codebase the way a human security
researcher would — tracing data flows, understanding component interactions, and catching
vulnerabilities that pattern-matching tools miss.

## When to Use This Skill

Use this skill when the request involves:

- Scanning a codebase or file for security vulnerabilities
- Running a security review or vulnerability check
- Checking for SQL injection, XSS, command injection, or other injection flaws
- Finding exposed API keys, hardcoded secrets, or credentials in code
- Auditing dependencies for known CVEs
- Reviewing authentication, authorization, or access control logic
- Detecting insecure cryptography or weak randomness
- Performing a data flow analysis to trace user input to dangerous sinks
- Any request phrasing like "is my code secure?", "scan this file", or "check my repo for vulnerabilities"
- Running `/security-review` or `/security-review <path>`

## How This Skill Works

Unlike traditional static analysis tools that match patterns, this skill:
1. **Reads code like a security researcher** — understanding context, intent, and data flow
2. **Traces across files** — following how user input moves through your application
3. **Self-verifies findings** — re-examines each result to filter false positives
4. **Assigns severity ratings** — CRITICAL / HIGH / MEDIUM / LOW / INFO
5. **Proposes targeted patches** — every finding includes a concrete fix
6. **Requires human approval** — nothing is auto-applied; you always review first

## Project Context — Ithas Fire (read this FIRST)

This is a **TypeScript-only** hexagonal monorepo. Use this to focus the scan and
avoid false positives; do NOT scan for Python/Java/PHP/Go/Ruby/Rust patterns.

**Stack & entry points (start tracing from these trust boundaries, not from repo root):**
- User input enters through **tRPC routers** (`packages/transport/trpc/src/routers`),
  Next.js route handlers + `middleware.ts` (`apps/web`), the **Better Auth** surface
  and **Stripe webhook** handlers (`apps/api`), and uploaded-file metadata.
- Persistence: **Prisma → Postgres**. SQL-injection surface is therefore ONLY
  `$queryRaw*` / `$executeRaw*` with interpolation — plain Prisma calls are
  parameterized. Defer deep SQL/RLS analysis to the `postgresql-code-review` skill.
- Auth: **Better Auth** (`apps/api/src/auth/better-auth.ts`). Storage: **Cloudflare R2**.
  Payments: **Stripe Connect**. Rate limiting: **Redis** (tRPC floor 240/min/actor + Better-Auth custom rules).

**Defenses already in place — FAST-CLEAR these; only report a MISSING or BYPASSED defense on a specific path:**
- Zod `.strict()` schemas at the tRPC boundary via `parseInput` (typed input validation).
- Free-text sanitization: `sanitizePlainText` / `sanitizePlainTextMultiline` and the Zod
  helpers `plainText{,Multiline}{Required,Optional}` (`packages/core/src/lib/sanitize-plain-text.ts`).
- HTML: `escape-html` library; `safeHref` (URL-scheme allowlist — blocks `javascript:`/`data:`);
  `sanitizeAnnouncementHtml`; the rich-text pipeline (`packages/service/rich-text-html`,
  `packages/ui-email/src/lib/prose-to-html.ts`). React auto-escapes JSX.
- Stripe webhooks verified via the adapter (signature check), not raw body parsing.
- RBAC via `repos.authz.ensureOrgRole` inside use cases. Email header CR/LF stripping.
- A finding on any of these MUST show the defense is absent/bypassed on a concrete
  field or path (e.g. a free-text field that skips `plainText*`, a `dangerouslySetInnerHTML`
  on un-sanitized data, the one `$queryRaw`) — not merely that a sink exists.

**Threat model — LEAD with these priority bug classes (highest value for a payments marketplace):**
1. **Cross-org IDOR / tenant isolation** — can org A read or mutate org B's events, orders,
   settlements, payouts? Every mutation must scope by org and pass `ensureOrgRole`.
2. **Money manipulation** — fee/refund/settlement math, negative or overflowing quantities,
   price-override abuse, the `sum(splits) === basis` invariant (see `docs/hot-paths.md`).
3. **Payout redirection** — tampering with Connect account / payee destination.
4. **Stripe webhook forgery / replay** — missing signature verification, non-idempotent handlers.
5. **Auth & session** — account takeover, and the **open redirect on the sign-in `?redirect=` param**.
6. **Stored XSS** via rich-text/HTML sinks (emails, announcements, entity-page blocks).
7. **Secrets exposure** and **SSRF** on user-supplied URLs (website / image / embed fields).

**Repo hand-offs:** read `docs/hot-paths.md` + `docs/engineering-standards.md` for the money/auth
invariants, and check the `project_security_audit_2026_07_05` memory for known-open items.

## Execution Workflow

Follow these steps **in order** every time:

### Step 1 — Scope Resolution
Determine what to scan:
- If a path was provided (`/security-review src/auth/`), scan only that scope
- If reviewing a change/PR, scan the **diff** (`git diff` against the base branch) plus the
  files it touches and their immediate callers/sinks — prefer this for iterative reviews
- If no path/diff given and a full audit is requested, start from the **trust boundaries**
  in Project Context above (tRPC routers, auth, webhooks, storage/email adapters), not from repo root
- This is a TS/JS monorepo — only the JavaScript/TypeScript section of
  `references/language-patterns.md` applies; ignore the other languages

### Step 2 — Dependency Audit
Before scanning source code, audit dependencies (fast wins):
- Run `pnpm audit` (this repo uses pnpm) against the real lockfile — it's authoritative,
  unlike a static watchlist. Flag High/Critical advisories and any deprecated crypto libs.
- `references/vulnerable-packages.md` is a fallback watchlist only; the live `pnpm audit`
  takes precedence. Skip the non-npm ecosystems entirely.

### Step 3 — Secrets & Exposure Scan
Scan ALL files (including config, env, CI/CD, Dockerfiles, IaC) for:
- Hardcoded API keys, tokens, passwords, private keys
- `.env` files accidentally committed
- Secrets in comments or debug logs
- Cloud credentials (AWS, GCP, Azure, Stripe, Twilio, etc.)
- Database connection strings with credentials embedded
- Read `references/secret-patterns.md` for regex patterns and entropy heuristics to apply

### Step 4 — Vulnerability Deep Scan
This is the core scan. Reason about the code — don't just pattern-match.
Read `references/vuln-categories.md` for full details on each category.

**Injection Flaws**
- SQL Injection: raw queries with string interpolation, ORM misuse, second-order SQLi
- XSS: unescaped output, dangerouslySetInnerHTML, innerHTML, template injection
- Command Injection: exec/spawn/system with user input
- LDAP, XPath, Header, Log injection

**Authentication & Access Control**
- Missing authentication on sensitive endpoints
- Broken object-level authorization (BOLA/IDOR)
- JWT weaknesses (alg:none, weak secrets, no expiry validation)
- Session fixation, missing CSRF protection
- Privilege escalation paths
- Mass assignment / parameter pollution

**Data Handling**
- Sensitive data in logs, error messages, or API responses
- Missing encryption at rest or in transit
- Insecure deserialization
- Path traversal / directory traversal
- XXE (XML External Entity) processing
- SSRF (Server-Side Request Forgery)

**Cryptography**
- Use of MD5, SHA1, DES for security purposes
- Hardcoded IVs or salts
- Weak random number generation (Math.random() for tokens)
- Missing TLS certificate validation

**Business Logic**
- Race conditions (TOCTOU)
- Integer overflow in financial calculations
- Missing rate limiting on sensitive endpoints
- Predictable resource identifiers

### Step 5 — Cross-File Data Flow Analysis
After the per-file scan, perform a **holistic review**:
- Trace user-controlled input from entry points (HTTP params, headers, body, file uploads)
  all the way to sinks (DB queries, exec calls, HTML output, file writes)
- Identify vulnerabilities that only appear when looking at multiple files together
- Check for insecure trust boundaries between services or modules

### Step 6 — Self-Verification Pass
For EACH finding:
1. Re-read the relevant code with fresh eyes
2. Ask: "Is this actually exploitable, or is there sanitization I missed?"
3. Check if a framework or middleware already handles this upstream
4. Downgrade or discard findings that aren't genuine vulnerabilities
5. Assign final severity: CRITICAL / HIGH / MEDIUM / LOW / INFO

### Step 7 — Generate Security Report
Output the full report in the format defined in `references/report-format.md`.

### Step 8 — Propose Patches
For every CRITICAL and HIGH finding, generate a concrete patch:
- Show the vulnerable code (before)
- Show the fixed code (after)
- Explain what changed and why
- Preserve the original code style, variable names, and structure
- Add a comment explaining the fix inline

Explicitly state: **"Review each patch before applying. Nothing has been changed yet."**

## Severity Guide

| Severity | Meaning | Example |
|----------|---------|---------|
| CRITICAL | Immediate exploitation risk, data breach likely | SQLi, RCE, auth bypass |
| HIGH | Serious vulnerability, exploit path exists | XSS, IDOR, hardcoded secrets |
| MEDIUM | Exploitable with conditions or chaining | CSRF, open redirect, weak crypto |
| LOW | Best practice violation, low direct risk | Verbose errors, missing headers |
| INFO | Observation worth noting, not a vulnerability | Outdated dependency (no CVE) |

## Output Rules

- **Always** produce a findings summary table first (counts by severity)
- **Never** auto-apply any patch — present patches for human review only
- **Always** include a confidence rating per finding (High / Medium / Low)
- **Group findings** by category, not by file
- **Be specific** — include file path, line number, and the exact vulnerable code snippet
- **Explain the risk** in plain English — what could an attacker do with this?
- If the codebase is clean, say so clearly: "No vulnerabilities found" with what was scanned

## Reference Files

For detailed detection guidance, load the following reference files as needed:

- `references/vuln-categories.md` — Deep reference for every vulnerability category with detection signals, safe patterns, and escalation checkers
- `references/secret-patterns.md` — Regex patterns, entropy-based detection, and CI/CD secret risks
- `references/language-patterns.md` — Framework-specific vulnerability patterns for JavaScript, Python, Java, PHP, Go, Ruby, and Rust
- `references/vulnerable-packages.md` — Curated CVE watchlist for npm, pip, Maven, Rubygems, Cargo, and Go modules
- `references/report-format.md` — Structured output template for security reports with finding cards, dependency audit, secrets scan, and patch proposal formatting
