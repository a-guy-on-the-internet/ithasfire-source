import { describe, expect, it, vi } from "vitest";

import { savedSnippetListKey } from "@th/test-utils/fakes/saved-snippets";

import {
  createSavedSnippet,
  deleteSavedSnippet,
  listSavedSnippets,
  reorderSavedSnippets,
  STARTER_DECLINE_REASONS,
  STARTER_REASON_KEYS,
  updateSavedSnippet,
} from "..";
import {
  EDITOR_ID,
  GRANTEE_ID,
  HUMAN_OWNER_ID,
  MISSING_PLACE_ID,
  NOW,
  ORG_ID,
  OTHER_ORG_ID,
  OUTSIDER_ID,
  PLACE_ID,
  VIEWER_ID,
  buildSavedSnippetsTestContext,
} from "./saved-snippets-test-context";

const SELF = { kind: "self" } as const;
const ORG = { kind: "org", orgId: ORG_ID } as const;
const PLACE = { kind: "place", placeId: PLACE_ID } as const;

const EN_LABELS = STARTER_REASON_KEYS.map((k) => STARTER_DECLINE_REASONS.en[k].label);
const ES_LABELS = STARTER_REASON_KEYS.map((k) => STARTER_DECLINE_REASONS.es[k].label);

const listKey = (ownerType: "HUMAN" | "ORGANIZATION", ownerId: string) =>
  savedSnippetListKey({ ownerType, ownerId, kind: "DECLINE_REASON" });

