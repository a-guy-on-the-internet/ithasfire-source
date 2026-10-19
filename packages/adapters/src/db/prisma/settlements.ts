import type { SettlementsRepo } from "@th/ports/repos/settlements";

import type { PrismaClientOrTx } from "./types";

/**
 * READ-ONLY adapter over the FROZEN settlement tables (spec 2026-08-10 §7).
 * Every write method — drafts, claims, transfer marking, cancellation,
 * amount folding, failed-row reset — is DELETED: the `PayeeLedgerEntry`
 * journal is the only source of truth for what a payee is owed. What is left
 * serves the historical admin/report views.
 */
export function makeSettlementsRepo(p: PrismaClientOrTx): SettlementsRepo {
  return {
    getById: async (settlementId: string) => {
      const r = await p.settlement.findUnique({ where: { id: settlementId } });
      return r as any;
    },

    getByIds: async (ids: string[]) => {
      if (ids.length === 0) return [];
      const rows = await p.settlement.findMany({ where: { id: { in: ids } } });
      return rows as any[];
    },

    listForOrg: async (input) => {
      const where: Record<string, unknown> = { payeeId: input.payeeId };
      if (input.status) where.status = input.status;
      if (input.scheduledPayoutDateGte || input.scheduledPayoutDateLte) {
        const dateFilter: Record<string, Date> = {};
        if (input.scheduledPayoutDateGte)
          dateFilter.gte = input.scheduledPayoutDateGte;
        if (input.scheduledPayoutDateLte)
          dateFilter.lte = input.scheduledPayoutDateLte;
        where.scheduledPayoutDate = dateFilter;
      }

      const [items, total] = await Promise.all([
        p.settlement.findMany({
          where,
          include: {
            event: { select: { title: true } },
            _count: { select: { lines: true } },
          },
          orderBy: { scheduledPayoutDate: "desc" },
          skip: input.offset,
          take: input.limit,
        }),
        p.settlement.count({ where }),
      ]);

      return {
        items: items.map((r) => ({
          id: r.id,
          payeeId: r.payeeId,
          date: r.date,
          scheduledPayoutDate: r.scheduledPayoutDate,
          amountCents: r.amountCents,
          currency: r.currency,
          status: r.status,
          stripeTransferId: r.stripeTransferId ?? null,
          eventId: r.eventId ?? null,
          eventTitle: r.event?.title ?? null,
          lineCount: r._count.lines,
          createdAt: r.createdAt,
        })),
        total,
      };
    },

    listAll: async (input) => {
      const where: Record<string, unknown> = {};
      if (input.status) where.status = input.status;
      if (input.scheduledPayoutDateGte || input.scheduledPayoutDateLte) {
        const dateFilter: Record<string, Date> = {};
        if (input.scheduledPayoutDateGte)
          dateFilter.gte = input.scheduledPayoutDateGte;
        if (input.scheduledPayoutDateLte)
          dateFilter.lte = input.scheduledPayoutDateLte;
        where.scheduledPayoutDate = dateFilter;
      }
      if (input.searchQuery) {
        where.OR = [
          {
            event: {
              title: { contains: input.searchQuery, mode: "insensitive" },
            },
          },
          {
            payee: {
              subjectId: { contains: input.searchQuery, mode: "insensitive" },
            },
          },
        ];
      }

      const [items, total] = await Promise.all([
        p.settlement.findMany({
          where,
          include: {
            event: { select: { title: true } },
            payee: { select: { subjectType: true, subjectId: true } },
            lines: {
              select: { order: { select: { stripePaymentIntentId: true } } },
            },
            _count: { select: { lines: true } },
          },
          orderBy: { scheduledPayoutDate: "desc" },
          skip: input.offset,
          take: input.limit,
        }),
        p.settlement.count({ where }),
      ]);

      // Collect unique org ids to resolve names
      const orgIds = [
        ...new Set(
          items
            .filter((r) => r.payee.subjectType === "ORGANIZATION")
            .map((r) => r.payee.subjectId),
        ),
      ];
      const orgMap = new Map<string, string>();
      if (orgIds.length > 0) {
        const orgs = await p.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        });
        for (const o of orgs) orgMap.set(o.id, o.name);
      }

      return {
        items: items.map((r) => ({
          id: r.id,
          payeeId: r.payeeId,
          payeeSubjectType: r.payee.subjectType,
          payeeSubjectId: r.payee.subjectId,
          payeeLabel: orgMap.get(r.payee.subjectId) ?? null,
          date: r.date,
          scheduledPayoutDate: r.scheduledPayoutDate,
          amountCents: r.amountCents,
          currency: r.currency,
          status: r.status,
          stripeTransferId: r.stripeTransferId ?? null,
          stripePaymentIntentIds: [
            ...new Set(
              r.lines
                .map((l) => l.order.stripePaymentIntentId)
                .filter((id): id is string => id != null),
            ),
          ],
          eventId: r.eventId ?? null,
          eventTitle: r.event?.title ?? null,
          lineCount: r._count.lines,
          createdAt: r.createdAt,
        })),
        total,
      };
    },

  };
}
