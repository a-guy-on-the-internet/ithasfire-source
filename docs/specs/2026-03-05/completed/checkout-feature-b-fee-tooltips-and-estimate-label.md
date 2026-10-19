# Feature B — Fee Breakdown Tooltips + Replace Tilde with "Est." Label

## Objective
1. Add info tooltips to the "Platform fee" and "Processing fee" rows in the order summary explaining what each fee covers.
2. Replace the `~` (tilde) prefix on all estimated values with a more user-friendly label like `"Est. "` — most people don't know what a tilde means.

## Scope
**Two files, pure frontend + i18n.**

| File | Action |
|------|--------|
| `apps/web/src/app/events/checkout/[...slug]/_components/OrderSummary.tsx` | Add tooltip UI; replace `~` prefix |
| `apps/web/src/i18n/messages/en.ts` (web) | Add tooltip copy + `estimatePrefix` key |
| `packages/locale/messages/en.json` (shared) | Add matching keys if `OrderSummary` uses `@th/ui`'s `useTranslations` (it does) |

## i18n Keys to Add

In both `apps/web/src/i18n/messages/en.ts` under `checkout:` AND `packages/locale/messages/en.json` under `"checkout"`:

```
platformFeeTooltip: "A service fee that supports the Ithas Fire platform."
processingFeeTooltip: "Covers card processing costs (Stripe)."
estimatePrefix: "Est."
```

The Spanish translations (`es.ts` / `es.json`) should be added too if they exist.

## Exact Changes in `OrderSummary.tsx`

### 1. Replace every `~` prefix
There are **three** places where `~` appears before a `formatPrice(...)` call:
- Estimated platform fee: `~{formatPrice(estimatedPlatformFeeCents)}`
- Estimated processor fee: `~{formatPrice(estimatedProcessorFeeCents)}`
- Estimated total: `` `~${formatPrice(estimatedTotalCents!)}` ``

Replace each with the i18n key:
```tsx
{String(t("checkout.estimatePrefix"))} {formatPrice(estimatedPlatformFeeCents)}
```
For the total (which uses a template literal), use:
```tsx
{`${String(t("checkout.estimatePrefix"))} ${formatPrice(estimatedTotalCents!)}`}
```

### 2. Add inline tooltip to Platform Fee and Processing Fee labels
Since the project uses **inline styles** (no Tailwind — it's broken in this codebase), build a small hover-tooltip using a `<span>` with `position: relative` and a hidden child that appears on `:hover`. Use the existing approach from the codebase (CSS `:hover` pseudo, or a tiny `useState` toggle).

Recommended pattern — a small inline `InfoTooltip` component defined at the top of the file or extracted:

```tsx
const InfoTooltip = ({ text }: { text: string }) => {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 4, cursor: "help" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <Info size={12} style={{ color: `color-mix(in srgb, ${fg} 55%, transparent)` }} />
      {show && (
        <span style={{
          position: "absolute",
          bottom: "calc(100% + 6px)",
          left: "50%",
          transform: "translateX(-50%)",
          whiteSpace: "nowrap",
          padding: "6px 10px",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 400,
          fontStyle: "normal",
          color: fg,
          background: "var(--background, #0a0a0a)",
          border: "1px solid rgba(237,237,237,0.12)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          zIndex: 10,
          pointerEvents: "none",
        }}>
          {text}
        </span>
      )}
    </span>
  );
};
```

Import `Info` from `lucide-react` and `useState` from `react`.

Then wrap each fee label:
```tsx
<span style={{ color: `color-mix(in srgb, ${fg} 92%, transparent)`, display: "inline-flex", alignItems: "center" }}>
  {String(t("checkout.platformFee"))}
  <InfoTooltip text={String(t("checkout.platformFeeTooltip"))} />
</span>
```

Same pattern for `processingFee` / `processingFeeTooltip`.

### 3. Tilde in `Checkout.tsx` mobile bar
If Feature A (remove mobile bar) hasn't been done yet, the mobile bar in `Checkout.tsx` also has `~${formatPrice(...)}`. Apply the same `Est.` replacement there. If Feature A is already done, this is a no-op.

## How to Verify
1. `pnpm build` — no TS errors.
2. On the checkout page, select tickets. Before clicking "Continue":
   - Platform fee and processing fee should show `Est. $X.XX` (italic) instead of `~$X.XX`.
   - Estimated total should show `Est. $X.XX`.
   - Hovering the `ⓘ` icon next to "Platform fee" shows "A service fee that supports the Ithas Fire platform."
   - Hovering the `ⓘ` icon next to "Processing fee" shows "Covers card processing costs (Stripe)."
3. After clicking "Continue" (order created), fees show exact values with no prefix and no tooltip changes needed (tooltips remain on labels).

## Dependencies
None — fully independent. If Feature A is done first, skip the mobile bar tilde replacement.
