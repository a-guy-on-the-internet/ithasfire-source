import { z } from "zod";

export const OFFSET_DEFAULT_LIMIT = 25;
export const OFFSET_MAX_LIMIT = 200;
export const CURSOR_DEFAULT_LIMIT = 25;
export const CURSOR_MAX_LIMIT = 200;

export const offsetPaginationInputSchema = z.object({
  limit: z.number().int().min(1).max(OFFSET_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export const cursorPaginationInputSchema = z.object({
  limit: z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional().nullable(),
});

export type OffsetPaginationInput = z.infer<typeof offsetPaginationInputSchema>;
export type CursorPaginationInput = z.infer<typeof cursorPaginationInputSchema>;

export const offsetPageInfoSchema = z.object({
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  hasNextPage: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type OffsetPageInfo = z.infer<typeof offsetPageInfoSchema>;

export const cursorPageInfoSchema = z.object({
  cursorField: z.string().min(1),
  nextCursor: z.string().min(1).nullable(),
  limit: z.number().int().positive(),
  hasNextPage: z.boolean(),
});

export type CursorPageInfo = z.infer<typeof cursorPageInfoSchema>;

export const offsetPaginatedResultSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
) =>
  z.object({
    items: z.array(itemSchema),
    pageInfo: offsetPageInfoSchema,
  });

export const cursorPaginatedResultSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
) =>
  z.object({
    items: z.array(itemSchema),
    pageInfo: cursorPageInfoSchema,
  });

export type OffsetPaginatedResult<T> = {
  items: T[];
  pageInfo: OffsetPageInfo;
};

export type CursorPaginatedResult<T> = {
  items: T[];
  pageInfo: CursorPageInfo;
};

export type OffsetPaginationParams = {
  limit?: number;
  offset?: number;
  defaultLimit?: number;
  maxLimit?: number;
};

export function sanitizeOffsetPagination({
  limit,
  offset,
  defaultLimit = OFFSET_DEFAULT_LIMIT,
  maxLimit = OFFSET_MAX_LIMIT,
}: OffsetPaginationParams) {
  const safeLimit = Math.min(Math.max(limit ?? defaultLimit, 1), maxLimit);
  const safeOffset = Math.max(offset ?? 0, 0);

  return { limit: safeLimit, offset: safeOffset } as const;
}

export function buildOffsetPageInfo(params: {
  total: number;
  limit: number;
  offset: number;
  count: number;
}): OffsetPageInfo {
  const { total, limit, offset, count } = params;
  const hasNextPage = offset + count < total;
  const nextOffset = hasNextPage ? offset + count : null;

  return {
    total,
    count,
    limit,
    offset,
    hasNextPage,
    nextOffset,
  } satisfies OffsetPageInfo;
}

export function buildOffsetPaginatedResult<T>(params: {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
}): OffsetPaginatedResult<T> {
  const { items, total = items.length, offset = 0 } = params;
  const limit =
    params.limit ?? (items.length > 0 ? items.length : OFFSET_DEFAULT_LIMIT);

  return {
    items,
    pageInfo: buildOffsetPageInfo({
      total,
      limit,
      offset,
      count: items.length,
    }),
  } satisfies OffsetPaginatedResult<T>;
}
