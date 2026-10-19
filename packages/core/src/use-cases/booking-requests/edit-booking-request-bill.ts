import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookingRequestActRecord,
  BookingRequestActRole,
  BookingRequestRecord,
  CreateBookingRequestActInput,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";
import { fail } from "@th/errors";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";
import {
  ORG_EDIT_ROLES,
  requireOrgMembership,
  requireOwnerAccess,
} from "../../lib/rbac";
import { plainTextOptional } from "../../lib/sanitize-plain-text";
import { ACT_CONFIRMABLE_REQUEST_STATUSES } from "./answer-booking-request-act";
import { resolveBillActNames } from "./_shared/bill-act-names";
import { buildBillChangedEntry } from "./_shared/bill-changed-entry";
import { findBookingEventForBill } from "./_shared/bill-event";
import {
  bookingRequestActRoleSchema,
  bookingRequestBillItemSchema,
  resolveBillIdentities,
  toBillItems,
} from "./_shared/bill-items";
import {
  BOOKING_BILL_ACT_NAME_MAX_LENGTH,
  BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH,
  BOOKING_BILL_MAX_ROWS,
  bookingBillActSchema,
  type BookingBillActInput,
} from "./_shared/bill-schema";
import { performerOwnerKey } from "./_shared/performer-display-names";
import {
  resolveTaggableGroups,
  resolveTaggableHumans,
} from "./_shared/taggable-humans";
import { consumeLineupTagBudget } from "./create-booking-request";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import type { NotifyBookingLineupInvitedFn } from "./notify-booking-lineup-invited";
import type { NotifyBookingLineupRemovedFn } from "./notify-booking-lineup-removed";

// ─────────────────────────────────────────────────────────────────────────────
// editBookingRequestBill — the SENDER changes the bill (lineup-booking-
// requests v3, FR-009 / L5 / L13 / L14).
//
// WHO: the sender pair, with the authority `withdrawBookingRequest` uses —
// a human sender themselves, an org sender's ORG_EDIT_ROLES. An unclaimed
// anonymous inquiry has no sender to edit as. The venue never edits the
// bill (it asks on the thread).
//
// WHEN: a TO_VENUE PERFORM request that is PENDING, VIEWED or ACCEPTED (a
// closed request → INVALID_STATUS `request_closed`) and whose bill has not
// flowed into an event yet (`findBookingEventForBill`; an event-first
// request is locked from the start) → else BILL_LOCKED: the event's lineup is
// the record. RENT/USE and TO_PERFORMER requests carry no bill
// (BILL_NOT_ALLOWED).
//
// WHAT: `ops[]`, applied in order to the bill as the SENDER sees it (live
// rows, passed acts included — struck), then written once:
//   · add {act, position?}   — a tagged person / group, or a by-name act,
//                              with its role (PERFORMER by default). A tagged
//                              act the sender took off earlier is RESTORED
//                              (the removed row still holds its unique key):
//                              back to PENDING and asked again. An act that
//                              PASSED is never re-added (ACT_ALREADY_DECLINED).
//   · remove {actId}         — soft remove (any source; a passed act too).
//   · move {actId, toIndex}  — to a 0-based position on the bill.
//   · setRole {actId, role, customRoleLabel?}
//   · addSelf {position?} / removeSelf — the sender's own act; adding it
//                              restores the removed SELF row when there is
//                              one, and needs performer mode as at create.
// Same gates as create: ≤ 12 live rows, taggable acts only, never the
// sender as a tag, the sender pair's daily tag budget (each act asked —
// new or restored, person or group — spends one). The budget is charged
// BEFORE the transaction and NOT refunded when the transaction then refuses
// (a stale edit, a lost race) — accepted: the port has no refund, and the
// loss is bounded by the edit's own tags (same residual as create).
//
// RE-INVITE EMAIL COOLDOWN: an act put back on the bill is asked again, but
// the same act on the same request gets at most ONE invite email per
// {@link BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS} (7 days — the owner's
// lineup re-add cooldown). A re-invite inside the window is in-app only.
// Derived from data already on the row: the restored row's PREVIOUS
// `invitedAt` (read before the restore overwrites it). That stamp is the
// last invite of any kind, so the rule is conservative — a remove/restore
// loop every few days keeps the invite in-app until a full week passes
// between asks — and never sends more than one email a week.
//
// ONE transaction under the bill lock (`lockBill`, shared with the answer
// and the mint): the status + event gates re-read, the plan re-run against
// the locked bill, every write, ONE `booking_request.bill_changed` entry
// when the venue can see a change (`buildBillChangedEntry` — none for an
// edit that only touches passed acts), the audit row. Post-commit and
// swallowed: invites to every act asked (a restored act carries its new
// invite generation, so it really is asked again), and
// `booking.lineup-removed` to each removed act that had JOINED.
//
// NFR-002: when the sender goes on the bill and the request's display
// `actName` was DEFAULTED from a by-name act (create with the sender off the
// bill), it gives way to the sender (null — readers name the sender). If the
// sender is still off the bill, it follows the first by-name act left.
// ─────────────────────────────────────────────────────────────────────────────

