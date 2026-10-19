"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { YStack, XStack, styled } from "tamagui";
import {
	User,
	Settings,
	Ticket,
	Bell,
	LogOut,
	ChevronRight,
	ShieldCheck,
	FileText,
	BadgeCheck,
	HeartHandshake,
} from "lucide-react";

import { Text, Button, Spinner, useTranslations } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";

// ─────────────────────────────────────────────────────────────────────────────

const PageContainer = styled(YStack, {
	name: "AccountPage",
	gap: "$5",
	padding: "$4",
	width: "100%",
	maxWidth: 600,
	marginHorizontal: "auto",
	$gtMd: { padding: "$6" },
});

/** Monospace section number prefix — orange accent per Swiss spec. */
const SectionNum = styled(Text, {
	name: "AccountSectionNum",
	fontFamily: "$mono",
	fontSize: 14,
	letterSpacing: 1.6,
	color: "$brandSecondary",
	fontVariant: "tabular-nums" as never,
	minWidth: 28,
	textTransform: "uppercase",
});

const MenuCard = styled(YStack, {
	name: "MenuCard",
	backgroundColor: "$surface",
	borderRadius: 0,
	// Swiss structural lines: top and bottom rules, not boxed in
	borderTopWidth: 2,
	borderTopColor: "$borderColor",
	borderBottomWidth: 1,
	borderBottomColor: "$borderColor",
	overflow: "hidden",
	// Contain the swiss-dots pseudo-element overlay
	position: "relative",
});

const MenuItem = styled(XStack, {
	name: "MenuItem",
	padding: "$4",
	gap: "$3",
	alignItems: "center",
	cursor: "pointer",
	hoverStyle: { backgroundColor: "$backgroundHover" },
	pressStyle: { opacity: 0.85 },
	borderBottomWidth: 1,
	borderBottomColor: "$borderColor",
});

// ─────────────────────────────────────────────────────────────────────────────

export default function AccountPage() {
	const router = useRouter();
	const t = useTranslations();
	// Three-way session read, not raw `isPending` + `data`: Better Auth cannot
	// tell "nobody is signed in" apart from "the lookup beat the freshly-set
	// cookie", and rendering the second as the first greets someone who just
	// signed in with a sign-in prompt. See `useSessionVerdict`.
	const { verdict, user, markSignedOut } = useSessionVerdict();
	const isLoading = verdict === "unknown";

	const handleSignOut = useCallback(async () => {
		await authClient.signOut();
		// The one thing that takes a signed-in verdict away.
		markSignedOut();
		router.push("/");
	}, [markSignedOut, router]);

	if (isLoading) {
		return (
			<PageContainer alignItems="center" justifyContent="center" minHeight={300}>
				<Spinner size="lg" />
			</PageContainer>
		);
	}

	if (!user) {
		return (
			<PageContainer alignItems="center" justifyContent="center" minHeight={300} gap="$4">
				<User size={48} color="$colorMuted" />
				<Text variant="h3">{String(t("account.notSignedIn"))}</Text>
				<Text variant="body" tone="muted" textAlign="center">
					{String(t("account.notSignedInDesc"))}
				</Text>
				<Link href="/sign-in">
					<Button tag="span" variant="primary" size="$3">
						{String(t("auth.signIn"))}
					</Button>
				</Link>
			</PageContainer>
		);
	}

	return (
		<PageContainer>
			{/* Profile header */}
			<YStack gap="$2" alignItems="center" paddingVertical="$4">
				<XStack
					width={64}
					height={64}
					borderRadius={0}
					backgroundColor="$accentSoft"
					alignItems="center"
					justifyContent="center"
				>
					<User size={28} color="$accent" />
				</XStack>
				<Text variant="h3" weight="bold" textTransform="uppercase" letterSpacing={-0.5}>
					{user.name || String(t("account.userFallback"))}
				</Text>
				{user.email && (
					<Text variant="body" tone="muted">
						{user.email}
					</Text>
				)}
			</YStack>

			<YStack borderBottomWidth={2} borderBottomColor="$borderColor" />

			{/* 01 — Navigation menu */}
			<YStack gap="$2">
				<XStack gap="$2" alignItems="baseline" paddingLeft="$1">
					<SectionNum aria-hidden>01</SectionNum>
					<Text variant="bodySmall" weight="bold" tone="muted" textTransform="uppercase" letterSpacing={0.8}>
						{String(t("account.navigate") ?? "Navigate")}
					</Text>
				</XStack>
				<MenuCard className="swiss-dots">
				<MenuItem onPress={() => router.push("/account/page")}>
					<FileText size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.myPage"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
				<MenuItem onPress={() => router.push("/my-tickets")}>
					<Ticket size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.myTickets"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
				<MenuItem onPress={() => router.push("/my-volunteering")}>
					<HeartHandshake size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.myVolunteering"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
				<MenuItem onPress={() => router.push("/account/memberships")}>
					<BadgeCheck size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.memberships"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
				<MenuItem onPress={() => router.push("/account/notifications")}>
					<Bell size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.notifications"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
				<MenuItem onPress={() => router.push("/account/settings")} borderBottomWidth={0}>
					<Settings size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.settings"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
			</MenuCard>
			</YStack>

			{/* 02 — Support */}
			<YStack gap="$2">
				<XStack gap="$2" alignItems="baseline" paddingLeft="$1">
					<SectionNum aria-hidden>02</SectionNum>
					<Text variant="bodySmall" weight="bold" tone="muted" textTransform="uppercase" letterSpacing={0.8}>
						{String(t("account.support"))}
					</Text>
				</XStack>
				<MenuCard className="swiss-dots">
				<MenuItem onPress={() => router.push("/contact")} borderBottomWidth={0}>
					<ShieldCheck size={20} color="$colorMuted" />
					<Text variant="body" flex={1}>{String(t("account.support"))}</Text>
					<ChevronRight size={16} color="$colorMuted" />
				</MenuItem>
			</MenuCard>
			</YStack>

			{/* Sign out */}
			<Button
				variant="outlined"
				size="$3"
				onPress={handleSignOut}
				marginTop="$2"
			>
				<LogOut size={16} />
				{String(t("account.signOut"))}
			</Button>
		</PageContainer>
	);
}
