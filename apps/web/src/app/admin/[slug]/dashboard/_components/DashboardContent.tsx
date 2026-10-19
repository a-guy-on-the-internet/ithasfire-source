"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { XStack, YStack, styled } from "tamagui";
import {
	ShoppingCart,
	Wallet,
	TrendingUp,
	CalendarPlus,
	MapPin,
	ClipboardList,
	ScanLine,
	ArrowUpRight,
	Plus,
} from "lucide-react";

import { Text, Button, Spinner, Badge, useTranslations, useFormatters } from "@th/ui";

import { trpc } from "@/trpc";
import { fmtCurrency } from "@/lib/format";
import { ACCENT, STRUCTURAL, BORDER, MUTED_TEXT } from "@/lib/design-tokens";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { DashboardCalendar } from "./DashboardCalendar";
import { keepPreviousData } from "@tanstack/react-query";
import { buildOrderStats, payoutStat } from "./order-stat";
import { formatErrorMessage } from "@/lib/format-error-message";

const ORDER_STATUS_KEY: Record<string, string> = {
	PENDING: "admin.statusPending",
	SUCCEEDED: "admin.statusSucceeded",
	PART_REFUNDED: "admin.statusPartialRefund",
	REFUNDED: "admin.statusRefunded",
	DISPUTED: "admin.statusDisputed",
	CANCELLED: "admin.statusCancelled",
};

// ─── Swiss grid pattern overlay (CSS background) ────────────────────────────
const GRID_PATTERN_BG = `
	linear-gradient(color-mix(in srgb, var(--structure, #211C16) 4%, transparent) 1px, transparent 1px),
	linear-gradient(90deg, color-mix(in srgb, var(--structure, #211C16) 4%, transparent) 1px, transparent 1px)
`;

const PageContainer = styled(YStack, {
	name: "PageContainer",
	gap: "$8",
	padding: "$4",
	width: "100%",
	maxWidth: 1200,
	marginHorizontal: "auto",
	$gtMd: {
		padding: "$6",
	},
});

const WelcomeSection = styled(YStack, {
	name: "WelcomeSection",
	gap: "$2",
	paddingBottom: "$6",
	borderBottomWidth: 2,
	borderBottomColor: "$borderColor",
});

/** Monospace section number prefix — orange accent per Swiss spec. */
const DashSectionNum = styled(Text, {
	name: "DashSectionNum",
	fontFamily: "$mono",
	fontSize: 12,
	letterSpacing: 1.8,
	color: "$brandSecondary",
	fontVariant: "tabular-nums" as never,
	textTransform: "uppercase",
});

const StatsGrid = styled(XStack, {
	name: "StatsGrid",
	flexWrap: "wrap",
	gap: 0,
});

const StatCard = styled(YStack, {
	name: "StatCard",
	backgroundColor: "$surface",
	borderRadius: 0,
	borderWidth: 1,
	borderColor: "$borderColor",
	borderLeftWidth: 3,
	borderLeftColor: "$accent",
	padding: "$5",
	minWidth: 180,
	flex: 1,
	gap: "$3",
	cursor: "pointer",
	hoverStyle: {
		borderLeftColor: "$brandSecondary",
		backgroundColor: "$surfaceMuted",
	},
	pressStyle: {
		opacity: 0.92,
	},
});

const StatIconWrap = styled(XStack, {
	name: "StatIconWrap",
	width: 40,
	height: 40,
	borderRadius: 0,
	borderWidth: 2,
	borderColor: "$accent",
	backgroundColor: "transparent",
	alignItems: "center",
	justifyContent: "center",
});

const QuickActionsSection = styled(YStack, {
	name: "QuickActionsSection",
	gap: "$5",
	paddingTop: "$6",
});

const QuickActionsGrid = styled(XStack, {
	name: "QuickActionsGrid",
	flexWrap: "wrap",
	gap: 0,
});

const QuickActionCard = styled(YStack, {
	name: "QuickActionCard",
	backgroundColor: "$surface",
	borderRadius: 0,
	borderWidth: 1,
	borderColor: "$borderColor",
	padding: "$5",
	minWidth: 200,
	flex: 1,
	gap: "$3",
	cursor: "pointer",
	hoverStyle: {
		backgroundColor: "$brandPrimary",
	},
	pressStyle: {
		scale: 0.98,
		opacity: 0.92,
	},
});

