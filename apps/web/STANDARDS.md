# Web App Standards (Draft)

> **Status:** outline for discussion

## Goals

- Keep Next.js code predictable, testable, and consistent with the rest of Ithas Fire’s architecture.
- Make it easy to share UI primitives while isolating web-only concerns (routing, SEO, streaming).

## 1. Folder Structure & Naming

````text
apps/web/src/
  app/
    layout.tsx            // root layout – sets metadata, fonts, providers
    providers.tsx         // wraps IthasFireProvider, Tamagui theme, reanimated bridge
    (marketing)/...
    (dashboard)/...
    events/
      page.tsx
      _components/        // client-only islands shared by files in the route tree
    places/
      page.tsx
      _components/
    ...
  lib/
    server/               // server-only helpers (marked with `server-only`)
    client/               // browser-only helpers/hooks
  features/               // co-locate UI + hooks for complex flows
  trpc.ts                 // createTRPCReact<AppRouter>
```text

- Use route groups `(dashboard)`, `(marketing)` to separate domains.
- Within a route folder, put interactive/client code in `_components/` and keep `page.tsx`, `layout.tsx`, etc. as light server shells that just import the client islands. Shared logic that’s reused across multiple routes graduates to `src/features/<domain>` or `packages/ui`.
- Each route folder gets `page.tsx`, optional `layout.tsx`, `loading.tsx`, `error.tsx`, and child components.
- Shared UI stays in `packages/ui`; only web-specific wrappers live here.
- File names kebab-case; components PascalCase.

## 2. Server vs Client Components

- Default to **server components** (`export default async function Page() { ... }`). Fetch data on the server via tRPC server helpers or direct `fetch` to internal APIs.
- Opt into `'use client'` only for interaction or browser APIs. Client components receive data via props or typed hooks (`trpc.xyz.useQuery`).
- Keep side effects inside `useEffect`. Do not call `window`/`document` in server components.
- Mark server-only utilities with `import "server-only";` to avoid accidental bundling.

## 3. Data Fetching & Mutations

- Use `@th/trpc` types: create a `caller` in server components, `trpcClient` hooks in client islands.
- Avoid raw Prisma or adapter calls; all business logic lives in core use cases.
- For SEO/structured data, fetch the same data shape used for rendering (no undocumented fields).
- Mutations run from client components via `trpc.xyz.useMutation`. Handle optimistic updates case-by-case.
- Cache management: rely on React Query invalidation via `trpc.useContext()`. Configure `staleTime`, `retry`, etc., explicitly.

## 4. SEO & Metadata

- Use Next.js App Router **Metadata API** when possible (`export const generateMetadata`).
- Structured data components (`SeoJsonLd`) live in `apps/web` under `src/app/seo/` to keep HTML-specific output here.
- Share reusable builders (`buildEventJsonLd`) as pure helpers in `packages/types` or `packages/core`.
- Ensure `<link rel="canonical">`, OpenGraph tags, and Twitter cards match marketing requirements.
- Keep metadata generation deterministic; avoid random IDs client-side.

## 5. Styling & Theming

- Compose UI from `@th/ui` Tamagui primitives. Do not write raw CSS unless wrapping third-party widgets.
- Global CSS limited to resets and root-level tokens (`src/app/globals.css`).
- Dark/light theming flows through `IthasFireProvider`; respect system preference.
- For responsive layouts, rely on Tamagui media props or `@th/ui` helpers.

## 6. Forms & Interactivity

- Use `react-hook-form` + Zod resolvers when building forms. Validate on blur/submit.
- Show feedback using shared components (`Toast`, `Banner`).
- Keep business rules in core use cases; client-side validation mirrors server validation but doesn’t replace it.

## 7. Testing & Linting

- Unit/component tests with Vitest + Testing Library in `__tests__` folders adjacent to components.
- For integration flows, add Playwright specs under `apps/web/tests` (future work).
- Run `pnpm --filter @th/web lint` (add lint script) and typed builds before merging.
- Storybook stories live in `packages/ui`; when web-only state machines exist, add docs pages under `apps/docs`.

## 8. Performance & Streaming

- Use `Suspense` boundaries for data fetching islands. Provide `loading.tsx` where necessary.
- Defer non-critical scripts with `next/script` and `strategy="lazyOnload"`.
- Enable image optimization via `<Image>` once assets exist.
- Monitor bundle size with `@next/bundle-analyzer` (future task).

## 9. Error Handling

- Implement `error.tsx` in route groups for user-friendly fallback UI.
- Re-throw typed errors from tRPC to surface proper status codes.
- Log unexpected errors via the provided logger in `ctx`.

## 10. Accessibility & i18n

- Use semantic HTML elements. Ensure tab order and ARIA labels.
- Prepare copy for translation by centralizing strings; avoid inline concatenation.

## 11. Overlay system

- Client islands that need layered UI (sign-in promo, onboarding nudges, etc.) rely on `AppOverlayProvider`, which wraps the entire chrome in a single `OverlayHost` from `@th/ui`.
- Feature entry points request overlays through `useAppOverlay()` (e.g., `showSignInOverlay({ redirect })`) so we can pop auth flows in-place without redirecting. Deep-link routes like `/sign-in` still render `<OverlayMount>` children directly when needed.
- `OverlayMount` IDs must be stable per overlay type; reuse IDs when re-opening so focus trap + pointer lock behave correctly.
- Keep overlays dumb: they receive props/state from the parent feature and render Tamagui primitives. Network/workflow logic stays in the invoking feature or core use cases.
- When a page needs multiple overlays, render them as siblings inside the host—ordering controls z-index, but only one overlay is displayed at a time per host configuration.

## Open Questions

- How should we organize marketing vs product routes? (e.g., `(marketing)` vs `(app)` groups.)
- Do we need a shared server-helper package (similar to an edge-friendly `@th/web-server`)?
- Should structured data helpers move to `@th/types`?

## Next Steps

1. Review this outline with the team; fill gaps (routing conventions, analytics, auth flows).
2. Add lint/test scripts to `apps/web/package.json` and wire into CI.
3. Document feature scaffolding workflow (CLI or template) for new routes.
4. Implement example page demonstrating server + client component split, metadata, and SEO component usage.
````
