import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { beforeEach, describe, expect, it } from "vitest";

import { hookPath } from "../src/auth/profile-image-sync";
import {
  prismaUnprovenEmailMoveLookup,
  refuseUnprovenEmailMove,
} from "../src/auth/unproven-email-move";

/**
 * B2 against a REAL `betterAuth()` (memory adapter): the production
 * `refuseUnprovenEmailMove` runs as `user.update.before`, exactly as
 * `better-auth.ts` calls it, and a real `/email-otp/change-email` request
 * drives it. This pins what the unit test only assumes: that the hook context
 * of that endpoint carries `path` and `context.session.user.id`.
 *
 * The OTP is requested through Better Auth's own `/email-otp/request-email-
 * change` here (production refuses that route and stores the code from
 * `POST /api/account/email-change/request` instead; the stored identifier is
 * the same, so `/email-otp/change-email` behaves the same).
 */

const BASE_URL = "https://api.ithasfire.com";
const AUTH_BASE = `${BASE_URL}/api/auth`;
const PASSWORD = "correct-horse-battery-staple";

type Row = Record<string, unknown>;
type MemoryDb = Record<string, Row[]>;

let db: MemoryDb;
let mailedOtps: Map<string, string>;
/**
 * Email-attached rows by Human id, one set per table the production lookup
 * queries. The memory schema has no humanId column: the user id stands in.
 */
type Attached = "order" | "ticket" | "coordinator" | "lineup";
let attached: Record<Attached, Set<string>>;

const hit = (table: Attached, humanId: string) =>
  attached[table].has(humanId) ? { id: `${table}-${humanId}` } : null;

// The PRODUCTION lookup, over a Prisma-shaped fake of the memory tables, so
// the generalised "holds anything attached by email" query is what runs.
const lookup = prismaUnprovenEmailMoveLookup({
  authUser: {
    findUnique: async ({ where }) => {
      const row = db.user!.find((u) => u.id === where.id);
      return row
        ? { emailVerified: Boolean(row.emailVerified), humanId: where.id }
        : null;
    },
  },
  order: { findFirst: async ({ where }) => hit("order", where.buyerHumanId) },
  ticket: { findFirst: async ({ where }) => hit("ticket", where.ownerHumanId) },
  volunteerGroup: {
    findFirst: async ({ where }) =>
      hit("coordinator", where.coordinatorHumanId),
  },
  eventHuman: { findFirst: async ({ where }) => hit("lineup", where.humanId) },
});

const buildAuth = () =>
  betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-32",
    database: memoryAdapter(db),
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [
      emailOTP({
        disableSignUp: true,
        // Production's setting (better-auth.ts).
        changeEmail: { enabled: true, verifyCurrentEmail: false },
        sendVerificationOTP: async ({ email, otp }) => {
          mailedOtps.set(email, otp);
        },
      }),
    ],
    databaseHooks: {
      user: {
        update: {
          // The production call (better-auth.ts `user.update.before`).
          before: async (_data, ctx) => {
            await refuseUnprovenEmailMove(lookup, hookPath(ctx), ctx);
          },
        },
      },
    },
  });

let auth: ReturnType<typeof buildAuth>;

const request = (
  path: string,
  init: { body?: unknown; cookie?: string } = {},
) =>
  auth.handler(
    new Request(`${AUTH_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE_URL,
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );

const sessionCookieFrom = (response: Response): string => {
  const cookie = response.headers
    .getSetCookie()
    .map((h) => h.split(";")[0]!)
    .find((pair) => /session_token=.+/.test(pair));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
};

const userRow = (email: string): Row => {
  const row = db.user!.find((u) => u.email === email);
  if (!row) throw new Error(`no user ${email}`);
  return row;
};

/** Sign up, set the verification flag, and return the session cookie. */
const createAccount = async (email: string, emailVerified: boolean) => {
  const res = await request("/sign-up/email", {
    body: { email, password: PASSWORD, name: email.split("@")[0] },
  });
  expect(res.status).toBe(200);
  const cookie = sessionCookieFrom(res);
  userRow(email).emailVerified = emailVerified;
  return { cookie, id: userRow(email).id as string };
};

const changeEmail = async (cookie: string, newEmail: string) => {
  const requested = await request("/email-otp/request-email-change", {
    body: { newEmail },
    cookie,
  });
  expect(requested.status).toBe(200);
  const otp = mailedOtps.get(newEmail);
  expect(otp).toBeTruthy();
  return request("/email-otp/change-email", {
    body: { newEmail, otp },
    cookie,
  });
};

describe("refuseUnprovenEmailMove on a real better-auth instance (B2)", () => {
  beforeEach(() => {
    db = { user: [], session: [], account: [], verification: [] };
    mailedOtps = new Map();
    attached = {
      order: new Set(),
      ticket: new Set(),
      coordinator: new Set(),
      lineup: new Set(),
    };
    auth = buildAuth();
  });

  it("refuses an unverified account that holds orders: 403, address unchanged", async () => {
    const squatter = await createAccount("victim@example.test", false);
    attached.order.add(squatter.id);

    const res = await changeEmail(squatter.cookie, "squatter@example.test");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "VERIFY_CURRENT_EMAIL_FIRST",
    });
    const row = db.user!.find((u) => u.id === squatter.id)!;
    expect(row.email).toBe("victim@example.test");
    expect(row.emailVerified).toBe(false);
  });

  it("lets a verified account change its address", async () => {
    const owner = await createAccount("owner@example.test", true);
    attached.order.add(owner.id);

    const res = await changeEmail(owner.cookie, "owner-new@example.test");

    expect(res.status).toBe(200);
    expect(db.user!.find((u) => u.id === owner.id)!.email).toBe(
      "owner-new@example.test",
    );
  });

  it("lets an unverified account with nothing on it fix a typo", async () => {
    const fresh = await createAccount("tpyo@example.test", false);

    const res = await changeEmail(fresh.cookie, "typo@example.test");

    expect(res.status).toBe(200);
    const row = db.user!.find((u) => u.id === fresh.id)!;
    expect(row.email).toBe("typo@example.test");
    expect(row.emailVerified).toBe(true);
  });

  it.each([
    ["only a coordinator seat", "coordinator"],
    ["only a lineup link", "lineup"],
    ["only a ticket", "ticket"],
  ] as const)(
    "refuses an unverified account holding %s: 403, address unchanged",
    async (_label, table) => {
      const squatter = await createAccount("victim@example.test", false);
      attached[table].add(squatter.id);

      const res = await changeEmail(squatter.cookie, "squatter@example.test");

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "VERIFY_CURRENT_EMAIL_FIRST",
      });
      const row = db.user!.find((u) => u.id === squatter.id)!;
      expect(row.email).toBe("victim@example.test");
      expect(row.emailVerified).toBe(false);
    },
  );
});
