import { StyleSheet } from "react-native";

import { FIXED, palettes, type NativePalette } from "./palette";

/**
 * The scanner's single StyleSheet, built once per theme.
 *
 * ## Why a factory
 *
 * `StyleSheet.create` resolves its values at call time, so a module-level sheet
 * can never be theme-reactive. Rather than rebuild sheets on every render (which
 * would churn the native style registry), we build BOTH themes' sheets once at
 * module load and hand components the right one via `useStyles()`. Two themes ×
 * one sheet is a fixed, trivial cost paid at startup.
 *
 * ## Why one sheet and not two
 *
 * This file replaces the former `styles.ts` (`sharedStyles`) *and*
 * `unified-styles.ts` (`unifiedStyles`), which had diverged into two parallel
 * design systems: `cameraFrame` and `viewfinder` were byte-identical in both,
 * `input`/`searchInput` differed only in height and fill, and
 * `unified-search-screen.tsx` imported from both at once. Two sources of truth
 * for "what a card looks like" is the opposite of a design system.
 *
 * ## Design System v2 contract (docs/design/design-system-v2.md)
 *
 *   - **`radius: 0` for CONTENT** — cards, buttons, inputs, badges. Locked.
 *   - **Soft chrome for the FRAME** — the bottom nav, floating camera controls
 *     and the event chip are the frame around the content, not the content, so
 *     they get pills (`radius: 999`) and hairline low-alpha borders. See §4
 *     "Content = strict Swiss · Chrome = soft chrome".
 *   - **Gap, never margins, between siblings.**
 *   - Thick visible borders on content; no shadows.
 *   - 16px minimum body text; ≥44px tap targets, list rows ≥56px.
 *
 * ## Status tones
 *
 * Status states are distinguished by colour AND icon AND text — never colour
 * alone. Badges and tone cards are OUTLINED: the tone applies to the BORDER
 * only, the fill stays `surface` and the label stays `color`. That keeps every
 * status label at full contrast and reserves filled accent for the one primary
 * CTA per viewport.
 */
