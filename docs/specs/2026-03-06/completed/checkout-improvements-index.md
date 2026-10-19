# Checkout Improvements — Feature Split

Four independent feature specs, each scoped for a single AI agent to pick up and execute. They can be worked on in parallel (with minor soft dependencies noted).

## At a Glance

| Feature | Complexity | Layers | Spec |
| --- | --- | --- | --- |
| **A** — Remove mobile sticky bottom bar | Trivial | Frontend only | [Feature A](checkout-feature-a-remove-mobile-sticky-bar.md) |
| **B** — Fee tooltips + replace `~` with "Est." | Small | Frontend + i18n | [Feature B](checkout-feature-b-fee-tooltips-and-estimate-label.md) |
| **C** — Tax estimation after billing address | Medium | Frontend + Core + Transport | [Feature C](checkout-feature-c-tax-estimation-after-billing-address.md) *(backend done — uses venue-cached rate, not Stripe Tax)* |
| **D** — Save contact details to profile | Large | Full-stack (DB → Types → Core → Transport → Frontend) | [Feature D](checkout-feature-d-save-to-profile.md) |

## Recommended Execution Order

A and B are quick wins — start there. C and D are independent of each other but both require `pnpm build` after backend changes.

```
A ──→ done
B ──→ done
C ──→ done (soft dep: uses `checkout.estimatePrefix` from B if available)
D ──→ done (requires DB migration)
```

## Critical Reminders for All Features

1. **Tailwind is broken** in this codebase. All checkout components use React inline styles with CSS variables (`var(--foreground)`, `var(--background)`, `color-mix()`). Do NOT add Tailwind classes.
2. **`@th/trpc` is compiled** — the API server imports from `dist/`. After any change to `packages/transport/trpc/src/` or `packages/core/src/`, run `pnpm build` before testing at runtime.
3. **i18n lives in two places**: `apps/web/src/i18n/messages/en.ts` (web-specific, `.ts`) and `packages/locale/messages/en.json` (shared, `.json`). The checkout components use `useTranslations()` from `@th/ui`, which reads from the shared locale package. Update both if adding keys.
4. Follow the project's hexagonal architecture: use cases in `core`, port interfaces in `ports`, implementations in `adapters`, thin tRPC routes in `transport`.
5. Run `pnpm build` as the final sanity check for every feature.
