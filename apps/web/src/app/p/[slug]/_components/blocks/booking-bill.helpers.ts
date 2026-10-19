/**
 * Pure helpers for "The bill" inside the place-page PERFORM pitch
 * (lineup-booking-requests v3, FR-002 / L12 / L13 / L17; board F1).
 *
 * The wire contract lives in core
 * (`packages/core/src/use-cases/booking-requests/_shared/bill-schema.ts`).
 * It is NOT imported here: that module pulls zod + the sanitize-html graph,
 * which this client bundle deliberately avoids (see the header of
 * `request-to-play-form.helpers.ts`). The constants below are pinned to
 * core's by `__tests__/booking-bill.helpers.test.ts`, so the two cannot
 * drift silently.
 */

/** Most rows one bill may hold, the sender's own act INCLUDED (core: BOOKING_BILL_MAX_ROWS). */
export const BOOKING_BILL_MAX_ROWS = 12;

/** Free-text act name bound (core: BOOKING_BILL_ACT_NAME_MAX_LENGTH). */
export const BOOKING_BILL_ACT_NAME_MAX = 120;

/** OTHER's role-name bound (core: BOOKING_BILL_CUSTOM_ROLE_LABEL_MAX_LENGTH). */
export const BOOKING_BILL_ROLE_LABEL_MAX = 60;

/** Same bound as the pitch's typed link slots. */
export const BOOKING_BILL_LINK_MAX = 2000;

/**
 * EventHuman's role vocabulary, in the lineup editor's order, so the bill maps
 * one-to-one onto the event lineup (core: bookingRequestActRoleSchema).
 */
export const BOOKING_BILL_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "VOLUNTEER",
  "OTHER",
] as const;

export type BookingBillRole = (typeof BOOKING_BILL_ROLES)[number];

/** The lineup editor's own labels (LineupEditor.tsx ROLE_I18N_MAP). */
export const BOOKING_BILL_ROLE_KEYS = {
  PERFORMER: "admin.ebLineupRolePerformer",
  HOST: "admin.ebLineupRoleHost",
  DJ: "admin.ebLineupRoleDj",
  INSTRUCTOR: "admin.ebLineupRoleInstructor",
  SPEAKER: "admin.ebLineupRoleSpeaker",
  VENDOR: "admin.ebLineupRoleVendor",
  VOLUNTEER: "admin.ebLineupRoleVolunteer",
  OTHER: "admin.ebLineupRoleOther",
} as const satisfies Record<BookingBillRole, string>;

/**
 * One act the sender has put on the bill, as the form holds it. `key` is a
 * client-only React key. A tagged act carries the platform identity it was
 * picked as; a by-name act carries only what was typed.
 */
export type BookingBillActDraft =
  | {
      key: string;
      kind: "tagged";
      ownerType: "human" | "org";
      ownerId: string;
      name: string;
      role: BookingBillRole;
      customRoleLabel: string;
    }
  | {
      key: string;
      kind: "external";
      name: string;
      url: string;
      role: BookingBillRole;
      customRoleLabel: string;
    };

/** One act on the wire (core: bookingBillActSchema). */
export type BookingBillActPayload =
  | {
      kind: "tagged";
      humanId?: string;
      orgId?: string;
      role: BookingBillRole;
      customRoleLabel?: string;
    }
  | {
      kind: "external";
      name: string;
      url?: string;
      role: BookingBillRole;
      customRoleLabel?: string;
    };

export type BookingBillPayload = {
  includeSelf: boolean;
  acts: BookingBillActPayload[];
};

export type BookingBillErrorKey =
  | "admin.bkErrBillTooLong"
  | "admin.bkErrBillActInvalid"
  | "admin.bkErrBillSelfTag"
  | "admin.bkErrBillDuplicate";

