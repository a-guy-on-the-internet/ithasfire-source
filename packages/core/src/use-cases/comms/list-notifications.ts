import { z } from "zod";

import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  NotificationAction,
  NotificationKind,
  NotificationRecord,
} from "@th/ports/repos/notifications";

import { parseInput } from "../../lib/io";
import { resolveNotificationLocale } from "./locale";
import { renderStoredNotifications } from "./render-stored-notification";

export const listNotificationsInputSchema = z
  .object({
    /** The reader. Transports take it from the session, never from the client. */
    humanId: z.string().min(1),
    /** Only unread (`false`), only read (`true`), or all (absent). */
    read: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    /** `createdAt` of the last item of the previous page. */
    cursor: z.date().optional(),
    /**
     * The reader's UI language. Rows are re-rendered in it where their copy
     * exists; anything unknown resolves to English (the stored text).
     */
    locale: z.string().max(35).optional(),
  })
  .strict();

export type ListNotificationsInput = z.infer<
  typeof listNotificationsInputSchema
>;

/**
 * One inbox row as it leaves core. Deliberately NOT `NotificationRecord`: the
 * stored template (`templateKey/Version/Variables`) is the full render
 * payload, which can hold more than the visible text (ids, URLs, a withheld
 * address), so it never leaves the server. Built field by field, so a column
 * added to the record later does not reach clients until it is added here.
 */
export type NotificationListItem = {
  id: string;
  humanId: string;
  title: string | null;
  body: string;
  kind: NotificationKind;
  metadata: Record<string, string> | null;
  tags: string[];
  expiresAt: Date | null;
  readAt: Date | null;
  action: NotificationAction | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ListNotificationsOutput = {
  items: NotificationListItem[];
  /** `null` when there are no more pages. */
  nextCursor: Date | null;
};

export type ListNotificationsDeps = {
  repos: Pick<Repos, "notifications">;
  /** Re-render failures (stored text is shown instead); see renderStoredNotifications. */
  reportError?: ReporterPort;
};

function toListItem(row: NotificationRecord): NotificationListItem {
  return {
    id: row.id,
    humanId: row.humanId,
    title: row.title,
    body: row.body,
    kind: row.kind,
    metadata: row.metadata,
    tags: row.tags,
    expiresAt: row.expiresAt,
    readAt: row.readAt,
    action: row.action,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The reader's inbox page, with each row's text in their language where the
 * copy exists (owner ruling 2026-10-03, option A) and the stored template
 * stripped. No notifications repo bound → an empty page.
 */
export async function listNotifications(
  deps: ListNotificationsDeps,
  rawInput: unknown,
): Promise<ListNotificationsOutput> {
  const input = parseInput(listNotificationsInputSchema, rawInput);
  const repo = deps.repos.notifications;
  if (!repo) return { items: [], nextCursor: null };

  const page = await repo.listByHuman({
    humanId: input.humanId,
    read: input.read,
    limit: input.limit,
    cursor: input.cursor,
  });
  const localized = renderStoredNotifications(
    { reportError: deps.reportError },
    page.items,
    resolveNotificationLocale(input.locale),
  );
  return { items: localized.map(toListItem), nextCursor: page.nextCursor };
}
