"use client";

import { XStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

/**
 * "This value is still exactly what the act pitched — you did not choose it."
 *
 * WHERE IT SITS AND WHY. In this form, everything BELOW a control is the
 * validation channel (`baErr*` in `tone="error"`, plus the guarantee hint).
 * Provenance is not validation — it is neutral identity — so the marker lives
 * in the LABEL row instead, above the control. That keeps a venue from reading
 * "from booking request" as "something is wrong with this number", and it
 * costs no vertical space at any width.
 *
 * ACCESSIBILITY. A marker sitting next to a form control is invisible to a
 * screen reader in forms mode: it is not inside the `<label>`, so tabbing to
 * the input announces the label and `aria-describedby` and nothing else. The
 * caller therefore passes an `id` and points the field's `aria-describedby` at
 * it, which makes the announced text identical to the printed text. Read-only
 * renderings have no control to describe and omit the `id` — there the marker
 * is simply next in DOM order, right after the label.
 *
 * Rendering is the CALLER's decision: this component is only mounted for a
 * field whose server-derived `pitchProvenance` flag is `true` AND that has no
 * unsaved local edit. There is no "you chose this" inverse state.
 */
export function PitchProvenanceMarker({
  id,
  testID,
}: {
  /** Id for the field's `aria-describedby`. Omit in read-only renderings. */
  id?: string;
  testID?: string;
}) {
  const t = useTranslations();
  return (
    <XStack
      alignItems="center"
      paddingHorizontal={5}
      paddingVertical={1}
      borderWidth={1}
      borderColor="$borderColorSoft"
      backgroundColor="$surfaceMuted"
      testID={testID}
    >
      <Text
        id={id}
        variant="caption"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={0.6}
      >
        {String(t("admin.baPitchFromRequest"))}
      </Text>
    </XStack>
  );
}