describe("listSavedSnippets — first use copies the starters", () => {
  it("copies the starters once, in order, as starters, under the list lock", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const out = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });

    expect(out.ownerType).toBe("HUMAN");
    expect(out.snippets.map((s) => s.label)).toEqual(EN_LABELS);
    expect(out.snippets.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.snippets.every((s) => s.isStarter && s.kind === "DECLINE_REASON")).toBe(true);
    expect(out).toMatchObject({ total: 6, max: 30 });

    const key = listKey("HUMAN", EDITOR_ID);
    expect(ctx.savedSnippets.lockCalls.get(key)).toBe(1);
    expect(ctx.savedSnippets.lists.get(key)!.startersCopiedAt).toEqual(NOW);
    // The audit row is written inside the transaction, before it commits.
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "saved_snippets.starters_copied",
        data: expect.objectContaining({ ownerType: "HUMAN", ownerId: EDITOR_ID, locale: "en", count: 6 }),
      }),
    );
    expect(ctx.audit.log.mock.invocationCallOrder[0]!).toBeLessThan(
      ctx.txCommitted.mock.invocationCallOrder[0]!,
    );
  });

  it("a read of a list with reasons in it takes no lock and opens no transaction", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    ctx.tx.mockClear();
    const getListState = vi.spyOn(ctx.savedSnippets, "getListState");

    const again = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    expect(again.snippets.map((s) => s.label)).toEqual(EN_LABELS);
    expect(ctx.tx).not.toHaveBeenCalled();
    expect(getListState).not.toHaveBeenCalled();
    expect(ctx.savedSnippets.lockCalls.get(listKey("HUMAN", EDITOR_ID))).toBe(1);
  });

  it("an empty first read whose list state says 'copied' re-reads the list once (a concurrent first use committed)", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    ctx.tx.mockClear();
    // The first plain read ran before the other first use committed.
    const listByOwner = vi.spyOn(ctx.savedSnippets, "listByOwner").mockResolvedValueOnce([]);

    const out = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    expect(out.snippets.map((s) => s.label)).toEqual(EN_LABELS);
    expect(listByOwner).toHaveBeenCalledTimes(2);
    expect(ctx.tx).not.toHaveBeenCalled();
  });

  it("deleting every reason never brings the starters back, and the empty read takes no lock", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const first = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    for (const s of first.snippets) {
      await deleteSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, snippetId: s.id });
    }
    ctx.tx.mockClear();

    const empty = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    expect(empty).toMatchObject({ snippets: [], total: 0 });
    expect(ctx.tx).not.toHaveBeenCalled();
    expect(ctx.savedSnippets.lockCalls.get(listKey("HUMAN", EDITOR_ID))).toBe(1);
  });

  it("copies in the requested locale, else the stored one (language subtag), else English", async () => {
    const ctx = buildSavedSnippetsTestContext({
      humanLocales: { [EDITOR_ID]: "es-MX", [VIEWER_ID]: "fr-FR" },
    });

    const asked = await listSavedSnippets(ctx.deps, { actorHumanId: OUTSIDER_ID, owner: SELF, locale: "es" });
    expect(asked.snippets.map((s) => s.label)).toEqual(ES_LABELS);

    const stored = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    expect(stored.snippets.map((s) => s.label)).toEqual(ES_LABELS);

    const unknown = await listSavedSnippets(ctx.deps, { actorHumanId: VIEWER_ID, owner: SELF });
    expect(unknown.snippets.map((s) => s.label)).toEqual(EN_LABELS);

    // The requested locale wins over the stored one.
    const override = await listSavedSnippets(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: ORG,
      locale: "en",
    });
    expect(override.snippets.map((s) => s.label)).toEqual(EN_LABELS);
  });

  it("refuses a locale it has no starters for, and the reserved ASK kind", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, locale: "fr" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, kind: "ASK" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maxBodyLength offers only reasons that fit; total still counts the list", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const long = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      label: "Long one",
      body: "x".repeat(241),
    });
    const exact = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      label: "Exactly fits",
      body: "y".repeat(240),
    });

    const pass = await listSavedSnippets(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      maxBodyLength: 240,
    });
    const ids = pass.snippets.map((s) => s.id);
    expect(ids).not.toContain(long.snippet.id);
    expect(ids).toContain(exact.snippet.id);
    expect(pass.snippets).toHaveLength(7); // six starters fit an act's pass
    expect(pass.total).toBe(8);

    const full = await listSavedSnippets(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      maxBodyLength: 1000,
    });
    expect(full.snippets).toHaveLength(8);

    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, maxBodyLength: 1001 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("listSavedSnippets — a failed starter copy degrades (ReporterPort)", () => {
  it("returns the list without starters, logs and reports; the next read copies them", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const boom = new Error("lock timeout");
    // Fails before anything is written, so the fake holds exactly what a real
    // rollback would leave: nothing.
    vi.spyOn(ctx.savedSnippets, "lockList").mockRejectedValueOnce(boom);

    const out = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: ORG });
    expect(out).toMatchObject({ ownerType: "ORGANIZATION", snippets: [], total: 0 });
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "saved_snippets.starter_copy_failed",
      expect.objectContaining({ err: boom, ownerType: "ORGANIZATION", ownerId: ORG_ID }),
    );
    expect(ctx.reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "listSavedSnippets", step: "copy_starters" },
      extra: expect.objectContaining({ ownerType: "ORGANIZATION", ownerId: ORG_ID, kind: "DECLINE_REASON" }),
    });

    expect(ctx.savedSnippets.rows.size).toBe(0);

    // The retry: the next read copies the starters.
    const retry = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: ORG });
    expect(retry.snippets.map((s) => s.label)).toEqual(EN_LABELS);
    expect(ctx.savedSnippets.lists.get(listKey("ORGANIZATION", ORG_ID))!.startersCopiedAt).toEqual(NOW);
    expect(ctx.reportError).toHaveBeenCalledTimes(1);
  });

  it("a copy that fails AFTER writing rows leaves the marker unset (the real tx rolls the rows back)", async () => {
    const ctx = buildSavedSnippetsTestContext();
    vi.spyOn(ctx.savedSnippets, "markStartersCopied").mockRejectedValueOnce(new Error("boom"));
    const out = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: ORG });
    expect(out).toMatchObject({ snippets: [], total: 0 });
    expect(ctx.savedSnippets.lists.get(listKey("ORGANIZATION", ORG_ID))!.startersCopiedAt).toBeNull();
    expect(ctx.reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing reporter does not change the result", async () => {
    const ctx = buildSavedSnippetsTestContext();
    vi.spyOn(ctx.savedSnippets, "lockList").mockRejectedValueOnce(new Error("db down"));
    ctx.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF }),
    ).resolves.toMatchObject({ snippets: [], total: 0 });
    expect(ctx.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error).toHaveBeenCalledTimes(1);
  });

  it("an authz refusal is NOT swallowed", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: OUTSIDER_ID, owner: PLACE }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.reportError).not.toHaveBeenCalled();
  });
});

