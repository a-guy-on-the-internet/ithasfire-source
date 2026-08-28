---
name: help-center-authoring
description: "Structured workflow for writing or updating help-center articles under apps/web/content/help/. Use when adding a help article for a new feature, updating an article after a user-facing change, or sweeping articles for drift. Keeps articles grounded in shipped code, not specs or assumptions."
---

# Help Center Authoring

The help center lives at `apps/web/content/help/{category}/{slug}.md`. Articles are plain Markdown with YAML frontmatter and render through `react-markdown` with custom callout shortcodes (`:::tip`, `:::warning`, `:::action`). Routes: `/help`, `/help/[category]`, `/help/[category]/[slug]`.

## When to use

- Adding an article for a newly shipped feature
- Updating an existing article after a user-facing change (button rename, new step, changed error code, new payment method)
- Quarterly drift sweep — diff an article against current code and fix what's stale

## Hard rules

1. **Document shipped behaviour, not planned behaviour.** If the spec describes a flow but the UI/API isn't live yet, do not write the article. Misleading docs erode trust faster than missing docs.
2. **Verify every flow in the actual code** before writing. If the article cites a route, grep for the route file. If it cites a button label, grep for the string. If it cites a status code, find the enum definition.
3. **Describe observable behaviour, not exact UI plumbing.** Prefer "open your Security settings and click **Change password**" over "navigate to /account/settings#section-05 and press the button at row 3". Behaviour rots more slowly than UI layouts.
4. **One article per user-facing job.** If two articles would duplicate more than half their content, collapse them — either merge, or redirect one to the other with a link.
5. **No feature flags or internal codes** in user text. Describe what a buyer sees, not what's in the enum (`DRAFT`, `PUBLISHED` status codes are acceptable when they appear in the UI verbatim; internal flags are not).

## Frontmatter template

```yaml
---
title: "Short, specific action or subject"
description: "One sentence (max ~110 chars) summarising the article — appears in cards and search results."
category: "getting-started | buying-tickets | organising-events | account | troubleshooting"
order: <number>  # relative position within the category; lower numbers appear first
tags: ["short", "lower-case", "kebab-tags"]
related: ["category/slug", "category/slug"]  # 2–4 relevant articles
specs: ["<YYYY-MM-DD>/<spec-slug>"]  # OPTIONAL: specs this article documents, for drift detection
---
```

The `specs:` field is optional but preferred when an article describes a feature tracked by one or more specs in `docs/specs/`. Drift checks use this to flag articles whose underlying spec has been modified since the article's own last edit.

## Structure template

```markdown
Short intro (1–2 sentences) — what this article covers and when the reader needs it.

## Before you start

Prerequisites, required state, or context the reader needs. Omit if obvious.

## <Primary flow>

Numbered steps with exact button labels and observable outcomes.

:::tip
A non-obvious trick or nuance. Keep these to one paragraph.
:::

## <Secondary flows or edge cases>

## What can go wrong

Failure modes the reader might actually hit — not every theoretical edge case.

:::warning
A real risk the reader might not expect. Reserve :::warning for actual stakes, not soft hints.
:::

## Next steps / Related

Links to follow-up articles. Prefer inline links in prose over a bare list at the end.
```

## Voice

- Second person (`you`), active voice
- Present tense for behaviour, imperative for instructions
- Concrete nouns (`the event page`, `your order`, `Stripe Connect`) not abstractions (`the interface`)
- British English spellings are the house style (organiser, centre, cancelled)
- No marketing language ("delightful", "seamless"). No emoji unless the user explicitly asks.
- Apply the `unslop` skill's avoid-list — banned phrases, structures, and words for all prose in this repo.

## Callouts

Three kinds; pick one intentionally:

- `:::tip` — non-obvious shortcut or optimisation. Skippable.
- `:::warning` — real consequence the reader might not expect (data loss, money, irreversible action)
- `:::action` — CTA pointing the reader at the next step. Sparing use.

Callouts can contain inline markdown (`**bold**`, `[links](url)`). Don't put headings inside callouts.

