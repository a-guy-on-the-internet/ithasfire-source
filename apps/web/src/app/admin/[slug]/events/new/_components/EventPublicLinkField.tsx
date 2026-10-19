"use client";

import { memo, useId, useSyncExternalStore } from "react";
import { styled, XStack, YStack } from "tamagui";
import { Copy, ExternalLink, Link2 } from "lucide-react";

import { Button, Text, useTranslations } from "@th/ui";

import { useIsMobile } from "@/hooks/useIsMobile";

import { FormSection } from "./_builder-styled";
import { Field, FieldLabel } from "./_form-bits";
import { eventPublicLink, type EventLinkInput } from "./event-public-link.helpers";

/**
 * "Public link" — the event's shareable URL, first thing in the builder body.
 *
 * Renders NOTHING (no placeholder, no gutter) unless a stranger could open the
 * link (`eventPublicLink` → `isEventLinkPublic`): a DRAFT, or an event
 * cancelled / archived without ever going live, has no link worth showing.
 *
 * The box is a read-only display, not an input: nothing here is editable (the
 * slug is regenerated from Settings → Sharing), so it carries the field frame
 * for rhythm but no hover/focus affordance. The text stays selectable.
 *
 * Copy is the builder's own handler (the `⋯` menu's), so both copy paths
 * write the same URL through the same guarded clipboard call and raise the
 * same toasts. View event is a real link (`<a target="_blank">`), so
 * middle-click, "Copy link address" and the status-bar URL all work.
 */

/** The host is fixed for the page's life; nothing to subscribe to. */
const subscribeNoop = () => () => {};
const readHost = () => window.location.host;
/**
 * Server (and hydration) snapshot: no host. `useSyncExternalStore` renders
 * this during hydration and re-renders with `readHost` straight after, so a
 * server render and the first client render always agree. On an ordinary
 * client mount — the builder reads its event client-side, so that is the
 * normal case — React uses `readHost` from the first frame.
 */
const readNoHost = () => null;

/**
 * The frame of the builder's text fields. Those are painted by the global
 * native-input rule in `globals.css` (`input:not(…), textarea, select` —
 * `background: var(--background)`, `border: 2px solid var(--borderColorSoft)`),
 * which outranks `TextInput`'s own `$surface` / `$borderColor` props. This box
 * is not an input, so it takes the same two theme keys directly to sit flush
 * with the Event title below it in every theme.
 */
const LinkBox = styled(XStack, {
  flex: 1,
  minWidth: 0,
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$3",
  paddingVertical: 6,
  borderWidth: 2,
  borderColor: "$borderColorSoft",
  borderRadius: 0,
  backgroundColor: "$background",
});

export type EventPublicLinkFieldProps = EventLinkInput & {
  /** The builder's `handleCopyEventLink`. */
  onCopy: () => void;
};

/** A new-tab link without handing the public page a handle on the builder. */
const NEW_TAB_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;

function EventPublicLinkFieldImpl({
  onCopy,
  ...linkInput
}: EventPublicLinkFieldProps) {
  const t = useTranslations();
  const isMobile = useIsMobile();
  const labelId = useId();
  const host = useSyncExternalStore(subscribeNoop, readHost, readNoHost);

  const link = eventPublicLink(linkInput);
  if (!link) return null;

  // Shown without the scheme (it is what people read aloud and type); Copy
  // writes the full `https://…` URL. The `<wbr>` makes host|path the place a
  // phone wraps it — at 390px the column is 276px and `<host>/e/<id>` did not
  // fit one line (measured) — rather than an arbitrary character mid-host.
  const shown = host ? (
    <>
      {host}
      <wbr />
      {link.sharePath}
    </>
  ) : (
    link.sharePath
  );
  const controlHeight = isMobile ? 44 : 36;

  const box = (
    <LinkBox minHeight={controlHeight} data-testid="event-public-link-box">
      <Link2
        size={16}
        color="var(--colorMuted, #5C544A)"
        aria-hidden
        style={{ flexShrink: 0 }}
      />
      <Text
        variant="code"
        color="$color"
        userSelect="text"
        // A legacy event without a short ID shows its long canonical URL,
        // which runs to ~120 unbroken characters: break it rather than
        // overflow the column.
        style={{ overflowWrap: "anywhere", minWidth: 0 }}
        data-testid="event-public-link-url"
      >
        {shown}
      </Text>
    </LinkBox>
  );

  const copyLabel = String(t("eventDetail.shareCopyLink"));
  const viewLabel = String(t("pageActions.viewEvent"));

  return (
    <FormSection paddingBottom={0} data-testid="event-public-link">
      <Field role="group" aria-labelledby={labelId}>
        <FieldLabel id={labelId}>{String(t("admin.ebPublicLink"))}</FieldLabel>
        {isMobile ? (
          // Phone: the box gets the full width; the actions take their own
          // row beneath it, Copy filling what the square View event leaves.
          <YStack gap="$2">
            {box}
            <XStack gap="$2">
              <Button
                variant="secondary"
                size="$4"
                flex={1}
                minWidth={0}
                // `$4`'s own `$5` padding left "COPY LINK" truncated to
                // "COPY …" at 320px (a 154px button, measured). The label is
                // centred in a full-row button, so the tighter padding only
                // shows where it is needed.
                paddingHorizontal="$3"
                onPress={onCopy}
                data-testid="event-public-link-copy"
              >
                <Copy size={16} aria-hidden />
                {copyLabel}
              </Button>
              <Button
                variant="ghost"
                size="$4"
                icon
                tag="a"
                href={link.canonicalPath}
                {...NEW_TAB_LINK}
                aria-label={viewLabel}
                data-testid="event-public-link-view"
              >
                <ExternalLink size={16} aria-hidden />
              </Button>
            </XStack>
          </YStack>
        ) : (
          // Wraps rather than squeezes: below ~240px of box the buttons drop
          // to the next line (the builder's narrow desktop band). Centred on
          // the box: a legacy event's long URL wraps to several lines, and
          // 36px buttons pinned to the top of a taller box read as a slip.
          <XStack gap="$2" flexWrap="wrap" alignItems="center">
            <YStack flex={1} minWidth={240}>
              {box}
            </YStack>
            <Button
              variant="secondary"
              size="$3"
              onPress={onCopy}
              data-testid="event-public-link-copy"
            >
              <Copy size={16} aria-hidden />
              {copyLabel}
            </Button>
            <Button
              variant="ghost"
              size="$3"
              tag="a"
              href={link.canonicalPath}
              {...NEW_TAB_LINK}
              data-testid="event-public-link-view"
            >
              {viewLabel}
              <ExternalLink size={16} aria-hidden />
            </Button>
          </XStack>
        )}
      </Field>
    </FormSection>
  );
}

/**
 * Memoized like the builder's other sections: every prop is a primitive, a
 * query-owned `publishedAt` (stable by structural sharing) or the
 * `useCallback`'d copy handler, so a title keystroke elsewhere does not
 * re-render it.
 */
export const EventPublicLinkField = memo(EventPublicLinkFieldImpl);

EventPublicLinkField.displayName = "EventPublicLinkField";
