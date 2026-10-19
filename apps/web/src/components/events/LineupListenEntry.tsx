"use client";

import { useEffect, useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Play } from "lucide-react";
import { Text, useTranslations } from "@th/ui";
import { parseEmbedUrl, type ParsedMediaEmbed } from "@th/core/lib/embeds";

import { MediaEmbed } from "@/components/embeds/MediaEmbed";
import type { EventContentHuman } from "./event-content-types";
import { LineupItem, RoleBadge, formatRole } from "./event-content-styled";

/**
 * Resolves a lineup entry's server-derived `listenUrl` into a playable embed,
 * exactly the way `EpkEmbed` does: the client re-parses the URL through
 * `parseEmbedUrl` so the iframe `src` is always provider-derived — the raw
 * string shipped over the wire is never reflected into the iframe.
 *
 * Returns null for missing URLs, unparseable URLs, and `renderMode: "link"`
 * providers (not inline-playable → no chip, per the lineup-listen-embeds
 * spec).
 */
export function getListenEmbed(
  listenUrl: string | null | undefined,
): ParsedMediaEmbed | null {
  if (!listenUrl) return null;
  const parsed = parseEmbedUrl(listenUrl);
  if (parsed?.renderMode !== "iframe") return null;
  return parsed;
}

type LineupListenEntryProps = {
  human: EventContentHuman;
  /** Mirrors EventContent's `mobile` prop — compact avatar/type sizes. */
  mobile: boolean;
  /**
   * True for at most ONE row per lineup: the first entry (existing lineup
   * order) whose `listenUrl` resolves to an iframe embed, desktop only.
   * EventContent computes this; rows never self-elect.
   */
  autoExpand: boolean;
};

/**
 * One public-lineup row: avatar, name, role badge, and — when the entry
 * carries a client-parseable `listenUrl` — a quiet "Listen" chip that toggles
 * an inline `MediaEmbed` player panel under the row.
 *
 * Lazy mount is a hard requirement (lineup-listen-embeds spec): the player
 * (and therefore its iframe) is NOT in the DOM until the row first expands.
 * After the first open the player stays mounted and is hidden on collapse via
 * the `hidden` attribute, so re-toggling never reloads the iframe. Multiple
 * rows may be open at once — there is no accordion coupling.
 */
export function LineupListenEntry({
  human,
  mobile,
  autoExpand,
}: LineupListenEntryProps) {
  const t = useTranslations();
  const panelId = useId();
  const embed = getListenEmbed(human.listenUrl);
  const startOpen = autoExpand && embed !== null;
  const [expanded, setExpanded] = useState(startOpen);
  // Once true, stays true — keeps the player mounted across collapses so a
  // re-expand doesn't reload the iframe. Pre-first-open there is zero player
  // DOM.
  const [hasOpened, setHasOpened] = useState(startOpen);

  // The headliner's `autoExpand` arrives AFTER mount on the public page —
  // EventContent decides it against the real viewport in an effect (SSR
  // renders everything collapsed). Honor that late activation, but only if
  // the row has never been opened: a user who already toggled keeps their
  // state.
  useEffect(() => {
    if (autoExpand && embed !== null && !hasOpened) {
      setExpanded(true);
      setHasOpened(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpand]);

  const toggle = () => {
    setExpanded((prev) => !prev);
    if (!hasOpened) setHasOpened(true);
  };

  return (
    <YStack>
      <LineupItem>
        {human.imageUrl ? (
          <img
            src={human.imageUrl}
            alt=""
            style={{
              width: mobile ? 30 : 34,
              height: mobile ? 30 : 34,
              borderRadius: 0,
              objectFit: "cover",
              flexShrink: 0,
            }}
          />
        ) : (
          <YStack
            width={mobile ? 30 : 34}
            height={mobile ? 30 : 34}
            borderRadius={0}
            backgroundColor="transparent"
            borderWidth={2}
            borderColor="$borderColor"
            justifyContent="center"
            alignItems="center"
            aria-hidden={true}
          >
            <Text
              style={{
                fontSize: mobile ? 12 : 13,
                fontWeight: "700",
              }}
              color="$color"
            >
              {human.name.charAt(0).toUpperCase()}
            </Text>
          </YStack>
        )}
        <XStack gap={8} alignItems="center" flex={1} flexWrap="wrap">
          <Text
            style={{
              fontSize: mobile ? 15 : 16,
              fontWeight: "500",
            }}
            color="$color"
          >
            {human.name}
          </Text>
          <RoleBadge>
            <Text style={{ fontSize: mobile ? 11 : 12 }} color="$color">
              {human.role === "OTHER" && human.customRoleLabel
                ? human.customRoleLabel
                : formatRole(human.role)}
            </Text>
          </RoleBadge>
          {embed && (
            <button
              type="button"
              className="lineup-listen-chip"
              aria-expanded={expanded}
              aria-controls={panelId}
              // Accessible name stays constant across states ("Listen to X");
              // aria-expanded announces open/closed — swapping the name to a
              // "hide" phrasing would break label-in-name (WCAG 2.5.3).
              aria-label={String(
                t("eventDetail.listenChipLabel", { name: human.name }),
              )}
              onClick={toggle}
              data-testid="lineup-listen-chip"
            >
              <Play size={13} aria-hidden />
              {String(t("eventDetail.listenChip"))}
            </button>
          )}
        </XStack>
      </LineupItem>
      {embed && (
        <div
          id={panelId}
          role="region"
          aria-label={human.name}
          hidden={!expanded}
          data-testid="lineup-listen-panel"
        >
          {hasOpened && (
            <MediaEmbed
              embed={{
                provider: embed.provider,
                sourceUrl: embed.sourceUrl,
                embedUrl: embed.embedUrl,
                externalId: embed.externalId,
                renderMode: embed.renderMode,
                kind: embed.kind,
                title: human.name,
              }}
            />
          )}
        </div>
      )}
    </YStack>
  );
}
