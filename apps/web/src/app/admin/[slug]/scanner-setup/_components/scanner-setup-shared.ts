"use client";

import type React from "react";
import { YStack, styled } from "tamagui";
import { Text } from "@th/ui";

// ─── Env / channel meta ────────────────────────────────────────────────────

export type ReleaseChannel = "pilot" | "preview" | "production";

export function readChannel(): ReleaseChannel {
  const raw = process.env.NEXT_PUBLIC_SCANNER_RELEASE_CHANNEL?.toLowerCase();
  if (raw === "preview" || raw === "production") return raw;
  return "pilot";
}

// Aligned with the API-side `SCANNER_APP_IOS_URL` / `SCANNER_APP_ANDROID_URL`
// envs (just NEXT_PUBLIC_-prefixed for client visibility). Set both to the
// same TestFlight / Play-Store URL so install instructions match the email.
export const IOS_INSTALL_URL =
  process.env.NEXT_PUBLIC_SCANNER_APP_IOS_URL ??
  process.env.NEXT_PUBLIC_SCANNER_IOS_INSTALL_URL ??
  "";
export const ANDROID_INSTALL_URL =
  process.env.NEXT_PUBLIC_SCANNER_APP_ANDROID_URL ??
  process.env.NEXT_PUBLIC_SCANNER_ANDROID_INSTALL_URL ??
  "";

export const CHANNEL_META: Record<
  ReleaseChannel,
  {
    tone: "warning" | "info" | "success";
    label: string;
    description: string;
    iosSubtitle: string;
    androidSubtitle: string;
  }
> = {
  pilot: {
    tone: "warning",
    label: "Pilot",
    description:
      "Pre-release builds for invited operators only. Expect rapid iteration and limited support.",
    iosSubtitle: "TestFlight (invited)",
    androidSubtitle: "EAS internal",
  },
  preview: {
    tone: "info",
    label: "Preview",
    description:
      "Internal-distribution builds for staff and trusted testers. Stable enough for live shifts but not yet on public stores.",
    iosSubtitle: "TestFlight",
    androidSubtitle: "EAS internal",
  },
  production: {
    tone: "success",
    label: "Production",
    description: "Public store release. Safe for all field operators.",
    iosSubtitle: "App Store",
    androidSubtitle: "Google Play",
  },
};

// ─── Styled primitives ─────────────────────────────────────────────────────

export const PageContainer = styled(YStack, {
  name: "ScannerSetupContainer",
  gap: "$6",
  padding: "$4",
  width: "100%",
  maxWidth: 960,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

export const Card = styled(YStack, {
  name: "ScannerSetupCard",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  padding: "$5",
  gap: "$4",
});

export const CardLabel = styled(Text, {
  name: "ScannerSetupCardLabel",
  color: "$brandSecondary",
  fontSize: 11,
  letterSpacing: 2,
  textTransform: "uppercase",
});

export const InstallTile = styled(YStack, {
  name: "ScannerInstallTile",
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  padding: "$4",
  gap: "$3",
  flex: 1,
  minWidth: 220,
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
    borderColor: "$brandSecondary",
  },
  variants: {
    disabled: {
      true: {
        opacity: 0.55,
        hoverStyle: {
          backgroundColor: "$surface",
          borderColor: "$borderColorStrong",
        },
      },
    },
  } as const,
});

export const QrFrame = styled(YStack, {
  name: "ScannerSetupQrFrame",
  // True-white quiet zone — this frame wraps a QRCodeSVG that staff scan with
  // a phone to install the scanner app. Required for scan reliability; not
  // theme debt. Same rule for every QR/barcode surface.
  backgroundColor: "white",
  padding: "$3",
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "center",
  alignSelf: "flex-start",
});

export const FieldLabel = styled(Text, {
  name: "ScannerSetupFieldLabel",
  tag: "span",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1.2,
  color: "$colorMuted",
  fontWeight: "600",
});

export const ResultCard = styled(YStack, {
  name: "ScannerSetupResult",
  gap: "$3",
  padding: "$4",
  backgroundColor: "$surfaceMuted",
  borderWidth: 2,
  borderColor: "$borderColorStrong",
});

// ─── Helpers ───────────────────────────────────────────────────────────────

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatLocalDateTime(d: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export function formatEventLabel(ev: {
  id: string;
  title: string;
  startsAt: Date | null;
}): string {
  const date = ev.startsAt
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(ev.startsAt)
    : "No date";
  return `${ev.title} — ${date}`;
}

export type CopyHandler = (text: string, label?: string) => void;
export type OpenHandler = (url: string) => void;

export type SharedActions = {
  onCopy: CopyHandler;
  onOpen: OpenHandler;
};

export type IconNode = React.ReactNode;
