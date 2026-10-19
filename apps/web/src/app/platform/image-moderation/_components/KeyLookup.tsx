"use client";

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Badge, Button, Text, TextInput } from "@th/ui";
import { FileSearch, Search } from "lucide-react";

import {
  NO_VALUE,
  describeLookup,
  formatAgo,
  normalizeStorageKeyInput,
  statusTone,
  storageKeyInputProblem,
  type LookupResult,
} from "./image-moderation-ops.helpers";

/**
 * Find one moderation record by the thing a Sentry event or a CDN log line
 * actually hands you: an R2 storage key.
 *
 * Every other entry point on this page starts from a queue-health signal. An
 * operator holding a key starts from the opposite end and previously had no way
 * in at all.
 *
 * A MISS IS A FINDING, NOT AN ERROR. Read-time gating treats "no moderation
 * record" as APPROVED, so `found: false` means the object is unmoderated and
 * publicly visible — which is exactly the thing worth knowing. It renders as
 * information, in the same chrome as a hit.
 *
 * WITHHELD IS SAID OUT LOUD. If the key names an un-reviewed content hold, the
 * backend omits status, subject, timing, the key and the error — ABSENT, never
 * null, so "we are not telling you" and "there is nothing here" cannot
 * serialize the same. Rendering that as a row of blank cells would read as
 * missing data, or worse as a record with no subject; it gets a sentence
 * instead. Nothing here ever calls `String()` on an optional field.
 */

const FIELD_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(180px, 100%), 1fr))",
  gap: 12,
  width: "100%",
};

/** A storage key or a provider error is one long unbreakable token. */
const BREAK_ANYWHERE: CSSProperties = { overflowWrap: "anywhere" };
const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };
const ICON: CSSProperties = { flexShrink: 0 };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <YStack gap="$1" minWidth={0}>
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      {children}
    </YStack>
  );
}

function PlainValue({ value }: { value: string | null }) {
  return (
    <Text variant="bodySmall" style={BREAK_ANYWHERE}>
      {value ?? NO_VALUE}
    </Text>
  );
}

export type KeyLookupProps = {
  /** The key the page currently has a query out for, or null. */
  submittedKey: string | null;
  onLookup: (storageKey: string) => void;
  onClear: () => void;
  result: LookupResult | undefined;
  isLoading: boolean;
  errorMessage?: string;
  /** The page's single "now", so ages agree with every other age on screen. */
  now: Date;
};

