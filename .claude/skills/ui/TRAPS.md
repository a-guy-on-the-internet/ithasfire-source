# UI traps

Defects this codebase has already shipped or nearly shipped. Each one passes typecheck and unit tests; most only show in the running app. Read the section for the layer you are touching before writing code, and again before review.

## Tamagui

- **Fractional space tokens are zero.** The space scale has integer tokens only (`$0`–`$8`); `$1.5`, `$2.5` and friends silently resolve to no gap or padding.
- **`$sm` overrides `$xs`** (media declaration order), so a narrower `$xs` rung is dead code. Express phone-first styles as the base and widen with `$gtSm` / `$gtMd`.
- **A flex item whose `maxWidth` lives only under `$gtMd`** sizes to max-content at small widths and pushes controls off screen. Give it a base `maxWidth` or `minWidth: 0`.
- **`maxWidth: "100%"` inside a `flexShrink: 0` auto-basis parent is circular**: the cap resolves against a width the child sets. Only `contain: inline-size` on the parent breaks the loop.
- **Transforms are emitted as inline style**, so `:focus-visible` or other pseudo-class rules can never override them. Move state-dependent elements with `top`/`left`.
- **A prop-level `hoverStyle={{}}` merges** with the styled component's base hoverStyle instead of replacing it. Turn interaction styling off with a variant.

## @th/ui components

- **Every `@th/ui` component that uses client hooks declares `"use client"` itself**; `optimizePackageImports` breaks the parent's boundary.
- **`styled(Button)` over the DS Button** breaks string-child wrapping ("Unexpected text node in <View>"). Compose with props.
- **Avatar's `frameSize` spells out all six box props on purpose**; collapsing them to width/height renders every avatar at 14×14.
- **Popover `contentProps.style`** once wiped floating-ui positioning; the merge order is fixed, so keep caller styles in `contentProps.style` and never spread over the component's own style.
- **Hand-rolled `@th/ui` Button mocks** in web tests drop `aria-*` and mis-map `disabled`; assertions against them read null. Use the shared test setup.

## Layout and layering

- **`overflow: hidden` makes a scroll container**: `scrollIntoView` scrolls it, parking a popover at a negative offset inside a bar. Clip with `overflow: clip` or move the popover to a portal.
- **The `zIndexTokens` 1300–1600 scale is near-dead.** Body-portalled overlays use a literal `10000` and page chrome reaches `9999`; read the actual values in the components that compete, and ties need `>=`.
- **Body scroll lock can't be tested with `scrollBy()`**: `overflow: hidden` still permits programmatic scrolling. Press a real key (PageDown, Space).
- **Page `ViewTransition`** replays per navigation and React de-dups explicit names, so it stays on public surfaces and is targeted by class.

## Data and copy

- **tRPC `useInfiniteQuery` adds a top-level `direction` key**; a `.strict()` list input must allow it or every infinite query 400s.
- **Web i18n resolves from two merged catalogs** with no locale fallback: a missing key renders the raw key. `packages/locale/messages/*.json` are read-only (owner WIP); add new web keys to `apps/web/src/i18n/messages/en.ts` and `es.ts`, additions only (`catalog-parity.test.ts` checks en/es parity). Never reference a key that is in neither catalog.
- **`formatErrorMessage(err)` without the translator `t`** renders "Something went wrong".
- **`@th/ui-email` resolves from `dist/`**: after changing a template, `pnpm -F @th/ui-email build`, or real sends fail with `template_not_found` while `email:export` passes.

## Verifying in the browser

- **Use `http://localhost:3000`, never `127.0.0.1`**: on 127.0.0.1 Next 403s every chunk, React never boots, and the dead HTML looks console-clean and hydration-clean.
- **React 19 hydration mismatches skip `console.error`**, and the e2e ignore list once swallowed real failures. Assert a React fiber exists on the root and check the hydration error overlay, not just the console.
- **Below 500px use `emulate`**, and measure overflow as `documentElement.scrollWidth > documentElement.clientWidth`; `window.innerWidth` grows with overflowing content.
- **Compare the render to the board, not just the measurements.** A "does it fit" check passed a page that matched the layout and none of the treatment. Put the screenshot beside the board and check alignment, type, colour and spacing.
- **Dev-server slowness is Turbopack native memory** (~160MB per compiled route, never evicted). Restart the web dev server before blaming the page.