/** At most one invite EMAIL per act per request in this window (see the header). */
export const BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Ops one call may carry — a whole bill rebuilt twice over, and no more. */
export const BOOKING_BILL_EDIT_MAX_OPS = 2 * BOOKING_BILL_MAX_ROWS;

const positionSchema = z
  .number()
  .int()
  .min(0)
  .max(BOOKING_BILL_MAX_ROWS - 1);

export const bookingBillEditOpSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("add"),
      act: bookingBillActSchema,
      /** 0-based position on the bill; absent = the end. */
      position: positionSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("remove"), actId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("move"),
      actId: z.uuid(),
      toIndex: positionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("setRole"),
      actId: z.uuid(),
      role: bookingRequestActRoleSchema,
      customRoleLabel: plainTextOptional(
        BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH,
      ).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("addSelf"),
      /** 0-based position; absent = 0 (the headliner, as at create). */
      position: positionSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("removeSelf") }).strict(),
]);

export type BookingBillEditOp = z.infer<typeof bookingBillEditOpSchema>;

export const editBookingRequestBillInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    ops: z.array(bookingBillEditOpSchema).min(1).max(BOOKING_BILL_EDIT_MAX_OPS),
  })
  .strict();

export const editBookingRequestBillOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    /** False when the ops left the bill exactly as it was (nothing written). */
    changed: z.boolean(),
    /** True when a `bill_changed` entry went on the thread. */
    entryWritten: z.boolean(),
    /** The bill as the SENDER sees it after the edit (passed acts kept). */
    bill: z.array(bookingRequestBillItemSchema),
  })
  .strict();

export type EditBookingRequestBillInput = z.infer<
  typeof editBookingRequestBillInputSchema
>;
export type EditBookingRequestBillOutput = z.infer<
  typeof editBookingRequestBillOutputSchema
>;

export type EditBookingRequestBillDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "bookingRequestMessages"
    | "authz"
    | "audit"
    // BILL_LOCKED: has the bill flowed into an event?
    | "agreements"
    | "events"
    // Names (ledger snapshot, the sender's bill view) and taggability.
    | "humans"
    | "organizations"
    | "entityPages"
    // Performer mode, when the sender puts themselves on the bill.
    | "performerProfiles"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /** The sender pair's daily tag budget (FR-007). Absent = no budget. */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  /** Post-commit invites to every act asked (composed by the transport). */
  notifyBookingLineupInvited?: NotifyBookingLineupInvitedFn;
  /** Post-commit "you're off the bill" to removed JOINED acts. */
  notifyBookingLineupRemoved?: NotifyBookingLineupRemovedFn;
  /** Swallow reporter for both notices (ReporterPort convention). */
  reportError?: ReporterPort;
};

type Sender = { ownerType: PerformerOwnerType; ownerId: string };

// ─────────────────────────────────────────────────────────────────────────────
// The plan — pure
// ─────────────────────────────────────────────────────────────────────────────

type RoleFields = { role: BookingRequestActRole; customRoleLabel: string | null };

type NewAct =
  | ({ source: "SELF" } & RoleFields)
  | ({
      source: "TAGGED";
      actOwnerType: PerformerOwnerType;
      actOwnerId: string;
    } & RoleFields)
  | ({
      source: "EXTERNAL";
      externalName: string;
      externalUrl: string | null;
    } & RoleFields);

type Entry =
  | ({ kind: "existing"; act: BookingRequestActRecord } & RoleFields)
  | { kind: "new"; key: string; act: NewAct };

export type BillEditPlan = {
  /** Live rows to soft-remove. */
  removals: BookingRequestActRecord[];
  /** Removed rows to put back, with their final 0-based index. */
  restores: Array<{ act: BookingRequestActRecord; index: number }>;
  /** Rows to insert, with their final index (keyed for the id map). */
  inserts: Array<{ key: string; act: NewAct; index: number }>;
  /** The final bill: an existing act id, or an insert's key. */
  order: Array<{ actId: string } | { key: string }>;
  /** Existing rows (restored included) whose role / label changes. */
  roleChanges: Array<{ actId: string } & RoleFields>;
  /** Acts ASKED by this edit (new or restored TAGGED rows). */
  invites: Sender[];
  /** The sender's own act goes on the bill by this edit (new or restored). */
  selfGoesOn: boolean;
  /** Anything to write at all. */
  changed: boolean;
};

