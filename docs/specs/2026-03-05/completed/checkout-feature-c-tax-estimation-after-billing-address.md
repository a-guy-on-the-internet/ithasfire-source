# Feature C — Tax Estimation After Billing Address Is Filled

## Objective
When the buyer finishes filling in their billing address (all required fields populated), estimate taxes in real time and display them in the order summary — before they click "Continue." Currently taxes show "Calculated next" until the order is created.

## Architecture Decision

> **Superseded (2025-06):** The original spec called for a per-request Stripe Tax
> `calculateTax` API call ($0.50/calculation). That approach was replaced with a
> **venue-cached tax rate** strategy:
>
> 1. Tax rates are looked up via `TaxRateLookupPort` (Ziptax adapter, $29/mo flat)
>    and cached on `SavedLocation.admissionTaxRateBps` (basis points).
> 2. At event publish, the rate is stamped onto `Event.admissionTaxRateBps`.
> 3. Both `estimateCheckoutTax` and `create-checkout` compute tax with a simple
>    multiply: `Math.round(subtotalCents * taxRateBps / 10_000)`. **Zero API calls
>    per transaction.**
> 4. `billingAddress` is now optional in the input schema (kept for backward compat).
>    Tax is based on the *event venue*, not the buyer's address.

**Current implementation:** `events.estimateCheckoutTax` is a public tRPC query
that accepts the event ID and item quantities, reads the event's cached
`admissionTaxRateBps`, and returns `{ taxAmountCents }`. No Stripe or external
API call is made at estimation or checkout time.

## Scope

| Layer | File(s) | Action |
| ----- | ------- | ------ |
| **Frontend** | `CheckoutContactForm.tsx` | Add `onBillingAddressComplete` callback prop; fire when all required fields are non-empty |
| **Frontend** | `Checkout.tsx` | Wire the callback to trigger a `estimateCheckoutTax` query; pass result to `OrderSummary` |
| **Frontend** | `OrderSummary.tsx` | Accept optional `estimatedTaxCents` prop; display in tax row when present (before order) |
| **Transport** | `packages/transport/trpc/src/routers/events.ts` | `estimateCheckoutTax` public query (no `payments` dep) |
| **Core** | `packages/core/src/use-cases/events/estimate-checkout-tax.ts` | Reads event's cached `admissionTaxRateBps`, multiplies by subtotal |
| **Ports** | `TaxRateLookupPort` (Ziptax adapter) | Lookup + cache on `SavedLocation`; stamped to `Event` at publish |
| **DB** | `SavedLocation.admissionTaxRateBps`, `Event.admissionTaxRateBps` | Cached tax rate columns (basis points) |
| **i18n** | `en.ts` / `en.json` | No new keys needed — reuse `checkout.estimatedTaxes` |

## Detailed Changes

### 1. Use case: `estimate-checkout-tax.ts`

Location: `packages/core/src/use-cases/events/estimate-checkout-tax.ts`

> **Note:** This use case lives under `events/` (not `orders/`) because it reads
> the event's cached tax rate. It no longer calls any payment processor port.

```ts
import { z } from "zod";

const inputSchema = z.object({
  eventId: z.string().uuid(),
  items: z.array(z.object({
    ticketTypeId: z.string().uuid(),
    qty: z.number().int().positive(),
  })),
  billingAddress: z.object({ /* optional, kept for backward compat */ }).optional(),
});

// Deps: repos.events, repos.ticketTypes — no payments port needed.
// Tax = Math.round(subtotalCents * event.admissionTaxRateBps / 10_000)
```

Export from `packages/core/src/index.ts`.

### 2. tRPC route: `events.estimateCheckoutTax`

In `packages/transport/trpc/src/routers/events.ts`, add a public query:

```ts
estimateCheckoutTax: publicProcedure
  .input(z.object({
    eventId: z.string().uuid(),
    items: z.array(z.object({
      ticketTypeId: z.string().uuid(),
      qty: z.number().int().positive(),
    })),
    billingAddress: z.object({
      line1: z.string().min(1),
      city: z.string().min(1),
      state: z.string().min(1),
      postalCode: z.string().min(1),
      country: z.string().min(1),
    }),
  }))
  .query(async ({ input, ctx }) => {
    return estimateCheckoutTax(ctx.repos, input);
  }),
```