export function KeyLookup({
  submittedKey,
  onLookup,
  onClear,
  result,
  isLoading,
  errorMessage,
  now,
}: KeyLookupProps) {
  const [draft, setDraft] = useState("");

  const problem = storageKeyInputProblem(draft);
  const normalized = normalizeStorageKeyInput(draft);

  const submit = useCallback(() => {
    const key = normalizeStorageKeyInput(draft);
    if (!key) return;
    onLookup(key);
  }, [draft, onLookup]);

  const clear = useCallback(() => {
    setDraft("");
    onClear();
  }, [onClear]);

  const view = result ? describeLookup(result) : null;

  return (
    <YStack
      gap="$3"
      padding="$4"
      borderWidth={1}
      borderRadius={0}
      borderColor="$borderColorSoft"
      backgroundColor="$surface"
      flexShrink={1}
      minWidth={0}
    >
      <XStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
        <FileSearch
          size={14}
          color="var(--colorMuted, #5C544A)"
          style={ICON}
          aria-hidden
        />
        <Text variant="overline" tone="muted">
          Find a record by storage key
        </Text>
      </XStack>

      <XStack
        gap="$2"
        alignItems="flex-start"
        flexWrap="wrap"
        flexShrink={1}
        minWidth={0}
      >
        <YStack flex={1} flexShrink={1} minWidth={0}>
          <TextInput
            fullWidth
            // `id` + `name` are patched straight onto the DOM <input> by
            // `TextInput`. Without them Chrome logs "A form field element
            // should have an id or name attribute" on every load — this was
            // the only field on the page missing both.
            id="image-moderation-storage-key"
            name="storageKey"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            // The visible label above is the field's caption; this is its
            // accessible name. Keyed to the same words so the two agree.
            aria-label="Storage key"
            placeholder="events/1a2b…/hero.jpg"
            status={problem ? "error" : undefined}
          />
        </YStack>
        <Button
          variant="secondary"
          size="$3"
          aria-label="Look up this storage key"
          disabled={normalized === null}
          onPress={submit}
        >
          <Search size={14} aria-hidden />
          Look up
        </Button>
        {submittedKey ? (
          <Button
            variant="ghost"
            size="$3"
            aria-label="Clear the storage key result"
            onPress={clear}
          >
            Clear
          </Button>
        ) : null}
      </XStack>

      {problem ? (
        <Text variant="caption" color="$danger">
          {problem}
        </Text>
      ) : null}

      {submittedKey ? (
        <YStack gap="$2" flexShrink={1} minWidth={0}>
          <Text variant="code" fontSize={11} tone="muted" style={BREAK_ANYWHERE}>
            {submittedKey}
          </Text>

          {errorMessage ? (
            <Text variant="caption" color="$danger">
              {errorMessage}
            </Text>
          ) : isLoading || !view ? (
            <Text variant="caption" tone="muted">
              Looking up this key…
            </Text>
          ) : view.kind === "miss" ? (
            <YStack gap="$1" flexShrink={1} minWidth={0}>
              <Text variant="bodySmall" weight="bold">
                No moderation record for this key
              </Text>
              <Text variant="caption" tone="muted">
                Read-time gating treats an object with no record as approved, so
                this object is publicly visible. That is a finding, not a
                failure — most legacy objects look like this.
              </Text>
            </YStack>
          ) : view.kind === "withheld" ? (
            <YStack gap="$2" flexShrink={1} minWidth={0}>
              <Text variant="bodySmall" weight="bold">
                Held for review — details withheld
              </Text>
              <Text variant="caption" tone="muted">
                This key names an un-reviewed content hold. Its status, subject,
                timing and error are withheld here on purpose; the decision is
                made in the review queue. The record id below is what to hand a
                moderator.
              </Text>
              <div style={FIELD_GRID}>
                <Field label="Record">
                  <Text
                    variant="code"
                    fontSize={11}
                    tone="muted"
                    style={BREAK_ANYWHERE}
                  >
                    {view.recordId}
                  </Text>
                </Field>
                <Field label="Kind">
                  <PlainValue value={view.imageKind} />
                </Field>
                <Field label="Requeues / attempts">
                  <Text variant="bodySmall" style={TABULAR}>
                    {view.requeues} / {view.attempts}
                  </Text>
                </Field>
              </div>
            </YStack>
          ) : (
            <div style={FIELD_GRID}>
              <Field label="Record">
                <Text
                  variant="code"
                  fontSize={11}
                  tone="muted"
                  style={BREAK_ANYWHERE}
                >
                  {view.recordId}
                </Text>
              </Field>
              <Field label="Kind">
                <PlainValue value={view.imageKind} />
              </Field>
              <Field label="Status">
                <XStack gap="$1" alignItems="center" flexWrap="wrap" minWidth={0}>
                  {view.status ? (
                    <Badge tone={statusTone(view.status)} size="sm">
                      {view.status}
                    </Badge>
                  ) : (
                    <Text variant="bodySmall">{NO_VALUE}</Text>
                  )}
                  {view.degraded ? (
                    <Badge tone="warning" size="sm" variant="outline">
                      DEGRADED
                    </Badge>
                  ) : null}
                </XStack>
              </Field>
              <Field label="Subject">
                <PlainValue
                  value={
                    view.subjectType || view.subjectId
                      ? `${view.subjectType ?? NO_VALUE} · ${view.subjectId ?? NO_VALUE}`
                      : null
                  }
                />
              </Field>
              <Field label="Moderated">
                <Text variant="bodySmall" style={TABULAR}>
                  {view.moderatedAt ? formatAgo(view.moderatedAt, now) : NO_VALUE}
                </Text>
              </Field>
              <Field label="Next attempt">
                <Text variant="bodySmall" style={TABULAR}>
                  {view.nextAttemptAt
                    ? formatAgo(view.nextAttemptAt, now)
                    : NO_VALUE}
                </Text>
              </Field>
              <Field label="Requeues / attempts">
                <Text variant="bodySmall" style={TABULAR}>
                  {view.requeues} / {view.attempts}
                </Text>
              </Field>
              <Field label="Stored key">
                <Text
                  variant="code"
                  fontSize={11}
                  tone="muted"
                  style={BREAK_ANYWHERE}
                >
                  {view.recordStorageKey ?? NO_VALUE}
                </Text>
              </Field>
              <Field label="Last error">
                {view.lastError ? (
                  <Text
                    variant="caption"
                    color="$danger"
                    style={BREAK_ANYWHERE}
                  >
                    {view.lastError}
                  </Text>
                ) : (
                  <Text variant="bodySmall">{NO_VALUE}</Text>
                )}
              </Field>
            </div>
          )}
        </YStack>
      ) : null}
    </YStack>
  );
}
