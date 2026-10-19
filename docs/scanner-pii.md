# Scanner PII Retention

The scanner app caches a small amount of personally-identifiable information
(PII) on the operator's device so the manual-search fallback at the gate
keeps working when the network drops. This doc captures **what is stored,
where, and when it is wiped** so the retention model isn't surprising on
audit.

## What is stored

The scanner syncs every event in its event list, not only the one being
scanned. The list (`listScannerAccessibleEvents`,
`packages/core/src/use-cases/scanner/list-scanner-accessible-events.ts`) holds
every DRAFT, PUBLISHED and COMPLETED event, up to 200 per org, of every org
where the operator is OWNER, ADMIN or SCANNER (`SCANNER_OPERATOR_ROLES`). A
platform ADMIN with no such membership gets the events of every active org,
up to 200 orgs, and only once a passkey or TOTP is enrolled
(`docs/roles.md`, "Second factor" under platform staff roles).
Each event's manifest (`scanner.getEventManifest`, gated on `ORG_SCAN_ROLES`
or platform ADMIN in `get-scanner-event-manifest.ts`, same folder) is cached.
For each event the scanner caches:

- **Tickets** — code, status, owner humanId, order id, ticket type name,
  scan time. (No name, no email on the ticket row itself; people data lives
  on the `people` table below.)
- **People** — for each attendee and each volunteer signup of the event:
  - `humanId` (or `signup:<signupId>` for volunteer signups by users with
    no registered humanId)
  - `displayName`
  - `email` (also stored lowercased in the FTS index for prefix search)
  - `kind` (`"attendee"` or `"volunteer"`)
  - `signupStatus` for volunteers (`PENDING`, `APPROVED`, etc.)
  - `synced_at` (epoch millis of last manifest pull)
- **Scan queue** — pending scans not yet acked by the API, and **dropped
  scans** that gave up retrying.
- **Recent scans** — short list of the operator's last few scans for
  re-display.
- **Events** — name, org, start and end times, status, the operator's role,
  and the event's public location.

## Where it is stored

