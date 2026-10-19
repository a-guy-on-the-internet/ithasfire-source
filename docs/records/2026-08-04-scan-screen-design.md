# Scan-screen design spec — door-mode result states, stats strip, control rail

**Status:** design pass (step 1 of `scan-ticket-redesign.spec.yaml`). **No code was written for this
document.** It is the annotated brief the `mobile` agent builds from in steps 3–4.

**Scope:** `apps/scanner` only (Phase A, FR-001/003/004/005/007/009 + NFR-002). Phase B (web) inherits
the tone/copy contract in §2 and §10 but not the RN layout.

**Palette source of truth:** `packages/ui-native/src/palette.ts`. Every colour named here is a token.
There is not one raw hex in the design — `apps/scanner/eslint.config.mjs` already bans them
(see §9), and this spec must not be the thing that reintroduces them.

**Theme reality:** `DEFAULT_NATIVE_THEME = "stub"` (`palette.ts:416`), and `App.tsx:179` binds
`IthasFireProvider theme={name}` to the native theme, so Tamagui-resolved `@th/ui` typography and
the RN StyleSheets always agree. Every design below is specified for **both** `stub` and `ember`
because Ember is genuinely reachable from Settings on this app (unlike the web, where it is inert).

---

## 0. The four tone families

The single most important decision in this document. Everything else hangs off it.

The redesign collapses eleven outcomes into **four tone families**, and the families are 1:1 with
FR-002's four feedback signatures. That alignment is the point: the operator learns *four* things,
and colour, glyph, word, haptic and audio all say the same one of the four at the same time.

| # | Family | Meaning to the operator | Fill token | Foreground token | Haptic/audio signature (FR-002) |
|---|---|---|---|---|---|
| 1 | **ADMIT** | Let them in | `successFill` *(new)* | `onSuccessFill` *(new)* | success |
| 2 | **ALREADY IN** | This pass has been used | `support` | `onSupport` | double-pulse |
| 3 | **REDIRECT** | Nothing is wrong; you need a different path | `structure` | `onStructure` | wrong-event |
| 4 | **STOP** | Do not admit / cannot vouch | `dangerFill` *(new)* | `onDangerFill` *(new)* | error |

Design properties this buys, all of which matter at a door:

- **Lightness is a fourth channel.** ALREADY IN is the *only* light fill. In a dark room, at arm's
  length, out of the corner of an eye, "the bright one" is already a decision — before hue,
  before glyph, before reading.
- **Deep fills protect night vision.** A full-bleed `#22C55E` in a black room is a flashbang; the
  palette docblock already argues this for choosing Ember at a venue. The ADMIT and STOP fills are
  deep, so a full-screen verdict does not cost the operator their dark adaptation.
- **Green/red-blindness is covered without a fifth channel.** Deuteranopes see ADMIT and STOP as two
  similar dark blocks — which is exactly why the 96px glyph and the verdict WORD are mandatory,
  not decorative. See §2's redundancy contract.
- **No new hues.** `successFill`/`dangerFill` reuse values already in the palette (Stub's `success`
  and `danger`); only the *pairing* is new.

### New tokens required

Add to **both** palettes with identical values (`palette.test.ts` enforces identical key sets):

```
successFill    "#166534"   // Stub's `success` value, used as a FILL in both themes
onSuccessFill  "#FFFFFF"   // 7.13:1 — the only foreground legal on successFill
dangerFill     "#B91C1C"   // Stub's `danger` value, used as a FILL in both themes
onDangerFill   "#FFFFFF"   // 6.47:1 — the only foreground legal on dangerFill
```

They are theme-invariant by design, like `support`/`onSupport` already is. Do **not** brighten the
Ember variants to `#22C55E`/`#EF4444`: white on those is 2.03:1 and 3.76:1 respectively, and ink on
them re-opens the "which polarity" question the palette spent a rewrite closing.

`support`, `onSupport`, `structure`, `onStructure` already exist and are already contrast-verified;
they need no change.

### Banned pairings (these become guard-test negatives)

| Pairing | Stub | Ember | Why it is here |
|---|---|---|---|
| `color` on `surfaceStrong` | **1.00:1** | 9.46:1 | The known failure class. On Stub `surfaceStrong` **is** `color` (`#211C16` both). Any "strong fill" reflex reaches for this token and vanishes. `surfaceStrong` is currently unreferenced anywhere in `apps/scanner` or `packages/ui-native` — keep it that way, or pair it only with `onStructure`. |
| `color` on `structure` | **1.00:1** | 6.97:1 | Same collapse, same cause (`structure` is ink on Stub). The REDIRECT family's foreground is `onStructure`, never `color`. |
| `#FFFFFF` on `support` | 2.15:1 | 2.15:1 | The documented worst defect in the app's history. ALREADY IN carries **ink**. |
| `colorMuted` on any tone fill | 1.04–1.15:1 | 2.95–3.25:1 | The reflex for "secondary line on the verdict". Forbidden — see the no-alpha rule below. |
| `onSuccessFill` at 70% alpha | 4.40:1 | 4.40:1 | Alpha-muting a foreground to make a hierarchy. Fails at 70% and it is not obvious. **No alpha foregrounds on tone fills, ever** — hierarchy comes from size and weight only. |
| `success`/`danger` as text on their own fill | 1.00:1 | 3.13:1 | The "tone-on-tone" trap. |
| `accent` as text | 3.57:1 | 5.42:1 | DS v2 §9. Use `accentText`. |

Full arithmetic: **§8**.

---

## 1. Screen anatomy

Three persistent regions and one transient full-bleed layer.

```
┌──────────────────────────────────────┐  ← safe-area top
│ TopBar   SCAN / <event name>         │  persistent
├──────────────────────────────────────┤
│ STATS STRIP  (§4)                    │  persistent, 36pt + hairline
├──────────────────────────────────────┤
│                                      │
│         CAMERA FRAME                 │  ← the RESULT STATE (§2) covers
│         + viewfinder                 │     this region AND the recent
│                                      │     strip, EDGE TO EDGE
├──────────────────────────────────────┤
│ RECENT (last scan + undo)            │  persistent between scans (FR-006c)
├──────────────────────────────────────┤
│ CONTROL RAIL  (§5)  — contextual     │  persistent, swaps content
└──────────────────────────────────────┘  ← safe-area bottom
```

**Edge-to-edge is load-bearing.** `ScreenSurface` wraps children in `YStack padding="$4"`
(`packages/ui-native/src/primitives.tsx:54`). The result state must render **outside** that padding —
as an absolutely-positioned sibling layer, or by restructuring the screen so the scan surface is not
inside the padded stack. A full-bleed verdict with a 16pt cream gutter around it is not full-bleed;
it is a big card, which is the thing this FR is replacing.

**The stats strip stays visible under the result state.** The count is the one number an operator is
asked for mid-shift, and hiding it behind a verdict means they cannot answer without dismissing.

**The camera stays hard-paused** (`active={false}`) for the whole life of a result state, exactly as
the current `cameraPaused` contract does (NFR-003, `unified-scan-screen.tsx:314`).

### Viewfinder sizing (small change, real benefit)

Today the viewfinder is a fixed `220×220` (`styles.ts:62-72`). Replace with
`clamp(200, 0.62 × cameraFrameWidth, 260)`:

| Device | frame width | 0.62 × w | applied |
|---|---|---|---|
| SE-class 375 | 343 | 213 | **213** |
| iPhone 15 Pro Max 430 | 398 | 247 | **247** |

Same optical proportion on every phone instead of a box that looks tight on an SE and lost on a Max.
It stays `pointerEvents="none"` and keeps its `FIXED` stroke colours.

---

## 2. Full-bleed result states (FR-003)

### 2.1 Common structure

Every outcome renders the same skeleton. Only tokens, glyph and copy change.

