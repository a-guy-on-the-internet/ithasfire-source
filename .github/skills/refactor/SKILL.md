---
name: refactor
description: 'Comprehensive code refactoring skill that identifies code smells, applies design patterns, and follows a safe refactoring process. Use when asked to refactor code, reduce complexity, improve code structure, extract functions, eliminate duplication, simplify conditionals, remove dead code, apply SOLID principles, or improve maintainability. Provides before/after examples for 10 common code smells and a verification checklist.'
---

# Refactoring

Comprehensive refactoring methodology with code smell identification, design pattern
application, and a safe multi-step process.

## When to Use This Skill

Activate when:
- The user asks to refactor, simplify, or clean up code
- Code review identifies structural issues
- Functions/classes have grown too large
- There is duplicated logic across files
- The user asks to apply SOLID principles or design patterns

## Code Smells Reference

### 1. Long Method (> 50 lines)
Split into focused helper functions:

**Before:**
```typescript
function processOrder(order: Order) {
  // validate (10 lines)
  // calculate totals (15 lines)
  // apply discounts (20 lines)
  // generate invoice (15 lines)
  // send notifications (10 lines)
}
```

**After:**
```typescript
function processOrder(order: Order) {
  validateOrder(order);
  const totals = calculateTotals(order);
  const discounted = applyDiscounts(totals);
  const invoice = generateInvoice(discounted);
  sendNotifications(invoice);
}
```

### 2. Duplicated Code
Extract shared logic:

**Before:**
```typescript
// In fileA.ts
const tax = subtotal * 0.08;
const total = subtotal + tax + shipping;

// In fileB.ts
const tax = amount * 0.08;
const total = amount + tax + deliveryFee;
```

**After:**
```typescript
// In pricing.ts
function calculateTotal(subtotal: number, shipping: number): number {
  const tax = subtotal * TAX_RATE;
  return subtotal + tax + shipping;
}
```

### 3. Large Class (> 300 lines)
Split by responsibility:

**Before:**
```typescript
class UserService {
  createUser() { ... }
  updateUser() { ... }
  sendEmail() { ... }
  generateReport() { ... }
  validatePassword() { ... }
}
```

**After:**
```typescript
class UserService { createUser() { ... } updateUser() { ... } }
class EmailService { sendEmail() { ... } }
class ReportService { generateReport() { ... } }
class PasswordValidator { validate() { ... } }
```

### 4. Long Parameter List (> 4 params)
Use an options object:

**Before:**
```typescript
function createEvent(name: string, date: Date, venue: string,
  capacity: number, price: number, description: string) { ... }
```

**After:**
```typescript
interface CreateEventInput {
  name: string; date: Date; venue: string;
  capacity: number; price: number; description: string;
}
function createEvent(input: CreateEventInput) { ... }
```

### 5. Feature Envy
Move logic to the class that owns the data:

**Before:**
```typescript
function getDiscount(customer: Customer) {
  if (customer.loyaltyPoints > 1000) return 0.1;
  if (customer.memberSince < oneYearAgo) return 0.05;
  return 0;
}
```

**After:**
```typescript
class Customer {
  getDiscount(): number {
    if (this.loyaltyPoints > 1000) return 0.1;
    if (this.memberSince < oneYearAgo) return 0.05;
    return 0;
  }
}
```

### 6. Primitive Obsession
Replace primitives with domain types:

**Before:**
```typescript
function createOrder(userId: string, amount: number, currency: string) { ... }
```

**After:**
```typescript
type UserId = string & { readonly __brand: 'UserId' };
interface Money { amount: number; currency: Currency; }
function createOrder(userId: UserId, price: Money) { ... }
```

### 7. Magic Numbers
Extract to named constants:

**Before:**
```typescript
if (retries > 3) throw new Error('Failed');
await sleep(5000);
if (password.length < 8) return false;
```

