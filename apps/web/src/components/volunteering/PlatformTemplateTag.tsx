"use client";

/**
 * CatalogueTag — the one accent chip the volunteer-catalogue surfaces use, and
 * {@link PlatformTemplateTag}, its "From Ithas Fire" instance (FR-013).
 *
 * It sits ON a content row (a table row the organizer is working through), so
 * it is CONTENT, not chrome: `radius: 0`, a hard visible border, no pill and no
 * shadow.
 *
 * Colour: an `$accent` hairline border with `$accentText` ink. `$accent`
 * (#E2481D) is the one brand value with no AA foreground in either polarity, so
 * it never carries the label — a 1px border only needs 3:1. The label rides
 * `$accentText` (#B93312, 5.22:1 on the cream canvas). No fill: the tag repeats
 * once per catalogue row, and a filled accent chip on every row would blow the
 * ≤5%-per-viewport accent budget on its own.
 *
 * Why ONE treatment for two meanings — provenance ("From Ithas Fire") and
 * ranking ("Recommended"): they never co-occur. Provenance is a distinction
 * drawn against the org's OWN templates, so it only appears where both kinds of
 * row are listed together (the templates table, the apply dialog); the pack
 * picker is wall-to-wall catalogue, where marking every card "From Ithas Fire"
 * would say nothing. A reader therefore sees at most one chip MEANING per
 * viewport and there is no emphasis to arbitrate. If a second chip ever has to
 * share a surface with this one, the newcomer takes a NON-accent treatment —
 * accent is spoken for here.
 *
 * `flexShrink={0}` + `nowrap` are load-bearing, not polish: the tag rides in a
 * wrapping XStack beside a name of unbounded length, and a chip that wrapped to
 * two lines would overflow a box sized for one.
 */

import { XStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

export function CatalogueTag({
  label,
  testId,
}: {
  label: string;
  testId?: string;
}) {
  return (
    <XStack
      borderWidth={1}
      borderColor="$accent"
      borderRadius={0}
      paddingHorizontal={6}
      paddingVertical={2}
      alignItems="center"
      flexShrink={0}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <Text
        variant="overline"
        color="$accentText"
        fontSize={10}
        lineHeight={12}
        letterSpacing={1.5}
        style={{ whiteSpace: "nowrap" }}
      >
        {label}
      </Text>
    </XStack>
  );
}

export function PlatformTemplateTag({ testId }: { testId?: string }) {
  const t = useTranslations();
  return (
    <CatalogueTag
      label={String(t("admin.volunteerTemplatePlatformTag"))}
      testId={testId}
    />
  );
}