const RecentActivitySection = styled(YStack, {
	name: "RecentActivitySection",
	gap: "$5",
	paddingTop: "$6",
});

/**
 * Order / Status / Amount need this much room before the layout stops making
 * sense: Status and Amount are fixed 100px columns, so below ~420px the flex
 * Order column is squeezed to nothing and the mono order code wraps one
 * character per line. The list scrolls horizontally past this width rather
 * than crushing its columns (the shared `TableContainer` does the same).
 */
const ORDERS_TABLE_MIN_WIDTH = 420;

const ActivityList = styled(YStack, {
	name: "ActivityList",
	backgroundColor: "$surface",
	borderRadius: 0,
	borderWidth: 2,
	borderColor: "$borderColor",
	overflow: "hidden",
});

const ActivityItem = styled(XStack, {
	name: "ActivityItem",
	padding: "$4",
	paddingHorizontal: "$5",
	gap: "$3",
	alignItems: "center",
	cursor: "pointer",
	hoverStyle: {
		backgroundColor: "$surfaceMuted",
	},
	borderBottomWidth: 1,
	borderBottomColor: "$borderColor",
});

const EmptyState = styled(YStack, {
	name: "EmptyState",
	alignItems: "center",
	justifyContent: "center",
	padding: "$8",
	gap: "$4",
	borderWidth: 1,
	borderColor: "$borderColor",
	borderRadius: 0,
	backgroundColor: "$surfaceMuted",
});

// ─── Calendar styled primitives ─────────────────────────────────────────────

const CalendarSection = styled(YStack, {
	name: "CalendarSection",
	gap: "$5",
	paddingTop: "$6",
});

// ─── Section divider (Swiss structural horizontal rule) ─────────────────────

function SectionDivider() {
	return (
		<div
			style={{
				width: "100%",
				height: 2,
				backgroundColor: BORDER,
				position: "relative",
			}}
		>
			<div
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: 48,
					height: 2,
					backgroundColor: STRUCTURAL,
				}}
			/>
		</div>
	);
}

// ─── Pending payout ─────────────────────────────────────────────────────────

/**
 * Renders the server's pending payout as-is, never animated: a count-up shows
 * a smaller number than the organiser is owed on every frame until it ends.
 *
 * `cents === null` means UNKNOWN (failed or degraded read) and renders an em
 * dash, never $0.00.
 */
function PayoutAmount({
	cents,
	currency,
	isLoading,
}: {
	cents: number | null;
	currency: string;
	isLoading: boolean;
}) {
	const fmt = useFormatters();
	if (isLoading) return <>...</>;
	return <>{payoutStat(cents, currency, fmt)}</>;
}

