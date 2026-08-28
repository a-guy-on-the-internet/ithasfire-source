---
name: release-notes
description: "Generate release notes, changelogs, or PR descriptions from recent work. Use when asked to 'write release notes', 'summarize what changed', 'draft PR description', 'write a changelog entry', or after completing a feature to document what was shipped."
---

# Release Notes

Generate concise, audience-appropriate release notes from recent commits, specs, and code changes.

## When to Use

- After completing a feature or fix, to document what shipped
- When asked to "write release notes", "summarize changes", "draft PR description"
- When preparing a changelog entry for a version bump
- When the user wants a user-facing summary of technical work

## Workflow

### Step 1: Gather Context

Collect information from these sources (in priority order):

1. **Changed files**: Use the editor's changed-files tool (if available) for structured diffs, then supplement with `git diff --stat <base>..HEAD`
2. **Recent commits**: Run `git log --oneline -20` (or a specific range) to see what was committed
3. **Specs**: Check `docs/specs/` for any specs related to the changes
4. **Test results**: Note which test suites were affected and their status

### Step 2: Classify the Audience

Determine who reads this:

| Audience | Tone | Detail Level |
|----------|------|-------------|
| **PR description** | Technical, for reviewers | Full implementation detail, files changed, test coverage |
| **Changelog** | Developer-facing | What changed, why, migration notes |
| **User-facing release notes** | Non-technical | What users can now do, what's fixed |
| **Internal summary** | Team-facing | Business impact, decisions made, follow-ups |

Ask the user which audience if unclear.

### Step 3: Draft

#### PR Description Format

```markdown
## What

<1-2 sentence summary of the change>

## Why

<Problem this solves or opportunity it captures>

## How

### <Layer 1 — e.g., Database>
- <Change 1>
- <Change 2>

### <Layer 2 — e.g., Backend>
- <Change 1>

### <Layer 3 — e.g., Frontend>
- <Change 1>

## Tests

- <Test suite>: <N> tests, all passing
- <New tests added>: <description>

## Spec

- `docs/specs/<date>/<name>.spec.yaml`

## Follow-ups

- [ ] <Deferred work or known issues>
```

#### Changelog Entry Format

```markdown
### <Version or Date>

#### Added
- <New feature or capability>

#### Changed
- <Modified behavior>

#### Fixed
- <Bug fix>

#### Migration
- <Any migration steps needed>
```

#### User-Facing Release Notes Format

```markdown
## What's New

### <Feature Name>
<1-2 sentences describing what users can now do, in plain language.
No technical jargon. Focus on the benefit.>

### Bug Fixes
- <Fixed: description of what was wrong, now works correctly>
```

### Step 4: Verify

Before presenting:
- [ ] Every significant commit is represented
- [ ] No internal implementation details leak into user-facing notes
- [ ] Migration steps are included if schema changed
- [ ] Breaking changes are called out prominently
- [ ] Spec references are linked for PR descriptions

## Rules

- **Match the audience.** PR descriptions are technical. User-facing notes mention zero file paths.
- **Lead with the "what", not the "how".** "Buyers must now accept Terms of Service at checkout" not "Added termsVersion and termsAcceptedAt fields to Order model."
- **Group by feature, not by file.** Organize around what the user experiences, not which packages were touched.
- **Flag breaking changes.** If an API contract changed, a schema migrated, or behavior shifted, call it out explicitly.
- **Include follow-ups.** If there's deferred work or known limitations, list them so they don't get lost.
- **Keep it honest.** Don't oversell. If it's a small fix, it's a small fix.
- **Unslop it.** Apply the `unslop` skill's avoid-list — no "seamless", no "we're excited to", no grand closers.
