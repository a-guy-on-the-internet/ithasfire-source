import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { HumanWithIdentity } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";

import { sendScannerOnboardingEmail } from "./send-scanner-onboarding-email";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const TARGET = "00000000-0000-4000-8000-0000000000aa";

const fixedClock: ClockPort = {
  now: () => new Date("2026-05-01T17:00:00Z"),
};

function targetHuman(): HumanWithIdentity {
  return {
    human: {
      id: TARGET,
      name: "Operator",
      status: "ACTIVE",
      roles: [],
    } as HumanWithIdentity["human"],
    identity: {
      authUserId: "auth-2",
      email: "operator@example.com",
      emailVerified: true,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    },
  };
}

function makeRepos(opts: {
  humanById?: HumanWithIdentity | null;
  humanByEmail?: HumanWithIdentity | null;
  membership?: OrgMembership | null;
  org?: OrganizationRecord | null;
}): Repos {
  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async () =>
        opts.humanById === undefined ? targetHuman() : opts.humanById,
      ),
      getByEmail: vi.fn(async () =>
        opts.humanByEmail === undefined ? targetHuman() : opts.humanByEmail,
      ),
    },
    authz: {
      // requireOrgMembership delegates to ensureOrgRole on the ports/authz
      // path; the use case under test calls it via `requireOrgMembership`
      // from lib/rbac which itself uses repos.authz.getOrgMembership.
      getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) => {
        if (humanId === ACTOR) {
          return {
            orgId: ORG_A,
            humanId: ACTOR,
            role: "OWNER",
          } as OrgMembership;
        }
        return opts.membership ?? null;
      }),
    },
    organizations: {
      getById: vi.fn(async () =>
        opts.org === undefined
          ? ({
              id: ORG_A,
              name: "Alpha",
              contactEmail: "support@alpha.test",
            } as OrganizationRecord)
          : opts.org,
      ),
    },
  };
  return repos as unknown as Repos;
}

function makeMailer() {
  const send = vi.fn(async () => undefined);
  return { send } as unknown as MailerPort & { send: ReturnType<typeof vi.fn> };
}

describe("sendScannerOnboardingEmail", () => {
  it("emails the recipient when targetEmail matches an existing scanner-role member", async () => {
    const repos = makeRepos({
      membership: {
        orgId: ORG_A,
        humanId: TARGET,
        role: "SCANNER",
      } as OrgMembership,
    });
    const mailer = makeMailer();

    const result = await sendScannerOnboardingEmail(
      {
        repos,
        clock: fixedClock,
        mailer,
        iosAppUrl: "https://testflight.apple.com/join/abc",
        androidAppUrl: null,
      },
      {
        actorHumanId: ACTOR,
        orgId: ORG_A,
        targetEmail: "operator@example.com",
      },
    );

    expect(result).toEqual({ sentTo: "operator@example.com" });
    expect(
      (mailer as unknown as { send: ReturnType<typeof vi.fn> }).send,
    ).toHaveBeenCalledTimes(1);
    const payload = (mailer as unknown as { send: ReturnType<typeof vi.fn> })
      .send.mock.calls[0]?.[0];
    expect(payload?.to).toEqual({ to: "operator@example.com" });
    expect(payload?.replyTo).toEqual({
      to: "support@alpha.test",
      name: "Alpha",
    });
    expect(payload?.template).toEqual({
      key: "scanner.onboarding",
      variables: {
        orgName: "Alpha",
        recipientEmail: "operator@example.com",
        iosAppUrl: "https://testflight.apple.com/join/abc",
        androidAppUrl: null,
      },
    });
    // Idempotency key: scanner-onboarding:{orgId}:{email}:{utc-day}
    expect(payload?.idempotencyKey).toBe(
      `scanner-onboarding:${ORG_A}:operator@example.com:2026-05-01`,
    );
  });

  it("rejects when target is not a member of the org", async () => {
    const repos = makeRepos({ membership: null });
    const mailer = makeMailer();

    await expect(
      sendScannerOnboardingEmail(
        {
          repos,
          clock: fixedClock,
          mailer,
          iosAppUrl: null,
          androidAppUrl: null,
        },
        {
          actorHumanId: ACTOR,
          orgId: ORG_A,
          targetEmail: "operator@example.com",
        },
      ),
    ).rejects.toMatchObject({ code: "TARGET_NOT_MEMBER" });
    expect(
      (mailer as unknown as { send: ReturnType<typeof vi.fn> }).send,
    ).not.toHaveBeenCalled();
  });

  it("rejects when target's role on the org is below SCANNER", async () => {
    const repos = makeRepos({
      membership: {
        orgId: ORG_A,
        humanId: TARGET,
        role: "VIEWER",
      } as OrgMembership,
    });
    const mailer = makeMailer();

    await expect(
      sendScannerOnboardingEmail(
        {
          repos,
          clock: fixedClock,
          mailer,
          iosAppUrl: null,
          androidAppUrl: null,
        },
        {
          actorHumanId: ACTOR,
          orgId: ORG_A,
          targetEmail: "operator@example.com",
        },
      ),
    ).rejects.toMatchObject({ code: "TARGET_LACKS_SCANNER_ROLE" });
  });

  it("collapses targetHumanId not-found and missing-email into a single not_found", async () => {
    const repos = makeRepos({ humanById: null });
    const mailer = makeMailer();

    await expect(
      sendScannerOnboardingEmail(
        {
          repos,
          clock: fixedClock,
          mailer,
          iosAppUrl: null,
          androidAppUrl: null,
        },
        { actorHumanId: ACTOR, orgId: ORG_A, targetHumanId: TARGET },
      ),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("propagates iosAppUrl=null and androidAppUrl=null to the template", async () => {
    const repos = makeRepos({
      membership: {
        orgId: ORG_A,
        humanId: TARGET,
        role: "ADMIN",
      } as OrgMembership,
    });
    const mailer = makeMailer();

    await sendScannerOnboardingEmail(
      {
        repos,
        clock: fixedClock,
        mailer,
        iosAppUrl: null,
        androidAppUrl: null,
      },
      {
        actorHumanId: ACTOR,
        orgId: ORG_A,
        targetEmail: "operator@example.com",
      },
    );

    const payload = (mailer as unknown as { send: ReturnType<typeof vi.fn> })
      .send.mock.calls[0]?.[0];
    expect(payload?.template?.variables).toMatchObject({
      iosAppUrl: null,
      androidAppUrl: null,
    });
  });
});
