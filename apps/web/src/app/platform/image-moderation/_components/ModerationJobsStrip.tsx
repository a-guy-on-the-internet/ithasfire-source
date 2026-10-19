"use client";

import { useState, type CSSProperties } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Spinner, Text } from "@th/ui";
import { CheckCircle2, Play, XCircle } from "lucide-react";

import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { PlatformSectionTitle } from "../../_components/PlatformPageParts";

import {
  MODERATION_JOBS,
  NO_VALUE,
  describeJobResult,
  formatAgo,
  formatDurationMs,
  type ModerationJobName,
  type ModerationJobSpec,
} from "./image-moderation-ops.helpers";

/**
 * The two jobs that move this queue, with their last run and a "run now".
 *
 * REQUEUE ASKS FIRST AND DRAIN DOES NOT, and that asymmetry is the point:
 * draining is idempotent catch-up over rows that are already due, while
 * requeueing pushes degraded rows back into the scan queue and costs provider
 * calls. Same confirmation shape as `/platform/jobs`'s DLQ purge.
 *
 * THE RESULT LINE IS PROSE, NOT JSON. The jobs service stores
 * `JSON.stringify(result).slice(0, 500)`; rendering that verbatim put a 520px
 * unbreakable token on screen that dragged the document to `scrollWidth 604`
 * at a 320px viewport — and made a human decode six zeros to learn nothing had
 * happened. `describeJobResult` never falls back to printing the blob.
 */

const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };
const ICON: CSSProperties = { flexShrink: 0 };
/**
 * Safety net for the result line only. `describeJobResult` returns prose that
 * wraps at spaces, but the payload is not ours and an unforeseen shape must
 * not be able to widen the page.
 */
const BREAK_ANYWHERE: CSSProperties = { overflowWrap: "anywhere" };

export type JobLastRun = {
  finishedAt: string;
  durationMs: number;
  status: "success" | "error";
  resultSummary?: string;
  errorMessage?: string;
};

export type ModerationJobsStripProps = {
  /** Last run per job name, or undefined when the job has never run / is unknown. */
  lastRunByName: Partial<Record<ModerationJobName, JobLastRun | null>>;
  isLoading: boolean;
  /** True while a run for this job is in flight. */
  isRunning: (name: ModerationJobName) => boolean;
  onRun: (name: ModerationJobName) => void;
  /** Rendered as "now" for the last-run ages. */
  now: Date;
  /**
   * Set when the job-status read failed (usually the jobs-service URL is
   * unset). The buttons stay visible but inert — an operator should be able
   * to see the action exists.
   */
  unavailableReason?: string;
};