export const DashboardContent = () => {
	const params = useParams();
	const router = useRouter();
	const slug = typeof params?.slug === "string" ? params.slug : "";
	const t = useTranslations();
	const fmt = useFormatters();

	// `modeChoiceDialog` is not optional: for community moderators `createDraft`
	// only opens the Ticketed-vs-Community chooser, so without it rendered the
	// quick action does nothing at all for them.
	const {
		createDraft: handleCreateEvent,
		modeChoiceDialog,
	} = useCreateDraftEvent(slug);

	// Resolve owner entity from URL slug (shared hook — avoids duplicated logic)
	const {
		currentOwner,
		isLoading,
	} = useCurrentAdminOwner(slug);

	const orgId = currentOwner?.kind === "org" ? currentOwner.orgId : undefined;
	const isHumanOwner = currentOwner?.kind === "human";

	// Fetch orders — org path or human path
	const orgOrdersQuery = trpc.orders.listOrgOrders.useQuery(
		{ orgId: orgId ?? "", limit: 5, offset: 0 },
		{
			enabled: !!orgId,
			staleTime: 30_000,
			// The total and the 7-day tile are read together on every mount, so a
			// cached total can never sit beside a fresher (larger) week count.
			refetchOnMount: "always",
		}
	);

	const humanOrdersQuery = trpc.orders.listMyEventOrders.useQuery(
		{ limit: 5, offset: 0 },
		{
			enabled: isHumanOwner,
			staleTime: 30_000,
			refetchOnMount: "always",
		}
	);

	// "Orders, last 7 days": a real count (pageInfo.total of a limit-1 read), not
	// the length of the 5-row page above. The cutoff is bucketed to the hour,
	// recomputed each render: the key is stable within the hour, shared across
	// mounts, and advances at the hour boundary, so a tab left open for days
	// still counts 7 days. keepPreviousData spares the tile an em-dash flash when
	// the key advances; refetchOnMount keeps it read together with the total.
	const hourBucket = Math.floor(Date.now() / 3_600_000);
	const weekCutoff = useMemo(
		() => new Date(hourBucket * 3_600_000 - 7 * 24 * 60 * 60 * 1000),
		[hourBucket],
	);
	const orgWeekQuery = trpc.orders.listOrgOrders.useQuery(
		{ orgId: orgId ?? "", limit: 1, offset: 0, occurredAtGte: weekCutoff },
		{
			enabled: !!orgId,
			staleTime: 30_000,
			refetchOnMount: "always",
			placeholderData: keepPreviousData,
		}
	);
	const humanWeekQuery = trpc.orders.listMyEventOrders.useQuery(
		{ limit: 1, offset: 0, occurredAtGte: weekCutoff },
		{
			enabled: isHumanOwner,
			staleTime: 30_000,
			refetchOnMount: "always",
			placeholderData: keepPreviousData,
		}
	);

	// Payout summary
	const payoutQuery = trpc.orders.getOwnerPayoutSummary.useQuery(
		{ orgId },
		{
			enabled: !!currentOwner,
			staleTime: 30_000,
		}
	);

	const displayName =
		currentOwner?.kind === "org"
			? currentOwner.orgName
			: currentOwner?.kind === "human"
				? currentOwner.humanName
				: slug;

	// Unify org vs human orders (branch on resolved owner type, not orgId,
	// so during loading we don't accidentally pick the wrong query result)
	const ordersData = isHumanOwner ? humanOrdersQuery.data : orgOrdersQuery.data;
	const ordersError = isHumanOwner ? humanOrdersQuery.error : orgOrdersQuery.error;
	const ordersLoading = isHumanOwner ? humanOrdersQuery.isLoading : orgOrdersQuery.isLoading;
	const recentOrders = ordersData?.items ?? [];
	const totalOrders = ordersData?.pageInfo.total ?? 0;

	// Payout data. NULL = unknown (query failed, or the ledger read degraded to
	// `resolved: false`) — NEVER coalesced to 0, which would render a confident
	// $0.00 over a read that never landed. While loading, the tile shows "...".
	const pendingPayoutCents = payoutQuery.data?.pendingPayoutCents ?? null;
	const pendingCurrency = payoutQuery.data?.currency ?? "usd";

	// Order stat tiles render the server's number as-is (no count-up: a tile
	// mid-animation read lower than its own subset). No data yet, or the read
	// failed, shows an em dash, never a confident 0.
	const { total: totalOrdersStat, week: weekOrdersStat } = buildOrderStats({
		ordersData,
		weekData: isHumanOwner ? humanWeekQuery.data : orgWeekQuery.data,
	});

	// Quick stats — icons are stable references, only string values change.
	// Use a sentinel for the currency stat so we can render PayoutAmount
	// in JSX without putting it inside a memo dep array.
	const stats = useMemo(() => {
		return [
			{
				label: String(t("admin.totalOrders")),
				value: totalOrdersStat,
				iconKey: "orders" as const,
			},
			{
				label: String(t("admin.pendingPayout")),
				value: "__currency__" as const,
				iconKey: "payout" as const,
			},
			{
				label: String(t("admin.ordersLast7DaysStat")),
				value: weekOrdersStat,
				iconKey: "recent" as const,
			},
		];
	}, [totalOrdersStat, weekOrdersStat, t]);

	const statIcons: Record<string, React.ReactNode> = useMemo(
		() => ({
			orders: <ShoppingCart size={18} color={STRUCTURAL} />,
			payout: <Wallet size={18} color={STRUCTURAL} />,
			recent: <TrendingUp size={18} color={STRUCTURAL} />,
		}),
		[],
	);

	if (isLoading) {
		return (
			<PageContainer>
				{/* Skeleton welcome */}
				<WelcomeSection>
					<div style={{ width: 60, height: 12, backgroundColor: ACCENT, opacity: 0.3 }} />
					<div style={{ width: 280, height: 36, backgroundColor: BORDER, opacity: 0.3, marginTop: 8 }} />
					<div style={{ width: 220, height: 14, backgroundColor: BORDER, opacity: 0.2, marginTop: 4 }} />
				</WelcomeSection>

				{/* Skeleton stats */}
				<StatsGrid>
					{[1, 2, 3].map((i) => (
						<StatCard key={i} style={{ opacity: 0.5 }}>
							<div style={{ width: 40, height: 40, borderWidth: 2, borderColor: BORDER, borderStyle: "solid" }} />
							<div style={{ width: 80, height: 12, backgroundColor: BORDER, opacity: 0.3 }} />
							<div style={{ width: 100, height: 28, backgroundColor: BORDER, opacity: 0.4 }} />
						</StatCard>
					))}
				</StatsGrid>

				{/* Skeleton calendar */}
				<CalendarSection>
					<div style={{ width: "100%", height: 200, backgroundColor: BORDER, opacity: 0.15 }} />
				</CalendarSection>
			</PageContainer>
		);
	}

	return (
		<PageContainer>
			{/* ── Grid pattern overlay (subtle depth) ──────────────────────── */}
			<style>{`
				.dash-grid-overlay {
					position: relative;
				}
				.dash-grid-overlay::before {
					content: "";
					position: absolute;
					inset: 0;
					background-image: ${GRID_PATTERN_BG};
					background-size: 24px 24px;
					pointer-events: none;
					z-index: 0;
				}
				.dash-qa-card {
					transition: background-color 150ms ease, border-color 150ms ease;
				}
				.dash-qa-card:hover .dash-qa-icon {
					color: #fff !important;
				}
				.dash-qa-card:hover .dash-qa-title {
					color: #fff !important;
				}
				.dash-qa-card:hover .dash-qa-desc {
					color: rgba(255,255,255,0.8) !important;
				}
				.dash-qa-card:hover .dash-qa-arrow {
					color: #fff !important;
					transform: translate(2px, -2px);
				}
				.dash-qa-arrow {
					transition: transform 150ms ease, color 150ms ease;
				}
				.dash-activity-row:hover {
					background-color: var(--surfaceMuted);
				}
			`}</style>

			{/* ── Welcome Section ──────────────────────────────────────────── */}
			{/* The title block and the page's one primary share a wrapping row.
			    CREATE EVENT is the dashboard's action, so it sits beside the
			    heading the way it does on the events page — not buried as the
			    first of four look-alike quick-action cards further down, which
			    is where the retired action bar's duplicate left it. */}
			<WelcomeSection>
				<XStack
					gap="$4"
					alignItems="center"
					justifyContent="space-between"
					flexWrap="wrap"
				>
					<YStack gap="$2" flex={1} minWidth={220}>
						<DashSectionNum aria-hidden>00. overview</DashSectionNum>
						<Text
							variant="h1"
							weight="bold"
							textTransform="uppercase"
							style={{
								letterSpacing: -1.5,
								// `em`, NOT a bare number. A numeric `lineHeight` inside a
								// `style` object on a Tamagui/RNW component is treated as
								// PIXELS, so `0.95` set a 0.95px line box: the glyphs spilled
								// out and collided with the eyebrow above and the subtitle
								// below. (On a plain DOM element React would read it as a
								// ratio — which is why the pattern looks fine elsewhere.)
								lineHeight: "0.95em",
								fontSize: "clamp(32px, 5vw, 56px)",
								fontWeight: "900",
							}}
						>
							{displayName || ""}
						</Text>
						<Text
							variant="body"
							tone="muted"
							style={{ maxWidth: 480 }}
						>
							{String(t("admin.whatsHappening"))}
						</Text>
					</YStack>
					<Button
						variant="primary"
						size="$3"
						onPress={handleCreateEvent}
						data-testid="dashboard-create-event"
					>
						<CalendarPlus size={16} aria-hidden />
						{String(t("admin.createEvent"))}
					</Button>
				</XStack>
			</WelcomeSection>

			{/* ── Stats Grid ───────────────────────────────────────────────── */}
			<StatsGrid>
				{stats.map((stat, idx) => (
					<StatCard key={stat.label}>
						<XStack justifyContent="space-between" alignItems="flex-start">
							<StatIconWrap>{statIcons[stat.iconKey]}</StatIconWrap>
							<Text
								fontFamily="$mono"
								fontSize={11}
								color="$colorMuted"
								letterSpacing={1.2}
								textTransform="uppercase"
							>
								{String(idx + 1).padStart(2, "0")}
							</Text>
						</XStack>
						<YStack gap="$1" flex={1}>
							<Text
								variant="bodySmall"
								weight="semibold"
								tone="muted"
								textTransform="uppercase"
								letterSpacing={0.8}
							>
								{stat.label}
							</Text>
							<Text
								weight="bold"
								style={{
									fontSize: "clamp(28px, 3vw, 40px)",
									letterSpacing: -1,
									// See the page title above: a bare number here is
									// pixels, which collapsed this value onto its label.
									lineHeight: "1.1em",
									fontWeight: "900",
								}}
							>
								{stat.value === "__currency__" ? (
									<PayoutAmount
										cents={pendingPayoutCents}
										currency={pendingCurrency}
										isLoading={payoutQuery.isLoading}
									/>
								) : (
									stat.value
								)}
							</Text>
						</YStack>
					</StatCard>
				))}
			</StatsGrid>

			{/* ── Events Calendar ──────────────────────────────────────────── */}
			{/* The mount owns its reads, filters and create rule (FR-015/019);
			    it paints in the viewer's zone (FR-018) and renders its own
			    moderator mode-choice dialog for cell-create. */}
			<CalendarSection>
				<SectionDivider />
				<DashSectionNum aria-hidden>01. schedule</DashSectionNum>
				<DashboardCalendar slug={slug} displayName={displayName || slug} />
			</CalendarSection>

			{/* ── Quick Actions ─────────────────────────────────────────────── */}
			<QuickActionsSection>
				<SectionDivider />
				<DashSectionNum aria-hidden>02. actions</DashSectionNum>
				<Text
					variant="h3"
					weight="bold"
					textTransform="uppercase"
					letterSpacing={-0.5}
				>
					{String(t("admin.quickActions"))}
				</Text>
				<QuickActionsGrid>
					{[
						// No "Create event" card here: the primary in the header
						// above is this page's single activation path for it.
						{
							icon: <MapPin size={22} color={STRUCTURAL} className="dash-qa-icon" />,
							title: String(t("admin.managePlaces")),
							desc: String(t("admin.managePlacesDescription")),
							onPress: () => router.push(`/admin/${slug}/places`),
						},
						{
							icon: <ClipboardList size={22} color={STRUCTURAL} className="dash-qa-icon" />,
							title: String(t("admin.viewOrders")),
							desc: String(t("admin.viewOrdersDescription")),
							onPress: () => router.push(`/admin/${slug}/orders`),
						},
						{
							icon: <ScanLine size={22} color={STRUCTURAL} className="dash-qa-icon" />,
							title: String(t("admin.scanTicket")),
							desc: String(t("admin.scanTicketQuickDescription")),
							onPress: () => router.push(`/admin/${slug}/scan`),
						},
					].map((action) => (
						<QuickActionCard
							key={action.title}
							className="dash-qa-card"
							onPress={action.onPress}
							role="button"
							tabIndex={0}
						>
							<XStack justifyContent="space-between" alignItems="flex-start">
								{action.icon}
								<ArrowUpRight
									size={16}
									color={MUTED_TEXT}
									className="dash-qa-arrow"
								/>
							</XStack>
							<YStack gap="$1" flex={1}>
								<Text
									variant="body"
									weight="bold"
									className="dash-qa-title"
									textTransform="uppercase"
									letterSpacing={0.5}
								>
									{action.title}
								</Text>
								<Text
									variant="bodySmall"
									tone="muted"
									className="dash-qa-desc"
								>
									{action.desc}
								</Text>
							</YStack>
						</QuickActionCard>
					))}
				</QuickActionsGrid>
			</QuickActionsSection>

			{/* ── Recent Activity ───────────────────────────────────────────── */}
			<RecentActivitySection>
				<SectionDivider />
				{/*
				 * Wrapping is load-bearing at 320px. Tamagui inherits React
				 * Native's `flexShrink: 0` default, so without the shrink +
				 * minWidth below, this heading stack parks at its ~280px
				 * max-content width inside a 206px row and pushes "View all"
				 * out to x=338 — 144px of horizontal page overflow.
				 */}
				<XStack
					justifyContent="space-between"
					alignItems="flex-end"
					flexWrap="wrap"
					gap="$3"
				>
					<YStack gap="$2" flexShrink={1} minWidth={0}>
						<DashSectionNum aria-hidden>03. orders</DashSectionNum>
						<Text
							variant="h3"
							weight="bold"
							textTransform="uppercase"
							letterSpacing={-0.5}
						>
							{String(t("admin.recentOrders"))}
						</Text>
					</YStack>
					{totalOrders > 0 && (
						<Button
							size="$2"
							variant="ghost"
							onPress={() => router.push(`/admin/${slug}/orders`)}
							style={{
								textTransform: "uppercase",
								letterSpacing: 0.5,
								fontWeight: 600,
								fontSize: 12,
							}}
						>
							{String(t("admin.viewAll"))} →
						</Button>
					)}
				</XStack>

				{ordersLoading ? (
					<YStack padding="$6" alignItems="center">
						<Spinner size="sm" />
					</YStack>
				) : ordersError ? (
					<YStack padding="$6" alignItems="center">
						<Text variant="bodySmall" tone="muted">
							{String(
								t("admin.failedToLoadOrders", {
									error: formatErrorMessage(ordersError, (k) => String(t(k))),
								}),
							)}
						</Text>
					</YStack>
				) : recentOrders.length === 0 ? (
					<EmptyState>
						<Plus size={32} color={MUTED_TEXT} style={{ opacity: 0.5 }} />
						<Text variant="body" tone="muted" weight="semibold" textTransform="uppercase" letterSpacing={0.5}>
							{String(t("admin.noOrdersYet"))}
						</Text>
						<Text variant="bodySmall" tone="muted" style={{ maxWidth: 320, textAlign: "center" }}>
							{String(t("admin.ordersWillAppear"))}
						</Text>
					</EmptyState>
				) : (
					/*
					 * `overflowX: auto` via `style` — Tamagui's `overflow` prop type
					 * has no "auto", and the styled `overflow: "hidden"` still clips
					 * the vertical axis to the border.
					 */
					<ActivityList style={{ overflowX: "auto" }}>
						{/* Table header */}
						<XStack
							padding="$3"
							paddingHorizontal="$5"
							gap="$3"
							minWidth={ORDERS_TABLE_MIN_WIDTH}
							backgroundColor="$surfaceMuted"
							borderBottomWidth={2}
							borderBottomColor="$borderColor"
						>
							<Text
								variant="bodySmall"
								weight="bold"
								flex={1}
								textTransform="uppercase"
								letterSpacing={1}
								fontSize={11}
								tone="muted"
							>
								Order
							</Text>
							<Text
								variant="bodySmall"
								weight="bold"
								textTransform="uppercase"
								letterSpacing={1}
								fontSize={11}
								tone="muted"
								style={{ width: 100, textAlign: "center" }}
							>
								Status
							</Text>
							<Text
								variant="bodySmall"
								weight="bold"
								textTransform="uppercase"
								letterSpacing={1}
								fontSize={11}
								tone="muted"
								style={{ width: 100, textAlign: "right" }}
							>
								Amount
							</Text>
						</XStack>
						{recentOrders.map((order, index) => (
							<ActivityItem
								key={order.id}
								className="dash-activity-row"
								minWidth={ORDERS_TABLE_MIN_WIDTH}
								borderBottomWidth={index === recentOrders.length - 1 ? 0 : 1}
								onPress={() => router.push(`/admin/${slug}/orders`)}
							>
								<YStack flex={1} gap="$1">
									<Text variant="body" weight="semibold" fontFamily="$mono" fontSize={13}>
										#{order.id.slice(-8).toUpperCase()}
									</Text>
									<Text variant="bodySmall" tone="muted" fontSize={12}>
										{fmt.dateTime(new Date(order.occurredAt), {
											month: "short",
											day: "numeric",
											hour: "numeric",
											minute: "2-digit",
										})}
									</Text>
								</YStack>
								<XStack style={{ width: 100, justifyContent: "center" }}>
									<Badge
										tone={
											order.status === "SUCCEEDED" ? "success"
											: order.status === "PENDING" ? "warning"
											: order.status === "DISPUTED" ? "danger"
											: order.status === "REFUNDED" || order.status === "PART_REFUNDED" ? "info"
											: "neutral"
										}
										size="sm"
									>
										{ORDER_STATUS_KEY[order.status]
											? String(t(ORDER_STATUS_KEY[order.status]))
											: order.status}
									</Badge>
								</XStack>
								<Text
									variant="body"
									weight="bold"
									fontFamily="$mono"
									style={{ width: 100, textAlign: "right" }}
								>
									{fmtCurrency(fmt, order.amountGrossCents, order.currency)}
								</Text>
							</ActivityItem>
						))}
					</ActivityList>
				)}
			</RecentActivitySection>

			{modeChoiceDialog}
		</PageContainer>
	);
};
