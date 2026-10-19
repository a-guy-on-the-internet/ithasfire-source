---
name: handoff
description: Hand off to a fresh session. Use at a hand-off point (task done and the next is different, investigation turning into a build, session drifting) to write a handoff document and start the next session in a new VS Code tab.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Save to `~/.claude/projects/-Users-somehuman-Projects-TicketHunter/handoffs/<YYYY-MM-DD>-<slug>.md` — outside the workspace (never committed), but persistent across sessions, unlike the scratchpad.

Include:

- **Goal and current state** — what the work is for, what's done, what's next. List every open item, however small: "done" means none are left. Tag load-bearing claims `[VERIFIED: <command>]` or `[REASONED]` per the claim discipline in CLAUDE.md; the next agent must know which statements were actually executed.
- **Git state** — current branch, what's staged/unstaged, unpushed commits, and which of the touched files belong to THIS work vs. the pre-existing uncommitted backlog. This repo routinely carries many uncommitted files; a handoff that says "commit everything" causes clobbers. Name the exact paths to stage.
- **Rulings this session** — every decision, correction and preference the user gave, verbatim, with who decided it. Point to the memory or spec file where each one was saved; save any that only live in the conversation before writing the handoff.
- **First reads** — the 2–5 files the next agent opens first, in order, so it starts from disk rather than from this summary.
- **Suggested skills** — which skills the next agent should call the Skill tool for.
- **Gotchas hit this session** — anything that cost time and isn't yet captured in CLAUDE.md or memory.

Do not duplicate content already captured in other artifacts (specs in `docs/specs/`, plan files in the memory directory, decision records, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, or the hand-off was triggered by the user asking for a new task, treat that as what the next session will focus on and tailor the doc to it.

## Start the next session

Run `.claude/skills/handoff/launch.sh <handoff file>` (Bash, timeout 300000). It starts the next session headless in the background on `$HANDOFF_MODEL` (default `claude-opus-5-5`) with full tools (permission mode `$HANDOFF_PERMISSION_MODE`, default `bypassPermissions`); that session reads the handoff and gets straight to work on its next steps, and opens in a VS Code tab when its first turn ends. The launcher prints the session id and a log path at once. The headless turn loads only the MCP servers in `headless-mcp.json`, and at most 4 headless sessions run at once: a fifth waits in the background and the launcher prints a `queued:` line (knobs in the launcher's header). An ad-hoc headless resume takes the same wrapper: `node scripts/dev/gate/run.mjs --weight session -- claude -p --resume <id> --strict-mcp-config --mcp-config .claude/skills/handoff/headless-mcp.json "<prompt>"`. Skip this step only when the user asked for the file alone.

Done when: the launcher printed a session id, this session's entry is appended to `~/.claude/projects/-Users-somehuman-Projects-TicketHunter/memory/HISTORY.md`, and you have told the user in two lines — the handoff file path, and that the next session is already working, or queued if the launcher printed `queued:` (its tab opens when the first turn ends; the log path follows its progress). If the launcher fails, give the user the file path and the line to paste into a new chat instead.