### 3. `CheckoutContactForm.tsx` — add callback

Add a new optional prop:
```ts
onBillingAddressComplete?: (address: BillingAddress) => void;
```

Add a `useEffect` that fires when all required billing fields are non-empty:
```ts
useEffect(() => {
  if (addressLine1 && city && state && postalCode && country && onBillingAddressComplete) {
    onBillingAddressComplete({
      line1: addressLine1,
      ...(addressLine2 ? { line2: addressLine2 } : {}),
      city,
      state,
      postalCode,
      country,
    });
  }
}, [addressLine1, city, state, postalCode, country]);
```

Use a debounce (300–500ms) or a ref to avoid firing on every keystroke during autofill. A simple approach: only fire when `postalCode.length >= 3` and `country.length >= 2`.

### 4. `Checkout.tsx` — wire the estimate query

Add state + query:
```ts
const [billingAddressForTax, setBillingAddressForTax] = useState<BillingAddress | null>(null);

const taxEstimateQuery = trpc.events.estimateCheckoutTax.useQuery(
  {
    eventId: event.id,
    items: selectedItems,
    billingAddress: billingAddressForTax!,
  },
  {
    enabled: Boolean(billingAddressForTax) && selectedItems.length > 0 && !order,
    staleTime: 30_000,
  },
);
```

Pass callback to `CheckoutContactForm`:
```tsx
<CheckoutContactForm
  ref={contactFormRef}
  defaultName={sessionQuery.data?.user?.name ?? undefined}
  defaultEmail={sessionQuery.data?.user?.email ?? undefined}
  isSignedIn={isSignedIn}
  onSignIn={() => showSignInOverlay({ redirect: currentUrl })}
  onBillingAddressComplete={setBillingAddressForTax}
/>
```

Pass to `OrderSummary`:
```tsx
<OrderSummary
  ...
  estimatedTaxCents={taxEstimateQuery.data?.taxAmountCents ?? null}
/>
```

### 5. `OrderSummary.tsx` — display estimated tax

Add prop:
```ts
estimatedTaxCents?: number | null;
```

In the tax row, add a fourth display state between "order exists" and "Calculated next":
```tsx
{order ? (
  // existing order tax display
) : estimatedTaxCents != null && estimatedTaxCents > 0 ? (
  <span style={{
    fontVariantNumeric: "tabular-nums",
    color: `color-mix(in srgb, ${fg} 85%, transparent)`,
    fontStyle: "italic",
  }}>
    {String(t("checkout.estimatePrefix"))} {formatPrice(estimatedTaxCents)}
  </span>
) : (
  // existing "Calculated next" pill
)}
```

Also update `estimatedTotalCents` to include tax when available:
```ts
const estimatedTotalCents = React.useMemo(() => {
  if (estimatedBuyerFeesCents === null) return null;
  return subtotalCents + estimatedBuyerFeesCents + (estimatedTaxCents ?? 0);
}, [subtotalCents, estimatedBuyerFeesCents, estimatedTaxCents]);
```

## Build Requirement
After making transport/core changes: **`pnpm build`** — the API imports `@th/trpc` from `dist/`, so you must rebuild for the new route to be available at runtime.

## How to Verify
1. `pnpm build` — passes.
2. Core tests: `pnpm -C packages/core vitest --run` (add a test for `estimateCheckoutTax`).
3. On checkout page: fill in billing address fields completely → tax row should update from "Calculated next" to "Est. $X.XX" within ~1 second. The estimated total should also include the tax estimate.
4. After clicking "Continue" → tax row shows the actual calculated tax amount (no "Est." prefix).

## Dependencies
- **Soft dependency on Feature B**: If Feature B is done first, use `checkout.estimatePrefix` for the "Est." label. If not done yet, you can add the key yourself or use a hardcoded `"Est."` and let Feature B clean it up.
- Independent of Features A and D.
