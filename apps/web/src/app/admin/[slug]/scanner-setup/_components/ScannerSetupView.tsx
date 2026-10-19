"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { XStack } from "tamagui";
import { AlertTriangle, ArrowRight } from "lucide-react";

import {
  Badge,
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";

import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";

import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";
import { InstallPathsCard } from "./InstallPathsCard";
import { SendOnboardingEmailCard } from "./SendOnboardingEmailCard";
import { PersonalScannerCard } from "./PersonalScannerCard";
import { RecoveryHelpCard } from "./RecoveryHelpCard";
import {
  Card,
  CardLabel,
  CHANNEL_META,
  PageContainer,
  readChannel,
  type ReleaseChannel,
} from "./scanner-setup-shared";

export function ScannerSetupView() {
  const { slug } = useParams<{ slug: string }>();
  const { toast } = useNotify();
  const t = useTranslations();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);

  const channel = useMemo(readChannel, []);

  const handleCopy = (text: string, label = "Link") => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success({ title: `${label} copied` }))
      .catch(() =>
        toast.danger({
          title: "Copy failed",
          message: "Select and copy manually.",
        }),
      );
  };

  const openExternal = (url: string) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (isOwnerLoading) {
    return (
      <AdminPageData
        isLoading
        loadingMessage={String(t("admin.loadingScannerSetup"))}
      >
        {null}
      </AdminPageData>
    );
  }

  if (!currentOwner) {
    return (
      <PageContainer>
        <AdminPageHeader
          title="Scanner Setup"
          subtitle="Operator app distribution and onboarding"
        />
        <Card>
          <XStack gap="$3" alignItems="center">
            <AlertTriangle
              size={20}
              color="var(--brandSecondary)"
              aria-hidden
            />
            <Text variant="body" weight="bold">
              Owner context required
            </Text>
          </XStack>
          <Text tone="muted">
            Switch to a valid admin slug to view scanner setup options.
          </Text>
        </Card>
      </PageContainer>
    );
  }

  const isPersonal = currentOwner.kind === "human";

  return (
    <PageContainer>
      <AdminPageHeader
        title="Scanner Setup"
        subtitle="Install paths, onboarding links, and operator recovery"
      />

      <ChannelCard channel={channel} />

      <InstallPathsCard
        channel={channel}
        onCopy={handleCopy}
        onOpen={openExternal}
      />

      {isPersonal ? (
        <PersonalScannerCard
          slug={slug}
          humanId={currentOwner.humanId}
          onCopy={handleCopy}
        />
      ) : (
        <SendOnboardingEmailCard
          orgId={currentOwner.orgId}
          canManage={
            currentOwner.role === "OWNER" || currentOwner.role === "ADMIN"
          }
        />
      )}

      <WebFallbackCard slug={slug} />

      <RecoveryHelpCard />
    </PageContainer>
  );
}

// ─── Inline cards (small enough to keep here) ──────────────────────────────

function ChannelCard({ channel }: { channel: ReleaseChannel }) {
  const meta = CHANNEL_META[channel];
  return (
    <Card>
      <XStack
        gap="$3"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        <CardLabel>01. Distribution channel</CardLabel>
        <Badge tone={meta.tone} variant="solid">
          {meta.label.toUpperCase()}
        </Badge>
      </XStack>
      <Text variant="h4" textTransform="uppercase">
        {meta.label} build
      </Text>
      <Text tone="muted" fontSize="$2">
        {meta.description}
      </Text>
    </Card>
  );
}

function WebFallbackCard({ slug }: { slug: string }) {
  return (
    <Card backgroundColor="$surfaceMuted">
      <CardLabel>04. Web fallback</CardLabel>
      <Text variant="h4" textTransform="uppercase">
        If the scanner app fails mid-shift
      </Text>
      <Text tone="muted" fontSize="$2">
        Sign in here on any phone or laptop and use the admin scan page. The web
        fallback uses the same backend and is safe to mix with native scanners
        on the same event.
      </Text>
      <XStack>
        <NextLinkAnchor href={`/admin/${slug}/scan`}>
          <Button variant="secondary" size="$2">
            Open admin scan
            <ArrowRight size={14} aria-hidden />
          </Button>
        </NextLinkAnchor>
      </XStack>
    </Card>
  );
}