A local SQLite database created and managed by [`expo-sqlite`](https://docs.expo.dev/versions/latest/sdk/sqlite/).
The DB file lives in the app's private sandbox — not iCloud-backed,
not shared with other apps, no manual file export.

The `people` table is paired with an FTS5 virtual table (`people_fts`)
indexing `display_name` and `email_lower` (the lowercased email) for prefix
search. Devices without FTS5 fall back to `LIKE` search.

PII is **not** stored in `SecureStore` (that's reserved for auth
credentials). The DB file is **not** application-level encrypted; the
mitigation today is the OS-level app sandbox + iOS Data Protection
(default `NSFileProtectionCompleteUntilFirstUserAuthentication`) + Android
private app storage. Application-level encryption (SQLCipher via
`@op-engineering/op-sqlite` or equivalent) is a tracked follow-up — it
requires a native dep swap and is queued behind a separate effort. Until
then, the retention rules below are the privacy story.

## When it is wiped

The scanner enforces **six** retention rules. Rule 1 lives in
[apps/scanner/src/features/auth/use-scanner-session.ts](../apps/scanner/src/features/auth/use-scanner-session.ts);
rules 2–4 in
[apps/scanner/src/lib/use-local-sync.ts](../apps/scanner/src/lib/use-local-sync.ts),
with the deletes in [apps/scanner/src/lib/local-db.ts](../apps/scanner/src/lib/local-db.ts).
Rule 5 is the remote-wipe path described below; rule 6 lives in
[apps/scanner/src/lib/use-access-revocation.ts](../apps/scanner/src/lib/use-access-revocation.ts)
and [apps/scanner/src/lib/access-denied-wipe.ts](../apps/scanner/src/lib/access-denied-wipe.ts).
Rules 2–4 delete `people` rows only; ticket, event and scan rows stay until
sign-out or rule 6. Every delete runs with `PRAGMA secure_delete = ON`, a
wipe ends with a WAL checkpoint (`TRUNCATE`) so deleted rows do not sit in
`scanner.db-wal`, and the people search index is rebuilt from the rows at
each launch.

1. **On sign-out** — the entire local DB is wiped (`clearAll` in
   `local-db.ts`). Implemented inside `useScannerSession.signOut`, so every
   sign-out call site (home screen, access-denied screen, future surfaces)
   wipes automatically.
2. **When an event leaves `accessibleEvents`** — if the operator's role
   is removed, or the event becomes CANCELLED or ARCHIVED so the API no
   longer returns it, the per-event diff in `useLocalSync` calls
   `dropPeopleForEvent(eventId)` on the next event-list refresh (about
   every 10 minutes, `EVENTS_STALE_MS`, or when the hook remounts; not on
   the 60-second manifest tick). A COMPLETED event stays
   in the list; rule 3 covers it. The diff runs only on a successful list
   response. An operator who loses their **last** scan role gets rule 6
   instead.
3. **24h after `event.endsAt`** — even if the event is still in
   `accessibleEvents`, once `now > endsAt + 24h` the people rows for
   that event are dropped and the manifest fetch for that event is
   skipped. An event with no `endsAt` is never dropped by this rule.
4. **Stale sweep** — at the end of every sync tick (every 60 seconds,
   and when the app returns to the foreground),
   `dropStalePeople({ staleAfterMs: 24h, activeEventIds })` removes any
   rows whose `synced_at` is older than 24h AND whose event is not in
   the current accessible-events list. Catches anything that escaped the
   per-event diff (e.g., across cold starts).
5. **Remote wipe via forced re-login** — once the operator's sessions are
   deleted server-side, the device's next tRPC call returns 401: the API
   refuses a JWT whose session is gone (`docs/auth.md`, "Sessions, tokens
   and JWKS"). The fetch wrapper in
   [apps/scanner/src/trpc.ts](../apps/scanner/src/trpc.ts) detects 401s
   and notifies the auth-invalidation bus
   ([apps/scanner/src/features/auth/auth-invalidation-bus.ts](../apps/scanner/src/features/auth/auth-invalidation-bus.ts)).
   `useScannerSession` subscribes to that bus and calls `signOut`, which
   triggers rule 1 and wipes everything. No polling, no extra round-trips —
   the wipe happens on the first authenticated action after revocation.
   What deletes the sessions: a password reset (the sign-in card's
   forgot-password link), which deletes every session; the operator
   changing their password on the web, which signs out their other
   sessions; platform staff suspending or banning the operator; platform
   staff unlinking their auth login; or the first-proof sweep when an
   unverified login's inbox is first proven (`docs/auth.md`). Nobody in
   the operator's org can revoke a session; an org admin who removes the
   operator gets rule 2, or rule 6 when it was their last scan role.
6. **When the last scan role goes** — when `scanner.getSessionContext`
   (asked with no `eventId`) answers FORBIDDEN for the signed-in person
   (`INSUFFICIENT_ROLE`, or `SECOND_FACTOR_REQUIRED` for platform staff
   with no second factor), the app shows the access-denied screen and
   deletes people, the search index, tickets, events and recent scans
   (`clearAttendeeData`). The offline scan queue stays and keeps flushing:
   those are admits already made at the door. The question is asked at
   launch, when the app returns to the foreground, when the device comes
   back online, and when the 10-minute event-list refresh is itself
   refused. A network failure or a 5xx never wipes. A door sale still
   open holds the screen for up to 3 minutes; then an open card sale is
   cancelled and the denied screen says not to take cash for it.

## Out of scope (today)

- **Application-level encryption at rest.** The DB file is protected by
  OS-level app sandbox + iOS Data Protection only. SQLCipher migration
  (likely via `@op-engineering/op-sqlite`) is queued.
- **Per-event opt-out** for events that don't want their attendee list
  on operator devices. Not implemented; flagged in the spec
  ([docs/specs/2026-04-26/completed/scanner-people-search.spec.yaml](specs/2026-04-26/completed/scanner-people-search.spec.yaml))
  as `out_of_scope` for v1.
- **Phone numbers** — name + email only.

## Threat model summary

The realistic privacy-incident surface is "operator's phone is lost or
stolen with people data cached for an active event." Mitigations:

- Rows are stored per event, but the cache covers every eligible event
  in every org where the operator can scan, upcoming events included
  (see "What is stored"). A lost phone carries the names and emails of
  every attendee and volunteer the org currently has on upcoming events.
- The 24h post-event wipe means a phone lost the day after a festival
  has nothing useful in the cache for that event after that window.
- Sign-out wipes everything immediately. For a missing device, the
  operator can reset their password from the sign-in card, which deletes
  every session; change it in account settings, which signs out their
  other sessions (the setting shows only for a login that has a
  password); or platform staff can suspend the operator. The
  next tRPC call from the device returns 401, the scanner runs `signOut`,
  and the local cache is wiped (rule 5 above). This requires the device
  to come online once afterwards; until then, OS-sandbox protection is
  the only mitigation. Removing the operator's last scan role wipes the
  attendee data at the next check (rule 6).

If a future event's threat model requires stronger guarantees, the
per-event opt-out and application-level encryption follow-ups are the
path.
