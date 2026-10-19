"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Modal,
  Spinner,
  Text,
  TextInput,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { PoliteRegion, SupportNotice } from "./SaleStates";
import {
  parseManualRatePercent,
  ratePercentText,
  ratePercentWords,
  readManualRateRefusal,
} from "./sell-quote";

/**
 * Enter the event's sales-tax rate by hand while the tax lookup is down
 * (owner board M2). Two steps in one dialog: type the rate, then confirm it
 * shown large and in words, because a rate typed wrong is charged on every
 * sale of the event, online included, until the lookup answers again.
 *
 * The server decides whether an entry is allowed at all: it tries the lookup
 * once more and refuses (MANUAL_TAX_RATE_NOT_ALLOWED, with a reason) when
 * the lookup answers, the event already has a rate, there's no address, or
 * no lookup is configured. Each reason gets its own line, in amber: nothing
 * went wrong, there's just nothing to enter.
 *
 * Shown only to an Owner, Admin or Editor (the quote's refusal says who may);
 * the server checks the role again.
 */
export function ManualTaxRateDialog({
  open,
  eventId,
  eventLabel,
  onClose,
  onSaved,
}: {
  open: boolean;
  eventId: string;
  /** "Low Tide Revue · Fri 10 Oct". */
  eventLabel: string;
  /** Closed for any reason: cancel, saved, or a refusal acknowledged. */
  onClose: () => void;
  /** The rate is stored; the caller refetches the quote. */
  onSaved: (rateBps: number) => void;
}) {
  const t = useTranslations();
  const inputId = useId();
  const helpId = useId();
  const [step, setStep] = useState<"enter" | "confirm">("enter");
  const [raw, setRaw] = useState("");
  const [touched, setTouched] = useState(false);
  // Silent to the global error toast: a refusal here is shown in place, in
  // amber, and isn't a failure.
  const setRate = trpc.events.setManualTaxRate.useMutation({
    meta: { silent: true },
  });

  // Focus follows the step. On open the rate field takes it (the only thing
  // to do here is type); Continue unmounts the focused button, so the
  // confirm step's rate takes it next, rather than focus falling to <body>;
  // Change rate sends it back to the field.
  //
  // TextInput hands back either the raw <input> or a wrapper around it, so
  // resolve to the DOM input (same idiom as IssueCompDialog).
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolveInputRef = useCallback((node: unknown) => {
    const input =
      node instanceof HTMLInputElement
        ? node
        : ((node as HTMLElement | null)?.querySelector?.("input") ?? null);
    inputRef.current = input;
    // The rate reads at display size, as the board draws it. Set inline
    // because nothing else reaches it: a global `input:not(...)` rule in
    // globals.css (specificity 0,6,1) pins every input to 14px and beats
    // Tamagui's font-size classes, and TextInput doesn't forward `style`.
    if (input) input.style.fontSize = "24px";
  }, []);
  const confirmRef = useRef<HTMLElement | null>(null);
  const resolveConfirmRef = useCallback((node: unknown) => {
    confirmRef.current = node instanceof HTMLElement ? node : null;
  }, []);
  useEffect(() => {
    if (!open) return;
    // After the modal has mounted and run its own initial focus.
    const frame = requestAnimationFrame(() => {
      (step === "enter" ? inputRef.current : confirmRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, step]);

  // A fresh dialog every time it opens: a rate half-typed for another
  // refusal must not be one tap from being charged.
  useEffect(() => {
    if (!open) return;
    setStep("enter");
    setRaw("");
    setTouched(false);
    setRate.reset();
    // `setRate` is a new object each render; resetting on open is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rateBps = parseManualRatePercent(raw);
  const showInvalid = touched && raw.trim() !== "" && rateBps === null;
  const refusal = setRate.error ? readManualRateRefusal(setRate.error) : null;
  const busy = setRate.isPending;

  const submit = async () => {
    if (rateBps === null) return;
    try {
      await setRate.mutateAsync({ eventId, rateBps });
      onSaved(rateBps);
      onClose();
    } catch {
      // Rendered from `setRate.error` below.
    }
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Modal open={open} onClose={close}>
      <Modal.Panel width={460}>
        <Modal.Header
          title={
            step === "confirm" && rateBps !== null
              ? `Charge ${ratePercentText(rateBps)}% tax?`
              : "Enter tax rate"
          }
          subtitle={eventLabel}
          onClose={close}
        />

        {step === "enter" ? (
          <>
            <Modal.Body gap="$3">
              <Text
                tag="label"
                variant="overline"
                tone="muted"
                htmlFor={inputId}
              >
                Tax rate
              </Text>
              <XStack
                borderWidth={2}
                borderColor={showInvalid ? "$danger" : "$borderColor"}
                alignItems="stretch"
                // The input inside has no border of its own, so the focus
                // ring lives here: without it the field gave no sign of
                // focus at all.
                focusWithinStyle={{
                  outlineWidth: 2,
                  outlineStyle: "solid",
                  outlineColor: "$accent",
                  outlineOffset: 2,
                }}
              >
                <YStack flex={1} minWidth={0}>
                  <TextInput
                    ref={resolveInputRef}
                    id={inputId}
                    value={raw}
                    onChangeText={(v) => {
                      setRaw(v);
                      setTouched(false);
                    }}
                    onBlur={() => setTouched(true)}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="9.25"
                    aria-describedby={helpId}
                    aria-invalid={showInvalid || undefined}
                    fullWidth
                    borderWidth={0}
                    // One ring, on the wrapper (it spans the % box too): the
                    // input's own accent border would draw a second inside it.
                    focusStyle={{ borderWidth: 0, borderColor: "transparent" }}
                    hoverStyle={{ borderWidth: 0 }}
                    height={52}
                    fontWeight="700"
                    textAlign="right"
                    testId="manual-tax-rate-input"
                    onSubmitEditing={() => {
                      if (rateBps !== null) setStep("confirm");
                      else setTouched(true);
                    }}
                  />
                </YStack>
                <YStack
                  width={52}
                  alignItems="center"
                  justifyContent="center"
                  borderLeftWidth={2}
                  borderColor="$borderColor"
                  aria-hidden
                >
                  <Text variant="h5" weight="bold">
                    %
                  </Text>
                </YStack>
              </XStack>
              <Text
                id={helpId}
                variant="bodySmall"
                tone={showInvalid ? "error" : "muted"}
              >
                {showInvalid
                  ? "Enter a number between 0 and 25, with up to two decimals, for example 9.25."
                  : "The total sales tax rate where the event happens, as a percentage, for example 9.25. Between 0 and 25."}
              </Text>
              <Text variant="bodySmall">
                Every sale of this event uses it, at the door and online. We
                tell the platform team, and when the lookup works again its
                rate takes over.
              </Text>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" size="$3" minHeight={44} onPress={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="$3"
                minHeight={44}
                onPress={() => {
                  if (rateBps !== null) setStep("confirm");
                  else setTouched(true);
                }}
                data-testid="manual-tax-rate-continue"
              >
                Continue
              </Button>
            </Modal.Footer>
          </>
        ) : rateBps !== null ? (
          <>
            <Modal.Body gap="$3">
              {/* Focus lands here on the step change, so a screen reader
                  reads the rate and its words before the buttons. */}
              <YStack
                ref={resolveConfirmRef}
                tabIndex={-1}
                gap="$3"
                focusStyle={{ outlineWidth: 0 }}
                data-testid="manual-tax-rate-confirm-rate"
              >
                <Text
                  variant="display"
                  weight="black"
                  // No `lineHeight` here: react-native-web reads a bare
                  // number as PIXELS, and `lineHeight: 1` collapsed the line
                  // so the rate overprinted the words below it.
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {ratePercentText(rateBps)}%
                </Text>
                <Text variant="bodySmall">
                  {ratePercentWords(rateBps)}, on every sale of this event
                  until the lookup answers again.
                </Text>
              </YStack>
              <Text variant="caption" tone="muted">
                Recorded with your name and the time.
              </Text>
              {/* Mounted with the step, before any answer, so the refusal is
                  announced when it arrives. */}
              <PoliteRegion>
                {refusal ? (
                  <SupportNotice testId="manual-tax-rate-refused">
                    {refusal.message}
                  </SupportNotice>
                ) : null}
              </PoliteRegion>
              {!refusal && setRate.error ? (
                <Text variant="bodySmall" tone="error" role="alert">
                  {formatErrorMessage(setRate.error, t)}
                </Text>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              {refusal ? (
                // Nothing to enter: the only honest action left is to close
                // and go back to the sale (which re-asks for a quote).
                <Button
                  variant="primary"
                  size="$3"
                  minHeight={44}
                  onPress={close}
                  data-testid="manual-tax-rate-close"
                >
                  Close
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="$3"
                    minHeight={44}
                    disabled={busy}
                    onPress={() => {
                      setRate.reset();
                      setStep("enter");
                    }}
                  >
                    Change rate
                  </Button>
                  <Button
                    variant="primary"
                    size="$3"
                    minHeight={44}
                    disabled={busy}
                    onPress={() => void submit()}
                    data-testid="manual-tax-rate-confirm"
                  >
                    {busy ? <Spinner size="small" /> : null}
                    {/* One string: the DS Button lays out each text child
                        as its own item, so "Use", "9.25" and "%" spread
                        apart. */}
                    {`Use ${ratePercentText(rateBps)}%`}
                  </Button>
                </>
              )}
            </Modal.Footer>
          </>
        ) : null}
      </Modal.Panel>
    </Modal>
  );
}