```
╔══════════════════════════════════════╗ ← tone fill, edge to edge, radius 0
║                                      ║   paddingHorizontal 24, paddingTop 24
║  [⌁ OFFLINE · LOCAL LIST 2 MIN OLD]  ║   ① provenance chip (offline only)
║                                      ║
║            ◯                         ║   ② hero glyph — 96pt
║            96pt                      ║
║                                      ║
║  ADMIT                               ║   ③ verdict word — 32/700 UPPERCASE
║  Marisol Delgado-Rivera               ║   ④ holder name — 24/700, NOT uppercase
║  GENERAL ADMISSION                   ║   ⑤ ticket type — 16/700 UPPERCASE, tracking 1
║  Code 8KQ2-7HTM                      ║   ⑥ code — 14/500 tabular-nums, tracking 1
║                                      ║
║  Refunded on 3 Aug — do not admit.   ║   ⑦ guidance — 16/400, ≤2 lines
║                                      ║
║                       ⌄ MORE  ⑧      ║   ⑧ below-fold affordance (only if detail exists)
║══════════════════════════════════════║   ⑨ express progress rule — 6pt, bottom edge
╚══════════════════════════════════════╝
    ↓ scroll ↓
┌──────────────────────────────────────┐ ← `surface`, NOT the tone fill
│ Also volunteering / same-order bulk  │   detail block: all small text lives
│ admit / already-scanned timestamp    │   here at 15–16:1
└──────────────────────────────────────┘
```

**Redundancy contract (NFR-002, non-negotiable).** Every state carries **five** independent
channels: fill colour · fill *lightness* · hero glyph · verdict WORD · status badge. Removing any one
must still leave the outcome unambiguous. The status badge row from today's card
(`unified-result-view.tsx:450-458`) moves into ⑤/⑥'s zone as a compact inverted chip; it is not
dropped.

**Type scale**, from `@th/ui`'s `fontSizeScale` (`packages/ui/src/ui/tamagui/index.ts:37`):

| Element | variant | px | weight | transform | notes |
|---|---|---|---|---|---|
| Hero glyph | — | **96** | `strokeWidth={3}` | — | see stroke note below |
| Verdict word | `h3` | **32** | 700 | UPPERCASE | max 2 lines; copy is capped at 12 chars so it fits one line at 375 |
| Holder name | `h4` | **24** | 700 | **`textTransform="none"`** | `h4` defaults to UPPERCASE — override it. Uppercasing a human name mangles `McDonald`, `de la Cruz`, `O'Brien`. `numberOfLines={2}`, ellipsize tail |
| Ticket type | `body` | **16** | 700 | UPPERCASE | `letterSpacing: 1`. VIP variant: 20px in an inverted chip (see 2.3) |
| Ticket code | `bodySmall` | **14** | 500 | — | tabular-nums, `letterSpacing: 1` |
| Guidance | `body` | **16** | 400 | — | ≤2 lines |
| Provenance chip | `caption` | **12** | 700 | UPPERCASE | `letterSpacing: 1.5` |
| Below-fold hint | `caption` | **12** | 700 | UPPERCASE | `letterSpacing: 1.5` |

**Hero-glyph stroke.** DS v2 §6 pins Lucide `strokeWidth: 2`. At 96px a 2px stroke is ~2% of the
glyph box versus ~9% at the 22px used in the current header (`unified-result-view.tsx:143`), so it
reads as a hairline outline rather than a symbol. Specify `strokeWidth={3}` **at the 96px hero size
only**. This is a scale compensation, not a new grammar: every other icon in the scan flow stays at 2.

**Vertical budget at SE-class** (375×667), verifying it fits without scrolling the verdict:

```
available = 667 − 20 status − 72 topbar block − 37 stats strip − 120 rail+safe-area
          = 418pt for the verdict block (camera region 396 + recent-strip region 56, minus overlap)

used = 24 pad + 24 chip + 12 + 96 glyph + 16 + 36 verdict + 8
     + 60 name(2 lines) + 4 + 20 type + 8 + 18 code + 12 + 44 guidance(2 lines) + 24 pad
     = 406pt
```

**12pt of slack in the worst case** (2-line name *and* 2-line guidance *and* an offline chip). If a
build measures negative slack on a specific device, the drop order is: guidance to 1 line → chip
to icon+age → glyph 96→80. Never shrink the verdict word or the name.

### 2.2 The eleven states

`✱` marks states that only exist on the offline path (FR-001).