/** Rows the bill currently holds, the sender's own act included. */
export function bookingBillRowCount(args: {
  includeSelf: boolean;
  acts: readonly unknown[];
}): number {
  return (args.includeSelf ? 1 : 0) + args.acts.length;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The label is kept only beside OTHER, and only when it says something. */
function roleFields(act: {
  role: BookingBillRole;
  customRoleLabel: string;
}): { role: BookingBillRole; customRoleLabel?: string } {
  const label = act.customRoleLabel.trim();
  return act.role === "OTHER" && label.length > 0
    ? { role: act.role, customRoleLabel: label }
    : { role: act.role };
}

/**
 * The `bill` field for `bookingRequests.create`, or `undefined` when it must
 * be OMITTED.
 *
 * Omitted exactly when the bill says what the server already assumes without
 * one — the sender alone (`includeSelf: true`, no acts; create-booking-
 * request.ts `resolveBill`). That keeps every pre-bill payload byte-identical.
 * A sender who is NOT on their own bill (a promoter without performer mode,
 * or someone who switched themselves off) must send `includeSelf: false`
 * even with no acts: the server's default would put them on it and refuse
 * with PERFORMER_MODE_REQUIRED.
 *
 * `includeSelf` undefined = a caller that predates the bill = on.
 */
export function buildBookingBillPayload(args: {
  includeSelf?: boolean;
  acts?: readonly BookingBillActDraft[];
  sender?: { ownerType: "human" | "org"; ownerId: string };
}):
  | { ok: true; bill: BookingBillPayload | undefined }
  | { ok: false; errorKey: BookingBillErrorKey } {
  const includeSelf = args.includeSelf !== false;
  const drafts = args.acts ?? [];

  if (bookingBillRowCount({ includeSelf, acts: drafts }) > BOOKING_BILL_MAX_ROWS) {
    return { ok: false, errorKey: "admin.bkErrBillTooLong" };
  }

  const seen = new Set<string>();
  const acts: BookingBillActPayload[] = [];
  for (const draft of drafts) {
    const label = draft.customRoleLabel.trim();
    if (draft.role === "OTHER" && label.length > BOOKING_BILL_ROLE_LABEL_MAX) {
      return { ok: false, errorKey: "admin.bkErrBillActInvalid" };
    }
    if (draft.kind === "tagged") {
      if (
        draft.ownerType === args.sender?.ownerType &&
        draft.ownerId === args.sender.ownerId
      ) {
        return { ok: false, errorKey: "admin.bkErrBillSelfTag" };
      }
      const identity = `${draft.ownerType}:${draft.ownerId}`;
      if (seen.has(identity)) {
        return { ok: false, errorKey: "admin.bkErrBillDuplicate" };
      }
      seen.add(identity);
      acts.push({
        kind: "tagged",
        ...(draft.ownerType === "human"
          ? { humanId: draft.ownerId }
          : { orgId: draft.ownerId }),
        ...roleFields(draft),
      });
      continue;
    }
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (
      name.length === 0 ||
      name.length > BOOKING_BILL_ACT_NAME_MAX ||
      (url.length > 0 && (url.length > BOOKING_BILL_LINK_MAX || !isHttpUrl(url)))
    ) {
      return { ok: false, errorKey: "admin.bkErrBillActInvalid" };
    }
    acts.push({
      kind: "external",
      name,
      ...(url.length > 0 ? { url } : {}),
      ...roleFields(draft),
    });
  }

  if (includeSelf && acts.length === 0) return { ok: true, bill: undefined };
  return { ok: true, bill: { includeSelf, acts } };
}

/** A copy with the act at `index` swapped one place up (-1) or down (+1). */
export function moveBillAct<T>(
  acts: readonly T[],
  index: number,
  direction: -1 | 1,
): T[] {
  const target = index + direction;
  if (index < 0 || index >= acts.length || target < 0 || target >= acts.length) {
    return [...acts];
  }
  const next = [...acts];
  const moved = next[index] as T;
  next[index] = next[target] as T;
  next[target] = moved;
  return next;
}

/** "01", "02", … — the ledger's index column. */
export function billIndexLabel(position: number): string {
  return String(position).padStart(2, "0");
}

/**
 * Why a new act cannot go on the bill, or null when it can. A tagged act is a
 * duplicate by identity; a by-name act by its name (case-insensitive) against
 * every row, so two rows never read the same and their row controls never
 * share an accessible name.
 */
export function billAddRefusal(args: {
  acts: readonly BookingBillActDraft[];
  candidate:
    | { kind: "tagged"; ownerType: "human" | "org"; ownerId: string }
    | { kind: "external"; name: string };
  sender?: { ownerType: "human" | "org"; ownerId: string };
  rowCount: number;
}): "full" | "self" | "duplicate" | null {
  if (args.rowCount >= BOOKING_BILL_MAX_ROWS) return "full";
  const { candidate } = args;
  if (candidate.kind === "tagged") {
    if (
      candidate.ownerType === args.sender?.ownerType &&
      candidate.ownerId === args.sender.ownerId
    ) {
      return "self";
    }
    return args.acts.some(
      (act) =>
        act.kind === "tagged" &&
        act.ownerType === candidate.ownerType &&
        act.ownerId === candidate.ownerId,
    )
      ? "duplicate"
      : null;
  }
  const name = candidate.name.trim().toLocaleLowerCase();
  return args.acts.some((act) => act.name.trim().toLocaleLowerCase() === name)
    ? "duplicate"
    : null;
}

/**
 * The name each row's controls are announced by. Two different platform acts
 * can share a display name; only then is the position appended, so "Move
 * Paper Moth up" stays the common case and no two buttons on the page share
 * an accessible name.
 */
export function billRowNames(
  acts: readonly { name: string }[],
  firstPosition: number,
): string[] {
  const counts = new Map<string, number>();
  for (const act of acts) {
    const k = act.name.trim().toLocaleLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return acts.map((act, i) =>
    (counts.get(act.name.trim().toLocaleLowerCase()) ?? 0) > 1
      ? `${act.name} (${billIndexLabel(firstPosition + i)})`
      : act.name,
  );
}
