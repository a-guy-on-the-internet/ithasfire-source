import { fmtCurrency } from "@/lib/format";

type OrdersPage = { pageInfo: { total: number } } | undefined;

/**
 * Values for the two order-count stat tiles. Both read `pageInfo.total` (never
 * the length of a page of rows). `undefined` means the read has not landed
 * (loading, disabled or failed) and renders an em dash: a tile must never show
 * a confident 0 over a count it does not have.
 */
export function buildOrderStats({
	ordersData,
	weekData,
}: {
	ordersData: OrdersPage;
	weekData: OrdersPage;
}): { total: string; week: string } {
	const fmt = (n: number | undefined) => (n === undefined ? "\u2014" : String(n));
	const total = ordersData?.pageInfo.total;
	// The two counts are separate reads. When the hour-bucketed week key moves,
	// the week read can land after the total's, and a subset must never show
	// larger than its whole: clamp to the total whenever both are known.
	const week =
		weekData === undefined
			? undefined
			: total === undefined
				? weekData.pageInfo.total
				: Math.min(weekData.pageInfo.total, total);
	return { total: fmt(total), week: fmt(week) };
}

/**
 * The pending-payout tile text. `null` = unknown (failed or degraded read) and
 * renders an em dash: never a confident $0.00 over a payout we do not have.
 */
export function payoutStat(
	cents: number | null,
	currency: string,
	fmt: Parameters<typeof fmtCurrency>[0],
): string {
	return cents === null ? "\u2014" : fmtCurrency(fmt, cents, currency);
}
