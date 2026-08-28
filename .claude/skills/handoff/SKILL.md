---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Save to `~/.claude/projects/-Users-somehuman-Projects-TicketHunter/handoffs/<YYYY-MM-DD>-<slug>.md` — outside the workspace (never committed), but persistent across sessions, unlike the scratchpad.

Include:

- **Goal and current state** — what the work is for, what's done, what's next. Tag load-bearing claims `[VERIFIED: <command>]` or `[REASONED]` per the claim discipline in CLAUDE.md; the next agent must know which statements were actually executed.
- **Git state** — current branch, what's staged/unstaged, unpushed commits, and which of the touched files belong to THIS work vs. the pre-existing uncommitted backlog. This repo routinely carries many uncommitted files; a handoff that says "commit everything" causes clobbers. Name the exact paths to stage.
- **Suggested skills** — which skills the next agent should call the Skill tool for.
- **Gotchas hit this session** — anything that cost time and isn't yet captured in CLAUDE.md or memory.

Do not duplicate content already captured in other artifacts (specs in `docs/specs/`, plan files in the memory directory, decision records, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly. End by telling the user the file path and a one-line "paste this to the next agent" pointer.
