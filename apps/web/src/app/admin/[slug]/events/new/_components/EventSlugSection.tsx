"use client";

import { useState, useCallback } from "react";
import { nanoid } from "nanoid";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { Link2, Copy, RefreshCw, Check, ExternalLink } from "lucide-react";
import {
  Text,
  Button,
  FormErrorBanner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { eventPublicPath } from "@th/core/lib/event-public-paths";
import { trpc } from "@/trpc";
import { useFormErrors } from "@/hooks/useFormErrors";

import { EventPublicLinkField } from "./EventPublicLinkField";
import {
  isEventLinkPublic,
  type EventLinkState,
} from "./event-public-link.helpers";

const Container = styled(YStack, {
  gap: 16,
  padding: 32,
  backgroundColor: "$surface",
  maxWidth: 960,
  width: "100%",
  marginHorizontal: "auto",
});

const SectionTitle = styled(Text, {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "$color",
});

const LinkRow = styled(XStack, {
  padding: 12,
  borderWidth: 1,
  borderColor: "$borderColor",
  borderRadius: 0,
  alignItems: "center",
  gap: 12,
  backgroundColor: "$surfaceMuted",
});

export type EventSlugSectionProps = {
  eventId: string;
  slug: string;
  shortId?: string | null;
  /**
   * Status + first-publish time. While a stranger could open the link
   * (`isEventLinkPublic`) the group shows the same Public link field as the
   * top of the builder; a draft has a slug and short ID from creation but no
   * working link, so it keeps the plain slug row below.
   */
  eventStatus: EventLinkState["status"];
  publishedAt: EventLinkState["publishedAt"];
  /**
   * Render the "Regenerate slug" control. `regenerateEventSlug` asks edit
   * roles on a draft and ORG_ADMIN_ROLES (owner / OWNER-ADMIN delegate on a
   * personal event) once it is PUBLISHED; the caller resolves which applies.
   * When false the link, Copy and Open stay — only the action is withheld.
   */
  canRegenerate: boolean;
  /** The builder's `handleCopyEventLink`, shared with the Public link field. */
  onCopyEventLink: () => void;
};

export function EventSlugSection({
  eventId,
  slug,
  shortId,
  eventStatus,
  publishedAt,
  canRegenerate,
  onCopyEventLink,
}: EventSlugSectionProps) {
  const theme = useTheme();
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();
  const [currentSlug, setCurrentSlug] = useState(slug);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const utils = trpc.useUtils();

  const regenerateSlug = trpc.events.regenerateEventSlug.useMutation({
    retry: false,
    meta: { silent: true },
    // Returned, so `mutateAsync` settles after the refetch: the builder's Copy
    // link (built from the query) and the slug shown here change together.
    onSuccess: () =>
      utils.events.getEventForEdit.invalidate({ eventId }),
  });

  const eventPath = eventPublicPath(currentSlug) ?? "";
  const eventUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${eventPath}`
      : eventPath;

  const linkIsPublic = isEventLinkPublic({ status: eventStatus, publishedAt });

  const handleCopy = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setJustCopied(true);
        setTimeout(() => setJustCopied(false), 2000);
        toast.success({
          id: "link-copied",
          title: "Link copied",
          message: "",
        });
      } catch {
        // Fallback: select text approach
      }
    },
    [toast],
  );

  const handleRegenerate = useCallback(async () => {
    clearAll();
    setIsRegenerating(true);
    try {
      const result = await regenerateSlug.mutateAsync({
        eventId,
        clientKey: nanoid(12),
      });
      if (result.newSlug) {
        setCurrentSlug(result.newSlug);
        toast.success({
          id: "slug-regenerated",
          title: "Slug regenerated",
          message: `New URL: /events/${result.newSlug}`,
        });
      }
    } catch (error: any) {
      console.error("Failed to regenerate slug:", error);
      setError(error);
    } finally {
      setIsRegenerating(false);
    }
  }, [eventId, regenerateSlug, toast, clearAll, setError]);

  return (
    <Container data-testid="event-slug-section">
      {!linkIsPublic && <SectionTitle>Event Link</SectionTitle>}
      <FormErrorBanner message={formError} onDismiss={clearAll} />

      {linkIsPublic ? (
        <EventPublicLinkField
          status={eventStatus}
          publishedAt={publishedAt}
          slug={currentSlug}
          shortId={shortId}
          onCopy={onCopyEventLink}
        />
      ) : (
        <LinkRow>
          <Link2 size={16} color={theme.colorMuted?.val} />
          <YStack flex={1} gap={2}>
            <Text
              style={{
                fontSize: 14,
                fontFamily: "monospace",
                wordBreak: "break-all" as const,
              }}
              color="$color"
            >
              /events/{currentSlug}
            </Text>
          </YStack>
          <XStack gap={8}>
            <Button
              variant="ghost"
              size="$2"
              onPress={() => handleCopy(eventUrl)}
              data-testid="copy-event-link-btn"
            >
              {justCopied ? (
                <Check size={14} color="var(--success)" aria-hidden />
              ) : (
                <Copy size={14} aria-hidden />
              )}
              {justCopied ? "Copied" : "Copy"}
            </Button>
            <a
              href={eventPath}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <Button
                variant="ghost"
                size="$2"
                icon
                aria-label="Open event page"
                data-testid="open-event-link-btn"
              >
                <ExternalLink size={14} />
              </Button>
            </a>
          </XStack>
        </LinkRow>
      )}

      {/* Regenerate button — only for a viewer the server would let do it */}
      {canRegenerate && (
        <>
          <XStack>
            <Button
              variant="ghost"
              size="$2"
              onPress={handleRegenerate}
              disabled={isRegenerating}
              data-testid="regenerate-slug-btn"
            >
              <RefreshCw size={14} aria-hidden />
              {isRegenerating ? "Regenerating..." : "Regenerate slug"}
            </Button>
          </XStack>
          <Text style={{ fontSize: 11 }} tone="muted">
            Regenerating creates a new URL. The old URL will redirect
            automatically.
          </Text>
        </>
      )}
    </Container>
  );
}

export default EventSlugSection;
