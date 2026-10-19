"use client";

import { useCallback } from "react";
import { Printer } from "lucide-react";

import { Button } from "@th/ui";

/**
 * The one control that turns a print document into a PDF: the browser's own
 * print dialog. Shared by every document on the print layer.
 *
 * Screen-only — `PaperSheet` renders the toolbar under `[data-print-hide]`, so
 * this never lands on paper.
 *
 * Leading icon (an object, not a direction) per the icon grammar.
 */
export type PrintButtonProps = {
  label: string;
  disabled?: boolean;
  "data-testid"?: string;
};

export const PrintButton = ({
  label,
  disabled,
  "data-testid": testId,
}: PrintButtonProps) => {
  const handlePrint = useCallback(() => {
    if (typeof window === "undefined") return;
    window.print();
  }, []);

  return (
    <Button
      variant="primary"
      size="$3"
      minHeight={44}
      onPress={handlePrint}
      disabled={disabled}
      data-testid={testId ?? "print-button"}
    >
      <Printer size={15} aria-hidden />
      {label}
    </Button>
  );
};

PrintButton.displayName = "PrintButton";
