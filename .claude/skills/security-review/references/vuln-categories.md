# Vulnerability Categories — Deep Reference

This file contains detailed detection guidance for every vulnerability category.
Load this during Step 4 of the scan workflow.

---

## 1. Injection Flaws

### SQL Injection
**What to look for:**
- String concatenation or interpolation inside SQL queries
- Raw `.query()`, `.execute()`, `.raw()` calls with variables
- ORM `whereRaw()`, `selectRaw()`, `orderByRaw()` with user input
- Second-order SQLi: data stored safely, then used unsafely later
- Stored procedures called with unsanitized input

**Detection signals:**
```ts
prisma.$queryRawUnsafe(`SELECT ... ${input}`)      // string-built: injectable
prisma.$executeRawUnsafe("... " + input)
Prisma.raw(input)                                   // splices raw text into a tagged query
```

**Safe patterns (parameterized):**
```ts
prisma.$queryRaw`SELECT * FROM "Event" WHERE id = ${eventId}`  // tagged template binds params
prisma.event.findUnique({ where: { id: eventId } })
```

**Escalation checkers:**
- Is the query result ever used in another query? (second-order)
- Is the table/column name user-controlled? (cannot be parameterized — must allowlist)

---

### Cross-Site Scripting (XSS)
**What to look for:**
- `innerHTML`, `outerHTML`, `document.write()` with user data
- `dangerouslySetInnerHTML` in React
- `eval()`, `setTimeout(string)`, `setInterval(string)` with user data
- DOM-based: `location.hash`, `document.referrer`, `window.name` written to DOM
- Stored XSS: user input saved to DB, rendered without escaping later

**In this repo:** React escapes by default; a `dangerouslySetInnerHTML` carrying user-authored HTML must pass through a server-side sanitizer on every path that reaches it (announcements use `sanitizeAnnouncementHtml` at write and again at read in `get-my-page.ts` and the public `get-public-page.ts`); one that injects a static CSS constant is fine. Emails from `@th/ui-email` and href/src values built from user URLs (`javascript:`) are the other paths.

---

### Command Injection
**What to look for:**
```js
exec(userInput)
execSync(`ping ${host}`)
spawn('sh', ['-c', userInput])
child_process.exec('ls ' + dir)
```

**Safe alternatives:** `execFile`/`spawn` with an argument array and no shell; allowlist the command.

---

### Server-Side Request Forgery (SSRF)
**What to look for:**
- HTTP requests where the URL is user-controlled
- Webhooks, URL preview, image fetch features
- PDF generators that fetch external URLs
- Redirects to user-supplied URLs

**High-risk targets:**
- AWS metadata service: `169.254.169.254`
- Internal services: `localhost`, `127.0.0.1`, `10.x.x.x`, `192.168.x.x`
- Cloud metadata endpoints

**Detection:**
```js
fetch(req.body.url)
axios.get(userSuppliedUrl)
http.get(params.webhook)
```

---

## 2. Authentication & Access Control

### Broken Object Level Authorization (BOLA / IDOR)
**What to look for:**
- Resource IDs taken directly from URL/params without ownership check
- `findById(req.params.id)` without verifying `userId === currentUser.id`
- Numeric sequential IDs (easily guessable)

**Example vulnerable pattern:**
```ts
// VULNERABLE: any signed-in human can read any org's members by changing orgId
export async function listOrgMembers(deps, rawInput) {
  const input = parseInput(schema, rawInput);
  return deps.repos.organizations.listMembers({ orgId: input.orgId, limit: input.limit, offset: input.offset });
}

// SAFE: the use case asks AuthZPort before touching the repo
await deps.authz.requireOrgRole({
  actorHumanId: input.actorHumanId,
  orgId: input.orgId,
  requiredRoles: [...REQUIRED_ROLES],
});
```

---

### JWT Vulnerabilities
**What to look for:**
- `alg: "none"` accepted
- Weak or hardcoded secrets: `secret`, `password`, `1234`
- No expiry (`exp` claim) validation
- Algorithm confusion (RS256 → HS256 downgrade)
- JWT stored in `localStorage` (XSS risk; prefer httpOnly cookie)

**Detection:**
```js
jwt.verify(token, secret, { algorithms: ['HS256'] })  // Check algorithms array
jwt.decode(token)  // WARNING: decode does NOT verify signature
```

