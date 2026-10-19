import { Prisma } from "@prisma/client";
import type { SupportThreadRepository } from "@th/ports/repos/support";
import type {
  ListSupportThreadsResult,
  SupportMessageRecord,
  SupportThreadRecord,
  SupportThreadStaffRecord,
} from "@th/types/repos/support";
import { formatOrderCode } from "@th/types/order-identifier";

import type { PrismaClientOrTx } from "./types";

const threadSelect = {
  id: true,
  humanId: true,
  eventId: true,
  orderId: true,
  status: true,
  source: true,
  lastMessageAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const messageSelect = {
  id: true,
  threadId: true,
  authorType: true,
  authorHumanId: true,
  body: true,
  readAt: true,
  createdAt: true,
} as const;

// Inbox priority: escalated threads first, then open, then resolved. Mirrors
// the `status ASC` enum-order sort in listThreads but is independent of the
// enum's declaration order, so the inbox stays correct if the enum is ever
// re-declared.
const STATUS_SORT_PRIORITY: Record<string, number> = {
  AWAITING_HUMAN: 0,
  OPEN: 1,
  RESOLVED: 2,
};

// Staff-inbox select: the base columns plus identity/context relations resolved
// in the SAME query (no N+1). Email lives on AuthUser (not Human) — mirror the
// orders adapter's `buyer.authUser.email` join. event/order are optional FKs
// (SetNull), so their relations may be absent. This select feeds the STAFF-ONLY
// listThreads path; attendee-facing reads keep the lean `threadSelect`, so
// name/email never leak into getMyActiveThread / getMessages / sendMessage.
const staffThreadSelect = {
  ...threadSelect,
  human: { select: { name: true, authUser: { select: { email: true } } } },
  event: { select: { title: true } },
  order: { select: { id: true } },
  // Latest non-SYSTEM message, used to derive `needsReply` /
  // `lastMessageAuthorType` for the operator inbox. Prisma resolves this
  // relation include as ONE additional batched query for the whole page (not
  // per-row), so it satisfies the "no N+1" requirement. SYSTEM messages (status
  // notes) are excluded so they can't masquerade as a reply.
  messages: {
    where: { authorType: { not: "SYSTEM" } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { authorType: true },
  },
} as const;

type ThreadRow = Prisma.SupportThreadGetPayload<{ select: typeof threadSelect }>;
type StaffThreadRow = Prisma.SupportThreadGetPayload<{
  select: typeof staffThreadSelect;
}>;
type MessageRow = Prisma.SupportMessageGetPayload<{
  select: typeof messageSelect;
}>;

function toThreadRecord(row: ThreadRow): SupportThreadRecord {
  return {
    id: row.id,
    humanId: row.humanId,
    eventId: row.eventId,
    orderId: row.orderId,
    status: row.status,
    source: row.source,
    lastMessageAt: row.lastMessageAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStaffThreadRecord(row: StaffThreadRow): SupportThreadStaffRecord {
  // `messages` carries at most the single latest non-SYSTEM message (see
  // staffThreadSelect). `needsReply` is true only when that message is from the
  // USER — i.e. the ball is in the operator's court with no later agent reply.
  const lastMessageAuthorType = row.messages[0]?.authorType ?? null;
  return {
    ...toThreadRecord(row),
    // `human` is an OPTIONAL relation (FK is ON DELETE SET NULL), so a thread
    // whose owner was GDPR-erased returns `human: null` — degrade to null
    // name/email rather than throwing. The id-fragment fallback in the UI's
    // identity resolver covers the owner-less case.
    humanDisplayName: row.human?.name ?? null,
    humanEmail: row.human?.authUser?.email ?? null,
    eventTitle: row.event?.title ?? null,
    // The ONE order code, same as every other surface: the 8-hex tail of the
    // order id, uppercased. Derived through `formatOrderCode` rather than
    // sliced inline so support can never drift from admin search / the order
    // page — an operator reading a code off this inbox must be able to paste it
    // straight into search.
    orderRef: row.order ? formatOrderCode(row.order.id) : null,
    lastMessageAuthorType,
    needsReply: lastMessageAuthorType === "USER",
  };
}

function toMessageRecord(row: MessageRow): SupportMessageRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    authorType: row.authorType,
    authorHumanId: row.authorHumanId,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export function makeSupportThreadRepo(
  p: PrismaClientOrTx,
): SupportThreadRepository {
  return {
    createThread: async (input) => {
      const row = await p.supportThread.create({
        data: {
          humanId: input.humanId,
          eventId: input.eventId ?? null,
          orderId: input.orderId ?? null,
          status: input.status ?? "OPEN",
          source: input.source ?? "WIDGET",
          lastMessageAt: input.lastMessageAt,
        },
        select: threadSelect,
      });
      return toThreadRecord(row);
    },

    getThreadById: async (threadId) => {
      const row = await p.supportThread.findUnique({
        where: { id: threadId },
        select: threadSelect,
      });
      return row ? toThreadRecord(row) : null;
    },

    findActiveThreadByHuman: async (humanId) => {
      const row = await p.supportThread.findFirst({
        where: {
          humanId,
          status: { in: ["OPEN", "AWAITING_HUMAN"] },
        },
        orderBy: { lastMessageAt: "desc" },
        select: threadSelect,
      });
      return row ? toThreadRecord(row) : null;
    },

    appendMessage: async (input) => {
      // Insert the message, then bump the parent thread's lastMessageAt so the
      // inbox ordering stays current. Kept as two sequential writes rather than
      // a nested `$transaction` because `p` may already be a TransactionClient
      // (Prisma forbids nesting); the use cases that need atomicity wrap calls
      // in `repos.tx()`. A momentary lag on lastMessageAt has no invariant
      // impact — it only affects inbox sort recency.
      const message = await p.supportMessage.create({
        data: {
          threadId: input.threadId,
          authorType: input.authorType,
          authorHumanId: input.authorHumanId ?? null,
          body: input.body,
        },
        select: messageSelect,
      });
      await p.supportThread.update({
        where: { id: input.threadId },
        data: { lastMessageAt: input.lastMessageAt },
        select: { id: true },
      });
      return toMessageRecord(message);
    },

    updateThreadStatus: async (input) => {
      const row = await p.supportThread.update({
        where: { id: input.threadId },
        data: {
          status: input.status,
          resolvedAt: input.resolvedAt,
        },
        select: threadSelect,
      });
      return toThreadRecord(row);
    },

    listMessages: async (threadId, since) => {
      // Incremental cursor: when `since` is supplied the caller already holds
      // every message up to and INCLUDING that createdAt, so we fetch only
      // messages STRICTLY newer (`gt`, not `gte`) — passing the createdAt of the
      // newest seen message never re-fetches it. Absent → full history (initial
      // load). Backed by the @@index([threadId, createdAt]) on SupportMessage.
      const rows = await p.supportMessage.findMany({
        where: { threadId, ...(since ? { createdAt: { gt: since } } : {}) },
        orderBy: { createdAt: "asc" },
        select: messageSelect,
      });
      return rows.map(toMessageRecord);
    },

    markMessagesRead: async (input) => {
      const result = await p.supportMessage.updateMany({
        where: {
          threadId: input.threadId,
          authorType: { in: input.authorTypes },
          readAt: null,
        },
        data: { readAt: input.readAt },
      });
      return { updated: result.count };
    },

    scrubHumanSupportContent: async (input) => {
      // GDPR/CCPA erasure (see port docstring). Two ordered updateMany passes
      // over the same human's authored messages. The thread's own humanId is
      // handled by the FK ON DELETE SET NULL when the Human row is deleted;
      // SupportMessage.authorHumanId has no FK, so we scrub it by hand here.

      // 1) USER free-text: tombstone the body AND drop the author link. This
      //    is the actual content the user typed — it must not survive erasure.
      const scrubbed = await p.supportMessage.updateMany({
        where: { authorHumanId: input.humanId, authorType: "USER" },
        data: { body: input.tombstone, authorHumanId: null },
      });

      // 2) Remaining author links by this human (e.g. HUMAN_AGENT operator
      //    replies). The USER rows from step 1 are already null, so this pass
      //    catches only the non-USER messages — null their authorHumanId to
      //    drop the identity link without rewriting their (non-user) body.
      const cleared = await p.supportMessage.updateMany({
        where: { authorHumanId: input.humanId },
        data: { authorHumanId: null },
      });

      return {
        messagesScrubbed: scrubbed.count,
        authorLinksCleared: cleared.count,
      };
    },

    listThreads: async (input): Promise<ListSupportThreadsResult> => {
      const where: Prisma.SupportThreadWhereInput = input.status
        ? { status: input.status }
        : {};

      const [rows, total] = await Promise.all([
        p.supportThread.findMany({
          where,
          // SupportThreadStatus is declared AWAITING_HUMAN, OPEN, RESOLVED, and
          // Postgres sorts enum columns by declaration order — so `status ASC`
          // surfaces escalated threads first (the spec's "awaiting-human
          // first"), then most recently active within each status bucket. The
          // explicit sort below re-derives that intent in JS so the inbox
          // order is self-defending if the enum is ever re-declared.
          orderBy: [{ status: "asc" }, { lastMessageAt: "desc" }],
          take: input.limit,
          skip: input.offset,
          select: staffThreadSelect,
        }),
        p.supportThread.count({ where }),
      ]);

      const items = rows
        .map(toStaffThreadRecord)
        .sort(
          (a, b) =>
            (STATUS_SORT_PRIORITY[a.status] ?? 0) -
              (STATUS_SORT_PRIORITY[b.status] ?? 0) ||
            b.lastMessageAt.getTime() - a.lastMessageAt.getTime(),
        );

      return { items, total };
    },

    deleteResolvedThreadsBefore: async (input) => {
      // Bound the batch: select up to `limit` eligible thread ids first (oldest
      // resolved first), then deleteMany by id. Their messages cascade-delete
      // (SupportMessage.thread onDelete: Cascade), so the conversation is fully
      // removed. We don't delete-by-where directly so the job can chip away at a
      // large backlog in bounded chunks across runs.
      const rows = await p.supportThread.findMany({
        where: { status: "RESOLVED", resolvedAt: { not: null, lt: input.before } },
        select: { id: true },
        take: input.limit,
        orderBy: { resolvedAt: "asc" },
      });
      if (rows.length === 0) {
        return { deleted: 0 };
      }
      const result = await p.supportThread.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      return { deleted: result.count };
    },
  };
}