const makeStyles = (c: NativePalette) =>
  StyleSheet.create({
    // ── Screen scaffolding ────────────────────────────────────────────────
    screen: {
      flex: 1,
      backgroundColor: c.background,
    },

    // ── Camera (FIXED dark — the video feed is black in every theme) ───────
    cameraFrame: {
      flex: 1,
      minHeight: 320,
      overflow: "hidden",
      borderRadius: 0,
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: FIXED.cameraBackdrop,
    },
    viewfinder: {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: 220,
      height: 220,
      marginLeft: -110,
      marginTop: -110,
      borderWidth: 2,
      borderColor: FIXED.viewfinderStroke,
    },
    /** Locked / paused — orange stroke, 6.64:1 on the black feed. */
    viewfinderLocked: {
      borderColor: FIXED.viewfinderLocked,
    },
    /** Scrim over the camera while a scan resolves. */
    cameraLoadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: FIXED.cameraLoadingOverlay,
    },

    // ── Cards / panels (CONTENT — strict Swiss) ────────────────────────────
    card: {
      borderWidth: 2,
      borderColor: c.borderColor,
      borderRadius: 0,
      padding: 20,
      backgroundColor: c.surface,
      gap: 12,
    },
    cardMuted: {
      borderWidth: 1,
      borderColor: c.borderColor,
      borderRadius: 0,
      padding: 16,
      backgroundColor: c.surfaceRaised,
      gap: 8,
    },
    // Tone variants layer on top of `card` — border only.
    cardSuccess: { borderColor: c.success, borderWidth: 2 },
    cardWarning: { borderColor: c.accent, borderWidth: 2 },
    cardDanger: { borderColor: c.danger, borderWidth: 2 },

    divider: {
      height: 1,
      backgroundColor: c.borderColorSoft,
      marginVertical: 12,
    },
    /** Hairline between adjacent list rows. */
    rowSeparator: {
      height: 1,
      backgroundColor: c.borderColorSoft,
    },
    /** Translucent tint for the active row in a list / event selector. */
    activeRow: {
      backgroundColor: c.activeRowTint,
    },

    // ── Status badges (outlined, always paired with an icon) ───────────────
    badge: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderWidth: 1,
      borderColor: c.borderColor,
      borderRadius: 0,
      backgroundColor: c.surface,
    },
    badgeSuccess: { borderColor: c.success },
    badgeWarning: { borderColor: c.accent },
    badgeDanger: { borderColor: c.danger },
    badgeNeutral: { borderColor: c.borderColor },

    // ── Buttons (CONTENT — strict Swiss, hard colour inversion on press) ───
    /**
     * Primary CTA. Fill is `ctaFill`, label is `onCta` — the pair is AA in both
     * themes (Ember ink-on-#FF5721 5.61:1; Stub white-on-#B93312 5.92:1).
     * Stub deliberately rests one rung DOWN the orange ladder because white on
     * #E2481D is 4.06:1 and fails. See the palette docblock.
     */
    primaryButton: {
      minHeight: 52,
      minWidth: 44,
      paddingHorizontal: 24,
      paddingVertical: 14,
      backgroundColor: c.ctaFill,
      borderWidth: 2,
      borderColor: c.ctaFill,
      borderRadius: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    /** Press inverts to the surface; the label moves to `accentText`. */
    primaryButtonPressed: {
      backgroundColor: c.surface,
    },
    /**
     * Locked-primary — the primary action is gated by role/permission. Keeps
     * the orange border so the operator still reads "this is THE primary
     * action, currently locked", and mutes only the fill + label. Distinct
     * from `buttonDisabled`, which means "not relevant in this context".
     */
    primaryButtonLocked: {
      backgroundColor: c.surface,
      borderColor: c.ctaFillLocked,
      opacity: 0.85,
    },
    /**
     * Secondary CTA — neutral outlined.
     *
     * The border is `borderColor` (3.81:1 Ember / 14.89:1 Stub — clears the
     * WCAG 1.4.11 3:1 non-text floor) and the label is `color` (17.14:1 /
     * 14.89:1). This replaces a steel-blue-on-navy treatment that measured
     * **2.46:1 for both the border and the label** — a fail on both floors, on
     * every secondary button in the app.
     *
     * It is deliberately NOT accent-outlined: DS v2 allows one primary button
     * per viewport, and two orange buttons side by side is exactly the
     * "if two actions compete, one is secondary — decide" failure.
     */
    secondaryButton: {
      minHeight: 52,
      minWidth: 44,
      paddingHorizontal: 24,
      paddingVertical: 14,
      backgroundColor: c.background,
      borderWidth: 2,
      borderColor: c.borderColor,
      borderRadius: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    /** Press fills with `structure`; the label moves to `onStructure` (6.97:1 / 16.22:1). */
    secondaryButtonPressed: {
      backgroundColor: c.structure,
      borderColor: c.structure,
    },
    /** List-row variant — the Ithas Fire lists rule is ≥56px. */
    listRowButton: {
      minHeight: 56,
    },
    buttonDisabled: {
      backgroundColor: c.surfaceMuted,
      borderColor: c.borderColorSoft,
    },
    /** 44×44 square icon button (back arrow, inline actions). */
    iconButton: {
      width: 44,
      height: 44,
      borderRadius: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderColor,
    },

    // ── Inputs ────────────────────────────────────────────────────────────
    /** fontSize ≥16 prevents iOS auto-zoom on focus. */
    input: {
      minHeight: 52,
      borderWidth: 2,
      borderColor: c.borderColor,
      borderRadius: 0,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      color: c.color,
      backgroundColor: c.surface,
    },
    inputFocused: {
      borderColor: c.accent,
    },

    // ── Mode cards (home-screen mode selection) ───────────────────────────
    modeCard: {
      borderWidth: 2,
      borderColor: c.borderColor,
      borderRadius: 0,
      padding: 20,
      backgroundColor: c.surface,
    },
    modeIcon: {
      width: 48,
      height: 48,
      borderRadius: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.accentTint,
    },

    // ── Layout ────────────────────────────────────────────────────────────
    stickyFooter: {
      borderTopWidth: 2,
      borderTopColor: c.borderColor,
      backgroundColor: c.surface,
      paddingHorizontal: 20,
      paddingTop: 16,
      paddingBottom: 16,
      gap: 12,
    },
    emptyState: {
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      paddingVertical: 28,
    },
    progressTrack: {
      height: 6,
      backgroundColor: c.progressTrack,
      borderRadius: 0,
      overflow: "hidden",
    },
    modalScrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: c.modalScrim,
    },

    // ══════════════════════════════════════════════════════════════════════
    // CHROME — the frame, not the content. Soft: pills, hairlines, no 2px
    // structural borders. DS v2 §4.
    // ══════════════════════════════════════════════════════════════════════

    /** Header strip — structural fill, carries `onStructure` labels. */
    header: {
      backgroundColor: c.structure,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    /** Status-bar area above the header — same fill, no seam. */
    statusBarArea: {
      backgroundColor: c.structure,
    },
    /** 24×2 accent tick in the header lockup (decorative, non-text). */
    headerAccentRule: {
      width: 24,
      height: 2,
      backgroundColor: c.accent,
    },

    navBar: {
      backgroundColor: c.background,
    },
    /** Hairline, not a 2px structural rule — the nav is chrome. */
    navBorder: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.borderColorSoft,
    },
    navItems: {
      flexDirection: "row",
      justifyContent: "space-around",
      paddingTop: 6,
    },
    navItem: {
      flex: 1,
      alignItems: "center",
    },
    navTouchable: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 8,
      paddingHorizontal: 10,
      minHeight: 44,
      minWidth: 44,
      borderRadius: 999,
    },
    /** Active tab reads as a soft chrome pill, not a hard Swiss tab. */
    navTouchableActive: {
      backgroundColor: c.accentSoft,
    },
    navTouchablePressed: {
      opacity: 0.6,
    },

    /** Floating camera-overlay control — pill, hairline, fixed dark. */
    cameraControl: {
      position: "absolute",
      top: 12,
      right: 12,
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: FIXED.cameraScrim,
      borderWidth: 1,
      borderColor: FIXED.cameraControlBorder,
      borderRadius: 999,
    },

    /** Chrome chip (event selector, filters) — pill, hairline. */
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 36,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.borderColorSoft,
      backgroundColor: c.surface,
    },
    chipActive: {
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },

    /**
     * Full-width status banner (connectivity, platform-admin). Outlined-tone
     * pattern: tone lives on the left rule + the label, the fill stays a
     * theme surface. Callers add the tone.
     */
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: c.surface,
      borderLeftWidth: 4,
      borderLeftColor: c.borderColor,
    },
    bannerSupport: { borderLeftColor: c.support },
    bannerDanger: { borderLeftColor: c.danger },
  });

export type NativeStyles = ReturnType<typeof makeStyles>;

/**
 * Both themes' sheets, built once at module load. `useStyles()` (see
 * `./theme.tsx`) selects by the active theme name.
 */
export const SHEETS: Record<keyof typeof palettes, NativeStyles> = {
  ember: makeStyles(palettes.ember),
  stub: makeStyles(palettes.stub),
};
