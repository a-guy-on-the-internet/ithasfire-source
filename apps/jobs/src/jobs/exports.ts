/**
 * Admin CSV Export Job
 *
 * Background job that:
 * 1. Fetches all pages for a given admin data query (orders, settlements).
 * 2. Builds a CSV string.
 * 3. Uploads it to R2 under the `exports/` prefix.
 * 4. Creates an in-app notification with a time-limited download link.
 *
 * Files are stored under `exports/{orgId}/{exportType}-{timestamp}.csv`.
 * R2 lifecycle rules on the `exports/` prefix handle automatic expiry (7 days).
 */
import { z } from "zod";
import { defineJob, type JobContext } from "../lib/define-job";
import { listOrgOrders } from "@th/core/use-cases/orders/list-org-orders";
import { listOrgSettlements } from "@th/core/use-cases/settlements/list-org-settlements";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 200;
const MAX_ROWS = 100_000;
/** Signed URL lifetime in seconds (24 hours). */
const DOWNLOAD_LINK_EXPIRES_SEC = 86_400;
/** Notification expiry: 7 days from now. */
const NOTIFICATION_EXPIRY_DAYS = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

const adminCsvExportInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  exportType: z.enum(["org_orders", "org_settlements"]),
  filters: z
    .object({
      searchQuery: z.string().max(200).optional(),
      status: z.string().max(50).optional(),
      sort: z.string().max(50).optional(),
    })
    .default({}),
});

type AdminCsvExportInput = z.infer<typeof adminCsvExportInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// CSV helpers (server-side, no DOM needed)
// ─────────────────────────────────────────────────────────────────────────────

interface CsvCol<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

