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
 * Run (LOCAL docker DB only — the script refuses any non-local host):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev?schema=public \
 *     pnpm -F api exec tsx src/scripts/qa/seed-place-verification-qa.ts
 *
 * Staff second factor: acknowledge/review are staff actions, and the authz
 * adapter refuses a staff role without an enrolled second factor unless the
 * dev bypass is on. The script reads DEV_BYPASS_STAFF_2FA the way the local API
 * does (process env, then apps/api/.env.local, then the root .env.local) and
 * stops with instructions when it is off.
 *
 * Idempotent: each scenario's place is keyed by its fixed website (not shown as a name), so a
 * re-run finds the place (including ones a partial earlier run left behind),
 * reads its latest request, and only drives it forward to the scenario's
 * target state. Nothing is duplicated; a scenario already at its target is
 * skipped.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { getPrisma } from "@th/db";
import { createPrismaRepos } from "@th/adapters/db/prisma";
import { createSystemClock } from "@th/adapters/infra/clock";
import { createDbAuthZAdapter } from "@th/adapters/authz/db-authz-adapter";
import { requireStaffSecondFactorBypass } from "./lib/staff-second-factor-bypass";
import {
  submitPlaceVerification,
  acknowledgePlaceVerification,
  reviewPlaceVerification,
} from "@th/core/use-cases/places";
import {
  createFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";

// ─────────────────────────────────────────────────────────────────────────────
// Safety: LOCAL DOCKER ONLY (same guard as seed-reviews-qa.ts)
// ─────────────────────────────────────────────────────────────────────────────
//
// apps/api/.env points DATABASE_URL at the Neon dev CLOUD database, and
// `dotenv/config` loads it when no DATABASE_URL is set. Assert the host rather
// than trust that the caller prefixed the local URL.

const LOCAL_DB_URL =
  "postgresql://postgres:postgres@localhost:5432/dev?schema=public";

function assertLocalDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      `DATABASE_URL is not set. Prefix the run with DATABASE_URL=${LOCAL_DB_URL}`,
    );
  }
  const host = new URL(raw).hostname;
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db"]);
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL host is "${host}", not a local docker host.\n` +
        `This QA seed only ever writes to the local docker postgres. Re-run with:\n` +
        `  DATABASE_URL=${LOCAL_DB_URL} pnpm -F api exec tsx src/scripts/qa/seed-place-verification-qa.ts`,
    );
  }
  return host;
}

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

type TargetStatus = "PENDING" | "IN_REVIEW" | "APPROVED" | "REJECTED";

type Scenario = {
  target: TargetStatus;
  /** Name prefix; a partial earlier run appended " — <timestamp>". */
  name: string;
  place: {
    line1: string;
    city: string;
    region: string;
    postalCode: string;
    countryCode: string;
    lat: number;
    lng: number;
    capacity: number;
    phone: string;
    /** Fixed per scenario — the idempotency key for the scenario's place. */
    website: string;
  };
  docs: Omit<SeedDoc, "storageKey">[];
  reviewerNotes?: string;
};

const SCENARIOS: Scenario[] = [
  {
    target: "PENDING",
    name: "The Blue Room",
    place: {
      line1: "1414 4th Ave S",
      city: "Nashville",
      region: "TN",
      postalCode: "37210",
      countryCode: "US",
      lat: 36.1447,
      lng: -86.7736,
      capacity: 220,
      phone: "+16155550142",
      website: "https://theblueroom.example.com",
    },
    docs: [
      {
        fileName: "business-license.pdf",
        contentType: "application/pdf",
        sizeBytes: 284_133,
      },
      { fileName: "storefront.jpg", contentType: "image/jpeg", sizeBytes: 1_204_882 },
    ],
  },
  {
    target: "PENDING",
    name: "Harborview Hall",
    place: {
      line1: "600 River St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
      countryCode: "US",
      lat: 30.2589,
      lng: -97.7385,
      capacity: 480,
      phone: "+15125550188",
      website: "https://harborviewhall.example.com",
    },
    docs: [
      {
        fileName: "liquor-license.pdf",
        contentType: "application/pdf",
        sizeBytes: 512_004,
      },
    ],
  },
  {
    target: "IN_REVIEW",
    name: "The Underground",
    place: {
      line1: "2117 Belmont Blvd",
      city: "Nashville",
      region: "TN",
      postalCode: "37212",
      countryCode: "US",
      lat: 36.1329,
      lng: -86.7972,
      capacity: 150,
      phone: "+16155550170",
      website: "https://theunderground.example.com",
    },
    docs: [
      {
        fileName: "lease-agreement.pdf",
        contentType: "application/pdf",
        sizeBytes: 733_219,
      },
      { fileName: "marquee.jpg", contentType: "image/jpeg", sizeBytes: 902_551 },
    ],
  },
  {
    target: "APPROVED",
    name: "Sunset Amphitheater",
    place: {
      line1: "3839 Cliff Dr",
      city: "Santa Barbara",
      region: "CA",
      postalCode: "93109",
      countryCode: "US",
      lat: 34.4009,
      lng: -119.7145,
      capacity: 4200,
      phone: "+18055550123",
      website: "https://sunsetamphitheater.example.com",
    },
    docs: [
      {
        fileName: "deed-of-ownership.pdf",
        contentType: "application/pdf",
        sizeBytes: 1_048_233,
      },
    ],
    reviewerNotes: "Deed and business license check out. Verified.",
  },
  {
    target: "REJECTED",
    name: "The Corner Tavern",
    place: {
      line1: "88 Market St",
      city: "San Francisco",
      region: "CA",
      postalCode: "94103",
      countryCode: "US",
      lat: 37.7864,
      lng: -122.4014,
      capacity: 95,
      phone: "+14155550109",
      website: "https://thecornertavern.example.com",
    },
    docs: [
      {
        fileName: "utility-bill.pdf",
        contentType: "application/pdf",
        sizeBytes: 199_842,
      },
    ],
    // reviewerNotes ≥ 10 chars is required for a rejection.
    reviewerNotes:
      "Document is a utility bill, not proof of ownership. Please resubmit with a lease or deed.",
  },
];

async function main() {
  const host = assertLocalDatabase();
  const staffSecondFactorBypass = requireStaffSecondFactorBypass();
  console.log(`seed-place-verification-qa → local DB host "${host}"`);

  const prisma = getPrisma();
  const repos = createPrismaRepos(prisma);
  const clock = createSystemClock();
  // Same wiring as apps/api/src/lib/dep.ts: the dev-only bypass lets the
  // seeded admin (no enrolled second factor) act as staff.
  const authz = createDbAuthZAdapter({ repos, staffSecondFactorBypass });
  const storage = new ThrowingFileStorage();
  // `submitPlaceVerification` HEADs each new document (key prefix,
  // existence, size — F11). The seed has no real objects, so HEAD answers
  // "present, 1 byte" (every seed doc declares more); delete still throws.
  const submitStorage: Pick<FileStoragePort, "headObject" | "deleteObject"> = {
    headObject: async () => ({ exists: true, size: 1 }),
    deleteObject: () => storage.deleteObject(),
  };

  /**
   * Find the scenario's place (QA scaffolding read) or create it. The key is
   * the scenario's fixed website. Rows an earlier version of this seed made
   * carry a "-qa" website and a "[QA] ..." name; they are found by that legacy
   * website and renamed in place through the same `repos.places.upsert` path.
   */
  const findOrCreatePlace = async (s: Scenario) => {
    const legacyWebsite = s.place.website.replace(".example.com", "-qa.example.com");
    const existing = await prisma.place.findFirst({
      where: { website: { in: [s.place.website, legacyWebsite] } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        website: true,
        status: true,
        verification: true,
        listedInDirectory: true,
      },
    });
    if (existing) {
      if (existing.name !== s.name || existing.website !== s.place.website) {
        const q = s.place;
        // Keeps status / verification / listing as they are; only name and
        // website change. The address is re-sent because upsert rewrites it.
        await repos.places.upsert({
          placeId: existing.id,
          name: s.name,
          address: {
            formatted: `${q.line1}, ${q.city}, ${q.region} ${q.postalCode}`,
            line1: q.line1,
            city: q.city,
            region: q.region,
            postalCode: q.postalCode,
            countryCode: q.countryCode,
          },
          geo: { lat: q.lat, lng: q.lng },
          capacity: q.capacity,
          phone: q.phone,
          website: q.website,
          websiteSource: "USER_STUB",
          status: existing.status,
          verificationStatus: existing.verification,
          listedInDirectory: existing.listedInDirectory,
        });
      }
      return { id: existing.id, name: s.name, created: false };
    }
    const p = s.place;
    const place = await repos.places.upsert({
      owner: { kind: "org", orgId: ORG_ID },
      name: s.name,
      address: {
        formatted: `${p.line1}, ${p.city}, ${p.region} ${p.postalCode}`,
        line1: p.line1,
        city: p.city,
        region: p.region,
        postalCode: p.postalCode,
        countryCode: p.countryCode,
      },
      geo: { lat: p.lat, lng: p.lng },
      capacity: p.capacity,
      phone: p.phone,
      website: p.website,
      websiteSource: "USER_STUB",
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
      listedInDirectory: false,
    });
    return { id: place.id, name: place.name, created: true };
  };

  const summary: {
    placeName: string;
    placeId: string;
    requestId: string;
    status: string;
    action: string;
  }[] = [];

  for (const s of SCENARIOS) {
    console.log(`\n▶ ${s.name} → target ${s.target}`);
    const place = await findOrCreatePlace(s);
    const actions: string[] = [place.created ? "place created" : "place reused"];

    let request = await prisma.placeVerificationRequest.findFirst({
      where: { placeId: place.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    if (!request) {
      const requestDocs = docs(place.id, s.docs);
      const res = await submitPlaceVerification(
        { repos, authz, clock, storage: submitStorage },
        {
          actorHumanId: SUBMITTER_HUMAN_ID,
          placeId: place.id,
          orgId: ORG_ID,
          documents: requestDocs,
        },
      );
      request = { id: res.requestId, status: "PENDING" };
      actions.push(`submitted (${requestDocs.length} docs)`);
    }

    if (s.target === "IN_REVIEW" && request.status === "PENDING") {
      // With only one staff human seeded, the admin acknowledges its own
      // request → the workbench shows "locked to me".
      const ackActor = SECOND_REVIEWER_HUMAN_ID ?? REVIEWER_HUMAN_ID;
      await acknowledgePlaceVerification(
        { repos, authz, clock },
        { actorHumanId: ackActor, requestId: request.id },
      );
      request = { ...request, status: "IN_REVIEW" };
      actions.push("acknowledged");
    }

    if (
      (s.target === "APPROVED" || s.target === "REJECTED") &&
      (request.status === "PENDING" || request.status === "IN_REVIEW")
    ) {
      await reviewPlaceVerification(
        { repos, authz, storage, clock },
        {
          actorHumanId: REVIEWER_HUMAN_ID,
          requestId: request.id,
          decision: s.target,
          reviewerNotes: s.reviewerNotes,
        },
      );
      request = { ...request, status: s.target };
      actions.push(`reviewed → ${s.target}`);
    }

    if (request.status !== s.target) {
      console.warn(
        `  ! latest request is ${request.status}, not ${s.target}; left as is`,
      );
    }
    if (actions.length === 1) actions.push("already at target, skipped");
    console.log(`  ✓ ${place.name}: ${actions.join(", ")}`);
    summary.push({
      placeName: place.name,
      placeId: place.id,
      requestId: request.id,
      status: request.status,
      action: actions.join(", "),
    });
  }

  console.log(
    "\n──────────────────────────────────────────────────────────────────",
  );
  console.log("QA place-verification seed complete.");
  for (const row of summary) {
    console.log(
      `  • ${row.placeName}\n      status=${row.status}  (${row.action})` +
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
