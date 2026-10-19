import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The claim writes carry a per-person limit. A pending claim puts a place in
// CLAIM_PENDING, which stops moderators editing or archiving it, so a loop of
// claims across many places is a way to freeze them. Pinned here: each
// procedure spends its own bucket, keyed on the person and never on the place
// (so moving to the next place starts no new budget), and a spent bucket
// answers TOO_MANY_REQUESTS before the use case reads anything.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_A = "00000000-0000-4000-8000-00000000c1a1";
const PLACE_B = "00000000-0000-4000-8000-00000000c1a2";

/** Repos that record any read and fail it, so "the use case ran" is visible. */
function recordingRepos() {
  const touched: string[] = [];
  const repos = new Proxy(
    {},
    {
      get: (_target, repo: string | symbol) => {
        if (repo === "then") return undefined;
        if (String(repo) === "humans") {
          return { hasSecondFactorEnrolled: vi.fn(async () => true) };
        }
        touched.push(String(repo));
        return new Proxy(
          {},
          {
            get: (_t, method: string | symbol) => {
              if (method === "then") return undefined;
              return vi.fn(async () => {
                throw new Error(`reached ${String(repo)}.${String(method)}`);
              });
            },
          },
        );
      },
    },
  ) as unknown as Ctx["repos"];
  return { repos, touched };
}

const limiter = (deniedKeys: string[]) =>
  vi.fn(async (bucket: string) =>
    deniedKeys.includes(bucket)
      ? { allowed: false, remaining: 0, retryAfterSeconds: 120 }
      : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
  );

function callerFor(actorHumanId: string, consume: ReturnType<typeof limiter>) {
  const { repos, touched } = recordingRepos();
  const { caller } = createCaller(
    { places: placesRouter },
    {
      repos,
      actorHumanId,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
      // The claim takes its idempotency slot, then reads the place.
      idempotency: {
        begin: vi.fn(async () => true),
        get: vi.fn(async () => null),
        commit: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      } as unknown as Ctx["idempotency"],
    },
  );
  return { caller, touched };
}

type Caller = ReturnType<typeof callerFor>["caller"];

const submit = (caller: Caller, placeId: string, humanId: string) =>
  caller.places.submitPlaceClaim({
    placeId,
    owner: { kind: "human", humanId },
    proof: { kind: "email_domain_match" },
  });

const emailChallenge = (caller: Caller, placeId: string, _humanId: string) =>
  caller.places.requestClaimEmailChallenge({
    placeId,
    email: "owner@cornerbar.example",
  });

const docUpload = (caller: Caller, placeId: string, _humanId: string) =>
  caller.places.requestClaimDocUpload({
    placeId,
    contentType: "application/pdf",
    sizeBytes: 1024,
    fileName: "lease.pdf",
    context: "claim",
  });

describe("places claim procedures: per-person rate limits", () => {
  it.each([
    ["submitPlaceClaim", `places:claim:submit:${ACTOR_ID}`, 10, 3600, submit],
    [
      "requestClaimEmailChallenge",
      `places:claim:emailChallenge:${ACTOR_ID}`,
      10,
      3600,
      emailChallenge,
    ],
    // Already limited before this change; pinned so it cannot drift away.
    [
      "requestClaimDocUpload",
      `place:claimDocUpload:${PLACE_A}:${ACTOR_ID}`,
      20,
      60,
      docUpload,
    ],
  ] as const)(
    "%s: a spent bucket answers TOO_MANY_REQUESTS before the use case runs",
    async (_name, key, max, windowSeconds, call) => {
      const consume = limiter([key]);
      const { caller, touched } = callerFor(ACTOR_ID, consume);

      await expect(call(caller, PLACE_A, ACTOR_ID)).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(consume).toHaveBeenCalledWith(key, max, windowSeconds);
      expect(touched).toEqual([]);
    },
  );

  it.each([
    ["submitPlaceClaim", "places:claim:submit", submit],
    ["requestClaimEmailChallenge", "places:claim:emailChallenge", emailChallenge],
  ] as const)(
    "%s: the bucket follows the person across places, and is not shared with anyone else",
    async (_name, prefix, call) => {
      const actorKey = `${prefix}:${ACTOR_ID}`;
      const consume = limiter([actorKey]);

      // A different place does not reset the spent bucket.
      const { caller: actor } = callerFor(ACTOR_ID, consume);
      await expect(call(actor, PLACE_B, ACTOR_ID)).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });

      // Another person has their own bucket: the limiter lets them through to
      // the use case (which then fails on the recording repos).
      const { caller: other, touched } = callerFor(OTHER_ID, consume);
      await expect(call(other, PLACE_A, OTHER_ID)).rejects.not.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(consume).toHaveBeenCalledWith(`${prefix}:${OTHER_ID}`, 10, 3600);
      expect(touched.length).toBeGreaterThan(0);
    },
  );
});
