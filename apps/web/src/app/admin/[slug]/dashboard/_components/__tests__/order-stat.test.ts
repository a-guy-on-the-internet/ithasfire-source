import { describe, expect, it } from "vitest";

import { buildOrderStats, payoutStat } from "../order-stat";

const DASH = "\u2014";

describe("buildOrderStats", () => {
	it("reads pageInfo.total, never items.length", () => {
		const ordersData = { items: [1, 2, 3, 4, 5], pageInfo: { total: 4 } };
		expect(buildOrderStats({ ordersData, weekData: undefined }).total).toBe("4");
	});

	it("shows an em dash for the week tile while only the total is known", () => {
		const out = buildOrderStats({
			ordersData: { pageInfo: { total: 4 } },
			weekData: undefined,
		});
		expect(out).toEqual({ total: "4", week: DASH });
	});

	it("shows em dashes when neither read has landed", () => {
		expect(buildOrderStats({ ordersData: undefined, weekData: undefined })).toEqual({
			total: DASH,
			week: DASH,
		});
	});

	it("never shows the week count above the total", () => {
		const out = buildOrderStats({
			ordersData: { pageInfo: { total: 3 } },
			weekData: { pageInfo: { total: 4 } },
		});
		expect(out).toEqual({ total: "3", week: "3" });
	});

	it("keeps a week count below the total as it is", () => {
		const out = buildOrderStats({
			ordersData: { pageInfo: { total: 10 } },
			weekData: { pageInfo: { total: 3 } },
		});
		expect(out).toEqual({ total: "10", week: "3" });
	});

	it("shows the week count while only it has landed", () => {
		const out = buildOrderStats({
			ordersData: undefined,
			weekData: { pageInfo: { total: 3 } },
		});
		expect(out).toEqual({ total: DASH, week: "3" });
	});

	it("renders a real zero as 0", () => {
		const out = buildOrderStats({
			ordersData: { pageInfo: { total: 0 } },
			weekData: { pageInfo: { total: 0 } },
		});
		expect(out).toEqual({ total: "0", week: "0" });
	});
});

describe("payoutStat", () => {
	const fmt = { currency: (major: number, cur: string) => `${cur} ${major.toFixed(2)}` };

	it("renders the full amount at once, in major units", () => {
		expect(payoutStat(113787, "USD", fmt)).toBe("USD 1137.87");
	});

	it("shows an em dash for unknown, never a zero amount", () => {
		expect(payoutStat(null, "USD", fmt)).toBe(DASH);
	});

	it("shows a real zero as an amount", () => {
		expect(payoutStat(0, "USD", fmt)).toBe("USD 0.00");
	});
});
