"use client";

import { Fragment, isValidElement, useEffect, type ReactNode } from "react";
import { XStack, YStack, styled } from "tamagui";

import { Text } from "../../tamagui/components/typography/Text";
import { monoScale } from "../../tamagui/tokens/typography";

export const LEDGER_CONTEXT_STRIP_MIN_HEIGHT = 34;

/**
 * Register 3 of the ledger shell — what scope you are looking at, in mono.
 * A hairline register, not a structural one, so three stacked registers do
 * not read as three equal walls.
 *
 * Facts only. The moment it holds a button it is a toolbar and belongs in
 * the page; a dev-only warning fires if a control is slotted in.
 */
export interface LedgerContextStripProps {
  /** Facts about the current scope, joined with mono middots. */
  items?: ReactNode[];
  /** Right-aligned live figure — sold count, sync state — in ink. */
  right?: ReactNode;
  contentMaxWidth?: number;
  testIdBase?: string;
}

const StripFrame = styled(YStack, {
  name: "LedgerContextStrip",
  width: "100%",
  backgroundColor: "$surface",
  // Hairline, deliberately not the 2px structural rule (DS ContextStrip).
  borderBottomWidth: 1,
  borderBottomColor: "$borderColorSoft",
});

const StripRow = styled(XStack, {
  name: "LedgerContextStripRow",
  width: "100%",
  marginHorizontal: "auto",
  minHeight: LEDGER_CONTEXT_STRIP_MIN_HEIGHT,
  alignItems: "center",
  flexWrap: "wrap",
  gap: "$3",
  paddingHorizontal: "$4",
  paddingVertical: "$2",
});

const RightSlot = styled(XStack, {
  name: "LedgerContextStripRight",
  alignItems: "center",
  gap: "$3",
  marginLeft: "auto",
});

const INTERACTIVE_TAGS = new Set(["a", "button"]);

const isInteractiveElement = (node: ReactNode) =>
  isValidElement(node) &&
  typeof node.type === "string" &&
  INTERACTIVE_TAGS.has(node.type);

const Fact = ({ children, ink }: { children: ReactNode; ink?: boolean }) =>
  typeof children === "string" || typeof children === "number" ? (
    // Mono xs rung, regular weight, uppercase. Size + tracking travel
    // together from `monoScale`.
    <Text
      variant="overline"
      tone={ink ? "default" : "muted"}
      weight="regular"
      lineHeight={14}
      {...monoScale.xs}
    >
      {children}
    </Text>
  ) : (
    <>{children}</>
  );

export const LedgerContextStrip = ({
  items,
  right,
  contentMaxWidth = 1400,
  testIdBase = "ledger-context",
}: LedgerContextStripProps) => {
  const facts = (items ?? []).filter(
    (item) => item !== null && item !== undefined && item !== false,
  );

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (facts.some(isInteractiveElement) || isInteractiveElement(right)) {
      console.warn(
        "[LedgerContextStrip] facts only — an <a>/<button> was slotted into " +
          "the context strip. Controls belong in the page, not register 3.",
      );
    }
    // Content identity, not array identity, is what matters here (a fresh
    // `items` array on every render must not re-warn).
  }, [facts.length, right]);

  if (!facts.length && !right) {
    return null;
  }

  return (
    <StripFrame data-testid={testIdBase}>
      <StripRow maxWidth={contentMaxWidth}>
        {facts.map((fact, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <Text
                variant="overline"
                tone="muted"
                weight="regular"
                fontSize={monoScale.xs.fontSize}
                lineHeight={14}
                letterSpacing={0}
                style={{ opacity: 0.5 }}
                aria-hidden
              >
                ·
              </Text>
            ) : null}
            <Fact>{fact}</Fact>
          </Fragment>
        ))}
        {right ? (
          <RightSlot data-testid={`${testIdBase}-right`}>
            <Fact ink>{right}</Fact>
          </RightSlot>
        ) : null}
      </StripRow>
    </StripFrame>
  );
};

LedgerContextStrip.displayName = "LedgerContextStrip";
