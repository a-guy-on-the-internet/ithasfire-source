import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./fixtures";
import { createMailpitClient } from "./helpers/mailpit";
import { createE2eTrpcClient } from "./helpers/trpc";
import {
  API_BASE_URL,
  seedBookingLoop,
  type BookingLoopSeed,
} from "./helpers/booking-loop";

/**
 * Booking-inquirer outreach — a venue's thread reply to an ANONYMOUS embed
 * inquiry actually reaches the sender.
 *
 * WHY THIS SPEC EXISTS, in the exact shape of the bug it caught:
 *
 *   The backend for this (mint a shadow identity on the venue's first reply,
 *   flip the request to owned, deliver the message as email) passed three
 *   review rounds, 500+ unit tests, and a live send driven through real
 *   Postgres — and was still UNREACHABLE, because `BookingInbox` rendered the
 *   whole Conversation behind `{!isAnonymous && ...}`. Every one of those
 *   checks started AFTER the message existed; nothing asserted a venue could
 *   produce one.
 *
 *   So the load-bearing assertion here is the boring one: on an anonymous
 *   inquiry the venue can SEE a composer and SEND. Everything after it (the
 *   email, the threading headers) only matters if that holds.
 *
 * This spec does NOT call `resetE2eState()`, so it is safe under
 * `E2E_USE_LIVE_STACK=1` (which blocks the ~54 specs that do). It seeds its
 * own org/place/embed and creates its own inquiry with a per-run unique
 * address, and asserts only on rows it created — no dependence on ambient
 * seed fixtures, and no cleanup debt for other specs.
 *
 * The venue session comes from the project's storage state (auth.setup.ts),
 * same as booking-embed-loop.spec.ts.
 *
 * Prerequisites: postgres, redis, Mailpit, API, web dev server.
 */

/** Cloudflare's always-pass test pair is wired locally, so any token verifies. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

function uniqueInquirer() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: `Marisol Vega ${stamp.slice(-6)}`,
    // Unique per run: the anonymous dedupe index is
    // (placeId, lower(contactEmail)) WHERE status IN ('PENDING','VIEWED'),
    // so a re-run against a live stack must not collide with its own leftovers.
    email: `inquirer-${stamp}@example.test`,
  };
}

/** A preferred date well clear of today, in the schema's YYYY-MM-DD shape. */
function futureDate(): string {
  return new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * One message's raw MIME headers, case-insensitively.
 *
 * Mailpit's message-detail JSON does NOT carry them — it exposes `Text`,
 * `HTML`, `Subject`, `MessageID` and so on, but there is no `Headers` map — so
 * threading has to be read from the dedicated `/headers` endpoint. It also
 * spells the field `Message-Id`, not `Message-ID`, which is why the lookup is
 * case-insensitive rather than a plain index.
 */
async function headersOf(
  request: APIRequestContext,
  origin: string,
  id: string,
): Promise<(name: string) => string | undefined> {
  const res = await request.get(`${origin}/api/v1/message/${id}/headers`);
  expect(res.ok(), `Mailpit headers fetch failed for ${id}`).toBeTruthy();
  const raw = (await res.json()) as Record<string, string[]>;
  const lower = new Map(
    Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v?.[0]]),
  );
  return (name: string) => lower.get(name.toLowerCase());
}

