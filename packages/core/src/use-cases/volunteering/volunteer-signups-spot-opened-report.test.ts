import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";

import {
  withdrawVolunteerSignup,
  type VolunteerSignupDeps,
} from "./volunteer-signups";

// The spot-opened notice after an APPROVED withdrawal is a deliberate swallow:
// the withdrawal is persisted, only the admins' notice is lost. CLAUDE.md
// says such a swallow is reported (Sentry), not only error-logged, and a
// throwing reporter must never change the result.

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ROLE_ID = "00000000-0000-4000-8000-000000000010";
const SIGNUP_ID = "00000000-0000-4000-8000-000000000040";
const ADMIN_ID = "00000000-0000-4000-8000-000000000070";
const NOW = new Date("2026-06-01T12:00:00.000Z");

const signup = {
  id: SIGNUP_ID,
  eventId: EVENT_ID,
  roleId: ROLE_ID,
  shiftId: null,
  humanId: ACTOR_ID,
  status: "APPROVED",
};

function makeDeps(reportError: VolunteerSignupDeps["reportError"]) {
  const tx = {
    volunteering: {
      getSignup: vi.fn(async () => signup),
      updateSignupStatus: vi.fn(async () => ({
        ...signup,
        status: "WITHDRAWN",
      })),
      withdrawFutureClaimsBySignup: vi.fn(async () => 0),
      countPendingSignups: vi.fn(async () => 2),
      getEventRole: vi.fn(async () => ({ id: ROLE_ID, name: "Door" })),
      getShift: vi.fn(async () => null),
    },
    eventHumans: {
      listByEvent: vi.fn(async () => []),
      detach: vi.fn(),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        title: "Night Market",
      })),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, slug: "the-hall" })),
      listMembers: vi.fn(async () => ({
        items: [{ humanId: ADMIN_ID, role: "ADMIN" }],
        total: 1,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
  };
  const notify = vi.fn(async () => {
    throw new Error("smtp down");
  });
  const logger = { error: vi.fn() };
  const deps = {
    repos: {
      tx: vi.fn(async (fn: (t: TxRepos) => Promise<unknown>) =>
        fn(tx as unknown as TxRepos),
      ),
    } as unknown as Repos,
    authz: { hasStaffRole: vi.fn(async () => false) },
    clock: { now: () => NOW },
    notify,
    appBaseUrl: "https://test.local",
    logger,
    reportError,
  } as unknown as VolunteerSignupDeps;
  return { deps, notify, logger };
}

const input = { actorHumanId: ACTOR_ID, signupId: SIGNUP_ID };

describe("withdrawVolunteerSignup spot-opened notify failure", () => {
  it("is reported to Sentry and still error-logged; the withdrawal stands", async () => {
    const reportError = vi.fn();
    const { deps, notify, logger } = makeDeps(reportError);

    const result = await withdrawVolunteerSignup(deps, input);

    expect(result.status).toBe("WITHDRAWN");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "volunteering.withdrawVolunteerSignup.spot_opened_notify_failed",
      expect.objectContaining({ signupId: SIGNUP_ID, recipientHumanId: ADMIN_ID }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        useCase: "withdrawVolunteerSignup",
        stage: "notify",
      },
      extra: { signupId: SIGNUP_ID, recipientHumanId: ADMIN_ID },
    });
    expect((reportError.mock.calls[0] as unknown[])[0]).toMatchObject({
      message: "smtp down",
    });
  });

  it("a throwing reporter is swallowed: the withdrawal still resolves", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps, logger } = makeDeps(reportError);

    const result = await withdrawVolunteerSignup(deps, input);

    expect(result.status).toBe("WITHDRAWN");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
