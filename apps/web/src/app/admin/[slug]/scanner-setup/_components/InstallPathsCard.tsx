"use client";

import { QRCodeSVG } from "qrcode.react";
import { XStack, YStack } from "tamagui";
import { Apple, Copy, ExternalLink, Smartphone } from "lucide-react";

import { Button, Text } from "@th/ui";

import {
  ANDROID_INSTALL_URL,
  Card,
  CardLabel,
  CHANNEL_META,
  IOS_INSTALL_URL,
  InstallTile,
  QrFrame,
  type CopyHandler,
  type OpenHandler,
  type ReleaseChannel,
} from "./scanner-setup-shared";

export function InstallPathsCard({
  channel,
  onCopy,
  onOpen,
}: {
  channel: ReleaseChannel;
  onCopy: CopyHandler;
  onOpen: OpenHandler;
}) {
  const meta = CHANNEL_META[channel];
  return (
    <Card>
      <YStack gap="$1">
        <CardLabel>02. Install the scanner app</CardLabel>
        <Text variant="h4" textTransform="uppercase">
          Operator devices (BYOD)
        </Text>
        <Text tone="muted" fontSize="$2">
          Send these links to operators or have them scan the QR with their
          phone camera.
        </Text>
      </YStack>

      <XStack gap="$4" flexWrap="wrap" $sm={{ flexDirection: "column" }}>
        <InstallTileBlock
          title="iOS / iPadOS"
          subtitle={meta.iosSubtitle}
          icon={<Apple size={22} aria-hidden />}
          url={IOS_INSTALL_URL}
          onCopy={(u) => onCopy(u, "iOS install link")}
          onOpen={onOpen}
        />
        <InstallTileBlock
          title="Android"
          subtitle={meta.androidSubtitle}
          icon={<Smartphone size={22} aria-hidden />}
          url={ANDROID_INSTALL_URL}
          onCopy={(u) => onCopy(u, "Android install link")}
          onOpen={onOpen}
        />
      </XStack>
    </Card>
  );
}

function InstallTileBlock({
  title,
  subtitle,
  icon,
  url,
  onCopy,
  onOpen,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  url: string;
  onCopy: (url: string) => void;
  onOpen: (url: string) => void;
}) {
  const configured = url.length > 0;
  return (
    <InstallTile disabled={!configured}>
      <XStack gap="$3" alignItems="center">
        {icon}
        <YStack gap={0} flex={1}>
          <Text variant="body" weight="bold" textTransform="uppercase">
            {title}
          </Text>
          <Text fontSize={11} tone="muted" letterSpacing={1}>
            {subtitle}
          </Text>
        </YStack>
      </XStack>

      {configured ? (
        <XStack gap="$3" alignItems="flex-start" flexWrap="wrap">
          <QrFrame>
            <QRCodeSVG value={url} size={104} level="M" />
          </QrFrame>
          <YStack gap="$2" flex={1} minWidth={120}>
            <Button
              onPress={() => onOpen(url)}
              variant="primary"
              size="$2"
              aria-label={`Install ${title}`}
            >
              <ExternalLink size={14} aria-hidden />
              Install
            </Button>
            <Button
              onPress={() => onCopy(url)}
              variant="ghost"
              size="$2"
              aria-label={`Copy ${title} install link`}
            >
              <Copy size={14} aria-hidden />
              Copy link
            </Button>
          </YStack>
        </XStack>
      ) : (
        <YStack gap="$2">
          <Text fontSize={12} tone="muted">
            Not yet published for this channel.
          </Text>
          <Button variant="secondary" size="$2" disabled>
            Not configured
          </Button>
        </YStack>
      )}
    </InstallTile>
  );
}
