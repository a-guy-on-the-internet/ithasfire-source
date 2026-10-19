import type {
  BookingRequestActRecord,
  BookingRequestsRepo,
  CreateBookingRequestActInput,
  PromoteBookingRequestActToSelfInput,
  RestoreBookingRequestActInput,
  SetBookingRequestActConfirmationInput,
  SetBookingRequestActRoleInput,
  SetBookingRequestActSortOrdersInput,
  SoftRemoveBookingRequestActInput,
} from "@th/ports/repos/booking-requests";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";

/** The bill slice of BookingRequestsRepo (lineup-booking-requests v2 + v3). */
export type BookingRequestActsSlice = Pick<
  BookingRequestsRepo,
  | "addActs"
  | "listActsForRequests"
  | "getActForOwner"
  | "setActConfirmation"
  | "lockBill"
  | "promoteActToSelf"
  | "softRemoveAct"
  | "restoreAct"
  | "setActSortOrders"
  | "setActRole"
>;

export type FakeBookingRequestActs = BookingRequestActsSlice & {
  /** Keyed by act id. Stored objects — the methods hand out copies. */
  rows: Map<string, BookingRequestActRecord>;
};

/**
 * The request's sender pair, as the adapter reads it off the request row.
 * `undefined` = no such request (`booking_request_not_found`); `null` = the
 * request exists but has no owner pair (an unclaimed anonymous inquiry).
 */
export type FakeActSenderLookup = (
  bookingRequestId: string,
) =>
  | { ownerType: PerformerOwnerType; ownerId: string }
  | null
  | undefined
  | Promise<{ ownerType: PerformerOwnerType; ownerId: string } | null | undefined>;

export interface CreateFakeBookingRequestActsOptions {
  /**
   * Where SELF rows get their owner pair (the adapter copies the request
   * row's `performerOwnerType/Id`; SELF input carries none). Required only
   * if a suite inserts SELF rows — without it, a SELF insert throws
   * `booking_request_not_found`, same as the adapter on a missing request.
   */
  senderOf?: FakeActSenderLookup;
}

/**
 * Map-backed bill methods with the real adapter semantics (house style: real
 * behaviour, not vi.fn stubs — spy with `vi.spyOn` when call assertions are
 * needed):
 *   - `addActs` inserts in input order and stamps confirmation (SELF /
 *     EXTERNAL → CONFIRMED, TAGGED → PENDING); SELF rows take the sender
 *     pair from `senderOf` (never from the input);
 *   - a second platform row for the same (request, ownerType, ownerId) throws
 *     `{ code: "conflict", message: "booking_request_act_duplicate" }` —
 *     DECLINED rows still hold the key, like the SQL unique;
 *   - `listActsForRequests` orders by (bookingRequestId, sortOrder, insert).
 *     Prod breaks sortOrder ties by (createdAt, id), NOT insert order, so a
 *     suite must not depend on the tiebreak: core assigns distinct sortOrders;
 *   - `getActForOwner` / `setActConfirmation` address a row by its owner key
 *     (request + owner pair), never by act id; the CAS throws
 *     `{ code: "conflict", message: "booking_request_act_state_changed" }`
 *     on a lost race, a wrong owner or a missing row;
 *   - `lockBill` is a no-op (an in-memory store has no concurrent
 *     transactions to serialize) — spy on it to assert a caller takes it;
 *   - `promoteActToSelf` rewrites ONE EXTERNAL row on the named request into
 *     a SELF row carrying the `senderOf` pair (same errors as the adapter);
 *   - REMOVED rows (v3 FR-001, `removedAt` set) are hidden from
 *     `listActsForRequests` / `getActForOwner` unless `includeRemoved`, can
 *     neither answer nor be promoted, and STILL hold their unique key;
 *   - `softRemoveAct` / `restoreAct` / `setActSortOrders` / `setActRole`
 *     mirror the adapter's scoped CAS writes and typed conflicts (see the
 *     port input types for each contract).
 * Every method returns COPIES, so a caller mutating a result cannot edit the
 * store behind the fake's back.
 */