| # | Outcome | Family | Fill / fg | Hero glyph | Verdict word | Status badge | Guidance copy | Below the fold |
|---|---|---|---|---|---|---|---|---|
| 1 | ticket **VALID** | ADMIT | `successFill` / `onSuccessFill` | `CheckCircle2` | **ADMIT** | `VALID` | *(none — the rail's ADMIT button is the copy)* | same-order bulk admit; `alsoVolunteering` |
| 2 | ticket **SCANNED** | ALREADY IN | `support` / `onSupport` | `CheckCheck` | **ALREADY IN** | `SCANNED` | "Scanned at 21:14 — already admitted." | `alsoVolunteering`; scan history if present |
| 3 | ticket **REFUNDED** | STOP | `dangerFill` / `onDangerFill` | `CircleDollarSign` | **REFUNDED** | `REFUNDED` | "Refunded — do not admit." | `alsoVolunteering` |
| 4 | ticket **VOID** | STOP | `dangerFill` / `onDangerFill` | `Ban` | **VOIDED** | `VOID` | "Voided — do not admit." | `alsoVolunteering` |
| 5 | ticket **LISTED** | STOP | `dangerFill` / `onDangerFill` | `Tag` | **LISTED** | `LISTED` | **"Listed for resale — do not admit."** (FR-008 verbatim) | `alsoVolunteering` |
| 6 | ticket **INVALID** | STOP | `dangerFill` / `onDangerFill` | `XCircle` | **INVALID** | `INVALID` | "This ticket is not valid for entry." | — |
| 7 | **wrong_event** | REDIRECT | `structure` / `onStructure` | `CalendarX2` | **WRONG SHOW** | `WRONG EVENT` | "This QR is for a different event. Switch events in Settings, or scan a pass for *\<event\>*." | — |
| 8 | **unknown** · `malformed` | STOP | `dangerFill` / `onDangerFill` | `HelpCircle` | **UNREADABLE** | `NOT RECOGNIZED` | "Couldn't read this QR. Try again, or use Search." | — |
| 8b | **unknown** · `ticket_not_found` | STOP | `dangerFill` / `onDangerFill` | `SearchX` | **NO MATCH** | `NOT FOUND` | "No ticket matches this code for this event." | — |
| 8c | **unknown** · `signature_failed` | STOP | `dangerFill` / `onDangerFill` | `ShieldAlert` | **TAMPERED** | `INVALID PASS` | "This volunteer pass is invalid or has been tampered with." | — |
| 9 | **volunteer** valid | ADMIT | `successFill` / `onSuccessFill` | `UserCheck` | **VOLUNTEER** | role label chip | "*\<Role\>* — *\<shift\>*." + `scanWindowNote` | other candidates; `alsoHoldsTicket` rows |
| 10 ✱ | **volunteer needs connection** | REDIRECT | `structure` / `onStructure` | `WifiOff` | **NEEDS SIGNAL** | `OFFLINE` | "Volunteer passes are verified on the server. Reconnect, or find them with Search." | — |
| 11 ✱ | **can't verify offline** | STOP | `dangerFill` / `onDangerFill` | `ShieldQuestion` | **CAN'T VERIFY** | `UNVERIFIED` | "This code isn't in the offline list. **That does not mean it's invalid** — reconnect or use Search before turning anyone away." | — |

Notes on the judgement calls in that table:

- **State 11 is red but is not state 6.** FR-001 assigns danger, and that is right — a code absent
  from a synced manifest is more likely bad than good, and the operator should hesitate. But it must
  never *claim* invalidity, so it gets its own glyph (`ShieldQuestion`, not `XCircle`), its own
  verdict word (**CAN'T VERIFY**, not **INVALID**), its own badge (`UNVERIFIED`) and copy that says
  the quiet part out loud. Three of the five channels differ from state 6. Colour alone does not
  carry a false accusation.
- **State 10 is REDIRECT, not STOP.** A volunteer JWT offline carries *zero* information about the
  person; it is a known capability gap with a clear next action. Painting it red trains the operator
  to distrust volunteers for a reason that is entirely ours.
- **State 7's REDIRECT tone splits it from state 2.** Today wrong-event and already-scanned share the
  `warning` tone *and* the warning haptic (`unified-scan-screen.tsx:119-130`) — in the dark they are
  the same event. FR-002 splits the haptic; this splits the pixels, in the same direction.
- **VIP call-out survives.** The `/vip|backstage|premium/i` regex
  (`unified-result-view.tsx:436-438`) still fires, but the treatment moves from `accentText` copy to
  an **inverted chip** (see 2.3) — accent-coloured text on a tone fill is unmeasurable and
  unnecessary.

### 2.3 The inverted chip

The only chrome allowed on a tone fill. Solid `on<Tone>Fill` plate, tone-fill-coloured label,
`radius: 0`, `paddingHorizontal: 8`, `paddingVertical: 4`. Because the pair is just the tone pair
reversed, its contrast is **identical** (7.13 / 7.87 / 6.97 / 6.47 — §8 group A). Uses: the VIP
badge, the escalated stale-manifest chip (§3), the status badge when it must out-shout the code.

Do not invent a second chip style. Outlined-on-fill (transparent plate, `on<Tone>Fill` 1px border +
label) is the resting style; inverted is the emphasis style. Two styles, no alphas.

### 2.4 Dismiss semantics — a deliberate deviation from FR-003

FR-003 says "tap anywhere on the state or the sticky button" dismisses. **Split that by outcome:**

| Outcome | Tap on the verdict block | Rail |
|---|---|---|
| VALID (manual mode) | **Does nothing** | `ADMIT` (primary) + `SKIP` (secondary) |
| VALID (express mode) | Press-and-hold pauses auto-dismiss (§6) | `UNDO` (secondary) — see §6 |
| Every other outcome | **Dismisses** and re-arms the camera | `DISMISS AND SCAN NEXT` (primary) |

Rationale: with tap-to-dismiss on a VALID state, the operator's single most practised gesture — tap
the screen, next person — silently *skips* an admission. The ticket is never marked, the count is
wrong, and nothing tells anyone. Terminal states have no such hazard: dismissing is the only thing
you can do with them, so make it the biggest possible target. This is one line of behaviour and it
is the difference between a fast door and a miscounted one.

The detail block below the fold is never a dismiss target (it holds its own buttons).

### 2.5 Accessibility

- Each state keeps and extends the existing `announceForAccessibility` on entry
  (`unified-result-view.tsx:157-215`). New announcements needed for states 10, 11 and for the
  offline provenance prefix: `"Offline result. Local manifest synced 2 minutes ago. Ticket valid.
  Holder Marisol Delgado-Rivera. General Admission."` — provenance **first**, because it qualifies
  everything after it.
- The verdict block is one `accessibilityRole="button"` node with a composed label when it is
  tappable (2.4), so a screen-reader user gets one swipe target, not seven.
- `accessibilityLiveRegion="polite"` on the state container; **not** `assertive` — assertive
  interrupts, and these states arrive every few seconds.
- Express auto-dismiss is suspended entirely while screen-reader focus is inside the state (NFR-002),
  and the state renders `AUTO-DISMISS PAUSED` in the ⑨ zone so a sighted operator handing the phone
  over understands why it stopped cycling.

---

## 3. Offline provenance badge (FR-001)

### Placement and form

Top of the verdict block (zone ①), **above** the hero glyph — it qualifies the entire verdict, so it
reads before it. Outlined-on-fill chip: transparent plate, 1px `on<Tone>Fill` border, `WifiOff` glyph
at 14px, label at 12/700 uppercase, `letterSpacing: 1.5`, `radius: 0`, `alignSelf: flex-start`.

It appears on **every** offline-resolved state, including wrong-event-resolved-locally and
"can't verify offline". A result with no chip is a server result. That invariant is the badge's whole
value: the operator never has to wonder which kind of answer they are looking at.

### Wording: relative, until relative stops meaning anything

| Manifest age | Label | Why |
|---|---|---|
| < 60 s | `OFFLINE · JUST SYNCED` | "0 min old" reads as broken |
| 1–59 min | `OFFLINE · 7 MIN OLD` | Relative; no arithmetic at a door |
| 60 min – 23 h | `OFFLINE · 3 HR OLD` | Still a duration a human reasons about |
| ≥ 24 h, or unknown | `OFFLINE · SYNCED AUG 4, 21:04` **as an inverted chip** | "31 hr old" is noise; the *date* is the decision — a manifest from yesterday is the wrong door |

Two extra rules:

- **>10 min on a VALID, with express mode on:** append `· CONFIRM MANUALLY`. This is the visible
  half of FR-004's 10-minute staleness gate; without it the operator just notices express "randomly
  stopped working".
- The chip escalates to the **inverted** style at ≥24h and only there. One escalation step, tied to
  one threshold, so it means something when it fires.

Age is computed from the manifest's `synced_at`, rendered in device-local time, and refreshed at
most once per second (the strip already ticks at 1 Hz — reuse that clock, do not add a timer).

Screen reader: the chip's `accessibilityLabel` is a sentence — `"Offline result. Local manifest
synced 7 minutes ago."` — not the visual string.

---

## 4. Stats strip (FR-005)

### Layout — one line, 36pt + hairline

```
375pt (SE):  |←16→|ADMITTED 128 / 450          [⚡] [⌁ OFFLINE 3] [⚠ 2 FAILED]|←16→|
430pt (Max): |←16→|ADMITTED 128 / 450                 [⚡] [⌁ OFFLINE 3] [⚠ 2 FAILED]|←16→|
```

Flex row, `alignItems: center`, `gap: 8`. Left block `flex: 1`, chips content-sized and right-aligned.
Height 36, `borderBottomWidth: StyleSheet.hairlineWidth`, fill `surface`.

**Width arithmetic at 375** (the only width where this can break):

| Element | width |
|---|---|
| horizontal padding | 32 |
| `ADMITTED 128 / 450` — 18 chars, 12px Montserrat 700, tracking 1.5 ≈ 8.2px/char | 148 |
| `⚡` express — icon-only, 12px glyph | 12 |
| `⌁ OFFLINE 3` chip — 11 chars ≈ 90 + icon 12 + gaps 6 + padding 16 | 124 |
| `⚠ 2 FAILED` chip — 10 chars ≈ 82 + icon 12 + gaps 6 + padding 16 | 116 |
| 3 inter-element gaps | 24 |
| **total worst case** | **456** vs 375 available — **overflows** |

So the strip needs a documented collapse order, not hope:

1. **Express is icon-only, always.** A `Zap` glyph with `accessibilityLabel="Express mode on"`. It is
   a mode indicator, not a metric. (−58pt vs a labelled chip.)
2. **Offline and queue are one chip.** They co-occur; `⌁ OFFLINE 3` says both. Never two chips.
3. **At most two labelled chips.** If a third condition is live, the lowest-priority labelled chip
   collapses to its icon plus a count. Priority, highest first: `FAILED` → `OFFLINE/QUEUE` →
   capacity. (`FAILED` outranks everything: it is the only one that means someone got in and the
   server does not know.)
4. **Under 340pt of remaining width the left block drops the word** `ADMITTED` and renders
   `128 / 450` with a `Users` glyph (−66pt).

With rules 1–2 applied the realistic worst case is `32 + 148 + 12 + 124 + 116 + 24 = 456`… still
over, so rule 3 fires and `OFFLINE 3` becomes `⌁ 3` (−74) → **382**, then rule 4 → **316 < 375**. ✅
Two collapse steps are reachable at SE with all three conditions live; that is the design, not an
accident, and it should be a rendering test at 320/375/430.

### Open question answered: **yes, mirror Home's capacity colours** — with two changes

| State | Strip fill | Rule (top hairline) | Left label |
|---|---|---|---|
| Normal | `surface` | `borderColorSoft` | `ADMITTED 128 / 450` |
| ≥ 90% | `supportTint` over `surface` | **`warningSoft`** | `NEAR CAPACITY 405 / 450` |
| ≥ 100% | `dangerTint` over `surface` | `danger` | `AT CAPACITY 450 / 450` |

Numerals stay `color` throughout (15.32:1 / 14.19:1 on the tints — §8 group D).

**Decision and justification.** Mirror Home. The operator is the audience; the attendee sees an
edge-on phone at 60cm in the dark, and designing the operator's capacity signal around that
hypothetical viewer costs a real user a real signal. More decisively: the app already teaches
90%/100% = amber/red on Home (`home-screen.tsx:60-63,355-362`). Inventing a second, neutral capacity
language on the surface where the operator *actually stands* would mean two vocabularies for one
fact — strictly worse than the attendee-perception risk it avoids.

Two deliberate deviations from Home:

- **No pulse.** Home pulses the capacity glyph (`home-screen.tsx:67-88`). On the scan screen a
  looping animation sits centimetres from the result states whose entire job is to be the thing that
  changed, and it competes. Static tint only. (This also removes one reduced-motion branch — §7.)
- **`warningSoft`, not `support`, for the 90% rule.** This is a real contrast fix, not a preference:
  `support` `#F59E0B` on Stub `surface` measures **2.06:1**, failing the 3:1 graphic floor. See §8
  group H1 — and note the same defect is **already shipped** on Home's near-capacity card border
  (1.75:1), progress fill (1.50:1) and alert glyph (1.75:1). Per the no-grandfathering rule, fix
  Home in the same pass; it is four token swaps.

### Behaviour

- Whole strip is one `Pressable` → opens the Home counter detail (FR-005). `accessibilityRole="button"`,
  `accessibilityHint="Opens the admitted counter and sync detail."`
- `accessibilityLiveRegion="polite"`, but **announce only on state changes** — capacity band flip,
  connectivity flip, failed-count increase. The count itself refreshes on the existing 5s
  `getEventCounts` interval (`home-screen.tsx:56`); announcing every tick would make the strip
  unusable with VoiceOver on.
- Counts use `font-variant-numeric: tabular-nums` so the number does not jitter its own width as it
  climbs.

---

## 5. One-handed control rail (FR-007)

### Default (camera armed)

```
375 × 667 — iPhone SE                     430 × 932 — iPhone 15 Pro Max
┌───────────────────────────────────┐     ┌──────────────────────────────────────────┐
│▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔│ 2px │▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔│
│ ┌────┐ ┌───────────────┐ ┌────┐   │     │ ┌────┐ ┌──────────────────────┐ ┌────┐   │
│ │ ⌨  │ │    SEARCH     │ │ ⚡ │   │     │ │ ⌨  │ │       SEARCH         │ │ ⚡ │   │
│ │52² │ │   flex: 1     │ │52² │   │     │ │52² │ │      flex: 1         │ │52² │   │
│ └────┘ └───────────────┘ └────┘   │     │ └────┘ └──────────────────────┘ └────┘   │
└───────────────────────────────────┘     └──────────────────────────────────────────┘
  16   52  12    215    12  52   16         16   52  12      270      12  52   16
```

| | SE 375 | Max 430 |
|---|---|---|
| rail padding (H) | 16 × 2 = 32 | 32 |
| keypad + torch | 52 × 2 = 104 | 104 |
| gaps | 12 × 2 = 24 | 24 |
| **SEARCH (flex)** | **215** | **270** |
| SEARCH label `SEARCH`, 16/700, tracking 1 ≈ 11.5px/char | 69 + 48 padding = 117 ≤ 215 ✅ | ✅ |

**The layout is width-invariant** — only the flex middle grows. That is the answer to "show both
widths": there is no second layout, no wrap, no reflow, and therefore nothing extra to test or break.
The rail's horizontal padding drops from `stickyFooter`'s current 20 to **16** to buy the SE 8pt.

**Order is a reach decision, not an aesthetic one.** For a right-handed one-handed grip the thumb arc
covers bottom-right most comfortably and bottom-left worst. So:

- **Torch → bottom-right.** Most-toggled control in a dark room.
- **Keypad → bottom-left.** Rarest (damaged QR only), hardest reach. Correct trade.
- **SEARCH → centre, flex.** Widest label, needs the flex slot anyway.

All three ≥ 44pt; the two icon buttons are **52 × 52** (matching today's `codeEntryButton`,
`unified-scan-screen.tsx:508-510`) so the rail has one button height. Icons at 20px, hit area is the
full 52² — no `hitSlop` compensation needed.

**Nothing interactive remains over the camera.** After this change the only things on the feed are
the `pointerEvents="none"` viewfinder and the `pointerEvents="none"` in-flight scrim. That is FR-007
satisfied literally.

### Contextual swaps

| Screen state | Rail contents |
|---|---|
| Camera armed | `⌨` · `SEARCH` · `⚡` (above) |
| Code entry | input (flex) + `GO` + `CANCEL` — as today (`unified-scan-screen.tsx:429-472`), but the input row gets `minHeight: 52` to match |
| Result: VALID, manual | `ADMIT` (primary, flex) + `SKIP` (secondary, content-sized) |
| Result: VALID, express | `UNDO` (secondary, full width) — see §6 |
| Result: any other | `DISMISS AND SCAN NEXT` (primary, full width) |

### The torch is now a themed control — a deliberate deviation from FR-007

FR-007 says "torch keeps its FIXED camera-chrome colours". **Do not do that.** The `FIXED` values
exist because the torch painted on the *camera feed*, which is black in both themes; the palette
docblock is explicit that a literal is judged "by the SURFACE IT PAINTS ON, never by the theme it
happens to sit inside" (`palette.ts:53-59`). Move the button to the rail and it paints on `surface`
— warm paper on Stub. Keeping `FIXED` there would be judging it by its history, which is precisely
the bug class the rule was written to prevent.

Themed torch, matching the keypad button's geometry exactly:

| State | Fill | Border | Glyph | Contrast (graphic floor 3:1) |
|---|---|---|---|---|
| OFF | `surface` | 2px `borderColor` | `FlashlightOff` `colorMuted` | border 3.49 / 16.22 · glyph 7.16 / 7.14 ✅ |
| ON | `surface` | 2px `accentText` | `Flashlight` `accentText` | 4.96 / 5.68 ✅ |

**It is icon-only, and that is load-bearing.** The first draft put the ON state on an `accentSoft`
plate with a label; `accentText` on `accentSoft` measures **4.05:1** on Ember — fine for a glyph
(3:1), a fail for a label (4.5:1). Dropping the plate and the label puts both channels comfortably
clear. Accessibility is unaffected: `accessibilityRole="switch"`, `accessibilityState={{checked}}`,
`accessibilityLabel="Flashlight"` — exactly what `torch-button.tsx:39-45` already does.

`FIXED.cameraScrim` / `cameraControlBorder` / `cameraControlMuted` become unused by the torch. Leave
them in the palette (the loading scrim and any future on-feed control need them) but the torch stops
importing `FIXED` entirely.

---

## 6. Express mode (FR-004)

### The state

A VALID scan with express on renders **state 1 (ADMIT)** unchanged — same fill, glyph, verdict word,
name, type — plus:

- **⑨ progress rule:** 6pt tall, full-bleed, pinned to the bottom edge of the verdict block, solid
  `onSuccessFill` (7.13:1 — well past the 3:1 graphic floor), animating width 100% → 0 over the dwell.
  Animate `width` with `useNativeDriver: false`. This is one view for 1.2s; the JS-driven-layout
  objection does not apply at that scale, and the `scaleX` alternative needs a transform-origin RN
  does not have.
- **Rail:** a single full-width `UNDO` secondary button for the whole dwell. The undo *strip* also
  stays mounted underneath (FR-004/FR-006c) — but at 1.2s the operator cannot realistically read a
  strip row, find the right one and hit it. The rail button is the express-mode undo; the strip is
  the 30-second one.
- **Persistent mode indicator:** the `⚡` glyph in the stats strip (§4), visible whenever express is
  enabled, not only during a result. A mode that admits people with zero taps must never be
  invisible. This is an addition to FR-004 and it should not be dropped for width.

### Dwell: **1.2s, fixed, not configurable** — plus a hold gesture

**Decision: keep 1.2s. Do not ship a 1s/2s preference.**

The reasoning, in the order it actually matters:

1. **1.2s is inside the only band that works.** Reading a short name is a fixation plus 1–2 saccades,
   ~500–700ms once attention is already on the screen. NFR-001 caps camera re-arm at 2s after a VALID
   scan, and re-arming `CameraView` costs roughly 300–500ms. 1.2s + re-arm ≈ 1.5–1.7s: inside the
   budget, above the reading floor. 1.0s leaves no margin over the reading floor on a long
   hyphenated name; 2.0s blows the NFR-001 budget once re-arm is added. The band is narrow enough
   that a preference is mostly a way to let an operator pick a wrong value.
2. **A per-device duration poisons the evidence.** Throughput complaints and "it admitted someone I
   wanted to stop" incidents both get investigated against a number. If that number is a per-device
   preference nobody remembers setting, every such investigation starts with an unknown.
3. **The real need behind "make it configurable" is "let me look at *this* one longer"** — which is a
   per-scan need, not a per-device setting. Solve it per-scan:

**Hold to hold.** Press and hold anywhere on the verdict block: the timer pauses, the progress rule
freezes, and the ⑨ zone reads `HOLDING — RELEASE TO CONTINUE`. On release the dwell **restarts from
full**, not resumes — an operator who held because they needed to read has just started reading, and
resuming with 200ms left would be a cruel joke. Zero settings, zero new preferences, and it answers
the actual question at the moment it is asked.

Revisit the fixed value only if the step-6 device pass produces evidence against it. That is a
measurement, not a settings screen.

### Halts (acceptance-criteria surface)

Express **never** auto-dismisses for: SCANNED, wrong_event, unknown (all three reasons), REFUNDED,
VOID, LISTED, volunteer (any), volunteer-needs-connection, can't-verify-offline, same-order bulk
admit, or an offline VALID from a manifest older than 10 minutes (which drops to manual confirm and
shows `· CONFIRM MANUALLY` on the provenance chip — §3). It is also suspended while screen-reader
focus is inside the state (§2.5) and while a hold is active.

---

## 7. Reduced motion (NFR-002)

`useReducedMotion` already exists (`apps/scanner/src/lib/use-reduced-motion.ts`) and Home already
consumes it correctly (`home-screen.tsx:66-88`). The contract for the scan screen:

| Element | Motion ON | Reduced motion | Notes |
|---|---|---|---|
| Result state entry | **No animation either way** | same | A tone fill that fades or slides in delays the one signal the operator is waiting for. It appears. FR-003's "no flash/strobe animation ever" is satisfied by there being no entry animation at all, in both modes. |
| Express progress rule | Width 100% → 0 over 1.2s | **Static full-width rule**, no animation; ⑨ reads `AUTO-ADMITTED · DISMISSING`; dwell unchanged at 1.2s | The countdown becomes a text state instead of a moving one. Timing is behaviour, not decoration — it does not change. |
| Hold-to-hold | rule freezes | rule already static; ⑨ swaps to `HOLDING — RELEASE TO CONTINUE` | Text carries it in both modes |
| Stats-strip capacity | **No pulse in either mode** (§4) | same | Removes Home's animation branch from this surface entirely |
| Home capacity glyph | existing pulse | existing static (`pulseAnim.setValue(1)`) | Unchanged — do not regress it while fixing the `support` contrast defect |
| Viewfinder lock | Existing instant stroke swap | same | Already motionless |
| Camera in-flight scrim | `ActivityIndicator` | `ActivityIndicator` | RN's platform spinner is exempt from reduced-motion by convention (it is a progress indicator, not decoration); leave it |
| Rail contextual swap | Instant | Instant | No cross-fade. A rail that fades between `SEARCH` and `ADMIT` is a rail you can tap during the fade |

The rule of thumb encoded above: **nothing in the scan flow animates to communicate**. The only
animation in the design is the express progress rule, and it has a full text equivalent.

---

## 8. Contrast proof (NFR-002)

Computed by script from the real token values in `packages/ui-native/src/palette.ts` (parsed out of
the file, not transcribed), WCAG 2.x relative-luminance, translucent tints composited over their
actual backdrop. **Both themes, every pair.**

`[VERIFIED: node contrast.mjs]` — script at
`/private/tmp/claude-501/.../scratchpad/contrast.mjs`; it should be ported into
`packages/ui-native/src/__tests__/` as the FR-003 guard test (the Button-AA-ladder pattern).

### Verdict

> **Zero failures among the pairings this design ships.** Two failures were found *during* the
> design and fixed by changing the design, not by lowering a floor. One pre-existing shipped defect
> was found as blast radius and must be fixed in the same pass.

| Finding | Status |
|---|---|
| `support` as a rule/border/fill-bar on Stub `surface` = **2.06:1** (needs 3:1) | **Fixed in design** → capacity-90% rule uses `warningSoft` (6.80 / 9.41) |
| `accentText` label on `accentSoft` on Ember = **4.05:1** (needs 4.5:1) | **Fixed in design** → torch ON is icon-only on `surface` (4.96 / 5.68 against the 3:1 graphic floor) |
| Home's near-capacity card border/bar/glyph on Stub = **1.75 / 1.50 / 1.75:1** | **Pre-existing, shipped.** Fix in the same pass per no-grandfathering: `support` → `warningSoft` at `home-screen.tsx` `counterCardWarning.borderColor`, `progressFillWarning.backgroundColor`, and the `AlertTriangle` colour at `:172` |
| `color` on `surfaceStrong` on Stub = **1.00:1** | **Not reached.** `surfaceStrong` is referenced nowhere in `apps/scanner` or `packages/ui-native` outside the palette declarations `[VERIFIED: grep -rn "surfaceStrong" apps/scanner/src packages/ui-native/src apps/mobile/src]`. Design avoids it; it stays a banned pairing in the guard test |

### A — Full-bleed tone fills (text floor 4.5:1)

| Pair | Theme | fg | bg | Ratio | Verdict |
|---|---|---|---|---|---|
| ADMIT — verdict word, name, 96px glyph | ember | `onSuccessFill` #FFFFFF | `successFill` #166534 | **7.13:1** | ✅ |
| ADMIT — verdict word, name, 96px glyph | stub | `onSuccessFill` #FFFFFF | `successFill` #166534 | **7.13:1** | ✅ |
| ALREADY IN — verdict word, name, glyph | ember | `onSupport` #0F1B33 | `support` #F59E0B | **7.98:1** | ✅ |
| ALREADY IN — verdict word, name, glyph | stub | `onSupport` #211C16 | `support` #F59E0B | **7.87:1** | ✅ |
| STOP — verdict word, name, glyph | ember | `onDangerFill` #FFFFFF | `dangerFill` #B91C1C | **6.47:1** | ✅ |
| STOP — verdict word, name, glyph | stub | `onDangerFill` #FFFFFF | `dangerFill` #B91C1C | **6.47:1** | ✅ |
| REDIRECT — verdict word, name, glyph | ember | `onStructure` #FFFFFF | `structure` #35589A | **6.97:1** | ✅ |
| REDIRECT — verdict word, name, glyph | stub | `onStructure` #FDFAF3 | `structure` #211C16 | **16.22:1** | ✅ |
| Inverted chip (VIP / stale manifest) on ADMIT | both | `successFill` | `onSuccessFill` | **7.13:1** | ✅ |
| Inverted chip on ALREADY IN | ember / stub | `support` | `onSupport` | **7.98 / 7.87:1** | ✅ |
| Inverted chip on STOP | both | `dangerFill` | `onDangerFill` | **6.47:1** | ✅ |
| Inverted chip on REDIRECT | ember / stub | `structure` | `onStructure` | **6.97 / 16.22:1** | ✅ |

### B — Banned pairings (guard-test negatives; every one of these must stay unreachable)

| Pair | Ember | Stub |
|---|---|---|
| `color` on `surfaceStrong` | 9.46:1 | **1.00:1** ❌ |
| `color` on `structure` | 6.97:1 | **1.00:1** ❌ |
| `#FFFFFF` on `support` | **2.15:1** ❌ | **2.15:1** ❌ |
| `#FFFFFF` on `accent` | **3.16:1** ❌ | **4.06:1** ❌ |
| `color` on `accent` | **3.16:1** ❌ | **4.17:1** ❌ |
| `accent` as text on `background` | 5.42:1 | **3.57:1** ❌ |
| `colorMuted` on `successFill` | **3.25:1** ❌ | **1.04:1** ❌ |
| `colorMuted` on `dangerFill` | **2.95:1** ❌ | **1.15:1** ❌ |
| `onSuccessFill` @ 70% alpha on `successFill` | **4.40:1** ❌ | **4.40:1** ❌ |
| `success` as text on `successFill` | **3.13:1** ❌ | **1.00:1** ❌ |

The alpha row is the one to internalise: 70% white on the green fill *looks* like a perfectly
reasonable secondary line and misses AA by 0.1. **No alpha foregrounds on tone fills.**

### C — Below-the-fold detail block (on `surface`)

| Pair | Ember | Stub | Floor |
|---|---|---|---|
| body copy `color` | 15.71:1 ✅ | 16.22:1 ✅ | 4.5 |
| secondary copy `colorMuted` | 7.16:1 ✅ | 7.14:1 ✅ | 4.5 |
| `success` glyph | 6.89:1 ✅ | 6.84:1 ✅ | 3.0 |
| `danger` glyph | 4.17:1 ✅ | 6.21:1 ✅ | 3.0 |
| `accent` glyph (warning tone) | 4.96:1 ✅ | 3.89:1 ✅ | 3.0 |
| `borderColor` structural edge | 3.49:1 ✅ | 16.22:1 ✅ | 3.0 |
| `accentText` control label | 4.96:1 ✅ | 5.68:1 ✅ | 4.5 |

### D — Stats strip

| Pair | Ember | Stub | Floor |
|---|---|---|---|
| counter `color` on `surface` | 15.71:1 ✅ | 16.22:1 ✅ | 4.5 |
| counter `color` on `supportTint` over `surface` (#282C3C / #FCF3E0) | 13.85:1 ✅ | 15.32:1 ✅ | 4.5 |
| counter `color` on `dangerTint` over `surface` (#272540 / #F8E8E2) | 14.74:1 ✅ | 14.19:1 ✅ | 4.5 |
| ~~`support` rule on `surface`~~ | 7.31:1 | **2.06:1 ❌** | 3.0 |
| **`warningSoft` rule on `surface`** (the fix) | **9.41:1 ✅** | **6.80:1 ✅** | 3.0 |
| `warningSoft` rule on the tinted strip | 8.30:1 ✅ | 6.43:1 ✅ | 3.0 |
| `danger` rule on `surface` | 4.17:1 ✅ | 6.21:1 ✅ | 3.0 |
| `colorMuted` chip label | 7.16:1 ✅ | 7.14:1 ✅ | 4.5 |
| `dangerSoft` FAILED label on `dangerTint` plate | 5.33:1 ✅ | 5.43:1 ✅ | 4.5 |
| `danger` FAILED chip border on `dangerTint` plate | 3.92:1 ✅ | 5.43:1 ✅ | 3.0 |
| `accentText` queue label on `accentTint` plate | 4.61:1 ✅ | 5.13:1 ✅ | 4.5 |
| `accentText` express `Zap` glyph on `surface` | 4.96:1 ✅ | 5.68:1 ✅ | 3.0 |

### E — Control rail

| Pair | Ember | Stub | Floor |
|---|---|---|---|
| `SEARCH` label `color` on `background` (secondary fill) | 17.14:1 ✅ | 14.89:1 ✅ | 4.5 |
| secondary border `borderColor` on `background` | 3.81:1 ✅ | 14.89:1 ✅ | 3.0 |
| keypad glyph `color` on `surface` | 15.71:1 ✅ | 16.22:1 ✅ | 3.0 |
| torch OFF glyph `colorMuted` on `surface` | 7.16:1 ✅ | 7.14:1 ✅ | 3.0 |
| torch OFF border `borderColor` on `surface` | 3.49:1 ✅ | 16.22:1 ✅ | 3.0 |
| ~~torch ON label `accentText` on `accentSoft`~~ | **4.05:1 ❌** | 4.98:1 | 4.5 |
| **torch ON glyph + border `accentText` on `surface`** (the fix) | **4.96:1 ✅** | **5.68:1 ✅** | 3.0 |
| `ADMIT` label `onCta` on `ctaFill` | 5.61:1 ✅ | 5.92:1 ✅ | 4.5 |

### F — Camera chrome (FIXED — unchanged, and must stay unchanged)

| Pair | Both themes | Floor |
|---|---|---|
| `viewfinderStroke` on `cameraBackdrop` | 21.00:1 ✅ | 3.0 |
| `viewfinderLocked` on `cameraBackdrop` | 6.64:1 ✅ | 3.0 |
| spinner on `cameraLoadingOverlay` over the feed | 21.00:1 ✅ | 3.0 |

### G — On-fill chrome (offline chip + express rule, every tone)

| Element | ADMIT | ALREADY IN | STOP | REDIRECT |
|---|---|---|---|---|
| offline chip border + label (4.5 floor) | 7.13 ✅ | 7.98 / 7.87 ✅ | 6.47 ✅ | 6.97 / 16.22 ✅ |
| express progress rule (3.0 floor) | 7.13 ✅ | 7.98 / 7.87 ✅ | 6.47 ✅ | 6.97 / 16.22 ✅ |

### H — Pre-existing Home defect (blast radius of the `support`-on-light finding)

| Site | Ember | Stub | Floor |
|---|---|---|---|
| `counterCardWarning.borderColor`: `support` on `surfaceRaised` | 6.80:1 | **1.75:1 ❌** | 3.0 |
| …as rendered, against the `supportTint` fill | 6.02:1 | **1.66:1 ❌** | 3.0 |
| `progressFillWarning`: `support` on `progressTrack` | 5.35:1 | **1.50:1 ❌** | 3.0 |
| `AlertTriangle` at `home-screen.tsx:172`: `support` on `surfaceRaised` | 6.80:1 | **1.75:1 ❌** | 3.0 |
| *control:* `counterCardDanger.borderColor`: `danger` | 3.88:1 ✅ | 5.26:1 ✅ | 3.0 |
| *control:* `progressFillDanger`: `danger` on `progressTrack` | 3.05:1 ✅ | 4.52:1 ✅ | 3.0 |
| **fix:** `warningSoft` at each of the four sites | 8.75–9.41:1 ✅ | 4.96–6.80:1 ✅ | 3.0 |

Only the **90%** band is broken, only on **Stub**, which is exactly why it shipped: it was measured
on Ember (where amber-on-navy is 6.8:1) and Stub became the default afterwards. `support` remains
correct as a **fill** carrying `onSupport` — the ALREADY IN state depends on it. The rule is:
**`support` is a fill, `warningSoft` is a rule/glyph/label.**

---

## 9. FR-009 residue (exact sites)

### 9a. What is already done — correct the spec's stale premise

`scan-ticket-redesign.spec.yaml:180-182` says "apps/scanner has no equivalent gate". **That is stale.**
The raw-hex gate exists and is green:

- `apps/scanner/eslint.config.mjs` — bans bare hex literals via `no-restricted-syntax`, with
  `eslint-color-permanents.mjs` listing the two legitimate exemptions (`src/ui/oauth-logos.tsx`,
  `app.config.ts`).
- `packages/ui-native/eslint.config.mjs` — the same rule travelling with the token layer.
- `[VERIFIED: pnpm -F scanner lint]` → exit 0, no output. `apps/scanner` has **zero** raw hex outside
  the permanents `[VERIFIED: grep -rnE "#[0-9a-fA-F]{3,8}" apps/scanner/src --include='*.ts*']` — 12
  hits total: 8 inside prose doc-comments (explaining *why* a value was retired) and 4 Google-brand
  `fill=` attributes in the exempted `src/ui/oauth-logos.tsx`. Zero `rgba()` literals
  `[VERIFIED: grep -rnE "rgba?\(" apps/scanner/src --include='*.ts*']`.

**Remaining FR-009 gate work is therefore only:** (a) confirm `pnpm lint` at the repo root actually
reaches both packages in CI (`.github/workflows/ci.yml:86` runs `pnpm lint`; verify by planting a
violation and observing red, per the gates-that-look-real doctrine), and (b) the residue sweep below.

### 9b. Raw tamagui layout primitives — `import { YStack } from "tamagui"`

`[VERIFIED: grep -rn "from \"tamagui\"" apps/scanner/src]` — three files, exhaustive:

| File | Import | Usage lines | Becomes |
|---|---|---|---|
| `src/screens/home-screen.tsx` | `:10` | `:94` root stack | **`ScreenSurface`** — it already is `View(screen) + GeometricBackground + YStack flex/padding $4/gap $4/zIndex 1` (`primitives.tsx:36-59`), i.e. byte-for-byte what `home-screen.tsx:91-94` hand-rolls |
| | | `:127`, `:222`, `:232`, `:267` | **`Column`** *(new, see 9d)* — plain gap stacks; `:267`'s `marginTop="auto"` maps to the primitive's `pin="bottom"` |
| `src/screens/access-denied-screen.tsx` | `:1` | `:20` | **`Column`** with `justify="center"`, `flex` |
| `src/screens/settings-screen.tsx` | `:19` | `:237`, `:283`, `:313`, `:329`, `:343`, `:356`, `:370`, `:378`, `:567` | **`Column`** ×9 |

No other file under `apps/scanner/src` imports tamagui. `packages/ui-native/src/primitives.tsx:11`
does — that is the DS layer wrapping tamagui and is **correct**; it is the boundary, not a violation.

### 9c. `import { Text } from "@th/ui"` — 18 sites

`[VERIFIED: grep -rn "from \"@th/ui\"" apps/scanner/src apps/scanner/App.tsx]`

**Scan-flow (in scope for FR-009, sweep in build-order step 3):**

| File | Line | Becomes |
|---|---|---|
| `src/screens/unified-scan-screen.tsx` | `:16` | `Text` from `@th/ui-native` |
| `src/screens/unified-result-view.tsx` | `:11` | `Text` from `@th/ui-native` |
| `src/screens/unified-search-screen.tsx` | `:16` | `Text` from `@th/ui-native` |
| `src/screens/recent-scans-strip.tsx` | `:5` | `Text` from `@th/ui-native` |
| `src/screens/home-screen.tsx` | `:12` | `Text` from `@th/ui-native` |
| `src/ui/event-selector.tsx` | `:12` | `Text` from `@th/ui-native` |
| `src/ui/network-banner.tsx` | `:4` | `Text` from `@th/ui-native` |
| `src/ui/app-shell.tsx` | `:12` | `Text` from `@th/ui-native` |

**Adjacent screens (same sweep, cheap — take them):**

| File | Line | Becomes |
|---|---|---|
| `src/screens/settings-screen.tsx` | `:21` | `Text` |
| `src/screens/access-denied-screen.tsx` | `:3` | `Text` + **`SquarePrimaryButton`/`SquareSecondaryButton`** (it imports `@th/ui`'s `Button`, the only such site) |
| `src/screens/passkey-enroll-prompt.tsx` | `:4` | `Text` |
| `src/screens/sign-in-screen.tsx` | `:15` | `Text`; **`PasswordInput` is a duplicate** — `@th/ui-native` already exports one (`primitives.tsx:442`). Use the native one and drop the web import |
| `src/scanner-app.tsx` | `:6` | `Text`; keep `Embers` (see below) |

**Out of scope (POS, not scan-flow) — list only, do not sweep in this FR:**
`src/features/pos/sell-tab-screen.tsx:21`, `scanner-terms-modal.tsx:20`, `sell-screen.tsx:35`,
`tap-to-pay-surface.tsx:44`, `dev-simulated-card-picker.tsx:16`.

**Legitimately stays `@th/ui`:** `Embers` in `src/ui/loading-state.tsx:3`, `src/scanner-app.tsx:6`,
`App.tsx:9` — it takes an app-supplied `iconSource`, which is exactly why `primitives.tsx:279-291`
argues it must not move into the package. And `IthasFireProvider` in `App.tsx:9`.

**Important correctness note for whoever does this sweep:** the current `@th/ui` `Text` usage is
**not broken today.** `App.tsx:179` binds `IthasFireProvider theme={name}` to the native theme, so
Tamagui's `$color`/`$colorMuted` and `useColors().color`/`.colorMuted` resolve to the same values.
This is hygiene (one import surface, one token vocabulary), not a bug fix — do not let a reviewer
be told otherwise, and do not "fix" it by changing the provider wiring.

### 9d. What must be ADDED to `@th/ui-native`

| New export | Why it does not exist yet | Shape |
|---|---|---|
| **`Text`** | Every screen reaches into `@th/ui` for it; the package itself re-imports it (`primitives.tsx:13`). Without a native `Text`, 9c has no target. | Thin wrapper over `@th/ui`'s `Text` that keeps the variant/weight API and maps `tone` to `useColors()` values, so `Text` and `useColors()` can never diverge. Do **not** fork the typography scale. |
| **`Column` / `Row`** | The only reason `tamagui` is imported into three screens. | `View` wrappers taking `gap` (number), `flex`, `align`, `justify`, `pad`, `pin="bottom"`. RN ≥0.71 supports `gap` natively — no tamagui needed. |
| **`ToneResultState`** | §2's full-bleed state. This is the FR-003 primitive. | `{ tone: ToneFamily, glyph: LucideIcon, verdict: string, name?, typeName?, code?, guidance?, provenance?, express?, onDismiss? }` + `children` for the below-fold `surface` panel. Owns the tone→fill/fg mapping so no screen can pick a wrong pair. |
| **`ToneFamily` type + `TONE_FILL` map** | `BadgeTone` (`primitives.tsx:297`) is `neutral\|success\|warning\|danger` — a *badge* vocabulary, and `warning` there maps to `accent`, which is **not** the ALREADY IN fill. Overloading it would silently produce an accent-filled verdict with no legal foreground. | New, separate: `"admit" \| "alreadyIn" \| "redirect" \| "stop"`. Keep `BadgeTone` for badges. |
| **`MetaChip`** | The outlined-on-fill / inverted chip pair (§2.3), and the stats-strip chips. | `{ label, glyph?, variant: "outlined" \| "inverted", on: ToneFamily \| "surface" }` |
| **`StatsStrip`** | §4. Shared with Home's counter detail. | Owns the collapse ladder so the width rules live in one place |
| **`successFill` / `onSuccessFill` / `dangerFill` / `onDangerFill`** | §0 | Both palettes, identical values |

`SquareCard`, `StatusBadge`, `SquarePrimaryButton`, `SquareSecondaryButton`, `TopBar`, `Panel`,
`ScreenSurface`, `EmailInput`/`PasswordInput`/`FieldInput`, `ModeCard`, `GeometricBackground` all
already exist and are reused as-is.

---

## 10. Copy inventory (FR-008 input, English-only)

The scanner has no i18n catalog and this spec does not add one (per the spec's open question).
FR-008's shared module must still be **structured** so keys can route through a catalog later:
export a `Record<StatusKey, { label, verdict, tone, guidance }>` of plain strings — never inline
literals at call sites, never string concatenation with data in the middle. Then "add i18n" is a
lookup swap, not a rewrite.

Two strings are dictated: **`"Listed for resale — do not admit."`** (FR-008) and the corrected
web-side `INVALID` label (today mislabelled "Voided" at `UnifiedScanView.tsx:1210-1214`).

Copy rules for the verdict word: ≤12 characters, one word where possible, imperative or state — never
a sentence, never punctuation. The full table is in §2.2.

---

## 11. Build checklist for the mobile agent

1. Palette: add the four tokens (§0). `palette.test.ts` will fail until both themes carry them.
2. Port `contrast.mjs` into `packages/ui-native/src/__tests__/tone-contrast.test.ts` — assert §8
   groups A/C/D/E/G pass their floors **and** that group B's banned pairs are still banned
   (a guard that only checks the good pairs does not stop anyone reintroducing a bad one).
3. Fix the four Home `support` → `warningSoft` sites (§8 H) — same pass, no grandfathering.
4. Add the §9d primitives, then sweep §9b/§9c.
5. Build `ToneResultState`, then rewire `unified-result-view.tsx` onto it.
6. Stats strip, then control rail.
7. Express mode last (it depends on the state and the rail).
8. Render-test the strip at 320 / 375 / 430 and the result state at 375 with the worst-case content
   (2-line name + 2-line guidance + offline chip).
9. Step-6 device pass: dark room, both themes, airplane mode, VoiceOver on, reduced motion on.

---

## 12. Deviations from the spec, in one place

Three, each argued above. A reviewer should either accept them or push back on them explicitly;
they should not be discovered in a diff.

| # | Spec text | This design | §  |
|---|---|---|---|
| 1 | FR-003: "Dismiss remains explicit (tap anywhere on the state or the sticky button)" | Tap-anywhere dismisses **every outcome except VALID-in-manual-mode**, where it would silently skip an admission | 2.4 |
| 2 | FR-007: "Torch keeps its FIXED camera-chrome colours" | Torch becomes **themed** once it leaves the camera feed, per the palette's own judge-by-surface rule; `FIXED` stays reserved for things that still paint on the feed | 5 |
| 3 | FR-005 open question leans "mirror Home's alert colours" | Mirrors them, but **without Home's pulse** and with `warningSoft` instead of `support` (a contrast fix that Home also needs) | 4, 8H |

---

## Appendix A — the contrast script (verbatim, port this)

Run as-is with `node`. It parses the real token values out of `packages/ui-native/src/palette.ts`
rather than taking transcribed copies, so it cannot silently drift from the palette. Every number in
§8 came out of this. Port the `check()` core plus the group A/B/C/D/E/G assertions into
`packages/ui-native/src/__tests__/tone-contrast.test.ts`.

```js
/**
 * WCAG 2.x contrast computer for the scan-screen design spec.
 * Reads REAL token values out of packages/ui-native/src/palette.ts by regex so
 * the numbers cannot drift from the palette by transcription error.
 */
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  "/Users/somehuman/Projects/TicketHunter/packages/ui-native/src/palette.ts",
  "utf8",
);

/** Extract a `export const <name> = { ... } as const;` block into a map. */
function block(name) {
  const start = SRC.indexOf(`export const ${name} = {`);
  if (start < 0) throw new Error(`no block ${name}`);
  const end = SRC.indexOf("} as const;", start);
  const body = SRC.slice(start, end);
  const out = {};
  for (const m of body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*"([^"]+)"/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

const FIXED = block("FIXED");
const ember = block("emberPalette");
const stub = block("stubPalette");

const hex = (h) => {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const rgba = (v) => {
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return [...hex(v), 1];
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};
/** Composite a possibly-translucent colour over an opaque backdrop. */
const over = (fg, bg) => {
  const [r, g, b, a] = rgba(fg);
  const [br, bgc, bb] = hex(bg);
  return [
    Math.round(r * a + br * (1 - a)),
    Math.round(g * a + bgc * (1 - a)),
    Math.round(b * a + bb * (1 - a)),
  ];
};
const toHex = (rgb) =>
  "#" + rgb.map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("");
const lum = ([r, g, b]) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

// ── Proposed NEW tone-fill tokens (identical in both themes) ────────────────
// Deep fills so the on-fill foreground can be a single value per theme and so a
// dark venue is not flash-banged by a full-bleed bright panel.
const PROPOSED = {
  ember: {
    successFill: "#166534", onSuccessFill: "#FFFFFF",
    dangerFill: "#B91C1C", onDangerFill: "#FFFFFF",
  },
  stub: {
    successFill: "#166534", onSuccessFill: "#FFFFFF",
    dangerFill: "#B91C1C", onDangerFill: "#FFFFFF",
  },
};

const P = {
  ember: { ...ember, ...PROPOSED.ember },
  stub: { ...stub, ...PROPOSED.stub },
};

const rows = [];
/** fg/bg are token names, or literal "#..." / "rgba(...)". bgBase composites translucent bgs. */
function check(group, label, fgTok, bgTok, floor, note = "", bgBaseTok = null) {
  for (const theme of ["ember", "stub"]) {
    const pal = P[theme];
    const res = (t) => (t.startsWith("#") || t.startsWith("rgb") ? t : pal[t] ?? FIXED[t]);
    const fgRaw = res(fgTok);
    const bgRaw = res(bgTok);
    if (!fgRaw || !bgRaw) throw new Error(`missing token ${fgTok}/${bgTok} (${theme})`);
    const bgBase = bgBaseTok ? res(bgBaseTok) : null;
    const bgRgb = bgBase ? over(bgRaw, bgBase) : hex(bgRaw);
    const fgRgb = /rgba?\(/.test(fgRaw) ? over(fgRaw, toHex(bgRgb)) : hex(fgRaw);
    const r = ratio(fgRgb, bgRgb);
    rows.push({
      group, theme, label,
      fg: `${fgTok} ${toHex(fgRgb)}`,
      bg: `${bgTok} ${toHex(bgRgb)}`,
      ratio: r, floor,
      pass: r >= floor,
      note,
    });
  }
}


// … then the check() calls for groups A–H exactly as tabulated in §8, e.g.:
check("A tone fills", "ADMIT — verdict word + 96px glyph", "onSuccessFill", "successFill", 4.5);
check("B banned",     "color on surfaceStrong (1.00:1 on Stub)", "color", "surfaceStrong", 4.5, "BANNED");
check("D stats strip","capacity-90% rule", "warningSoft", "supportTint", 3.0, "", "surface");
```

**Guard-test contract:** group A/C/D/E/G pairs must PASS their floor in BOTH themes; group B pairs
must FAIL in at least one theme (they are negatives — a guard that only checks the good pairs does
not prevent anyone from reintroducing a bad one).
