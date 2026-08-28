/**
 * QA seed: populates the platform place-verification workbench
 * (`/platform/places`, Queue tab) with one request in every reviewable state
 * so a tester lands on a full queue instead of empty states.
 *
 * Drives the REAL use cases (submitPlaceVerification, acknowledgePlaceVerification,
 * reviewPlaceVerification) — no raw SQL for domain writes — so what you see
 * matches production behaviour (org-role gating, idempotency, doc soft-delete +
 * place verification flip on decision, audit trail, etc.). Places + org
 * ownership are set up through the places repo (`repos.places.upsert`), which is
 * a DTO method, not raw SQL.
 *
 * Creates (each on its own place, since submit is idempotent per-place):
 *   • 2 PENDING requests  — mixed docs (application/pdf + image/jpeg).
 *   • 1 IN_REVIEW request — acknowledged (locked) by a reviewer.
 *   • 1 APPROVED + 1 REJECTED terminal request — populates the "Reviewed" view.
 *
 * Sign in to review as:  admin@ithasfire.com / Dev-Login-2026!  (platform ADMIN).
 *
 * Run (local dev DB):
 *   pnpm -F api run seed:verification-qa
 * or:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm -F api exec tsx src/scripts/seed-place-verification-qa.ts
 *
 * Re-running creates a NEW set of [QA] places + requests each time (fresh place
 * IDs), so it's always safe to re-run and never mutates existing data.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createDbAuthZAdapter } from "@th/adapters/authz/db-authz-adapter";
import {
  submitPlaceVerification,
  acknowledgePlaceVerification,
  reviewPlaceVerification,
} from "@th/core/use-cases/places";
import {
  createFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";

// ── Seeded identities (see apps/api/src/scripts/seed/ids.ts + identity.ts) ──
// admin@ithasfire.com — the ONLY seeded staff human (roles: [USER, ADMIN]).
// It is both an ADMIN member of the Demo Org (so it can submit) and platform
// staff (so it can acknowledge/review).
const REVIEWER_HUMAN_ID = "00000000-0000-4000-8000-00000000d005";
// Demo Org (DEMO_IDS.org) — admin@ithasfire.com is an ADMIN member.
const ORG_ID = "00000000-0000-4000-8000-00000000d001";
// The submitter must be an OWNER/ADMIN of the org that owns the place; reuse the
// admin (the org-role gate on submit is satisfied by its ADMIN membership).
const SUBMITTER_HUMAN_ID = REVIEWER_HUMAN_ID;

/**
 * Only ONE staff human is seeded (admin@ithasfire.com). Without a SECOND staff
 * human we cannot demonstrate the true "locked to another reviewer" state, so
 * the IN_REVIEW request is acknowledged by the admin itself → the workbench
 * shows "locked to me" instead. See the run summary / report for this caveat.
 */
const SECOND_REVIEWER_HUMAN_ID: string | null = null;

/**
 * Best-effort file-storage stub. `reviewPlaceVerification` deletes verification
 * documents from object storage post-commit — but this seed writes only
 * plausible storageKeys (no real objects), and S3 isn't configured locally, so
 * every method throws. The use case catches the delete failure (best-effort,
 * non-fatal), which is exactly the behaviour we want here.
 */
class ThrowingFileStorage implements FileStoragePort {
  private fail(op: string): never {
    throw createFileStorageError("dependency_failed", `qa_seed_stub:${op}`);
  }
  putObject(): Promise<never> {
    return this.fail("putObject");
  }
  getObjectUrl(): Promise<never> {
    return this.fail("getObjectUrl");
  }
  deleteObject(): Promise<never> {
    return this.fail("deleteObject");
  }
  headObject(): Promise<never> {
    return this.fail("headObject");
  }
  getObject(): Promise<never> {
    return this.fail("getObject");
  }
  listObjects(): Promise<never> {
    return this.fail("listObjects");
  }
  presignPutObject(): Promise<never> {
    return this.fail("presignPutObject");
  }
  moveObject(): Promise<never> {
    return this.fail("moveObject");
  }
}

type SeedDoc = {
  storageKey: string;
  fileName: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  sizeBytes: number;
};

function docs(placeId: string, specs: Omit<SeedDoc, "storageKey">[]): SeedDoc[] {
  return specs.map((spec) => {
    const ext = spec.contentType === "application/pdf" ? "pdf" : "jpg";
    return {
      ...spec,
      // Mirror the real upload key shape:
      // place-verification/<placeId>/<uuid>.<ext>
      storageKey: `place-verification/${placeId}/${randomUUID()}.${ext}`,
    };
  });
}