function roleFieldsOf(input: {
  role?: BookingRequestActRole | undefined;
  customRoleLabel?: string | undefined | null;
}): RoleFields {
  const role = input.role ?? "PERFORMER";
  const label = input.customRoleLabel?.trim();
  return { role, customRoleLabel: role === "OTHER" && label ? label : null };
}

/** A tagged op's owner pair. The schema guarantees exactly one id. */
function taggedOwnerOf(
  act: Extract<BookingBillActInput, { kind: "tagged" }>,
): Sender {
  return act.orgId !== undefined
    ? { ownerType: "organization", ownerId: act.orgId }
    : { ownerType: "human", ownerId: act.humanId as string };
}

/** The client planned against a bill that is not this one. */
function stale(actId?: string): never {
  throw fail("CONFLICT", {
    message: "booking_request_bill_stale",
    meta: actId ? { actId } : {},
  });
}

function entryOwner(entry: Entry): Sender | null {
  if (entry.kind === "existing") {
    return entry.act.actOwnerType && entry.act.actOwnerId
      ? { ownerType: entry.act.actOwnerType, ownerId: entry.act.actOwnerId }
      : null;
  }
  const act = entry.act;
  return act.source === "TAGGED"
    ? { ownerType: act.actOwnerType, ownerId: act.actOwnerId }
    : null;
}

function isSelfEntry(entry: Entry): boolean {
  return entry.act.source === "SELF";
}

/**
 * Apply `ops` to the bill as the sender sees it and work out the writes.
 * `acts` is every row on the request, removed ones included (in the port's
 * order). Throws the typed refusals; writes nothing.
 */
