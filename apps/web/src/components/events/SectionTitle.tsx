import type { ComponentProps } from "react";

import { Text } from "@th/ui";

/**
 * Section heading for the event and place content pages — the `0N · LABEL`
 * rule.
 *
 * A COMPONENT rather than a `styled(Text, { tag: "h2" })`, and that is the
 * whole point of the file. `@th/ui`'s `Text` is a plain `forwardRef` function
 * that reads `tag` off its own props and falls back to its variant's default
 * (`body` → `span`). A `tag` written into a `styled()` config is consumed by
 * Tamagui's styled layer and never arrives as a prop, so the styled version of
 * this shipped as a `<span class="is_Paragraph">` while carrying a comment
 * claiming it was "a real section heading under the page h1".
 *
 * Measured 2026-09-02 on `/events/…`: the page had exactly two headings — the
 * h1 and an unrelated "Welcome" — while rendering five numbered sections.
 * Anything that needs a real tag has to pass it to `Text` directly.
 */
export function SectionTitle({
  children,
  ...rest
}: ComponentProps<typeof Text>) {
  return (
    <Text
      tag="h2"
      fontSize={15}
      letterSpacing={1}
      textTransform="uppercase"
      color="$color"
      // Keeps the UA's h2 margins out now that it really is an h2.
      margin={0}
      // Swiss structural accent: left rule for section headings.
      borderLeftWidth={3}
      borderLeftColor="$accent"
      paddingLeft={12}
      {...rest}
    >
      {children}
    </Text>
  );
}

SectionTitle.displayName = "SectionTitle";