describe("createSavedSnippet", () => {
  it("a create on a never-used list copies the starters first, then appends", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: ORG,
      label: "Private hire",
      body: "We have a private hire that night.",
    });
    expect(snippet).toMatchObject({ label: "Private hire", sortOrder: 6, isStarter: false });

    const list = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: ORG });
    expect(list.snippets.map((s) => s.label)).toEqual([...EN_LABELS, "Private hire"]);
    expect(ctx.savedSnippets.lockCalls.get(listKey("ORGANIZATION", ORG_ID))).toBe(1);
    expect(ctx.audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "saved_snippet.created", entityId: snippet.id }),
    );
  });

  it("appends after the highest sortOrder, not the count", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const first = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    await deleteSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      snippetId: first.snippets[0]!.id,
    });
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      label: "New",
      body: "New",
    });
    expect(snippet.sortOrder).toBe(6);
  });

  it("enforces the 30-per-list cap under the lock and writes nothing past it", async () => {
    const ctx = buildSavedSnippetsTestContext();
    for (let i = 0; i < 24; i += 1) {
      await createSavedSnippet(ctx.deps, {
        actorHumanId: EDITOR_ID,
        owner: SELF,
        label: `Reason ${i}`,
        body: `Body ${i}`,
      });
    }
    // 6 starters + 24 = 30.
    expect(ctx.savedSnippets.rows.size).toBe(30);
    const lockList = vi.spyOn(ctx.savedSnippets, "lockList");
    const listByOwner = vi.spyOn(ctx.savedSnippets, "listByOwner");

    await expect(
      createSavedSnippet(ctx.deps, {
        actorHumanId: EDITOR_ID,
        owner: SELF,
        label: "One too many",
        body: "Nope",
      }),
    ).rejects.toMatchObject({ code: "SAVED_SNIPPET_LIMIT_REACHED", meta: { max: 30 } });
    expect(ctx.savedSnippets.rows.size).toBe(30);
    // The count was taken AFTER the lock, inside the same transaction.
    expect(lockList.mock.invocationCallOrder[0]!).toBeLessThan(
      listByOwner.mock.invocationCallOrder[0]!,
    );

    // Deleting one makes room again.
    const [some] = await ctx.savedSnippets.listByOwner({ ownerType: "HUMAN", ownerId: EDITOR_ID });
    await deleteSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, snippetId: some!.id });
    await expect(
      createSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, label: "Fits", body: "Fits" }),
    ).resolves.toMatchObject({ snippet: { label: "Fits" } });
  });

  it("sanitizes label and body before the bounds, and keeps the body's line breaks", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      label: "  <b>Booked</b>‮  out ",
      body: "<script>x</script>Line one\nLine   two",
    });
    expect(snippet.label).toBe("Booked out");
    expect(snippet.body).toBe("Line one\nLine two");

    for (const bad of [
      { label: "<i></i>", body: "ok" },
      { label: "ok", body: "   " },
      { label: "l".repeat(61), body: "ok" },
      { label: "ok", body: "b".repeat(501) },
    ]) {
      await expect(
        createSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, ...bad }),
        JSON.stringify(bad).slice(0, 40),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("never accepts a client-supplied owner pair", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await expect(
      createSavedSnippet(ctx.deps, {
        actorHumanId: EDITOR_ID,
        owner: SELF,
        ownerType: "ORGANIZATION",
        ownerId: OTHER_ORG_ID,
        label: "x",
        body: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createSavedSnippet(ctx.deps, {
        actorHumanId: EDITOR_ID,
        owner: { kind: "self", ownerId: OTHER_ORG_ID },
        label: "x",
        body: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ctx.savedSnippets.rows.size).toBe(0);
  });
});

describe("updateSavedSnippet / deleteSavedSnippet — owner-scoped", () => {
  it("updates a reason (a starter stays a starter)", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const list = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    const starter = list.snippets[0]!;
    const { snippet } = await updateSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      snippetId: starter.id,
      body: "Not that night, sorry.",
    });
    expect(snippet).toMatchObject({ id: starter.id, label: starter.label, body: "Not that night, sorry.", isStarter: true });
    expect(ctx.audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "saved_snippet.updated",
        data: expect.objectContaining({ changed: ["body"] }),
      }),
    );
  });

  it("another owner's id is NOT_FOUND on update and a no-op on delete", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const theirs = await createSavedSnippet(ctx.deps, {
      actorHumanId: OUTSIDER_ID,
      owner: SELF,
      label: "Theirs",
      body: "Theirs",
    });

    await expect(
      updateSavedSnippet(ctx.deps, {
        actorHumanId: EDITOR_ID,
        owner: SELF,
        snippetId: theirs.snippet.id,
        label: "Mine now",
      }),
    ).rejects.toMatchObject({ code: "SAVED_SNIPPET_NOT_FOUND" });

    await expect(
      deleteSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, snippetId: theirs.snippet.id }),
    ).resolves.toEqual({ snippetId: theirs.snippet.id, deleted: false });
    expect(ctx.savedSnippets.rows.get(theirs.snippet.id)!.label).toBe("Theirs");
  });

  it("update needs something to change; delete is idempotent", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: SELF,
      label: "x",
      body: "x",
    });
    await expect(
      updateSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, snippetId: snippet.id }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: "nothing_to_update" });

    await expect(
      deleteSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, snippetId: snippet.id }),
    ).resolves.toEqual({ snippetId: snippet.id, deleted: true });
    await expect(
      deleteSavedSnippet(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, snippetId: snippet.id }),
    ).resolves.toEqual({ snippetId: snippet.id, deleted: false });
  });
});