export function planBillEdit(
  acts: readonly BookingRequestActRecord[],
  ops: readonly BookingBillEditOp[],
  sender: Sender,
): BillEditPlan {
  const live: Entry[] = acts
    .filter((act) => !act.removedAt)
    .map((act) => ({
      kind: "existing" as const,
      act,
      role: act.role,
      customRoleLabel: act.role === "OTHER" ? (act.customRoleLabel ?? null) : null,
    }));
  const initialOrder = live.map((entry) => (entry as { act: BookingRequestActRecord }).act.id);
  let nextKey = 0;

  const indexOfLive = (actId: string) =>
    live.findIndex((entry) => entry.kind === "existing" && entry.act.id === actId);
  const insertAt = (position: number | undefined, fallback: number) => {
    const at = position ?? fallback;
    if (at > live.length) stale();
    return at;
  };

  for (const op of ops) {
    switch (op.kind) {
      case "remove": {
        const index = indexOfLive(op.actId);
        if (index < 0) stale(op.actId);
        live.splice(index, 1);
        break;
      }
      case "move": {
        const index = indexOfLive(op.actId);
        if (index < 0 || op.toIndex >= live.length) stale(op.actId);
        const [entry] = live.splice(index, 1);
        live.splice(op.toIndex, 0, entry!);
        break;
      }
      case "setRole": {
        const index = indexOfLive(op.actId);
        if (index < 0) stale(op.actId);
        const entry = live[index] as Extract<Entry, { kind: "existing" }>;
        Object.assign(entry, roleFieldsOf(op));
        break;
      }
      case "addSelf": {
        if (live.some(isSelfEntry)) break; // already on: nothing to do
        const at = insertAt(op.position, 0);
        const removedSelf = acts.find((act) => act.source === "SELF");
        live.splice(
          at,
          0,
          removedSelf
            ? {
                kind: "existing",
                act: removedSelf,
                role: removedSelf.role,
                customRoleLabel:
                  removedSelf.role === "OTHER"
                    ? (removedSelf.customRoleLabel ?? null)
                    : null,
              }
            : {
                kind: "new",
                key: `new-${nextKey++}`,
                act: { source: "SELF", role: "PERFORMER", customRoleLabel: null },
              },
        );
        break;
      }
      case "removeSelf": {
        const index = live.findIndex(isSelfEntry);
        if (index >= 0) live.splice(index, 1);
        break;
      }
      case "add": {
        const at = insertAt(op.position, live.length);
        const roleFields = roleFieldsOf(op.act);
        if (op.act.kind === "external") {
          live.splice(at, 0, {
            kind: "new",
            key: `new-${nextKey++}`,
            act: {
              source: "EXTERNAL",
              externalName: op.act.name,
              externalUrl: op.act.url ?? null,
              ...roleFields,
            },
          });
          break;
        }
        const owner = taggedOwnerOf(op.act);
        const meta =
          owner.ownerType === "human"
            ? { humanId: owner.ownerId }
            : { orgId: owner.ownerId };
        if (
          owner.ownerType === sender.ownerType &&
          owner.ownerId === sender.ownerId
        ) {
          // The sender goes on as SELF ("I'm on the bill"), never as a tag.
          throw fail("ACT_NOT_TAGGABLE", { meta: { reason: "self", ...meta } });
        }
        const onBill = live.find((entry) => {
          const other = entryOwner(entry);
          return (
            other !== null &&
            !isSelfEntry(entry) &&
            other.ownerType === owner.ownerType &&
            other.ownerId === owner.ownerId
          );
        });
        const row = acts.find(
          (act) =>
            act.source === "TAGGED" &&
            act.actOwnerType === owner.ownerType &&
            act.actOwnerId === owner.ownerId,
        );
        // A pass is final (L14): never re-added, live or removed.
        if (row?.confirmation === "DECLINED") throw fail("ACT_ALREADY_DECLINED");
        if (onBill) {
          throw fail("ACT_NOT_TAGGABLE", {
            meta: { reason: "duplicate", ...meta },
          });
        }
        live.splice(
          at,
          0,
          row
            ? // Removed earlier: restored (the row keeps the unique key) and
              // asked again.
              { kind: "existing", act: row, ...roleFields }
            : {
                kind: "new",
                key: `new-${nextKey++}`,
                act: {
                  source: "TAGGED",
                  actOwnerType: owner.ownerType,
                  actOwnerId: owner.ownerId,
                  ...roleFields,
                },
              },
        );
        break;
      }
      default: {
        const exhaustive: never = op;
        return exhaustive;
      }
    }
  }

  if (live.length > BOOKING_BILL_MAX_ROWS) {
    throw fail("INVALID_INPUT", {
      message: "bill_too_long",
      meta: { max: BOOKING_BILL_MAX_ROWS },
    });
  }

  const finalExisting = new Set(
    live.flatMap((entry) => (entry.kind === "existing" ? [entry.act.id] : [])),
  );
  const removals = acts.filter(
    (act) => !act.removedAt && !finalExisting.has(act.id),
  );
  const restores: BillEditPlan["restores"] = [];
  const inserts: BillEditPlan["inserts"] = [];
  const roleChanges: BillEditPlan["roleChanges"] = [];
  const invites: Sender[] = [];
  let selfGoesOn = false;

  live.forEach((entry, index) => {
    if (entry.kind === "new") {
      inserts.push({ key: entry.key, act: entry.act, index });
      if (entry.act.source === "TAGGED") {
        invites.push({
          ownerType: entry.act.actOwnerType,
          ownerId: entry.act.actOwnerId,
        });
      }
      if (entry.act.source === "SELF") selfGoesOn = true;
      return;
    }
    const { act } = entry;
    if (act.removedAt) {
      restores.push({ act, index });
      if (act.source === "TAGGED" && act.actOwnerType && act.actOwnerId) {
        invites.push({ ownerType: act.actOwnerType, ownerId: act.actOwnerId });
      }
      if (act.source === "SELF") selfGoesOn = true;
    }
    const currentLabel =
      act.role === "OTHER" ? (act.customRoleLabel ?? null) : null;
    if (entry.role !== act.role || entry.customRoleLabel !== currentLabel) {
      roleChanges.push({
        actId: act.id,
        role: entry.role,
        customRoleLabel: entry.customRoleLabel,
      });
    }
  });

  const order = live.map((entry) =>
    entry.kind === "existing" ? { actId: entry.act.id } : { key: entry.key },
  );
  const reordered =
    order.length !== initialOrder.length ||
    order.some((slot, index) =>
      "actId" in slot ? slot.actId !== initialOrder[index] : true,
    );

  return {
    removals,
    restores,
    inserts,
    order,
    roleChanges,
    invites,
    selfGoesOn,
    changed:
      removals.length > 0 ||
      restores.length > 0 ||
      inserts.length > 0 ||
      reordered ||
      roleChanges.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function editBookingRequestBill(
  deps: EditBookingRequestBillDeps,
  rawInput: unknown,
): Promise<EditBookingRequestBillOutput> {
  const input = parseInput(editBookingRequestBillInputSchema, rawInput);

  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) throw fail("BOOKING_REQUEST_NOT_FOUND");
  const sender = await authorizeSender(deps, request, input.actorHumanId);
  if (request.direction !== "TO_VENUE" || request.intent !== "PERFORM") {
    throw fail("BILL_NOT_ALLOWED", { meta: { intent: request.intent } });
  }
  await assertBillEditable(deps.repos, request);

  // ── Pre-flight on committed state: the refusals that need reads OUTSIDE
  // the transaction (taggability, performer mode, the tag budget — no
  // non-tx I/O inside the interactive tx). Re-planned under the lock below.
  const committed = withLegacySelf(
    request,
    await deps.repos.bookingRequests.listActsForRequests([request.id], {
      includeRemoved: true,
    }),
  );
  const preflight = planBillEdit(committed, input.ops, sender);
  if (!preflight.changed) {
    return output(deps, request.id, committed, false, false);
  }
  if (preflight.selfGoesOn) await assertPerformerMode(deps, sender);
  await assertTaggable(deps, preflight.invites);
  await consumeLineupTagBudget(deps, {
    ownerType: sender.ownerType,
    ownerId: sender.ownerId,
    placeId: request.placeId,
    tagCount: preflight.invites.length,
    useCase: "editBookingRequestBill",
  });

  const now = deps.clock.now();
  const result = await deps.repos.tx(async (tx) => {
    // Serializes against the answers and the mint (port doc) — BEFORE the
    // reads every decision below rests on.
    await tx.bookingRequests.lockBill(request.id);
    const fresh = await tx.bookingRequests.getById(request.id);
    if (!fresh || fresh.direction !== "TO_VENUE") {
      throw fail("BOOKING_REQUEST_NOT_FOUND");
    }
    const freshSender = getBookingRequestSender(fresh);
    if (
      freshSender.kind !== "owned" ||
      freshSender.performerOwnerType !== sender.ownerType ||
      freshSender.performerOwnerId !== sender.ownerId
    ) {
      throw fail("NOT_RESOURCE_OWNER");
    }
    // The actor's authority, re-checked on the locked snapshot (as the answer
    // path re-checks a group editor): a role revoked since the pre-read must
    // not still edit the bill.
    await requireOwnerAccess({
      repos: tx,
      ownerType: sender.ownerType === "human" ? "HUMAN" : "ORGANIZATION",
      ownerId: sender.ownerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
    await assertBillEditable(tx, fresh);

    let before = await tx.bookingRequests.listActsForRequests([fresh.id], {
      includeRemoved: true,
    });
    if (isLegacyBill(fresh, before)) {
      // A request from before bills implies "the sender is the act"; the
      // first edit writes that down so the rest of the edit (and the mint)
      // reads a real bill.
      await tx.bookingRequests.addActs(fresh.id, [
        { source: "SELF", sortOrder: 0, role: "PERFORMER" },
      ]);
      before = await tx.bookingRequests.listActsForRequests([fresh.id], {
        includeRemoved: true,
      });
    }

    const plan = planBillEdit(before, input.ops, sender);
    // Nothing the pre-flight did not check (taggability, budget) may be
    // asked here: a concurrent edit moved the bill under us.
    const checked = new Set(
      preflight.invites.map((o) => performerOwnerKey(o.ownerType, o.ownerId)),
    );
    if (
      plan.invites.some(
        (o) => !checked.has(performerOwnerKey(o.ownerType, o.ownerId)),
      ) ||
      (plan.selfGoesOn && !preflight.selfGoesOn)
    ) {
      stale();
    }
    if (!plan.changed) {
      return { request: fresh, before, after: before, plan, entryWritten: false };
    }

    await writePlan(tx, fresh.id, plan, now);
    const after = await tx.bookingRequests.listActsForRequests([fresh.id], {
      includeRemoved: true,
    });

    const names = await resolveBillActNames(tx, [...before, ...after]);
    const entry = buildBillChangedEntry({
      before,
      after,
      nameOf: (actId) => names.get(actId) as string,
    });
    if (entry) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: fresh.id,
        kind: "booking_request.bill_changed",
        data: entry,
        actorHumanId: input.actorHumanId,
      });
    }

    const updatedRequest = await rederiveActName(tx, fresh, before, after);

    await tx.audit.log({
      entity: "booking_request",
      entityId: fresh.id,
      action: "booking_request.bill_changed",
      data: {
        actorHumanId: input.actorHumanId,
        opCount: input.ops.length,
        removedActIds: plan.removals.map((act) => act.id),
        restoredActIds: plan.restores.map(({ act }) => act.id),
        insertedCount: plan.inserts.length,
        roleChangedActIds: plan.roleChanges.map((change) => change.actId),
        entryWritten: entry !== null,
      },
      at: now,
    });

    return {
      request: updatedRequest,
      before,
      after,
      plan,
      entryWritten: entry !== null,
    };
  });

  if (!result.plan.changed) {
    return output(deps, request.id, result.after, false, false);
  }

  await sendInvites(
    deps,
    result.request,
    result.after,
    result.plan,
    input.actorHumanId,
    deps.clock.now(),
  );
  await sendRemovedNotices(
    deps,
    result.request,
    result.before,
    result.after,
    input.actorHumanId,
  );

  deps.logger?.info("booking_requests.bill_changed", {
    bookingRequestId: request.id,
    actorHumanId: input.actorHumanId,
    removed: result.plan.removals.length,
    restored: result.plan.restores.length,
    inserted: result.plan.inserts.length,
    roleChanges: result.plan.roleChanges.length,
    asked: result.plan.invites.length,
    entryWritten: result.entryWritten,
  });

  return output(deps, request.id, result.after, true, result.entryWritten);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sender pair's authority — `withdrawBookingRequest`'s: self for a human
 * sender, ORG_EDIT_ROLES for an org sender; an unclaimed inquiry has no
 * on-platform sender (see withdraw's note on shadow owners). TO_PERFORMER:
 * the organizer org's edit roles (it then gets BILL_NOT_ALLOWED).
 */
async function authorizeSender(
  deps: EditBookingRequestBillDeps,
  request: BookingRequestRecord,
  actorHumanId: string,
): Promise<Sender> {
  if (request.direction === "TO_PERFORMER") {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: request.organizerOrgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
    throw fail("BILL_NOT_ALLOWED", { meta: { direction: request.direction } });
  }
  if (isUnclaimedBookingInquiry(request)) throw fail("NOT_RESOURCE_OWNER");
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned") throw fail("NOT_RESOURCE_OWNER");
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: sender.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: sender.performerOwnerId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
  return { ownerType: sender.performerOwnerType, ownerId: sender.performerOwnerId };
}

/**
 * Open or accepted (else INVALID_STATUS `request_closed`), and no event yet
 * (else BILL_LOCKED — the event's lineup is the record). Pass the TX bag
 * after `lockBill` for the decision that gates the writes.
 */
async function assertBillEditable(
  repos: Pick<TxRepos, "agreements" | "events">,
  request: BookingRequestRecord,
): Promise<void> {
  if (
    !(ACT_CONFIRMABLE_REQUEST_STATUSES as readonly string[]).includes(
      request.status,
    )
  ) {
    throw fail("INVALID_STATUS", {
      message: "booking_request_bill_request_closed",
      meta: { reason: "request_closed", bookingRequestId: request.id },
    });
  }
  const eventId = await findBookingEventForBill(repos, request);
  if (eventId) {
    throw fail("BILL_LOCKED", { meta: { bookingRequestId: request.id, eventId } });
  }
}

async function assertPerformerMode(
  deps: EditBookingRequestBillDeps,
  sender: Sender,
): Promise<void> {
  const profile = await deps.repos.performerProfiles.getByOwner({
    ownerType: sender.ownerType,
    ownerId: sender.ownerId,
  });
  if (!isPerformerEnabled(profile)) throw fail("PERFORMER_MODE_REQUIRED");
}

/** Every act asked must be taggable now — restored acts included. */
async function assertTaggable(
  deps: EditBookingRequestBillDeps,
  invites: readonly Sender[],
): Promise<void> {
  const humanIds = invites
    .filter((o) => o.ownerType === "human")
    .map((o) => o.ownerId);
  const orgIds = invites
    .filter((o) => o.ownerType === "organization")
    .map((o) => o.ownerId);
  const [humans, groups] = await Promise.all([
    humanIds.length > 0
      ? resolveTaggableHumans(deps.repos, humanIds)
      : Promise.resolve(new Map()),
    orgIds.length > 0
      ? resolveTaggableGroups(deps.repos, orgIds)
      : Promise.resolve(new Map()),
  ]);
  for (const humanId of humanIds) {
    if (!humans.has(humanId)) {
      throw fail("ACT_NOT_TAGGABLE", { meta: { reason: "not_taggable", humanId } });
    }
  }
  for (const orgId of orgIds) {
    if (!groups.has(orgId)) {
      throw fail("ACT_NOT_TAGGABLE", { meta: { reason: "not_taggable", orgId } });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy requests (sent before bills)
// ─────────────────────────────────────────────────────────────────────────────

/** Placeholder id for the implied SELF row of a pre-bill request (pre-flight only). */
const LEGACY_SELF_ID = "00000000-0000-4000-8000-000000000000";

function isLegacyBill(
  request: BookingRequestRecord,
  acts: readonly BookingRequestActRecord[],
): boolean {
  return !request.billRecorded && acts.length === 0;
}

/**
 * A request from before bills has no rows and means "the sender is the act"
 * (the mint's legacy branch). The pre-flight plans against that implied
 * SELF row; the transaction writes it for real before the edit.
 */
function withLegacySelf(
  request: ToVenueBookingRequestRecord,
  acts: BookingRequestActRecord[],
): BookingRequestActRecord[] {
  if (!isLegacyBill(request, acts)) return acts;
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned") return acts;
  return [
    {
      id: LEGACY_SELF_ID,
      bookingRequestId: request.id,
      source: "SELF",
      actOwnerType: sender.performerOwnerType,
      actOwnerId: sender.performerOwnerId,
      externalName: null,
      externalUrl: null,
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 0,
      confirmation: "CONFIRMED",
      invitedAt: null,
      respondedAt: null,
      declineReason: null,
      removedAt: null,
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

async function writePlan(
  tx: TxRepos,
  bookingRequestId: string,
  plan: BillEditPlan,
  now: Date,
): Promise<void> {
  for (const act of plan.removals) {
    await tx.bookingRequests.softRemoveAct({
      bookingRequestId,
      actId: act.id,
      at: now,
    });
  }
  for (const { act, index } of plan.restores) {
    await tx.bookingRequests.restoreAct({
      bookingRequestId,
      actId: act.id,
      sortOrder: index,
      // A restored tagged act is asked again: its invite generation.
      ...(act.source === "TAGGED" ? { invitedAt: now } : {}),
    });
  }

  const idOfKey = new Map<string, string>();
  if (plan.inserts.length > 0) {
    const rows = await tx.bookingRequests.addActs(
      bookingRequestId,
      plan.inserts.map(({ act, index }) => toInsert(act, index, now)),
    );
    plan.inserts.forEach(({ key }, position) => {
      idOfKey.set(key, rows[position]!.id);
    });
  }

  await tx.bookingRequests.setActSortOrders({
    bookingRequestId,
    orderedActIds: plan.order.map((slot) =>
      "actId" in slot ? slot.actId : (idOfKey.get(slot.key) as string),
    ),
  });

  for (const change of plan.roleChanges) {
    await tx.bookingRequests.setActRole({
      bookingRequestId,
      actId: change.actId,
      role: change.role,
      customRoleLabel: change.customRoleLabel,
    });
  }
}

function toInsert(
  act: NewAct,
  sortOrder: number,
  now: Date,
): CreateBookingRequestActInput {
  const roleFields = { role: act.role, customRoleLabel: act.customRoleLabel };
  switch (act.source) {
    case "SELF":
      return { source: "SELF", sortOrder, ...roleFields };
    case "TAGGED":
      return {
        source: "TAGGED",
        actOwnerType: act.actOwnerType,
        actOwnerId: act.actOwnerId,
        invitedAt: now,
        sortOrder,
        ...roleFields,
      };
    case "EXTERNAL":
      return {
        source: "EXTERNAL",
        externalName: act.externalName,
        externalUrl: act.externalUrl,
        sortOrder,
        ...roleFields,
      };
  }
}

function clippedExternalName(act: BookingRequestActRecord): string | null {
  const name = act.externalName
    ?.slice(0, BOOKING_BILL_ACT_NAME_MAX_LENGTH)
    .trim();
  return name ? name : null;
}

/**
 * NFR-002: the request's display `actName`, when it was DEFAULTED from a
 * by-name act (create with the sender off the bill — `firstExternalActName`),
 * follows the bill: null once the sender is on it (readers then name the
 * sender — a by-name act must never stand in for a linked identity), else
 * the first by-name act still on the bill. A name the sender typed (the
 * sender was on the bill, or it matches no by-name act) is left alone.
 */
async function rederiveActName(
  tx: TxRepos,
  request: ToVenueBookingRequestRecord,
  before: readonly BookingRequestActRecord[],
  after: readonly BookingRequestActRecord[],
): Promise<BookingRequestRecord> {
  const current = request.actName;
  if (current === null) return request;
  const selfLiveBefore = before.some(
    (act) => act.source === "SELF" && !act.removedAt,
  );
  const defaulted =
    !selfLiveBefore &&
    before.some(
      (act) => act.source === "EXTERNAL" && clippedExternalName(act) === current,
    );
  if (!defaulted) return request;

  const selfLiveAfter = after.some(
    (act) => act.source === "SELF" && !act.removedAt,
  );
  const firstByName = [...after]
    .filter((act) => act.source === "EXTERNAL" && !act.removedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const next = selfLiveAfter
    ? null
    : firstByName
      ? clippedExternalName(firstByName)
      : null;
  if (next === current) return request;
  return tx.bookingRequests.setActName({ id: request.id, actName: next });
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-commit notices (swallowed + reported)
// ─────────────────────────────────────────────────────────────────────────────

async function sendInvites(
  deps: EditBookingRequestBillDeps,
  request: BookingRequestRecord,
  after: readonly BookingRequestActRecord[],
  plan: BillEditPlan,
  actorHumanId: string,
  now: Date,
): Promise<void> {
  if (!deps.notifyBookingLineupInvited || plan.invites.length === 0) return;
  if (request.direction !== "TO_VENUE") return;
  const restoredIds = new Set(plan.restores.map(({ act }) => act.id));
  // The re-invite email cooldown (header): a restored act whose PREVIOUS
  // invite (the row's `invitedAt` as read before the restore) is inside the
  // window is re-asked in-app only.
  const inviteInAppOnly: Record<string, true> = {};
  for (const { act } of plan.restores) {
    if (
      act.source === "TAGGED" &&
      act.actOwnerType &&
      act.actOwnerId &&
      act.invitedAt &&
      now.getTime() - act.invitedAt.getTime() <
        BOOKING_LINEUP_REINVITE_EMAIL_COOLDOWN_MS
    ) {
      inviteInAppOnly[performerOwnerKey(act.actOwnerType, act.actOwnerId)] =
        true;
    }
  }
  const inviteGenerations: Record<string, number> = {};
  for (const act of after) {
    if (
      restoredIds.has(act.id) &&
      act.source === "TAGGED" &&
      act.actOwnerType &&
      act.actOwnerId &&
      act.invitedAt
    ) {
      inviteGenerations[performerOwnerKey(act.actOwnerType, act.actOwnerId)] =
        act.invitedAt.getTime();
    }
  }
  try {
    await deps.notifyBookingLineupInvited({
      bookingRequest: request,
      place: { id: request.placeId, name: request.placeName ?? "" },
      taggedHumanIds: plan.invites
        .filter((o) => o.ownerType === "human")
        .map((o) => o.ownerId),
      taggedOrgIds: plan.invites
        .filter((o) => o.ownerType === "organization")
        .map((o) => o.ownerId),
      inviteGenerations,
      inviteInAppOnly,
      actorHumanId,
    });
  } catch (error) {
    reportSwallow(deps, error, "booking_requests.edit_bill.notify_invited_failed", {
      step: "lineup_invited",
      extra: { bookingRequestId: request.id, asked: plan.invites.length },
    });
  }
}

async function sendRemovedNotices(
  deps: EditBookingRequestBillDeps,
  request: BookingRequestRecord,
  before: readonly BookingRequestActRecord[],
  after: readonly BookingRequestActRecord[],
  actorHumanId: string,
): Promise<void> {
  if (!deps.notifyBookingLineupRemoved) return;
  const liveBefore = new Set(
    before.filter((act) => !act.removedAt).map((act) => act.id),
  );
  const removedJoined = after.filter(
    (act) =>
      act.removedAt !== null &&
      liveBefore.has(act.id) &&
      act.source === "TAGGED" &&
      act.confirmation === "CONFIRMED",
  );
  if (removedJoined.length === 0) return;
  try {
    await deps.notifyBookingLineupRemoved({
      bookingRequest: request,
      acts: removedJoined,
      actorHumanId,
    });
  } catch (error) {
    reportSwallow(deps, error, "booking_requests.edit_bill.notify_removed_failed", {
      step: "lineup_removed",
      extra: { bookingRequestId: request.id, removed: removedJoined.length },
    });
  }
}

function reportSwallow(
  deps: Pick<EditBookingRequestBillDeps, "logger" | "reportError">,
  error: unknown,
  event: string,
  context: { step: string; extra: Record<string, unknown> },
): void {
  deps.logger?.error(event, { ...context.extra, err: error });
  try {
    deps.reportError?.(error, {
      tags: { useCase: "editBookingRequestBill", step: context.step },
      extra: context.extra,
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never fail the
    // committed edit.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

async function output(
  deps: EditBookingRequestBillDeps,
  bookingRequestId: string,
  acts: readonly BookingRequestActRecord[],
  changed: boolean,
  entryWritten: boolean,
): Promise<EditBookingRequestBillOutput> {
  const live = acts.filter((act) => !act.removedAt && act.id !== LEGACY_SELF_ID);
  const identities = await resolveBillIdentities(deps.repos, live);
  return editBookingRequestBillOutputSchema.parse({
    bookingRequestId,
    changed,
    entryWritten,
    // The sender's view: passed acts kept (rendered struck).
    bill: toBillItems(live, identities, { hideDeclined: false }),
  });
}