test.describe("booking inquirer outreach", () => {
  let seed: BookingLoopSeed;

  test.beforeEach(async ({ request }) => {
    // `seedBookingLoop` now produces a venue that is actually BOOKABLE —
    // verified, accepting, AND carrying place-wide CalendarAvailability rows.
    // That last part used to be missing, and both create paths fail closed
    // without it (`booking_requests_unconfigured`, availability-onboarding
    // FR-005), so every spec here had to finish the venue through an
    // authorized tRPC call first. It doesn't any more.
    seed = await seedBookingLoop(request);
  });

  test("venue replies in the thread of an anonymous inquiry and it reaches them by email", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const inquirer = uniqueInquirer();
    const mailpit = createMailpitClient({ request });
    await mailpit.ready();

    // ── Arrange: an anonymous inquiry through the real public procedure the
    // embed widget calls. Not a direct row write — the sender-identity rules
    // are exactly what this feature turns on.
    const trpc = createE2eTrpcClient(request, API_BASE_URL);
    await trpc.embeds.createBookingInquiry.mutate({
      embedId: seed.embedId,
      hostOrigin: `http://${seed.embedDomain}`,
      turnstileToken: TURNSTILE_DUMMY_TOKEN,
      contactName: inquirer.name,
      contactEmail: inquirer.email,
      actName: "The Paper Kites",
      message:
        "We are touring through in the autumn and would love to play the room. Three-piece, we bring our own backline.",
      preferredDates: [futureDate()],
    });

    // Clear AFTER arranging: creating the inquiry fires the venue's own
    // new-request notification, which is not what this spec asserts on.
    await mailpit.clear();

    // ── Act: the venue opens its inbox and replies in the thread.
    await page.goto(`/admin/${seed.orgSlug}/places/${seed.placeId}/bookings`);

    const row = page
      .getByRole("row")
      .filter({ hasText: inquirer.name })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    // THE REGRESSION THIS SPEC EXISTS FOR: an anonymous inquiry must offer a
    // composer. When this was gated on `!isAnonymous` the feature shipped with
    // no way to reach it, and every other check stayed green.
    const composer = page.getByRole("textbox", { name: /message/i });
    await expect(
      composer,
      "an anonymous inquiry must expose the thread composer — without it the outreach path is unreachable",
    ).toBeVisible({ timeout: 20_000 });

    // The venue must be told Send means "email", not "in-app message".
    await expect(page.getByText(/sent as email/i)).toBeVisible();

    // The mailto affordance (embed spec FR-006) coexists with the thread — it
    // is the venue's fallback and must not be replaced by it.
    await expect(
      page.locator(`a[href="mailto:${inquirer.email}"]`),
    ).toBeVisible();

    const body =
      "Sep 27 works for us. Load-in is 6pm, doors at 8 — can you confirm the lineup size?";
    await composer.fill(body);
    await page.getByRole("button", { name: /^send$/i }).click();

    // ── Assert: the message lands in the thread...
    await expect(page.getByText(body)).toBeVisible({ timeout: 20_000 });

    // ...and actually leaves the building, carrying the venue's own words
    // rather than a "you have a message" stub.
    const mail = await mailpit.waitForEmailTo(inquirer.email, {
      timeoutMs: 30_000,
    });
    expect(`${mail.Text ?? ""}${mail.HTML ?? ""}`).toContain("Load-in is 6pm");
    expect(mail.Subject ?? "").toContain(seed.placeName);

    // NO threading headers. Verified 2026-09-08 against real Resend + Gmail:
    // a caller-supplied Message-Id is DISCARDED and replaced with the
    // provider's own SES id, so an In-Reply-To built from ours points at a
    // message that exists nowhere — and the probe pair landed in Gmail as two
    // separate threads. We send none rather than send unsatisfiable ones.
    // (Local SMTP still stamps its own Message-Id; that is nodemailer, not us.)
    const h1 = await headersOf(request, mailpit.origin, mail.ID);
    expect(h1("In-Reply-To")).toBeUndefined();
    expect(h1("References")).toBeUndefined();
  });

  test("a second reply keeps the subject stable and adds no unsatisfiable threading headers", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const inquirer = uniqueInquirer();
    const mailpit = createMailpitClient({ request });
    await mailpit.ready();

    const trpc = createE2eTrpcClient(request, API_BASE_URL);
    await trpc.embeds.createBookingInquiry.mutate({
      embedId: seed.embedId,
      hostOrigin: `http://${seed.embedDomain}`,
      turnstileToken: TURNSTILE_DUMMY_TOKEN,
      contactName: inquirer.name,
      contactEmail: inquirer.email,
      actName: "The Paper Kites",
      message:
        "Following up on our note about the autumn run — happy to work around your calendar.",
      preferredDates: [futureDate()],
    });

    await mailpit.clear();
    await page.goto(`/admin/${seed.orgSlug}/places/${seed.placeId}/bookings`);

    const row = page
      .getByRole("row")
      .filter({ hasText: inquirer.name })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    const composer = page.getByRole("textbox", { name: /message/i });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const send = page.getByRole("button", { name: /^send$/i });

    // SEND is disabled while empty AND while the post mutation is in flight, so
    // each click waits for it to be enabled. Without that the second click
    // lands on the still-pending button from the first send and times out.
    await composer.fill("First reply — the date is open.");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByText("First reply — the date is open.")).toBeVisible({
      timeout: 20_000,
    });
    const first = await mailpit.waitForEmailTo(inquirer.email, {
      timeoutMs: 30_000,
    });

    // The composer clears itself on a successful post; wait for that before
    // typing again, so the fill cannot race the reset and be wiped.
    await expect(composer).toHaveValue("", { timeout: 20_000 });
    await composer.fill("Second reply — confirming load-in.");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(
      page.getByText("Second reply — confirming load-in."),
    ).toBeVisible({ timeout: 20_000 });

    // Two distinct emails to this address, and the second must reference the
    // first so a mail client groups the booking as ONE conversation rather
    // than N unrelated alerts.
    await expect
      .poll(
        async () => {
          const all = await mailpit.list();
          return all.filter((m) =>
            (m.To ?? []).some(
              (a) =>
                (a.Address ?? "").toLowerCase() === inquirer.email.toLowerCase(),
            ),
          ).length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(2);

    const all = await mailpit.list();
    const secondSummary = all.find(
      (m) =>
        m.ID !== first.ID &&
        (m.To ?? []).some(
          (a) =>
            (a.Address ?? "").toLowerCase() === inquirer.email.toLowerCase(),
        ),
    );
    expect(secondSummary, "a second outbound email should exist").toBeTruthy();

    const second = await mailpit.get(secondSummary!.ID);
    const hSecond = await headersOf(request, mailpit.origin, second.ID);

    // The follow-up must NOT carry In-Reply-To/References. We cannot know the
    // id the provider actually stamped on the first message, so any value we
    // put here names a message that does not exist — which is worse than
    // nothing: it is a threading instruction no client can satisfy, and it is
    // what made the real-world probe split into two Gmail threads.
    expect(hSecond("In-Reply-To")).toBeUndefined();
    expect(hSecond("References")).toBeUndefined();

    // The STABLE SUBJECT is what actually groups these for the recipient now,
    // so it is the thing worth pinning.
    expect(second.Subject).toBe(first.Subject);
  });
});