describe("reorderSavedSnippets", () => {
  it("takes the list lock, rewrites the order and audits it", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const list = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: ORG });
    const reversed = [...list.snippets].reverse().map((s) => s.id);

    const out = await reorderSavedSnippets(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: ORG,
      orderedIds: reversed,
    });
    expect(out.snippets.map((s) => s.id)).toEqual(reversed);
    expect(out.snippets.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ctx.savedSnippets.lockCalls.get(listKey("ORGANIZATION", ORG_ID))).toBe(2);
    expect(ctx.audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "saved_snippets.reordered" }),
    );
  });

  it("a stale order is SAVED_SNIPPET_ORDER_CHANGED and writes nothing", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const list = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    const ids = list.snippets.map((s) => s.id);
    const auditCalls = ctx.audit.log.mock.calls.length;

    for (const orderedIds of [ids.slice(1), [...ids, ids[0]!], [...ids.slice(1), OTHER_ORG_ID]]) {
      await expect(
        reorderSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF, orderedIds }),
      ).rejects.toMatchObject({ code: "SAVED_SNIPPET_ORDER_CHANGED" });
    }
    const after = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: SELF });
    expect(after.snippets.map((s) => s.id)).toEqual(ids);
    expect(ctx.audit.log.mock.calls.length).toBe(auditCalls);
  });
});

