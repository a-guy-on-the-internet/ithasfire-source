import { AlertTriangle } from "lucide-react";
import { Button } from "../forms/Button";
import { Alert } from "./Alert";

export interface FormErrorBannerProps {
  /** Error message to display. Renders nothing when null / empty. */
  message: string | null;
  /** Optional dismiss handler. Shows a close button when provided. */
  onDismiss?: () => void;
  /** Optional retry handler. Shows a retry button when provided. */
  onRetry?: () => void;
  /** Label for the retry button. Defaults to "RETRY". */
  retryLabel?: string;
  /** Test automation id forwarded to the root element. */
  testId?: string;
}

export function FormErrorBanner({
  message,
  onDismiss,
  onRetry,
  retryLabel = "RETRY",
  testId,
}: FormErrorBannerProps) {
  if (!message) return null;

  return (
    <Alert
      tone="error"
      role="alert"
      icon={<AlertTriangle size={18} strokeWidth={2.25} />}
      description={message}
      onDismiss={onDismiss}
      actions={
        onRetry ? (
          <Button size="$2" variant="ghost" onPress={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
      borderRadius={0}
      fullWidth
      {...(testId ? { "data-testid": testId } : {})}
    />
  );
}

FormErrorBanner.displayName = "FormErrorBanner";
