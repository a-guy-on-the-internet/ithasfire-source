# Feature D — "Save to Profile" Prompts for Phone, Email, Billing Address

## Objective
After checkout, gently prompt the buyer to save their contact details (phone, billing address) to their profile for faster future checkouts. The UX is a non-blocking inline prompt — not a modal. Tone: "Want to save this for next time? You're welcome to, but you don't have to."

## Architecture Overview
This is a **full-stack feature** requiring schema changes, a new use case, a new tRPC route, and frontend work.

### Current State
- **Human model** (`packages/db/prisma/schema.prisma`): Only has `id, name, status, roles, locale`. No phone or billing address fields.
- **`HumanRecord`** (`packages/types/src/repos/humans.ts`): `{ id, name, status, roles, locale }`.
- **`UpdateHumanInput`**: `Partial<Pick<HumanRecord, "name" | "status" | "locale">>` — very limited.
- **`AuthIdentityRecord`**: Has `email, phone` (from Better Auth), but phone is often null.
- **No "update profile" use case exists** in `packages/core/src/use-cases/humans/`.
- **Profile model**: Has `displayName, slug, bio, avatarUrl, bannerUrl, visibility` — no contact details.

### Design Decision
Store phone and billing address on the **Human** model (not Profile, which is public-facing). Email is managed by Better Auth and shouldn't be duplicated.

## Scope

| Layer | File(s) | Action |
|-------|---------|--------|
| **DB** | `packages/db/prisma/schema.prisma` | Add columns to Human model |
| **DB** | Migration | `pnpm -C packages/db prisma migrate dev --name add-human-contact-fields` |
| **Types** | `packages/types/src/repos/humans.ts` | Extend `HumanRecord`, `UpdateHumanInput` |
| **Ports** | `packages/ports/src/repos/humans.port.ts` | Ensure `update()` method exists (check current signature) |
| **Core** | `packages/core/src/use-cases/humans/update-human-profile.ts` | New use case |
| **Transport** | `packages/transport/trpc/src/routers/humans.ts` | New `updateProfile` mutation |
| **Frontend** | `CheckoutContactForm.tsx` or new `SaveToProfilePrompt.tsx` | Inline prompt UI |
| **Frontend** | `Checkout.tsx` | Wire prompt after successful checkout |
| **i18n** | `en.ts` / `en.json` | Add prompt copy |

## Detailed Changes

### 1. Prisma Schema — Human model

Add to the `Human` model in `packages/db/prisma/schema.prisma`:

```prisma
model Human {
  // ... existing fields ...

  // Saved contact details for faster checkout
  phone              String?
  billingAddressLine1    String?
  billingAddressLine2    String?
  billingCity            String?
  billingState           String?
  billingPostalCode      String?
  billingCountry         String?
}
```

Then run:
```bash
pnpm -r exec -- prisma validate --schema=packages/db/prisma/schema.prisma
pnpm -C packages/db prisma migrate dev --name add-human-contact-fields
pnpm -F @th/db prisma generate
```

### 2. Types — extend `HumanRecord` and `UpdateHumanInput`

In `packages/types/src/repos/humans.ts`:

```ts
export type HumanRecord = {
  id: string;
  name: string;
  status: HumanStatus;
  roles: HumanRole[];
  locale: string;
  // Saved contact details
  phone: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
};

export type UpdateHumanInput = Partial<Pick<HumanRecord,
  | "name"
  | "status"
  | "locale"
  | "phone"
  | "billingAddressLine1"
  | "billingAddressLine2"
  | "billingCity"
  | "billingState"
  | "billingPostalCode"
  | "billingCountry"
>>;
```

### 3. Adapter — update Prisma adapter mapping

Wherever the Prisma `Human` result is mapped to `HumanRecord` (likely in `packages/adapters/src/`), ensure the new fields are included in the mapping. Search for `HumanRecord` in `packages/adapters/`.

### 4. New use case: `update-human-profile.ts`

Location: `packages/core/src/use-cases/humans/update-human-profile.ts`

```ts
import { z } from "zod";
import type { Repos } from "@th/ports";

const inputSchema = z.object({
  humanId: z.string().uuid(),
  phone: z.string().optional(),
  billingAddress: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().min(1),
  }).optional(),
});

export async function updateHumanProfile(
  repos: Repos,
  callerId: string,
  rawInput: z.infer<typeof inputSchema>,
) {
  const input = inputSchema.parse(rawInput);

  // Users can only update their own profile
  if (input.humanId !== callerId) {
    throw { code: "forbidden" as const, message: "Cannot update another user's profile" };
  }

  const updateData: Record<string, unknown> = {};
  if (input.phone !== undefined) updateData.phone = input.phone;
  if (input.billingAddress) {
    updateData.billingAddressLine1 = input.billingAddress.line1;
    updateData.billingAddressLine2 = input.billingAddress.line2 ?? null;
    updateData.billingCity = input.billingAddress.city;
    updateData.billingState = input.billingAddress.state;
    updateData.billingPostalCode = input.billingAddress.postalCode;
    updateData.billingCountry = input.billingAddress.country;
  }

  await repos.humans.update(input.humanId, updateData);

  return { success: true };
}
```

