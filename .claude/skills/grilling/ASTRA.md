# The Astra pass

**Astra** is the owner's name for the newest GPT, reached only through `scripts/codex-headless.sh` (read `.claude/skills/codex-delegate/SKILL.md` once for the wrapper's exit codes). It does two jobs in a round:

- **Clear**: settle a frontier question from evidence (code, schema, docs, specs, recorded rulings), so it never reaches the owner.
- **Ideate**: name options, angles and missing branches that Claude's draft round left out.

Astra's output is input to Claude. Claude checks it, keeps or drops each piece, and owns every recommendation.

## What Astra may clear

A question is **clearable** when its answer is a fact that a source can show: how the code behaves today, what a model or port already carries, what a precedent did, what a recorded ruling already says. Everything else is an **owner question** and stays on the owner's list however confident Astra is:

- product, UX, copy, design or any taste call (TASTE STAYS WITH CLAUDE: Claude recommends, the owner decides);
- money, fees, refunds, payouts, legal, tax, privacy or auth policy;
- a pro-social tiebreak or anything that might be enshittification (`docs/pro-social.md`);
- anything that would change or reinterpret an owner ruling.

Astra may **narrow** an owner question: rule out an option with evidence, or show two options collapse into one. A narrowed question still goes to the owner, with the narrowing stated.

## Steps

1. **Brief.** Write `$SCRATCH/astra-round-<n>.md` with: the topic in one line, the settled rulings (verbatim, with who and when), the facts found so far, and the draft round, every question with its recommendation. Name the spec or plan file and the code paths in play.
2. **Run** in the foreground, read-only, with the schema beside this file:

   ```bash
   scripts/codex-headless.sh --cap-seconds 600 --schema .claude/skills/grilling/astra.schema.json -- \
     "$(cat .claude/skills/grilling/astra-prompt.md) $(cat $SCRATCH/astra-round-<n>.md)"
   ```

   Exit 125, 124 or 1 → send the round without Astra and say so in one line; a stuck run is killed by the PID the wrapper prints.
3. **Triage**, each item on its merits:
   - a **clear**: open the cited source and confirm it. Confirmed and clearable → drop the question from the round and log it. Unconfirmed, or an owner question → it stays in the round.
   - a **narrow**: confirm the evidence, then fold it into the question body.
   - an **idea**: keep it when it adds a real option or a missing branch. A kept option goes into its question's body; a missing branch becomes a new question in this round or a later one. Recommend on Claude's own judgement, which may be Astra's option or not.
   - a **disagreement** with a recommendation: weigh it; when it changes the recommendation, say so in the question.
4. **Log** every cleared question in the active spec or plan file beside the owner's answers: the question, the answer, the source path, `cleared by Astra, checked by Claude, <date>`.

## What the owner sees

Astra's contributions carry its name, so the owner can tell whose idea is whose. Inside a question, an option or narrowing from Astra reads `💡 Astra: <one line>`. After the questions, one short block:

```
🧹 **Cleared without you** (overrule any):
- **<question title>**: <answer>. Source: `<path>`.
```

Leave the block out when nothing was cleared.

## Discussions outside a grill

When the owner says "ask Astra" or wants more ideas in a discussion, run the same pass with the brief cut down to the question at hand, and present the result the same way: Astra's ideas labelled, Claude's verdict separate.

## Cost

One run per round on the owner's ChatGPT/Codex subscription (no Claude tokens), about 90 seconds for a ten-question round (trial, 2026-10-15). The owner prefers GPT for this kind of work, so the pass runs every round by default; one trivial question with no code behind it can skip it.