## Workflow

### 1. Scope the article

Answer before writing:

- What's the one thing a reader should walk away knowing?
- What's the specific failure mode this article prevents?
- What's the likely entry point (search query, category browse, link from another article)?

If answers are vague, the article will be vague. Narrow scope until the answers are concrete.

### 2. Ground in code

For a new article, before writing anything:

- Find the route files (`apps/web/src/app/**/page.tsx`)
- Find the use case (`packages/core/src/use-cases/**/*.ts`) and read input/output schemas
- Find the button strings — grep for the label you intend to cite
- Check for status/error enums — copy the actual names used in the UI

For an update, do the same steps but compare against the existing article: flag anything that no longer matches. Don't just trust the article's current text.

### 3. Write

Follow the structure template. Keep paragraphs tight. Each section should answer one question.

### 4. Cross-link

- Add `related:` entries for the 2–4 most adjacent articles
- Add inline links where a reader would naturally jump to another article
- Update the `related:` arrays of those other articles if the new article fits their orbit
- Update `troubleshooting/faq.md` with a 2–3 line summary + link if the new article answers a common question

### 5. Verify render

After writing, reload `/help/<category>/<slug>` in dev and confirm:

- All links resolve (no 404s)
- Callouts render correctly (tip / warning / action variants)
- No stray `:::` markers or unformatted frontmatter leaking through
- The article appears in the category list and the article count increments

### 6. Update count expectations

If adding or removing articles, no code changes are needed — category counts derive from the content directory automatically.

## Drift sweep

When running a drift sweep on existing articles:

1. Read the article
2. For each UI reference (route, button, status code), verify it against current code
3. For each procedural step, re-walk the flow (either by reading the route/use-case or loading the page in the dev browser)
4. Report findings as a list of `[file]: <what changed>` — don't rewrite without approval unless the fix is mechanical

Articles with a `specs:` frontmatter field can be prioritised: if the spec's mtime is newer than the article's, the article is a candidate for review. Run this automatically:

```bash
pnpm -F web help-drift
```

This walks every article under `apps/web/content/help/`, reads `specs:`, and compares the last-commit timestamp of each referenced spec against the article's own last-commit timestamp. Exits `0` clean, `1` on drift, `2` if a referenced spec is missing.

## Anti-patterns

- Do not paste spec text into an article. Specs describe intent; articles describe reality.
- Do not reference internal Linear/GitHub issue numbers, engineer names, or branch names.
- Do not include API shapes or database columns unless they appear verbatim in the UI (e.g. the `chargesEnabled` status label).
- Do not write speculative "coming soon" sections. If a feature isn't shipped, it doesn't exist in the help center.
- Do not add articles for features whose UI is partial (backend-only, admin-only for a buyer article, behind a feature flag that's off in prod).

## Common traps (learned from past iterations)

- **OAuth-only accounts** need explicit callouts — some settings (email change, password change) are unavailable or different for these accounts.
- **Organisers vs buyers** are different audiences with different RBAC. An article should be clear about which role it's written for; don't mix buyer and organiser steps in one doc.
- **Platform vs organiser admin** are different dashboards (`/platform/*` vs `/admin/[slug]/*`). Don't confuse them.
- **Monetary behaviour** changes slowly but consequentially. Fees, holds, payout timing should be double-checked against the use case, not just the UI label.
- **Two scan surfaces, and they differ.** The scan page at `/admin/[slug]/scan` runs in any browser (iPhone Safari included), needs a connection, and has no torch or offline queue. The operator app is a separate Android install, offered from `/admin/[slug]/scanner-setup`, and adds the torch and offline scanning. Say which surface a step applies to.
- **Reading a pass never admits anyone.** Both surfaces resolve first and wait for an explicit **Admit** tap (**Check in** for volunteers). The old confirm-less camera path is gone; results read as words like ADMIT / ALREADY IN / WRONG SHOW, not Accepted / Replay / Rejected.
- **`source: "COMP"`** on a $0 order is how comp tickets are represented — there's no separate `CompTicket` model.