**After:**
```typescript
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const MIN_PASSWORD_LENGTH = 8;

if (retries > MAX_RETRIES) throw new Error('Failed');
await sleep(RETRY_DELAY_MS);
if (password.length < MIN_PASSWORD_LENGTH) return false;
```

### 8. Deeply Nested Conditionals
Use early returns and guard clauses:

**Before:**
```typescript
function process(user: User) {
  if (user) {
    if (user.isActive) {
      if (user.hasPermission) {
        // actual logic here
      } else {
        throw new Error('No permission');
      }
    } else {
      throw new Error('Inactive');
    }
  } else {
    throw new Error('No user');
  }
}
```

**After:**
```typescript
function process(user: User) {
  if (!user) throw new Error('No user');
  if (!user.isActive) throw new Error('Inactive');
  if (!user.hasPermission) throw new Error('No permission');
  // actual logic here
}
```

### 9. Dead Code
Remove unused code aggressively:
- Commented-out code blocks
- Unused imports, variables, functions
- Unreachable code after return/throw
- Feature flags that are always on/off
- Deprecated functions with no callers

### 10. Inappropriate Intimacy
Reduce coupling between modules:
- Classes accessing private internals of others
- Circular dependencies between modules
- Direct property access instead of methods
- Reaching through objects: `a.b.c.d.doSomething()`

---

## Design Patterns for Common Refactors

### Strategy Pattern
When you have multiple algorithms selected by conditionals:

```typescript
// Before: switch/if chain
function calculateShipping(method: string, weight: number) {
  if (method === 'ground') return weight * 1.5;
  if (method === 'express') return weight * 3.0;
  if (method === 'overnight') return weight * 5.0;
}

// After: Strategy
const shippingStrategies: Record<string, (weight: number) => number> = {
  ground: (w) => w * 1.5,
  express: (w) => w * 3.0,
  overnight: (w) => w * 5.0,
};
function calculateShipping(method: string, weight: number) {
  const strategy = shippingStrategies[method];
  if (!strategy) throw new Error(`Unknown method: ${method}`);
  return strategy(weight);
}
```

### Chain of Responsibility
When you have a sequence of processing steps:

```typescript
// Before: deeply nested or sequential if/else
function processRequest(req: Request) {
  if (!authenticate(req)) return unauthorized();
  if (!authorize(req)) return forbidden();
  if (!validate(req)) return badRequest();
  return handle(req);
}

// After: middleware chain
type Middleware = (req: Request, next: () => Response) => Response;
const pipeline: Middleware[] = [authMiddleware, authzMiddleware, validateMiddleware];
function processRequest(req: Request) {
  return runPipeline(pipeline, req, () => handle(req));
}
```

---

## Safe Refactoring Process

### Phase 1: Prepare
1. Ensure all existing tests pass
2. Commit current state (clean baseline)
3. Identify the scope of the refactor

### Phase 2: Identify
1. List all code smells found
2. Prioritize by impact (most tangled/duplicated first)
3. Check for dependent code (callers, importers)

### Phase 3: Refactor
1. Make ONE small change at a time
2. Run tests after each change
3. Keep behavior identical (no feature changes mixed in)
4. Use IDE rename/extract for mechanical changes

### Phase 4: Verify
1. All tests still pass
2. No new lint errors or warnings
3. Type checker passes
4. No behavior change (diff review)

### Phase 5: Clean Up
1. Remove any dead code created by the refactor
2. Update imports and re-exports
3. Update documentation if public API changed

---

## Quality Checklist

After refactoring, verify:

- [ ] No function exceeds 50 lines
- [ ] No file exceeds 400 lines
- [ ] No class/module has more than one responsibility
- [ ] No duplicated logic across files
- [ ] No `any` types introduced
- [ ] No circular dependencies
- [ ] All magic numbers replaced with named constants
- [ ] Maximum nesting depth <= 3 levels
- [ ] All dead code removed
- [ ] All tests pass with no behavior change
