import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which editor the place page's "Edit page" action opens: an owner's admin
 * route, the moderator route for an unowned place (moderator-place-page D8),
 * or nothing. The moderator probe is chained on the owner read FAILING, so
 * owners and anonymous viewers never fire it.
 */

const session = vi.hoisted(() => ({
  data: null as null | { user: { id: string } },
}));
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: session.data, isPending: false }),
  },
}));

const owners = vi.hoisted(() => ({
  list: undefined as unknown,
}));
vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({ ownersWithSlugs: owners.list }),
}));

const q = vi.hoisted(() => ({
  edit: {} as Record<string, unknown>,
  probe: undefined as unknown,
  probeEnabled: [] as boolean[],
  role: { allowed: true, secondFactorEnrolled: true } as unknown,
  roleEnabled: [] as boolean[],
}));
vi.mock("@/trpc", () => ({
  trpc: {
    places: { getPlaceForEdit: { useQuery: () => q.edit } },
    community: {
      checkModeratorAccess: {
        useQuery: (_input: unknown, opts: { enabled: boolean }) => {
          q.roleEnabled.push(opts.enabled);
          return { data: opts.enabled ? q.role : undefined };
        },
      },
    },
    entityPages: {
      placePageEditAccess: {
        useQuery: (_input: unknown, opts: { enabled: boolean }) => {
          q.probeEnabled.push(opts.enabled);
          return { data: opts.enabled ? q.probe : undefined };
        },
      },
    },
  },
}));

import { useVenueEditorLink } from "../useVenueEditorLink";

const PLACE = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  session.data = { user: { id: "h1" } };
  owners.list = undefined;
  q.edit = { isSuccess: false, isError: true, data: undefined };
  q.probe = undefined;
  q.probeEnabled = [];
  q.role = { allowed: true, secondFactorEnrolled: true };
  q.roleEnabled = [];
});

describe("useVenueEditorLink", () => {
  it("an owner gets the admin editor and the probe never fires", () => {
    q.edit = {
      isSuccess: true,
      isError: false,
      data: { place: { access: { orgIds: ["o1"], humanIds: [] } } },
    };
    owners.list = [{ kind: "org", orgId: "o1", adminSlug: "acme" }];
    const { result } = renderHook(() => useVenueEditorLink(PLACE));
    expect(result.current.href).toBe(`/admin/acme/places/${PLACE}/page`);
    expect(q.roleEnabled).not.toContain(true);
    expect(q.probeEnabled).not.toContain(true);
  });

  it("a community moderator on an unowned place gets the moderator route", () => {
    q.probe = {
      canEditPage: true,
      editorKind: "community_moderator",
      reason: null,
    };
    const { result } = renderHook(() => useVenueEditorLink(PLACE));
    expect(result.current.href).toBe(`/moderate/places/${PLACE}/page`);
  });

  it("a signed-in non-moderator never sends the place probe", () => {
    q.role = { allowed: false, secondFactorEnrolled: false };
    q.probe = {
      canEditPage: true,
      editorKind: "community_moderator",
      reason: null,
    };
    const { result } = renderHook(() => useVenueEditorLink(PLACE));
    expect(q.roleEnabled).toContain(true);
    expect(q.probeEnabled).not.toContain(true);
    expect(result.current.href).toBeNull();
  });

  it("a moderator without a second factor still reaches the probe, but gets no link", () => {
    q.role = { allowed: true, secondFactorEnrolled: false };
    q.probe = {
      canEditPage: false,
      editorKind: null,
      reason: "SECOND_FACTOR_REQUIRED",
    };
    const { result } = renderHook(() => useVenueEditorLink(PLACE));
    expect(q.probeEnabled).toContain(true);
    expect(result.current.href).toBeNull();
  });

  it("a refused probe (claim pending) gives no link", () => {
    q.probe = { canEditPage: false, editorKind: null, reason: "CLAIM_PENDING" };
    const { result } = renderHook(() => useVenueEditorLink(PLACE));
    expect(result.current.href).toBeNull();
  });

  it("a signed-out viewer fires nothing", () => {
    session.data = null;
    q.probe = {
      canEditPage: true,
      editorKind: "community_moderator",
      reason: null,
    };
    const { result } = renderHook(() => useVenueEditorLink(PLACE));
    expect(result.current.href).toBeNull();
    expect(q.probeEnabled).not.toContain(true);
  });
});