export function ModerationJobsStrip({
  lastRunByName,
  isLoading,
  isRunning,
  onRun,
  now,
  unavailableReason,
}: ModerationJobsStripProps) {
  const [confirming, setConfirming] = useState<ModerationJobSpec | null>(null);

  const press = (spec: ModerationJobSpec) => {
    // The run button is `aria-disabled` while in flight rather than
    // `disabled`, so the press must be guarded here (see the button below).
    if (isRunning(spec.name) || unavailableReason) return;
    if (spec.confirm) {
      setConfirming(spec);
      return;
    }
    onRun(spec.name);
  };

  return (
    <YStack gap="$3" flexShrink={1} minWidth={0}>
      <PlatformSectionTitle>Jobs</PlatformSectionTitle>

      {unavailableReason ? (
        <Text variant="caption" tone="muted">
          {unavailableReason}
        </Text>
      ) : null}

      <YStack
        borderWidth={2}
        borderRadius={0}
        borderColor="$borderColor"
        backgroundColor="$surface"
        flexShrink={1}
        minWidth={0}
      >
        {MODERATION_JOBS.map((spec, index) => {
          const lastRun = lastRunByName[spec.name] ?? null;
          const running = isRunning(spec.name);
          const summary = lastRun
            ? describeJobResult(lastRun.resultSummary)
            : null;
          return (
            <XStack
              key={spec.name}
              gap="$4"
              padding="$4"
              alignItems="flex-start"
              flexWrap="wrap"
              borderTopWidth={index === 0 ? 0 : 1}
              borderColor="$borderColorSoft"
              flexShrink={1}
              minWidth={0}
            >
              <YStack gap="$1" flex={1} flexShrink={1} minWidth={0}>
                <Text variant="bodySmall" weight="bold">
                  {spec.label}
                </Text>
                <Text
                  variant="code"
                  fontSize={11}
                  tone="muted"
                  style={BREAK_ANYWHERE}
                >
                  {spec.name}
                </Text>
                <Text variant="caption" tone="muted">
                  {spec.description}
                </Text>
              </YStack>

              <YStack gap="$1" flexShrink={1} minWidth={0}>
                <Text variant="overline" tone="muted">
                  Last run
                </Text>
                {isLoading ? (
                  <Text variant="caption" tone="muted">
                    Loading…
                  </Text>
                ) : lastRun ? (
                  <>
                    <XStack
                      gap="$2"
                      alignItems="center"
                      flexShrink={1}
                      minWidth={0}
                    >
                      {lastRun.status === "success" ? (
                        <CheckCircle2
                          size={14}
                          color="var(--success, #166534)"
                          style={ICON}
                          aria-hidden
                        />
                      ) : (
                        <XCircle
                          size={14}
                          color="var(--danger, #B91C1C)"
                          style={ICON}
                          aria-hidden
                        />
                      )}
                      <Text variant="caption" style={TABULAR}>
                        {formatAgo(new Date(lastRun.finishedAt), now)} ·{" "}
                        {formatDurationMs(lastRun.durationMs)}
                      </Text>
                    </XStack>
                    {lastRun.status === "error" && lastRun.errorMessage ? (
                      <Text
                        variant="caption"
                        color="$danger"
                        style={BREAK_ANYWHERE}
                      >
                        {lastRun.errorMessage}
                      </Text>
                    ) : summary ? (
                      <Text
                        variant="caption"
                        tone="muted"
                        style={BREAK_ANYWHERE}
                      >
                        {summary}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text variant="caption" tone="muted">
                    {NO_VALUE} never run
                  </Text>
                )}
              </YStack>

              <XStack alignItems="center" flexShrink={0}>
                <Button
                  size="$3"
                  variant="secondary"
                  // `aria-busy` + `aria-disabled`, NOT `disabled`: `disabled`
                  // applies `disabledStyle` (opacity .45), which dims the very
                  // spinner and label that ARE the progress feedback. This is
                  // the pattern `Button.tsx` documents for exactly this case;
                  // `press()` guards the handler.
                  aria-busy={running || undefined}
                  aria-disabled={running || undefined}
                  disabled={Boolean(unavailableReason)}
                  // Two jobs can be in flight at once; without the job name
                  // both buttons would announce as plain "Running…".
                  aria-label={
                    running
                      ? `${spec.label}: running`
                      : `${spec.runLabel} — ${spec.label}`
                  }
                  onPress={() => press(spec)}
                >
                  {running ? (
                    <Spinner size="small" />
                  ) : (
                    <Play size={14} aria-hidden />
                  )}
                  {running ? "Running…" : spec.runLabel}
                </Button>
              </XStack>
            </XStack>
          );
        })}
      </YStack>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.confirm?.title ?? ""}
        description={confirming?.confirm?.description ?? ""}
        confirmLabel={confirming?.confirm?.confirmLabel ?? "Confirm"}
        // No `loading` prop: the dialog closes in the same tick it confirms,
        // so a loading flag here could never render. The in-flight state lives
        // on the run button, which stays on screen.
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (!confirming) return;
          onRun(confirming.name);
          setConfirming(null);
        }}
      />
    </YStack>
  );
}
