---
name: unslop
description: Strip repetitive AI writing defaults from prose. Use whenever writing or editing user-facing or human-facing text — help articles, release notes, emails, marketing/GTM copy, support replies, README prose, blog posts — or when asked to 'unslop', 'de-AI', or 'make this sound human'. Also applies to your own conversational replies.
---

# Unslop

Every model collapses toward the same defaults: the same openings, transitions, rhetorical moves, and grand closers. This skill is a measured avoid-list (derived from mshumer/unslop's 100-sample analysis). It says what to avoid, not what one new style to adopt — the point is to force fresher choices, not swap one template for another.

Scope: **prose only — but all of it.** Artifacts (articles, emails, copy) and your own replies to the user in conversation alike; a chat answer collapses toward the same defaults an essay does. Visual/UI style in this repo is governed by the design system (`docs/design/design-system-v2.md`), not by a generic anti-slop profile. Code comments follow the surrounding code's density, not this skill.

## Phrases to never use

Do not use any of the following phrases or close variants:

- "In today's [adjective] landscape/world/era" / "In an increasingly [adjective] world"
- "It's not just about X — it's about Y" / "X is more than just Y — it's Z" / "This isn't just [X] — it's [grander X]"
- "Here's the thing" / "Here's why that matters" / "But here's the catch"
- "Let's dive in" / "Let's dive deeper" / "Let's unpack this"
- "At its core" / "At the end of the day" / "The bottom line"
- "It's worth noting that" / "It goes without saying"
- "This is where things get interesting" / "This raises an important question"
- "The short answer is" / "The long answer is" / "To put it simply" / "In other words"
- "Think about it this way" / "The reality is" / "Make no mistake"
- "What does this mean for [audience]?" / "The question isn't whether X, but Y"
- "Spoiler alert:" / "Let that sink in"
- "Perhaps most importantly" / "The good news is" / "The bad news is"

## Structural patterns to avoid

- Do not start with a broad, sweeping statement about the state of the world or industry before narrowing to the topic. Start with the actual topic.
- Do not use the structure: "[Broad claim]. But [complication]. Here's [resolution]."
- Do not end with a paragraph that restates the thesis in grander terms than the piece warrants.
- Do not organize every piece as: intro hook → context → 3-5 body sections → takeaway → call to action. Vary the structure.
- Do not use a "The future of X" section near the end.
- Do not add a "Final thoughts" or "Key takeaways" section header.
- Do not number your points unless the reader actually needs them in order.
- Do not use rhetorical questions as transitions between sections.

## Tonal patterns to avoid

- Do not hedge with "might," "could potentially," "it remains to be seen" on every other claim. Either commit or don't make the claim.
- Do not affect breathless enthusiasm. Not everything is "fascinating," "remarkable," "game-changing," or "transformative."
- Do not address the reader as "you" in every paragraph.
- Do not use the false-authority voice where every claim sounds like settled consensus when it's actually opinion.
- Do not end paragraphs with one-sentence dramatic kickers meant to sound profound.

## Word-level patterns to avoid

- Do not overuse: "landscape," "paradigm," "leverage," "robust," "seamless," "ecosystem," "holistic," "nuanced," "compelling," "innovative," "crucial," "essential," "fundamental."
- Do not use "delve" or "delve into."
- Do not use "navigate," "unlock," or "empower" metaphorically.
- Do not use "double-edged sword" or "at the intersection of X and Y."
- Em dashes: fine in moderation; a pileup of them in one paragraph is a tell. Vary the punctuation.

## Instead

Vary your openings, structures, and phrasing every time. Write like a specific human with a specific voice would — not like a median of all writing on the internet. For Ithas Fire user-facing copy specifically: plain, direct, second person only where the reader acts, and the user-facing vocabulary from `CONTEXT.md` (e.g. "action bar", never "CAB").

## Generating narrower profiles

This avoid-list is for general prose. For a narrower domain (e.g. "event marketing emails", "help-center articles"), generate a measured profile instead of guessing: clone `https://github.com/mshumer/unslop`, run `python3 unslop.py --domain "<domain>"`, review `unslop-output/analysis.md` for specificity, and add the resulting `skill.md` next to this file as `<domain>-profile.md` with a pointer here.