export function createFakeBookingRequestActs(
  options: CreateFakeBookingRequestActsOptions = {},
): FakeBookingRequestActs {
  const rows = new Map<string, BookingRequestActRecord>();
  // Insert sequence — the fake's stand-in for the adapter's createdAt tiebreak.
  const seq = new Map<string, number>();
  let tick = 0;

  const platformKey = (
    bookingRequestId: string,
    ownerType: string | null,
    ownerId: string | null,
  ) =>
    ownerType === null || ownerId === null
      ? null
      : `${bookingRequestId}|${ownerType}|${ownerId}`;

  const copy = (row: BookingRequestActRecord): BookingRequestActRecord =>
    structuredClone(row);

  const findByOwner = (
    bookingRequestId: string,
    actOwnerType: string,
    actOwnerId: string,
  ) =>
    [...rows.values()].find(
      (r) =>
        r.bookingRequestId === bookingRequestId &&
        r.actOwnerType === actOwnerType &&
        r.actOwnerId === actOwnerId,
    );

  /** The LIVE row `actId` on `bookingRequestId`, or undefined. */
  const liveOn = (bookingRequestId: string, actId: string) => {
    const row = rows.get(actId);
    return row &&
      row.bookingRequestId === bookingRequestId &&
      row.removedAt === null
      ? row
      : undefined;
  };

  /** Mirrors the SQL CHECK "BookingRequestAct_custom_role_label_check". */
  const assertRoleLabel = (role: string, customRoleLabel: string | null) => {
    if (customRoleLabel !== null && role !== "OTHER") {
      throw new Error(
        'violates check constraint "BookingRequestAct_custom_role_label_check"',
      );
    }
  };

  const stateChanged = () =>
    ({
      code: "conflict",
      message: "booking_request_act_state_changed",
    }) as const;

  const toRecord = (
    bookingRequestId: string,
    act: CreateBookingRequestActInput,
    now: Date,
    sender: { ownerType: PerformerOwnerType; ownerId: string } | null,
  ): BookingRequestActRecord => {
    const base = {
      id: crypto.randomUUID(),
      bookingRequestId,
      source: act.source,
      role: act.role ?? "PERFORMER",
      customRoleLabel: act.customRoleLabel ?? null,
      sortOrder: act.sortOrder,
      respondedAt: null,
      declineReason: null,
      removedAt: null,
      createdAt: now,
      updatedAt: now,
    } as const;
    if (act.source === "EXTERNAL") {
      return {
        ...base,
        actOwnerType: null,
        actOwnerId: null,
        externalName: act.externalName,
        externalUrl: act.externalUrl ?? null,
        confirmation: "CONFIRMED",
        invitedAt: null,
      };
    }
    if (act.source === "SELF") {
      return {
        ...base,
        actOwnerType: sender!.ownerType,
        actOwnerId: sender!.ownerId,
        externalName: null,
        externalUrl: null,
        confirmation: "CONFIRMED",
        invitedAt: null,
      };
    }
    return {
      ...base,
      actOwnerType: act.actOwnerType,
      actOwnerId: act.actOwnerId,
      externalName: null,
      externalUrl: null,
      confirmation: "PENDING",
      invitedAt: act.invitedAt ?? null,
    };
  };

  return {
    rows,

    async addActs(bookingRequestId, acts) {
      let sender: { ownerType: PerformerOwnerType; ownerId: string } | null =
        null;
      if (acts.some((act) => act.source === "SELF")) {
        const found = await options.senderOf?.(bookingRequestId);
        if (found === undefined) {
          throw {
            code: "not_found",
            message: "booking_request_not_found",
          } as const;
        }
        if (found === null) {
          throw {
            code: "invalid_input",
            message: "booking_request_self_act_without_sender",
          } as const;
        }
        sender = found;
      }
      const out: BookingRequestActRecord[] = [];
      for (const act of acts) {
        const record = toRecord(bookingRequestId, act, new Date(), sender);
        assertRoleLabel(record.role, record.customRoleLabel);
        const key = platformKey(
          bookingRequestId,
          record.actOwnerType,
          record.actOwnerId,
        );
        if (key !== null) {
          for (const existing of rows.values()) {
            if (
              platformKey(
                existing.bookingRequestId,
                existing.actOwnerType,
                existing.actOwnerId,
              ) === key
            ) {
              throw {
                code: "conflict",
                message: "booking_request_act_duplicate",
              } as const;
            }
          }
        }
        tick += 1;
        rows.set(record.id, record);
        seq.set(record.id, tick);
        out.push(copy(record));
      }
      return out;
    },

    async listActsForRequests(bookingRequestIds, listOptions) {
      const wanted = new Set(bookingRequestIds);
      return [...rows.values()]
        .filter(
          (r) =>
            wanted.has(r.bookingRequestId) &&
            (listOptions?.includeRemoved || r.removedAt === null),
        )
        .sort(
          (a, b) =>
            (a.bookingRequestId < b.bookingRequestId
              ? -1
              : a.bookingRequestId > b.bookingRequestId
                ? 1
                : 0) ||
            a.sortOrder - b.sortOrder ||
            (seq.get(a.id) ?? 0) - (seq.get(b.id) ?? 0),
        )
        .map(copy);
    },

    async getActForOwner(
      { bookingRequestId, actOwnerType, actOwnerId },
      readOptions,
    ) {
      const row = findByOwner(bookingRequestId, actOwnerType, actOwnerId);
      if (!row) return null;
      if (row.removedAt !== null && !readOptions?.includeRemoved) return null;
      return copy(row);
    },

    async setActConfirmation(input: SetBookingRequestActConfirmationInput) {
      // Owner-scoped CAS, mirroring the adapter's WHERE.
      const current = findByOwner(
        input.bookingRequestId,
        input.actOwnerType,
        input.actOwnerId,
      );
      if (
        !current ||
        // Only TAGGED rows carry consent (the adapter's WHERE has it too).
        current.source !== "TAGGED" ||
        current.confirmation !== input.expectedFrom ||
        // A removed act cannot answer.
        current.removedAt !== null
      ) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      const next: BookingRequestActRecord = {
        ...current,
        confirmation: input.to,
        respondedAt: input.respondedAt,
        declineReason:
          input.to === "DECLINED" ? (input.declineReason ?? null) : null,
        updatedAt: new Date(),
      };
      rows.set(next.id, next);
      return copy(next);
    },

    async lockBill() {
      // Nothing to serialize in memory (see the doc above).
    },

    async promoteActToSelf(input: PromoteBookingRequestActToSelfInput) {
      const found = await options.senderOf?.(input.bookingRequestId);
      if (found === undefined) {
        throw {
          code: "not_found",
          message: "booking_request_not_found",
        } as const;
      }
      if (found === null) {
        throw {
          code: "invalid_input",
          message: "booking_request_self_act_without_sender",
        } as const;
      }
      const current = rows.get(input.actId);
      if (
        !current ||
        current.bookingRequestId !== input.bookingRequestId ||
        current.source !== "EXTERNAL" ||
        current.removedAt !== null
      ) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      if (findByOwner(input.bookingRequestId, found.ownerType, found.ownerId)) {
        throw {
          code: "conflict",
          message: "booking_request_act_duplicate",
        } as const;
      }
      const next: BookingRequestActRecord = {
        ...current,
        source: "SELF",
        actOwnerType: found.ownerType,
        actOwnerId: found.ownerId,
        externalName: null,
        externalUrl: null,
        confirmation: "CONFIRMED",
        updatedAt: new Date(),
      };
      rows.set(next.id, next);
      return copy(next);
    },

    async softRemoveAct(input: SoftRemoveBookingRequestActInput) {
      const current = liveOn(input.bookingRequestId, input.actId);
      if (!current) throw stateChanged();
      const next: BookingRequestActRecord = {
        ...current,
        removedAt: input.at,
        updatedAt: new Date(),
      };
      rows.set(next.id, next);
      return copy(next);
    },

    async restoreAct(input: RestoreBookingRequestActInput) {
      const current = rows.get(input.actId);
      if (
        !current ||
        current.bookingRequestId !== input.bookingRequestId ||
        current.removedAt === null ||
        // A pass is final (L14).
        current.confirmation === "DECLINED"
      ) {
        throw stateChanged();
      }
      const next: BookingRequestActRecord =
        current.source === "TAGGED"
          ? {
              ...current,
              removedAt: null,
              sortOrder: input.sortOrder,
              confirmation: "PENDING",
              respondedAt: null,
              declineReason: null,
              invitedAt: input.invitedAt ?? null,
              updatedAt: new Date(),
            }
          : {
              ...current,
              removedAt: null,
              sortOrder: input.sortOrder,
              updatedAt: new Date(),
            };
      rows.set(next.id, next);
      return copy(next);
    },

    async setActSortOrders(input: SetBookingRequestActSortOrdersInput) {
      const liveIds = new Set(
        [...rows.values()]
          .filter(
            (r) =>
              r.bookingRequestId === input.bookingRequestId &&
              r.removedAt === null,
          )
          .map((r) => r.id),
      );
      const named = new Set(input.orderedActIds);
      if (
        named.size !== input.orderedActIds.length ||
        named.size !== liveIds.size ||
        [...named].some((id) => !liveIds.has(id))
      ) {
        throw {
          code: "conflict",
          message: "booking_request_bill_changed",
        } as const;
      }
      const now = new Date();
      input.orderedActIds.forEach((id, index) => {
        const row = rows.get(id)!;
        rows.set(id, { ...row, sortOrder: index, updatedAt: now });
      });
      return [...rows.values()]
        .filter(
          (r) =>
            r.bookingRequestId === input.bookingRequestId &&
            r.removedAt === null,
        )
        .sort(
          (a, b) =>
            a.sortOrder - b.sortOrder ||
            (seq.get(a.id) ?? 0) - (seq.get(b.id) ?? 0),
        )
        .map(copy);
    },

    async setActRole(input: SetBookingRequestActRoleInput) {
      const current = liveOn(input.bookingRequestId, input.actId);
      if (!current) throw stateChanged();
      assertRoleLabel(input.role, input.customRoleLabel);
      const next: BookingRequestActRecord = {
        ...current,
        role: input.role,
        customRoleLabel: input.customRoleLabel,
        updatedAt: new Date(),
      };
      rows.set(next.id, next);
      return copy(next);
    },
  };
}