describe("owner resolution and authz", () => {
  it("a place's list is its owning org's for an EDITOR, who may read and write it", async () => {
    const ctx = buildSavedSnippetsTestContext();
    const read = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: PLACE });
    expect(read.ownerType).toBe("ORGANIZATION");
    // The same list the org route names.
    const viaOrg = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: ORG });
    expect(viaOrg.snippets.map((s) => s.id)).toEqual(read.snippets.map((s) => s.id));

    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: PLACE,
      label: "Place reason",
      body: "Place reason",
    });
    expect(ctx.savedSnippets.rows.get(snippet.id)).toMatchObject({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });
  });

  it("a VIEWER may neither read nor write the place's or the org's list", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: VIEWER_ID, owner: PLACE }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      createSavedSnippet(ctx.deps, { actorHumanId: VIEWER_ID, owner: PLACE, label: "x", body: "x" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: VIEWER_ID, owner: ORG }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      createSavedSnippet(ctx.deps, { actorHumanId: VIEWER_ID, owner: ORG, label: "x", body: "x" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("an outsider is refused on every route but their own", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: OUTSIDER_ID, owner: PLACE }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      updateSavedSnippet(ctx.deps, {
        actorHumanId: OUTSIDER_ID,
        owner: PLACE,
        snippetId: "5e5e5e5e-0000-4000-8000-0000000000ee",
        label: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      reorderSavedSnippets(ctx.deps, { actorHumanId: OUTSIDER_ID, owner: ORG, orderedIds: [] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: OUTSIDER_ID, owner: { kind: "place", placeId: MISSING_PLACE_ID } }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    // Nothing was locked or copied for a refused caller.
    expect(ctx.savedSnippets.lockCalls.size).toBe(0);
  });

  // holds-without-a-request FR-002: no capability flags (H3), and the grant
  // is resolved through its grantee (H2): the person, an edit-role delegate
  // of theirs, an edit-role member of a grantee org. Reading stays the only
  // thing it allows here.
  const DELEGATE_ID = "5e5e5e5e-0000-4000-8000-000000000006";
  const GRANTEE_ORG_EDITOR_ID = "5e5e5e5e-0000-4000-8000-000000000007";
  const granteeSetups = {
    person: { actor: GRANTEE_ID },
    delegate: { actor: DELEGATE_ID },
    "grantee-org editor": { actor: GRANTEE_ORG_EDITOR_ID },
  } as const;
  function buildWithGrantee(kind: keyof typeof granteeSetups) {
    const ctx = buildSavedSnippetsTestContext({
      memberships: [
        { orgId: ORG_ID, humanId: EDITOR_ID, role: "EDITOR" },
        { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
        { orgId: OTHER_ORG_ID, humanId: GRANTEE_ORG_EDITOR_ID, role: "EDITOR" },
      ],
      delegations: [{ principalId: GRANTEE_ID, delegateId: DELEGATE_ID, role: "EDITOR" }],
    });
    if (kind === "grantee-org editor") {
      ctx.placeBookingGrants.seed({ placeId: PLACE_ID, grantee: { kind: "org", orgId: OTHER_ORG_ID } });
    } else {
      ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });
    }
    return { ctx, actor: granteeSetups[kind].actor };
  }

  it.each(Object.keys(granteeSetups) as (keyof typeof granteeSetups)[])(
    "a booking grantee (%s) may READ the place's list but never edit it",
    async (kind) => {
      const { ctx, actor: GRANTEE_ACTOR } = buildWithGrantee(kind);

      const read = await listSavedSnippets(ctx.deps, { actorHumanId: GRANTEE_ACTOR, owner: PLACE });
      expect(read.ownerType).toBe("ORGANIZATION");
      expect(read.snippets).toHaveLength(6);

      const id = read.snippets[0]!.id;
      await expect(
        createSavedSnippet(ctx.deps, { actorHumanId: GRANTEE_ACTOR, owner: PLACE, label: "x", body: "x" }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      await expect(
        updateSavedSnippet(ctx.deps, { actorHumanId: GRANTEE_ACTOR, owner: PLACE, snippetId: id, label: "x" }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      await expect(
        deleteSavedSnippet(ctx.deps, { actorHumanId: GRANTEE_ACTOR, owner: PLACE, snippetId: id }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      await expect(
        reorderSavedSnippets(ctx.deps, { actorHumanId: GRANTEE_ACTOR, owner: PLACE, orderedIds: [id] }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(ctx.savedSnippets.rows.size).toBe(6);
    },
  );

  it("a pending, declined, revoked, expired or calendar-scoped grant reads nothing", async () => {
    const ctx = buildSavedSnippetsTestContext();
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID, acceptedAt: null });
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: GRANTEE_ID,
      acceptedAt: null,
      declinedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: GRANTEE_ID,
      revokedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: GRANTEE_ID,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      humanId: GRANTEE_ID,
      calendarId: "5e5e5e5e-0000-4000-8000-0000000000c1",
    });
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: GRANTEE_ID, owner: PLACE }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("a person-owned place's list is the owner's own HUMAN list", async () => {
    const ctx = buildSavedSnippetsTestContext({
      place: { orgIdsWithAccess: [], humanIdsWithAccess: [HUMAN_OWNER_ID] },
    });
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: HUMAN_OWNER_ID,
      owner: PLACE,
      label: "Mine",
      body: "Mine",
    });
    expect(ctx.savedSnippets.rows.get(snippet.id)).toMatchObject({
      ownerType: "HUMAN",
      ownerId: HUMAN_OWNER_ID,
    });
    const self = await listSavedSnippets(ctx.deps, { actorHumanId: HUMAN_OWNER_ID, owner: SELF });
    expect(self.snippets.map((s) => s.id)).toContain(snippet.id);

  });

  it("a grantee at a person-owned place may NOT read that person's list (it is their own self list)", async () => {
    const ctx = buildSavedSnippetsTestContext({
      place: { orgIdsWithAccess: [], humanIdsWithAccess: [HUMAN_OWNER_ID] },
    });
    await listSavedSnippets(ctx.deps, { actorHumanId: HUMAN_OWNER_ID, owner: SELF });
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: GRANTEE_ID, owner: PLACE }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: expect.objectContaining({ reason: "grantee_cannot_read_person_list" }),
    });
    // Only the owner's own first read locked the list; the grantee touched nothing.
    expect(ctx.savedSnippets.lockCalls.get(listKey("HUMAN", HUMAN_OWNER_ID))).toBe(1);
    expect(ctx.savedSnippets.lockCalls.size).toBe(1);
  });

  it("a grantee at a place owned by an org AND a person reads the org's list", async () => {
    const ctx = buildSavedSnippetsTestContext({
      place: { orgIdsWithAccess: [ORG_ID], humanIdsWithAccess: [HUMAN_OWNER_ID] },
    });
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: GRANTEE_ID });
    const read = await listSavedSnippets(ctx.deps, { actorHumanId: GRANTEE_ID, owner: PLACE });
    expect(read.ownerType).toBe("ORGANIZATION");
    expect(ctx.savedSnippets.lists.has(listKey("ORGANIZATION", ORG_ID))).toBe(true);
    // The grantee's first read copied the starters, audited under the grantee.
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "saved_snippets.starters_copied",
        data: expect.objectContaining({ actorHumanId: GRANTEE_ID, ownerId: ORG_ID }),
      }),
    );
  });

  it.each([
    ["smaller first", [ORG_ID, OTHER_ORG_ID]],
    ["larger first", [OTHER_ORG_ID, ORG_ID]],
  ] as const)(
    "a place owned by two orgs the actor edits in resolves to the smallest orgId (memberships %s)",
    async (_label, order) => {
      const ctx = buildSavedSnippetsTestContext({
        place: { orgIdsWithAccess: [...order], humanIdsWithAccess: [] },
        memberships: order.map((orgId) => ({ orgId, humanId: EDITOR_ID, role: "EDITOR" as const })),
      });
      expect(ORG_ID < OTHER_ORG_ID).toBe(true);
      const read = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: PLACE });
      expect(read.ownerType).toBe("ORGANIZATION");
      const { snippet } = await createSavedSnippet(ctx.deps, {
        actorHumanId: EDITOR_ID,
        owner: PLACE,
        label: "Two orgs",
        body: "Two orgs",
      });
      expect(ctx.savedSnippets.rows.get(snippet.id)).toMatchObject({
        ownerType: "ORGANIZATION",
        ownerId: ORG_ID,
      });
      expect(ctx.savedSnippets.lists.has(listKey("ORGANIZATION", OTHER_ORG_ID))).toBe(false);
    },
  );

  it("two owning orgs, edit role in only the larger one: that org (the role, not the id, decides first)", async () => {
    const ctx = buildSavedSnippetsTestContext({
      place: { orgIdsWithAccess: [ORG_ID, OTHER_ORG_ID], humanIdsWithAccess: [] },
      memberships: [
        { orgId: ORG_ID, humanId: EDITOR_ID, role: "VIEWER" },
        { orgId: OTHER_ORG_ID, humanId: EDITOR_ID, role: "ADMIN" },
      ],
    });
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: EDITOR_ID,
      owner: PLACE,
      label: "x",
      body: "x",
    });
    expect(ctx.savedSnippets.rows.get(snippet.id)).toMatchObject({ ownerId: OTHER_ORG_ID });
  });

  it("on a place owned by an org AND a person, the person acts on their own list, never the org's", async () => {
    const ctx = buildSavedSnippetsTestContext({
      place: { orgIdsWithAccess: [ORG_ID], humanIdsWithAccess: [HUMAN_OWNER_ID] },
    });
    const { snippet } = await createSavedSnippet(ctx.deps, {
      actorHumanId: HUMAN_OWNER_ID,
      owner: PLACE,
      label: "Co-owner",
      body: "Co-owner",
    });
    expect(ctx.savedSnippets.rows.get(snippet.id)).toMatchObject({
      ownerType: "HUMAN",
      ownerId: HUMAN_OWNER_ID,
    });
    const orgList = await listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: PLACE });
    expect(orgList.ownerType).toBe("ORGANIZATION");
    expect(orgList.snippets.map((s) => s.id)).not.toContain(snippet.id);
  });

  it("an org route for an org the actor edits in another org is refused", async () => {
    const ctx = buildSavedSnippetsTestContext();
    await expect(
      listSavedSnippets(ctx.deps, { actorHumanId: EDITOR_ID, owner: { kind: "org", orgId: OTHER_ORG_ID } }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