async function main() {
  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  const authz = createDbAuthZAdapter({ repos });
  const storage = new ThrowingFileStorage();

  const stamp = clock.now().toISOString().slice(0, 16).replace("T", " ");

  // Fresh place per request each run — a place with an active (PENDING /
  // IN_REVIEW) request would short-circuit submit (idempotency), so isolating
  // one request per place keeps every state independently reproducible.
  const createPlace = async (input: {
    name: string;
    line1: string;
    city: string;
    region: string;
    postalCode: string;
    countryCode: string;
    lat: number;
    lng: number;
    capacity: number;
    phone: string;
    website: string;
  }) => {
    const formatted = `${input.line1}, ${input.city}, ${input.region} ${input.postalCode}`;
    const place = await repos.places.upsert({
      owner: { kind: "org", orgId: ORG_ID },
      name: input.name,
      address: {
        formatted,
        line1: input.line1,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        countryCode: input.countryCode,
      },
      geo: { lat: input.lat, lng: input.lng },
      capacity: input.capacity,
      phone: input.phone,
      website: input.website,
      websiteSource: "USER_STUB",
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
      listedInDirectory: false,
    });
    return place;
  };

  const summary: {
    placeName: string;
    placeId: string;
    requestId: string;
    status: string;
    docCount: number;
  }[] = [];

  // ── 1a. PENDING — mixed docs (PDF + JPEG) ────────────────────────────────
  console.log("\n▶ Creating PENDING request (PDF + JPEG)…");
  {
    const place = await createPlace({
      name: `[QA] The Blue Room — ${stamp}`,
      line1: "1414 4th Ave S",
      city: "Nashville",
      region: "TN",
      postalCode: "37210",
      countryCode: "US",
      lat: 36.1447,
      lng: -86.7736,
      capacity: 220,
      phone: "+16155550142",
      website: "https://theblueroom-qa.example.com",
    });
    const requestDocs = docs(place.id, [
      {
        fileName: "business-license.pdf",
        contentType: "application/pdf",
        sizeBytes: 284_133,
      },
      {
        fileName: "storefront.jpg",
        contentType: "image/jpeg",
        sizeBytes: 1_204_882,
      },
    ]);
    const res = await submitPlaceVerification(
      { repos, authz, clock },
      {
        actorHumanId: SUBMITTER_HUMAN_ID,
        placeId: place.id,
        orgId: ORG_ID,
        documents: requestDocs,
      },
    );
    summary.push({
      placeName: place.name,
      placeId: place.id,
      requestId: res.requestId,
      status: "PENDING",
      docCount: requestDocs.length,
    });
    console.log(`  ✓ ${place.name} → PENDING (${requestDocs.length} docs)`);
  }

  // ── 1b. PENDING — single PDF ─────────────────────────────────────────────
  console.log("▶ Creating PENDING request (PDF only)…");
  {
    const place = await createPlace({
      name: `[QA] Harborview Hall — ${stamp}`,
      line1: "600 River St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
      countryCode: "US",
      lat: 30.2589,
      lng: -97.7385,
      capacity: 480,
      phone: "+15125550188",
      website: "https://harborviewhall-qa.example.com",
    });
    const requestDocs = docs(place.id, [
      {
        fileName: "liquor-license.pdf",
        contentType: "application/pdf",
        sizeBytes: 512_004,
      },
    ]);
    const res = await submitPlaceVerification(
      { repos, authz, clock },
      {
        actorHumanId: SUBMITTER_HUMAN_ID,
        placeId: place.id,
        orgId: ORG_ID,
        documents: requestDocs,
      },
    );
    summary.push({
      placeName: place.name,
      placeId: place.id,
      requestId: res.requestId,
      status: "PENDING",
      docCount: requestDocs.length,
    });
    console.log(`  ✓ ${place.name} → PENDING (${requestDocs.length} docs)`);
  }

  // ── 2. IN_REVIEW — submitted then acknowledged (locked) ──────────────────
  console.log("▶ Creating IN_REVIEW request (acknowledged)…");
  {
    const place = await createPlace({
      name: `[QA] The Underground — ${stamp}`,
      line1: "2117 Belmont Blvd",
      city: "Nashville",
      region: "TN",
      postalCode: "37212",
      countryCode: "US",
      lat: 36.1329,
      lng: -86.7972,
      capacity: 150,
      phone: "+16155550170",
      website: "https://theunderground-qa.example.com",
    });
    const requestDocs = docs(place.id, [
      {
        fileName: "lease-agreement.pdf",
        contentType: "application/pdf",
        sizeBytes: 733_219,
      },
      {
        fileName: "marquee.jpg",
        contentType: "image/jpeg",
        sizeBytes: 902_551,
      },
    ]);
    const res = await submitPlaceVerification(
      { repos, authz, clock },
      {
        actorHumanId: SUBMITTER_HUMAN_ID,
        placeId: place.id,
        orgId: ORG_ID,
        documents: requestDocs,
      },
    );
    // Claim the lock. With only one staff human seeded, the admin acknowledges
    // its own request → workbench shows "locked to me" (substitute for the
    // "locked to another reviewer" state, which needs a 2nd staff human).
    const ackActor = SECOND_REVIEWER_HUMAN_ID ?? REVIEWER_HUMAN_ID;
    const ack = await acknowledgePlaceVerification(
      { repos, authz, clock },
      { actorHumanId: ackActor, requestId: res.requestId },
    );
    summary.push({
      placeName: place.name,
      placeId: place.id,
      requestId: res.requestId,
      status: `IN_REVIEW (locked to ${
        SECOND_REVIEWER_HUMAN_ID ? "another reviewer" : "me/admin"
      }, claimed=${ack.claimed})`,
      docCount: requestDocs.length,
    });
    console.log(
      `  ✓ ${place.name} → IN_REVIEW (acknowledged by ${ackActor}, ${requestDocs.length} docs)`,
    );
  }

  // ── 3a. APPROVED terminal ────────────────────────────────────────────────
  console.log("▶ Creating APPROVED (terminal) request…");
  {
    const place = await createPlace({
      name: `[QA] Sunset Amphitheater — ${stamp}`,
      line1: "3839 Cliff Dr",
      city: "Santa Barbara",
      region: "CA",
      postalCode: "93109",
      countryCode: "US",
      lat: 34.4009,
      lng: -119.7145,
      capacity: 4200,
      phone: "+18055550123",
      website: "https://sunsetamphitheater-qa.example.com",
    });
    const requestDocs = docs(place.id, [
      {
        fileName: "deed-of-ownership.pdf",
        contentType: "application/pdf",
        sizeBytes: 1_048_233,
      },
    ]);
    const submit = await submitPlaceVerification(
      { repos, authz, clock },
      {
        actorHumanId: SUBMITTER_HUMAN_ID,
        placeId: place.id,
        orgId: ORG_ID,
        documents: requestDocs,
      },
    );
    await reviewPlaceVerification(
      { repos, authz, storage, clock },
      {
        actorHumanId: REVIEWER_HUMAN_ID,
        requestId: submit.requestId,
        decision: "APPROVED",
        reviewerNotes: "Deed and business license check out. Verified.",
      },
    );
    summary.push({
      placeName: place.name,
      placeId: place.id,
      requestId: submit.requestId,
      status: "APPROVED",
      docCount: requestDocs.length,
    });
    console.log(`  ✓ ${place.name} → APPROVED`);
  }

  // ── 3b. REJECTED terminal (reviewerNotes ≥ 10 chars required) ────────────
  console.log("▶ Creating REJECTED (terminal) request…");
  {
    const place = await createPlace({
      name: `[QA] The Corner Tavern — ${stamp}`,
      line1: "88 Market St",
      city: "San Francisco",
      region: "CA",
      postalCode: "94103",
      countryCode: "US",
      lat: 37.7864,
      lng: -122.4014,
      capacity: 95,
      phone: "+14155550109",
      website: "https://thecornertavern-qa.example.com",
    });
    const requestDocs = docs(place.id, [
      {
        fileName: "utility-bill.pdf",
        contentType: "application/pdf",
        sizeBytes: 199_842,
      },
    ]);
    const submit = await submitPlaceVerification(
      { repos, authz, clock },
      {
        actorHumanId: SUBMITTER_HUMAN_ID,
        placeId: place.id,
        orgId: ORG_ID,
        documents: requestDocs,
      },
    );
    await reviewPlaceVerification(
      { repos, authz, storage, clock },
      {
        actorHumanId: REVIEWER_HUMAN_ID,
        requestId: submit.requestId,
        decision: "REJECTED",
        reviewerNotes:
          "Document is a utility bill, not proof of ownership. Please resubmit with a lease or deed.",
      },
    );
    summary.push({
      placeName: place.name,
      placeId: place.id,
      requestId: submit.requestId,
      status: "REJECTED",
      docCount: requestDocs.length,
    });
    console.log(`  ✓ ${place.name} → REJECTED`);
  }

  console.log(
    "\n──────────────────────────────────────────────────────────────────",
  );
  console.log("QA place-verification seed complete.");
  for (const row of summary) {
    console.log(
      `  • ${row.placeName}\n      status=${row.status}  docs=${row.docCount}` +
        `\n      placeId=${row.placeId}  requestId=${row.requestId}`,
    );
  }
  console.log(
    "\n  Workbench     : /platform/places  (Queue tab for PENDING/IN_REVIEW; Reviewed tab for APPROVED/REJECTED)",
  );
  console.log(
    "  Sign in as    : admin@ithasfire.com / Dev-Login-2026!  (platform ADMIN = reviewer)",
  );
  if (!SECOND_REVIEWER_HUMAN_ID) {
    console.log(
      "  Note          : only one staff human is seeded, so IN_REVIEW is 'locked to me' (no 'locked to another reviewer').",
    );
  }
  console.log(
    "  Note          : verification docs use plausible storageKeys with no real objects — JPEG thumbnails may 404; PDFs render as file cards with an Open button.",
  );
  console.log(
    "──────────────────────────────────────────────────────────────────\n",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("seed-place-verification-qa failed:", err);
  process.exit(1);
});
