# Human/AuthUser Data Model Cleanup Migration

## Date: 2026-02-03

## Problem

The `Human` model duplicates fields that Better Auth requires on `AuthUser`:
- `email` / `emailVerified` — duplicated
- `phone` / `phoneVerified` — duplicated  
- `username` / `displayUsername` — on Human but not wired to Better Auth

## Solution

1. **Remove from Human**: `email`, `emailVerified`, `phone`, `phoneVerified`, `username`, `displayUsername`
2. **AuthUser becomes source of truth** for identity (email, phone, verification status)
3. **Enable Better Auth username plugin** for username-based login
4. **Profile.avatarUrl** synced from OAuth providers via AuthUser.image
5. **Human** becomes purely domain state: `id`, `status`, `roles`, `locale`, `name`

## Migration Steps

### Phase 1: Schema Changes (Prisma)
- [ ] Remove fields from Human model
- [ ] Add username/displayUsername to AuthUser (via plugin schema)
- [ ] Generate migration
- [ ] Backfill: copy data from Human → AuthUser where missing

### Phase 2: Enable Username Plugin
- [ ] Add `username()` plugin to better-auth.ts
- [ ] Update AuthUser schema for username fields

### Phase 3: Update Types & Ports
- [ ] Update `HumanRecord` type (remove email, phone, verified fields)
- [ ] Update `HumansRepo` interface (remove getByEmail, getByPhone)
- [ ] Add `getByAuthUserId` to get Human with auth data joined

### Phase 4: Update Adapters
- [ ] Update Prisma humans adapter
- [ ] Create joined query for Human + AuthUser data

### Phase 5: Update Use Cases
- [ ] Update all use cases that read human.email → join with authUser
- [ ] Update provisioning flow
- [ ] Update notification/comms to get email/phone from authUser

### Phase 6: Update Clients
- [ ] Update mobile/web to get email from auth session

## Files to Update

### Schema
- `packages/db/prisma/schema.prisma`

### Types
- `packages/types/src/repos/humans.ts`
- `packages/ports/src/repos/humans.ts`

### Adapters
- `packages/adapters/src/db/prisma/humans.ts`

### Use Cases
- `packages/core/src/use-cases/humans/create-human.ts`
- `packages/core/src/use-cases/humans/provision-human-for-auth-user.ts`
- `packages/core/src/use-cases/humans/get-human.ts`
- `packages/core/src/use-cases/comms/channels/send-email.ts`
- `packages/core/src/use-cases/comms/channels/send-sms.ts`
- `packages/core/src/use-cases/comms/update-notification-preferences.ts`
- `packages/core/src/use-cases/orders/send-ticket-issued-email.ts`
- `packages/core/src/use-cases/events/list-event-owner-entities.ts`

### Auth
- `apps/api/src/auth/better-auth.ts`

### Clients
- `apps/mobile/src/navigation/AppNavbar.tsx`
