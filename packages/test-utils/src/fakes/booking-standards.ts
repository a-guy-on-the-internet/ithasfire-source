import type {
  BookingPitchExampleRecord,
  BookingStandardItemRecord,
  BookingStandardOwnerKey,
  BookingStandardsRepo,
} from "@th/ports/repos/booking-standards";
import type { BookingIntent } from "@th/ports/repos/booking-requests";

export type FakeBookingStandards = BookingStandardsRepo & {
  /** Stored objects, keyed by id — the methods hand out copies. */
  items: Map<string, BookingStandardItemRecord>;
  examples: Map<string, BookingPitchExampleRecord>;
};

/** Postgres enum DECLARATION order — what the adapter's ORDER BY sorts by. */
const OWNER_TYPE_ORDER = { PLACE: 0, CALENDAR: 1 } as const;
const INTENT_ORDER = { PERFORM: 0, RENT: 1, USE: 2 } as const;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function readOrder<
  T extends BookingStandardOwnerKey & {
    intent: BookingIntent;
    sortOrder: number;
    id: string;
  },
>(a: T, b: T): number {
  return (
    OWNER_TYPE_ORDER[a.ownerType] - OWNER_TYPE_ORDER[b.ownerType] ||
    cmpStr(a.ownerId, b.ownerId) ||
    INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent] ||
    a.sortOrder - b.sortOrder ||
    cmpStr(a.id, b.id)
  );
}

/**
 * Map-backed BookingStandardsRepo with the adapter's real semantics (house
 * style: real behaviour, not vi.fn stubs — spy with `vi.spyOn` when call
 * assertions are needed):
 *   - `listForOwners` returns both lists for the requested owner PAIRS,
 *     optionally one intent, ordered (ownerType, ownerId, intent, sortOrder,
 *     id) with ownerType / intent in enum declaration order, like Postgres;
 *   - `replaceItems` / `replaceExamples` replace ONE (owner, intent) and stamp
 *     sortOrder 0..n-1 from array order;
 *   - D2a: a CUSTOM + REQUIRED item throws (the SQL CHECK's stand-in) and
 *     NOTHING changes — the old rows stay, like the adapter's transaction.
 * The fake does NOT enforce the VarChar bounds; core's schemas do, first.
 * Every method returns COPIES, so a caller mutating a result cannot edit the
 * store behind the fake's back.
 */
export function createFakeBookingStandards(): FakeBookingStandards {
  const items = new Map<string, BookingStandardItemRecord>();
  const examples = new Map<string, BookingPitchExampleRecord>();

  const sameScope = (
    row: BookingStandardOwnerKey & { intent: BookingIntent },
    scope: BookingStandardOwnerKey & { intent: BookingIntent },
  ) =>
    row.ownerType === scope.ownerType &&
    row.ownerId === scope.ownerId &&
    row.intent === scope.intent;

  return {
    items,
    examples,

    async listForOwners({ owners, intent }) {
      if (owners.length === 0) return { items: [], examples: [] };
      const wanted = new Set(owners.map((o) => `${o.ownerType}|${o.ownerId}`));
      const matches = (row: BookingStandardOwnerKey & { intent: BookingIntent }) =>
        wanted.has(`${row.ownerType}|${row.ownerId}`) &&
        (intent === undefined || row.intent === intent);
      return {
        items: [...items.values()]
          .filter(matches)
          .sort(readOrder)
          .map((r) => structuredClone(r)),
        examples: [...examples.values()]
          .filter(matches)
          .sort(readOrder)
          .map((r) => structuredClone(r)),
      };
    },

    async replaceItems(input) {
      // Validate the whole batch BEFORE touching the store — the adapter's
      // transaction rolls back on the CHECK, so a failure changes nothing.
      if (
        input.items.some(
          (item) => item.field === "CUSTOM" && item.requirement === "REQUIRED",
        )
      ) {
        throw new Error(
          'new row for relation "BookingStandardItem" violates check constraint "BookingStandardItem_custom_is_suggested_check"',
        );
      }
      for (const [id, row] of items) {
        if (sameScope(row, input)) items.delete(id);
      }
      const now = new Date();
      const out = input.items.map((item, index) => {
        const record: BookingStandardItemRecord = {
          id: crypto.randomUUID(),
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          intent: input.intent,
          field: item.field,
          label: item.label,
          hint: item.hint ?? null,
          requirement: item.requirement,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        };
        items.set(record.id, record);
        return structuredClone(record);
      });
      return out;
    },

    async replaceExamples(input) {
      for (const [id, row] of examples) {
        if (sameScope(row, input)) examples.delete(id);
      }
      const now = new Date();
      return input.examples.map((example, index) => {
        const record: BookingPitchExampleRecord = {
          id: crypto.randomUUID(),
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          intent: input.intent,
          title: example.title,
          body: example.body,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        };
        examples.set(record.id, record);
        return structuredClone(record);
      });
    },
  };
}