---

### Missing Authentication / Authorization
**What to look for:**
- A sensitive procedure on `publicProcedure` or `optionalProcedure` where it needs `authedProcedure`
- A use case that trusts an `orgId` / `placeId` / `eventId` from input without an AuthZPort check (`requireOrgRole`, `canEditEvent`, `canManagePlace`, `canFinanceOrg`, `hasStaffRole`)
- A public event read that skips the transport gate (`ensureFullEventReadAccess*`)
- Fastify routes outside tRPC (webhooks, `/jobs/*`, e2e helpers) that skip signature or secret checks, or ship enabled in production

---

### CSRF
**What to look for:**
- State-changing operations (POST/PUT/DELETE) without CSRF token
- APIs relying only on cookies for auth without SameSite attribute
- Missing `SameSite=Strict` or `SameSite=Lax` on session cookies

---

## 3. Secrets & Sensitive Data Exposure

### In-Code Secrets
Look for patterns like:
```
API_KEY = "sk-..."
password = "hunter2"
SECRET = "abc123"
private_key = "-----BEGIN RSA PRIVATE KEY-----"
aws_secret_access_key = "wJalrXUtn..."
```

Entropy heuristic: strings > 20 chars with high character variety in assignment context
are likely secrets even if the variable name doesn't say so.

### In Logs / Error Messages
```js
console.log('User password:', password)
logger.info({ user, token })   // token shouldn't be logged
res.status(500).json({ error: err.stack })  // stack traces expose internals
```

### Sensitive Data in API Responses
- Returning full user object including `password_hash`, `ssn`, `credit_card`
- Including internal IDs or system paths in error responses

---

## 4. Cryptography

### Weak Algorithms
| Algorithm | Issue | Replace With |
|-----------|-------|--------------|
| MD5 | Broken for security | SHA-256 or bcrypt (passwords) |
| SHA-1 | Collision attacks | SHA-256 |
| DES / 3DES | Weak key size | AES-256-GCM |
| RC4 | Broken | AES-GCM |
| ECB mode | No IV, patterns visible | GCM or CBC with random IV |

### Weak Randomness
```js
// VULNERABLE
Math.random()                    // not cryptographically secure
Date.now()                       // predictable
Math.random().toString(36)       // weak token generation

// SAFE
crypto.randomBytes(32)           // Node.js
```

### Password Hashing
Passwords are hashed by Better Auth. Flag any new code that hashes or compares a password or token itself (a plain `sha256`, `===` on secrets instead of `crypto.timingSafeEqual`).

---

## 5. Insecure Dependencies

### What to flag:
- Packages with known CVEs in installed version range
- Packages abandoned > 2 years with no security updates
- Packages with extremely broad permissions for their stated purpose
- Transitive dependencies pulling in known-bad packages
- Pinned versions that are significantly behind current (possible unpatched vulns)

### High-risk package watchlist: see `references/vulnerable-packages.md`

---

## 6. Business Logic

### Race Conditions (TOCTOU)
```js
// VULNERABLE: check then act without atomic lock
const balance = await getBalance(userId);
if (balance >= amount) {
  await deductBalance(userId, amount);  // race condition between check and deduct
}

// SAFE: use atomic DB transaction or optimistic locking
await db.transaction(async (trx) => {
  const user = await User.query(trx).forUpdate().findById(userId);
  if (user.balance < amount) throw new Error('Insufficient funds');
  await user.$query(trx).patch({ balance: user.balance - amount });
});
```

### Missing Rate Limiting
Flag endpoints that:
- Accept authentication credentials (login, 2FA)
- Send emails or SMS
- Perform expensive operations
- Expose user enumeration (password reset, registration)

---

## 7. Path Traversal
```ts
// VULNERABLE: user value reaches a filesystem path or an R2 object key
const key = `uploads/${input.filename}`;          // "../other-org/…"
await fs.readFile(path.join(UPLOAD_DIR, input.file));

// SAFE: server-generated keys; if a user value must appear, basename it and
// check the resolved path stays under the root
const safe = path.resolve(UPLOAD_DIR, path.basename(input.file));
if (!safe.startsWith(UPLOAD_DIR + path.sep)) throw forbidden();
```
