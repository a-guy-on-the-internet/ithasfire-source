/**
 * COLOR RULES — the SHORT list of files in `apps/scanner` allowed to keep a raw hex literal.
 *
 * ## This is NOT a debt grandfather list
 *
 * Every literal that was *debt* (a hex inlined into a screen that the palette module already
 * covers, or trivially could) was migrated off before the rule was switched on — see
 * `src/ui/palette.ts`, which gained `splashBackground` / `splashTint` / `googleBrand` /
 * `appleBrand` / `shadow` / `signInGridLine` in the same change. This file lists ONLY the places
 * where a raw literal is genuinely *correct*, and each entry states why.
 *
 * Note what is deliberately NOT here: `src/screens/sign-in-screen.tsx`. It carried the Google
 * and Apple button fills, which ARE vendor-fixed — but exempting a whole screen to license two
 * values would permanently un-gate the largest screen in the app, including every future literal
 * anyone adds to it. Vendor colours are still colours, and the palette is the sanctioned home for
 * raw hex, so they became `FIXED.googleBrand` / `FIXED.appleBrand` instead and the screen stays
 * fully gated. Prefer that move to a file exemption every time.
 *
 * Before adding anything here, re-read `docs/design/design-system-v2.md` §2 and check the palette
 * module doesn't already cover the value — and that adding a token to it wouldn't.
 *
 * ## Why each one is legitimate
 *
 *   - `src/ui/oauth-logos.tsx` — the Google "G" mark's four brand fills (#4285F4 blue, #34A853
 *     green, #FBBC05 yellow, #EA4335 red). These are dictated by Google's sign-in branding
 *     guidelines: the mark must be reproduced in its exact brand colours, unmodified. They are
 *     theme-independent by contract, not by coincidence — we are not permitted to restyle them
 *     for the dark surface even if we wanted to. The Apple mark in the same file is monochrome
 *     and takes our tint, so it is NOT exempt-worthy — the CALLER supplies its colour and it
 *     has NO palette default, deliberately: defaulting it to a theme token made it ink on Stub
 *     and therefore invisible on the vendor-black Apple button. Callers pass
 *     `FIXED.onVendorBrand`. The Google fills are the only literals this entry licenses.
 *
 *   - `app.config.ts` — Expo native config (`splash.backgroundColor`,
 *     `android.adaptiveIcon.backgroundColor`). This file is evaluated by the Expo CLI / EAS
 *     during native prebuild, outside the React Native runtime, and its output is baked into
 *     `Info.plist` / Android resource XML. The values must be inert literals at config-resolution
 *     time; a native splash cannot reference a JS palette at runtime because it paints *before*
 *     any JS exists. (These two are mirrored by `FIXED.splashBackground` for the JS splash, and
 *     both sides carry a sync warning comment — that coupling is manual and intentional.)
 */
export const colorPermanents = ["src/ui/oauth-logos.tsx", "app.config.ts"];
