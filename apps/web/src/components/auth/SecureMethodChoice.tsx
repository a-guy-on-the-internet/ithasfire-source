"use client";

import { Text } from "@th/ui";
import { Stack, XStack, YStack } from "tamagui";

import { AUTH_FOCUS_RING } from "./auth-card-chrome";
import {
  nextSecureMethodForKey,
  secureMethodDomId,
  type SecureMethod,
} from "./secure-method.helpers";

export type SecureMethodOption = {
  value: SecureMethod;
  title: string;
  /** Short mono tag after the title — "· fastest". Ornament, not a control. */
  tag?: string;
  description: string;
  testId: string;
};

export type SecureMethodChoiceProps = {
  options: readonly SecureMethodOption[];
  value: SecureMethod;
  onChangeAction: (method: SecureMethod) => void;
  disabled?: boolean;
  /** Accessible name for the group. */
  label: string;
};

/**
 * The method picker on "Secure your account" — three selectable rows.
 *
 * A radio group, not three buttons that each fire their own action: the card
 * asks ONE question and has ONE primary ("Continue") that acts on the answer.
 * The old prompt had an accent-filled "Authenticator app" beside an outlined
 * "Email me codes", so the reader was choosing between two CTAs rather than
 * between two methods, and there was nowhere to put a third.
 *
 * ## Selected = the ink card's own inversion
 *
 * The auth panel is ink on the cream page, and its primary CTA is a CREAM fill
 * with an ink label (`[data-auth-card]` in `globals.css`). The selected row
 * takes that same inversion through the `structure` pair — `$structure` is
 * rebound to paper on this surface and `$onStructure` to ink — so choosing a
 * row reads as "this one is lit", in the grammar the CTA beneath it already
 * speaks. Unselected rows sit one step off the panel on the field fill
 * (`$background`, 6% paper) inside the 40% hairline every boxed field wears.
 *
 * ## Contrast on the lit row
 *
 * Everything on the paper row is `$onStructure` (ink, 16.22:1). The muted and
 * support hues are NOT used there: on this surface `$colorMuted` is rebound to
 * muted PAPER (#BDB4A6, ~2:1 on cream) and `$support` is amber (2.2:1 on
 * cream), both of which fail. The description steps down with opacity
 * instead — ink at 80% on cream still clears 4.5:1 by a wide margin — and the
 * "· fastest" tag drops from amber to ink. Colour was never its only signal;
 * the tag is its own word.
 *
 * ## Keyboard
 *
 * One tab stop for the whole group (roving tabindex on the selected row),
 * arrows move focus AND selection together, wrapping at both ends. Each row
 * is a real `<button>`, so Space and Enter select natively and no key handler
 * has to fake activation. The focus ring is the panel's amber
 * (`AUTH_FOCUS_RING`) — deliberately NOT the selected state's paper border, so
 * a row that is focused-but-unselected can never read as chosen.
 */
export const SecureMethodChoice = ({
  options,
  value,
  onChangeAction,
  disabled = false,
  label,
}: SecureMethodChoiceProps) => {
  const order = options.map((option) => option.value);

  const handleKeyDown = (event: {
    key: string;
    preventDefault: () => void;
  }) => {
    if (disabled) return;
    const target = nextSecureMethodForKey(value, event.key, order);
    if (!target) return;
    event.preventDefault();
    onChangeAction(target);
    document.getElementById(secureMethodDomId(target))?.focus();
  };

  return (
    <YStack
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled ? true : undefined}
      gap="$2"
      width="100%"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <XStack
            key={option.value}
            id={secureMethodDomId(option.value)}
            tag="button"
            // @ts-expect-error -- 'type' is valid in the DOM but not in Tamagui's typings
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={disabled ? -1 : selected ? 0 : -1}
            data-testid={option.testId}
            disabled={disabled}
            onPress={() => {
              if (!disabled) onChangeAction(option.value);
            }}
            onKeyDown={handleKeyDown}
            width="100%"
            minHeight={44}
            alignItems="center"
            gap="$3"
            paddingVertical="$3"
            paddingHorizontal="$4"
            borderWidth={2}
            borderStyle="solid"
            borderRadius={0}
            borderColor={selected ? "$structure" : "$borderColorSoft"}
            backgroundColor={selected ? "$structure" : "$background"}
            cursor={disabled ? "not-allowed" : "pointer"}
            // Firm the hairline to full paper on hover, the same move a
            // boxed field makes on focus. The lit row has nowhere further
            // to go, so it holds.
            hoverStyle={selected ? undefined : { borderColor: "$borderColor" }}
            focusStyle={AUTH_FOCUS_RING}
            disabledStyle={{ opacity: 0.45 }}
          >
            {/* The marker: a 14px square, the radio's dot in the card's
                square grammar. Lit = ink fill with an inset paper ring, drawn
                as a box-shadow because the ring sits INSIDE the 2px border.
                `--structure`'s Stub value is the fallback the gate expects;
                on this surface the var itself is paper. */}
            <Stack
              aria-hidden
              width={14}
              height={14}
              flexShrink={0}
              borderWidth={2}
              borderStyle="solid"
              borderRadius={0}
              borderColor={selected ? "$onStructure" : "$borderColor"}
              backgroundColor={selected ? "$onStructure" : "transparent"}
              style={
                selected
                  ? { boxShadow: "inset 0 0 0 2px var(--structure, #211C16)" }
                  : undefined
              }
            />

            <YStack flex={1} minWidth={0} gap={2} alignItems="flex-start">
              <XStack
                alignItems="baseline"
                gap="$2"
                flexWrap="wrap"
                justifyContent="flex-start"
              >
                <Text
                  variant="body"
                  fontWeight="700"
                  textAlign="left"
                  color={selected ? "$onStructure" : "$color"}
                >
                  {option.title}
                </Text>
                {option.tag ? (
                  <Text
                    variant="overline"
                    color={selected ? "$onStructure" : "$support"}
                  >
                    {option.tag}
                  </Text>
                ) : null}
              </XStack>
              <Text
                variant="bodySmall"
                textAlign="left"
                color={selected ? "$onStructure" : "$colorMuted"}
                style={selected ? { opacity: 0.8 } : undefined}
              >
                {option.description}
              </Text>
            </YStack>
          </XStack>
        );
      })}
    </YStack>
  );
};

SecureMethodChoice.displayName = "SecureMethodChoice";