Follow the patterns in adjacent use cases (e.g., `create-human.ts`). Export from `packages/core/src/index.ts`.

### 5. tRPC route

In the humans router (`packages/transport/trpc/src/routers/humans.ts`), add:

```ts
updateProfile: protectedProcedure
  .input(z.object({
    phone: z.string().optional(),
    billingAddress: z.object({
      line1: z.string().min(1),
      line2: z.string().optional(),
      city: z.string().min(1),
      state: z.string().min(1),
      postalCode: z.string().min(1),
      country: z.string().min(1),
    }).optional(),
  }))
  .mutation(async ({ input, ctx }) => {
    return updateHumanProfile(ctx.repos, ctx.humanId, {
      humanId: ctx.humanId,
      ...input,
    });
  }),
```

### 6. Frontend — Pre-fill from saved profile

When the contact form loads and the user is signed in, fetch their saved contact details and pre-fill:

In `Checkout.tsx`, query the human's profile:
```ts
const humanQuery = trpc.humans.getHuman.useQuery(undefined, {
  enabled: isSignedIn,
});
```

Pass saved values to `CheckoutContactForm`:
```tsx
<CheckoutContactForm
  defaultPhone={humanQuery.data?.phone ?? undefined}
  defaultBillingAddress={humanQuery.data?.billingAddressLine1 ? {
    line1: humanQuery.data.billingAddressLine1,
    line2: humanQuery.data.billingAddressLine2 ?? undefined,
    city: humanQuery.data.billingCity ?? "",
    state: humanQuery.data.billingState ?? "",
    postalCode: humanQuery.data.billingPostalCode ?? "",
    country: humanQuery.data.billingCountry ?? "",
  } : undefined}
  ...
/>
```

Add `defaultPhone` and `defaultBillingAddress` props to `CheckoutContactForm` and use them in the `useState` initializers (same pattern as `defaultName`/`defaultEmail`).

### 7. Frontend — "Save to Profile" prompt

After a successful checkout (when `clientSecret` is set or order is confirmed), show a non-blocking inline banner if the user entered details that differ from their saved profile:

Create a small component (can be inline in `Checkout.tsx` or a new `SaveToProfilePrompt.tsx`):

```tsx
const SaveToProfilePrompt = ({ phone, billingAddress, onSave, onDismiss }) => {
  const t = useTranslations();
  return (
    <div style={{
      borderRadius: 12,
      border: "1px solid rgba(237,237,237,0.10)",
      background: "color-mix(in srgb, var(--foreground) 3%, transparent)",
      padding: "16px 20px",
      fontSize: 14,
    }}>
      <p style={{ margin: "0 0 8px", fontWeight: 500 }}>
        {String(t("checkout.saveToProfileTitle"))}
      </p>
      <p style={{ margin: "0 0 12px", fontSize: 13, opacity: 0.8 }}>
        {String(t("checkout.saveToProfileDescription"))}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" size="$3" onPress={onSave}>
          {String(t("checkout.saveToProfile"))}
        </Button>
        <Button variant="ghost" size="$3" onPress={onDismiss}>
          {String(t("checkout.noThanks"))}
        </Button>
      </div>
    </div>
  );
};
```

### 8. i18n Keys

Add to both `en.ts` and `en.json` under `checkout`:

```
saveToProfileTitle: "Save for next time?"
saveToProfileDescription: "We can save your contact info so checkout is faster next time. Totally optional."
saveToProfile: "Save to profile"
noThanks: "No thanks"
```

## Build Requirement
After schema/type/core/transport changes:
```bash
pnpm -F @th/db prisma generate
pnpm build
```

## How to Verify
1. Prisma: `pnpm -r exec -- prisma validate --schema=packages/db/prisma/schema.prisma`
2. `pnpm build` — passes.
3. Core tests: add tests in `packages/core/src/use-cases/humans/update-human-profile.test.ts`.
4. Manual: go through checkout, enter phone + billing address, complete purchase → see "Save for next time?" prompt → click "Save to profile" → next checkout pre-fills those fields.

## Dependencies
- Independent of Features A, B, C.
- Requires `pnpm db:reset` or a migration for local dev after schema changes.

## Risks & Notes
- Changing `HumanRecord` touches many files that import it. The new fields are all nullable (`string | null`), so existing code that destructures `HumanRecord` won't break — it just gains new optional properties. However, any code that spreads `HumanRecord` into a non-Prisma context may need updating.
- The `getHuman` use case / tRPC route already returns `HumanRecord` — the new fields will automatically be included once the type and adapter are updated.
- Don't store email separately — Better Auth owns the canonical email. Only phone and billing address are saved on Human.