function buildCsv<T>(rows: T[], cols: CsvCol<T>[]): string {
  const esc = (v: string): string => {
    if (
      v.includes('"') ||
      v.includes(",") ||
      v.includes("\n") ||
      v.includes("\r")
    ) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };

  const header = cols.map((c) => esc(c.header)).join(",");
  const body = rows
    .map((row) =>
      cols
        .map((col) => {
          const raw = col.value(row);
          if (raw == null) return "";
          return esc(String(raw));
        })
        .join(","),
    )
    .join("\n");

  // UTF-8 BOM for Excel compatibility
  return `\uFEFF${header}\n${body}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export builders per type
// ─────────────────────────────────────────────────────────────────────────────

async function exportOrgOrders(
  ctx: JobContext,
  input: AdminCsvExportInput,
): Promise<{ csv: string; rowCount: number; filenameSlug: string }> {
  const allItems: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && offset < MAX_ROWS) {
    const page = await listOrgOrders(
      {
        repos: ctx.repos,
        authz: { canFinanceOrg: async () => ({ allowed: true }) } as any,
        logger: ctx.logger,
      },
      {
        actorHumanId: input.actorHumanId,
        orgId: input.orgId,
        searchQuery: input.filters.searchQuery,
        status: input.filters.status,
        sort: input.filters.sort,
        limit: PAGE_SIZE,
        offset,
      },
    );
    allItems.push(...page.items);
    hasMore = page.pageInfo.hasNextPage;
    offset += PAGE_SIZE;
  }

  const cols: CsvCol<any>[] = [
    { header: "Order ID", value: (r) => r.id },
    { header: "Date", value: (r) => r.occurredAt },
    { header: "Buyer Name", value: (r) => r.buyerName },
    { header: "Buyer Email", value: (r) => r.buyerEmail },
    { header: "Event", value: (r) => r.eventTitle },
    { header: "Gross (cents)", value: (r) => r.amountGrossCents },
    { header: "Platform Fee (cents)", value: (r) => r.feesPlatformCents },
    { header: "Currency", value: (r) => r.currency },
    { header: "Status", value: (r) => r.status },
    { header: "Source", value: (r) => r.source },
    { header: "Stripe PI", value: (r) => r.stripePaymentIntentId },
  ];

  return {
    csv: buildCsv(allItems, cols),
    rowCount: allItems.length,
    filenameSlug: "orders",
  };
}

async function exportOrgSettlements(
  ctx: JobContext,
  input: AdminCsvExportInput,
): Promise<{ csv: string; rowCount: number; filenameSlug: string }> {
  const allItems: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && offset < MAX_ROWS) {
    const page = await listOrgSettlements(
      {
        repos: ctx.repos,
        authz: { canFinanceOrg: async () => ({ allowed: true }) } as any,
        logger: ctx.logger,
      },
      {
        actorHumanId: input.actorHumanId,
        orgId: input.orgId,
        status: input.filters.status,
        limit: PAGE_SIZE,
        offset,
      },
    );
    allItems.push(...page.items);
    hasMore = page.pageInfo.hasNextPage;
    offset += PAGE_SIZE;
  }

  const cols: CsvCol<any>[] = [
    { header: "Settlement ID", value: (r) => r.id },
    { header: "Payee ID", value: (r) => r.payeeId },
    { header: "Date", value: (r) => r.date },
    { header: "Scheduled Payout Date", value: (r) => r.scheduledPayoutDate },
    { header: "Amount (cents)", value: (r) => r.amountCents },
    { header: "Currency", value: (r) => r.currency },
    { header: "Status", value: (r) => r.status },
    { header: "Stripe Transfer ID", value: (r) => r.stripeTransferId },
    { header: "Event ID", value: (r) => r.eventId },
    { header: "Event Title", value: (r) => r.eventTitle },
    { header: "Line Count", value: (r) => r.lineCount },
    { header: "Created At", value: (r) => r.createdAt },
  ];

  return {
    csv: buildCsv(allItems, cols),
    rowCount: allItems.length,
    filenameSlug: "settlements",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Job definition
// ─────────────────────────────────────────────────────────────────────────────

export const adminCsvExport = defineJob({
  name: "admin.csv-export",
  description:
    "Background CSV export for admin tables. Uploads the file to R2 and notifies the user with a download link.",
  input: adminCsvExportInputSchema,
  handler: async ({ input, ctx }) => {
    ctx.logger.info("admin.csv-export.start", {
      exportType: input.exportType,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
    });

    // 1. Fetch all data and build CSV
    let result: { csv: string; rowCount: number; filenameSlug: string };

    switch (input.exportType) {
      case "org_orders":
        result = await exportOrgOrders(ctx, input);
        break;
      case "org_settlements":
        result = await exportOrgSettlements(ctx, input);
        break;
      default:
        throw {
          code: "invalid_input",
          message: `Unknown export type: ${input.exportType}`,
        };
    }

    ctx.logger.info("admin.csv-export.csv_built", {
      rowCount: result.rowCount,
      csvBytes: Buffer.byteLength(result.csv, "utf-8"),
    });

    // 2. Upload to R2
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const storageKey = `exports/${input.orgId}/${result.filenameSlug}-${timestamp}.csv`;

    const { url: objectUrl } = await ctx.fileStorage.putObject({
      key: storageKey,
      content: Buffer.from(result.csv, "utf-8"),
      options: {
        contentType: "text/csv; charset=utf-8",
        metadata: {
          "th-export-type": input.exportType,
          "th-org-id": input.orgId,
          "th-actor-human-id": input.actorHumanId,
          "th-row-count": String(result.rowCount),
        },
      },
    });

    ctx.logger.info("admin.csv-export.uploaded", { storageKey, objectUrl });

    // 3. Generate a signed download URL (24h)
    const { url: downloadUrl } = await ctx.fileStorage.getObjectUrl({
      key: storageKey,
      options: { expiresSec: DOWNLOAD_LINK_EXPIRES_SEC },
    });

    // 4. Create in-app notification with download link
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + NOTIFICATION_EXPIRY_DAYS);

    const exportLabel =
      input.exportType === "org_orders" ? "Orders" : "Settlements";

    if (ctx.repos.notifications) {
      await ctx.repos.notifications.create({
        humanId: input.actorHumanId,
        title: "Export ready",
        body: `Your ${exportLabel} CSV export is ready (${result.rowCount.toLocaleString()} rows). The download link expires in 24 hours.`,
        kind: "SUCCESS",
        tags: ["admin-export"],
        expiresAt,
        action: {
          label: "Download CSV",
          href: downloadUrl,
        },
      });
    }

    ctx.logger.info("admin.csv-export.completed", {
      exportType: input.exportType,
      rowCount: result.rowCount,
      storageKey,
    });

    return {
      success: true,
      exportType: input.exportType,
      rowCount: result.rowCount,
      storageKey,
    };
  },
});

export const exportJobs = [adminCsvExport];
