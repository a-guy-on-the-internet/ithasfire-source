"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Button,
  Money,
  NextLinkAnchor,
  SegmentedControl,
  Spinner,
  useFormatters,
  useNotify,
} from "@th/ui";
import { ArrowRight, Info } from "lucide-react";

import { useFeatureGates } from "@/hooks/useFeatureGates";
import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";

import { DealTag } from "./ClauseRow";
import { NotSaved, useDealFreeze } from "./DealFreeze";
import type { TellCandidate } from "./deal-names";
import {
  classifyResaleReadError,
  classifyResaleWriteError,
} from "./deal-errors";
import type { DealTarget } from "./deal-model";
import {
  RESALE_EXAMPLE,
  RESALE_NOT_EDITABLE_KEYS,
  formOfClause,
  parseResaleForm,
  recipientPortions,
  resaleExample,
  resaleSentenceOf,
  sameResaleClause,
  writeOfView,
  type ResaleClauseRead,
  type ResaleClauseView,
  type ResaleClauseWrite,
  type ResaleForm,
  type ResaleRecipient,
  type ResaleSharePayer,
  type ResaleShareType,
} from "./resale-clause-model";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

export type ResaleClauseProps = {
  /** Whose resale clause: an event, a booking's event, or a group's default. */
  target: DealTarget;
  /** "Change who gets it": the host shows the event's resale payout lines. */
  onChangeRecipients?: () => void;
  /** Where "Open the agreement" goes when a booking holds the clause. */
  agreementHref?: (agreementId: string) => string;
  testIdBase?: string;
};

type Seed = { version: number | null; clause: ResaleClauseView | null };

/**
 * The resale clause inside The deal (organiser-resale-share FR-011, board
 * RC1): a percentage of each resale or a flat amount, paid by the seller or
 * added for the buyer, at most 10% of the sale, split over the event's
 * resale payout lines. Its own read (`deals.getResaleClause`) and write
 * (`deals.setResaleClause`, with `expectedVersion`): a different terms row
 * from the ticket-sales deal around it.
 *
 * Behind the `resale` gate, like every other resale surface.
 */
export function ResaleClause({
  target,
  onChangeRecipients,
  agreementHref,
  testIdBase = "deal",
}: ResaleClauseProps) {
  const { gates } = useFeatureGates();
  // Fail closed while the gates load: no resale surface flashes in.
  if (gates?.resale !== true) return null;
  return (
    <ResaleClauseBody
      target={target}
      onChangeRecipients={onChangeRecipients}
      agreementHref={agreementHref}
      testIdBase={`${testIdBase}-resale`}
    />
  );
}

function ResaleClauseBody({
  target,
  onChangeRecipients,
  agreementHref,
  testIdBase: testId,
}: Required<Pick<ResaleClauseProps, "target" | "testIdBase">> &
  Pick<ResaleClauseProps, "onChangeRecipients" | "agreementHref">) {
  const { t } = useDealWords();
  const titleId = useId();
  const read = trpc.deals.getResaleClause.useQuery(
    { target },
    // It carries the version a save sends as expectedVersion: never serve a
    // cached one on mount.
    { retry: false, staleTime: 0, meta: { silent: true } },
  );

  if (read.error && classifyResaleReadError(read.error) === "NOT_ALLOWED") {
    return null;
  }

  return (
    <section
      className={styles.resale}
      aria-labelledby={titleId}
      data-testid={testId}
      data-state={
        read.data ? (read.data.mayEdit ? "editable" : "read-only") : undefined
      }
    >
      <div className={styles.resaleHead}>
        <h4 id={titleId} className={styles.sectionTitle}>
          {t("deals.resale.title")}
        </h4>
        <DealTag tone="neutral">{t("deals.resale.tag")}</DealTag>
        <span className={`${styles.kicker} ${styles.resaleLimit}`}>
          {t("deals.resale.limit")}
        </span>
      </div>

      {read.isLoading ? (
        <div className={styles.actions} aria-busy>
          <Spinner size="sm" />
          <span className={styles.hint}>{t("deals.resale.loading")}</span>
        </div>
      ) : read.error || !read.data ? (
        <div className={styles.actions} role="status">
          <p className={`${styles.hint} ${styles.dangerText}`}>
            {t("deals.resale.readFailed")}
          </p>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void read.refetch()}
            disabled={read.isFetching}
            testID={`${testId}-retry`}
          >
            {t("deals.retry")}
          </Button>
        </div>
      ) : (
        <ResaleClauseContent
          data={read.data}
          target={target}
          onChangeRecipients={onChangeRecipients}
          agreementHref={agreementHref}
          testId={testId}
        />
      )}
    </section>
  );
}

function ResaleClauseContent({
  data,
  target,
  onChangeRecipients,
  agreementHref,
  testId,
}: {
  data: ResaleClauseRead;
  target: DealTarget;
  onChangeRecipients?: () => void;
  agreementHref?: (agreementId: string) => string;
  testId: string;
}) {
  const { t } = useDealWords();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const amountId = useId();
  const isDefault = target.kind === "ORG_DEFAULT";

  // The clause the form was opened against, and its version: a save sends
  // that version, so a change someone else made since is refused, not lost.
  const [seed, setSeed] = useState<Seed | null>(null);
  const [form, setForm] = useState<ResaleForm>(() => formOfClause(data.clause));
  const [writeError, setWriteError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const seedForm = useMemo(
    () => formOfClause(seed ? seed.clause : data.clause),
    [seed, data.clause],
  );
  const dirty =
    form.type !== seedForm.type ||
    form.payer !== seedForm.payer ||
    form.amountText.trim() !== seedForm.amountText;

  // Seed on the first read, and re-seed when the read's version moves while
  // nothing is typed (someone else's save; our own is written into the cache
  // first, so it arrives already seeded). Only a version CHANGE re-seeds: a
  // read still carrying the old version must not pull the form back. A form
  // with edits in it keeps them; its save is then refused as a conflict and
  // re-seeded.
  const lastVersionRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const moved = lastVersionRef.current !== data.version;
    lastVersionRef.current = data.version;
    if (seed === null || (moved && !dirty)) {
      setSeed({ version: data.version, clause: data.clause });
      setForm(formOfClause(data.clause));
    }
  }, [seed, dirty, data.version, data.clause]);

  const mutation = trpc.deals.setResaleClause.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const busy = saving || mutation.isPending;

  const send = (clause: ResaleClauseWrite | null) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setWriteError(null);
    mutation.mutate(
      {
        target,
        clause,
        expectedVersion: seed ? seed.version : data.version,
      },
      {
        onSuccess: (out) => {
          // The saved clause into the cache first, so the read the form
          // re-seeds from already says what was saved (no snap-back to the
          // old clause while the refetch is in flight).
          utils.deals.getResaleClause.setData({ target }, (d) =>
            d
              ? {
                  ...d,
                  version: out.version,
                  clause: out.clause,
                  payoutTermsId: out.payoutTermsId,
                }
              : d,
          );
          setSeed({ version: out.version, clause: out.clause });
          setForm(formOfClause(out.clause));
          toast.success({
            id: `${testId}-saved`,
            title: t(
              clause === null
                ? "deals.resale.clearedToast"
                : "deals.resale.savedToast",
            ),
          });
          void Promise.all([
            utils.deals.getResaleClause.invalidate({ target }),
            utils.deals.getTermsDeal.invalidate({ target }),
          ]).finally(() => {
            savingRef.current = false;
            setSaving(false);
          });
        },
        onError: (err) => {
          const failure = classifyResaleWriteError(err);
          setWriteError(
            failure.kind === "OTHER"
              ? formatErrorMessage(err, t)
              : t(failure.key),
          );
          const done = () => {
            savingRef.current = false;
            setSaving(false);
          };
          if (failure.kind === "CONFLICT") {
            // Load the clause as it is now and start the form over from it.
            void utils.deals.getResaleClause
              .invalidate({ target })
              .then(() => setSeed(null))
              .finally(done);
          } else {
            done();
          }
        },
      },
    );
  };

  // The frozen deal (freeze-the-deal FR-010): read-only while frozen; while
  // the frozen terms change, the edit rides the editor's one save.
  const freeze = useDealFreeze();
  const phase = isDefault ? "open" : (freeze?.phase ?? "open");
  const changing = phase === "changing";

  const parsed = parseResaleForm(form);
  const showFieldError = form.amountText.trim() !== "" && !parsed.ok;
  const editable = data.mayEdit && phase !== "frozen";
  const saved: ResaleClauseWrite | null = data.clause
    ? writeOfView(data.clause)
    : null;
  // What the sentence and example describe: the clause being typed while it
  // parses, else the one on file.
  const shown: ResaleClauseWrite | null =
    editable && parsed.ok ? parsed.clause : saved;
  // A clause with nobody to receive it is refused (AGREEMENT_MISSING_LINES);
  // a default composes its recipients per event.
  const hasRecipients = isDefault || (data.recipients?.length ?? 0) > 0;
  const canSave =
    editable &&
    hasRecipients &&
    dirty &&
    parsed.ok &&
    !sameResaleClause(seed ? seed.clause : data.clause, parsed.clause);
  const resaleOn = (data.resaleOnTicketTypes ?? 0) > 0;

  // Changing the frozen terms: report the edit (and who receives the share)
  // to the editor, and give it the send. Leaving the change drops the edit.
  const changedClause = changing && editable && dirty;
  const pendingAfter =
    changedClause && parsed.ok && !sameResaleClause(seed ? seed.clause : data.clause, parsed.clause)
      ? parsed.clause
      : null;
  const sentenceText = useResaleSentenceText();
  const pendingBefore = saved ? sentenceText(saved) : null;
  const pendingAfterText = pendingAfter ? sentenceText(pendingAfter) : null;
  const pendingValid = changedClause ? parsed.ok && hasRecipients : true;
  const setResalePending = freeze?.setResalePending;
  useEffect(() => {
    if (!setResalePending) return;
    if (!changedClause) {
      setResalePending(null);
      return;
    }
    setResalePending({
      beforeText: pendingBefore,
      afterText: pendingAfterText ?? "",
      valid: pendingValid && pendingAfterText !== null,
    });
  }, [setResalePending, changedClause, pendingBefore, pendingAfterText, pendingValid]);
  useEffect(() => () => setResalePending?.(null), [setResalePending]);
  const recipientsKey = JSON.stringify(
    (data.recipients ?? []).map((r) => ({ kind: r.kind, name: r.name })),
  );
  const setResaleRecipients = freeze?.setResaleRecipients;
  useEffect(() => {
    setResaleRecipients?.(JSON.parse(recipientsKey) as TellCandidate[]);
  }, [setResaleRecipients, recipientsKey]);
  const resaleSend = freeze?.resaleSend;
  const sendRef = useRef<() => Promise<void>>(async () => undefined);
  sendRef.current = async () => {
    if (!pendingAfter) return;
    let out: Awaited<ReturnType<typeof mutation.mutateAsync>>;
    try {
      out = await mutation.mutateAsync({
        target,
        clause: pendingAfter,
        expectedVersion: seed ? seed.version : data.version,
        frozenChange: true,
      });
    } catch (err) {
      if (classifyResaleWriteError(err).kind === "CONFLICT") {
        // Someone else saved the share first: load theirs and re-base on
        // its version, keeping what was typed, so the next "Save and tell
        // them" is checked against the share as it is now.
        await utils.deals.getResaleClause.invalidate({ target });
        const fresh = utils.deals.getResaleClause.getData({ target });
        setSeed(
          fresh ? { version: fresh.version, clause: fresh.clause } : null,
        );
      }
      throw err;
    }
    utils.deals.getResaleClause.setData({ target }, (d) =>
      d
        ? {
            ...d,
            version: out.version,
            clause: out.clause,
            payoutTermsId: out.payoutTermsId,
          }
        : d,
    );
    setSeed({ version: out.version, clause: out.clause });
    setForm(formOfClause(out.clause));
  };
  useEffect(() => {
    if (!resaleSend) return;
    resaleSend.current = () => sendRef.current();
    return () => {
      resaleSend.current = null;
    };
  }, [resaleSend]);
  // Discarding the change (or leaving it after a save) puts the form back
  // on the share as it is now, never on a seed a conflict left behind.
  const liveRef = useRef(data);
  liveRef.current = data;
  const wasChangingRef = useRef(changing);
  useEffect(() => {
    if (wasChangingRef.current && !changing) {
      const live = liveRef.current;
      setSeed({ version: live.version, clause: live.clause });
      setForm(formOfClause(live.clause));
      setWriteError(null);
    }
    wasChangingRef.current = changing;
  }, [changing]);

  // Nobody receives it yet: said under "Who gets it", beside the link that
  // fixes it, not as a lock notice.
  const noRecipientsYet = data.notEditableReason === "no_recipients_yet";
  const reasonKey =
    data.notEditableReason && !noRecipientsYet
      ? RESALE_NOT_EDITABLE_KEYS[data.notEditableReason]
      : null;

  return (
    <>
      {pendingAfter && pendingBefore ? (
        <p className={styles.termsLine}>
          <s className={`${styles.was} ${styles.termsWas}`}>
            <span className={styles.srOnly}>{t("deals.history.before")} </span>
            {pendingBefore}
          </s>
        </p>
      ) : null}
      {shown ? (
        <Sentence clause={shown} />
      ) : (
        <p className={styles.blockBody} data-testid={`${testId}-not-set`}>
          {t(
            !editable
              ? "deals.resale.notSetReadOnly"
              : isDefault
                ? "deals.resale.notSetDefault"
                : "deals.resale.notSetEvent",
          )}
        </p>
      )}

      {pendingAfter ? <NotSaved testId={`${testId}-not-saved`} /> : null}

      {reasonKey ? (
        <div className={styles.notice} data-testid={`${testId}-read-only`}>
          <Info size={16} strokeWidth={2} aria-hidden />
          <span>
            {t(reasonKey)}{" "}
            {data.notEditableReason === "resale_owned_by_booking" &&
            data.agreementId &&
            agreementHref ? (
              <NextLinkAnchor
                className={styles.link}
                href={agreementHref(data.agreementId)}
                data-testid={`${testId}-agreement-link`}
              >
                {t("deals.resale.openAgreement")}
                <ArrowRight size={16} strokeWidth={2.5} aria-hidden />
              </NextLinkAnchor>
            ) : null}
          </span>
        </div>
      ) : null}

      {editable ? (
        <form
          className={styles.resaleFields}
          aria-label={t("deals.resale.title")}
          // @th/ui Buttons render type="submit"; every button acts on press.
          onSubmit={(e) => e.preventDefault()}
          data-testid={`${testId}-form`}
        >
          <div className={styles.field}>
            <span className={styles.kicker}>{t("deals.resale.type")}</span>
            <SegmentedControl<ResaleShareType>
              fullWidth
              equalSegments
              value={form.type}
              onChange={(type) => {
                if (type === form.type) return;
                setForm((f) => ({ ...f, type, amountText: "" }));
                setWriteError(null);
              }}
              ariaLabel={t("deals.resale.type")}
              disabled={busy}
              options={[
                { value: "PERCENT", label: t("deals.resale.typePercent") },
                { value: "FLAT", label: t("deals.resale.typeFlat") },
              ]}
              testIdBase={`${testId}-type`}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.kicker} htmlFor={amountId}>
              {t("deals.resale.amount")}
              <span className={styles.srOnly}>
                {" "}
                {t(
                  form.type === "PERCENT"
                    ? "deals.resale.amountPercentLabel"
                    : "deals.resale.amountFlatLabel",
                )}
              </span>
            </label>
            <div className={styles.affixed}>
              {form.type === "FLAT" ? (
                <span className={styles.affix} aria-hidden>
                  $
                </span>
              ) : null}
              <input
                id={amountId}
                inputMode="decimal"
                autoComplete="off"
                value={form.amountText}
                disabled={busy}
                aria-invalid={showFieldError ? true : undefined}
                aria-describedby={`${amountId}-hint${showFieldError ? ` ${amountId}-err` : ""}`}
                onChange={(e) => {
                  const amountText = e.target.value;
                  setForm((f) => ({ ...f, amountText }));
                  setWriteError(null);
                }}
                data-testid={`${testId}-amount`}
              />
              {form.type === "PERCENT" ? (
                <span className={styles.affix} aria-hidden>
                  %
                </span>
              ) : null}
            </div>
            <p id={`${amountId}-hint`} className={styles.hint}>
              {t(
                form.type === "PERCENT"
                  ? "deals.resale.percentHint"
                  : "deals.resale.flatHint",
              )}
            </p>
            {showFieldError && !parsed.ok ? (
              <p id={`${amountId}-err`} className={styles.fieldError}>
                {t(`deals.resale.errors.${parsed.error}`)}
              </p>
            ) : null}
          </div>

          <div className={styles.field}>
            <span className={styles.kicker}>{t("deals.resale.payer")}</span>
            <SegmentedControl<ResaleSharePayer>
              fullWidth
              equalSegments
              value={form.payer}
              onChange={(payer) => {
                setForm((f) => ({ ...f, payer }));
                setWriteError(null);
              }}
              ariaLabel={t("deals.resale.payer")}
              disabled={busy}
              options={[
                { value: "SELLER", label: t("deals.resale.payerSeller") },
                { value: "BUYER", label: t("deals.resale.payerBuyer") },
              ]}
              testIdBase={`${testId}-payer`}
            />
            <p className={styles.hint}>{t("deals.resale.payerHint")}</p>
          </div>
        </form>
      ) : null}

      {!isDefault && data.recipients !== null ? (
        <Recipients
          recipients={data.recipients}
          emptyKey={
            // Ask someone to choose only where they can: this page has the
            // way to the lines. The booking page has none (its RESALE lines
            // are the event's), so it says where they are set instead.
            (editable || noRecipientsYet) && onChangeRecipients
              ? "deals.resale.noRecipients"
              : noRecipientsYet && target.kind === "BOOKING_AGREEMENT"
                ? "deals.resale.noRecipientsBooking"
                : "deals.resale.noRecipientsReadOnly"
          }
          onChange={editable || noRecipientsYet ? onChangeRecipients : undefined}
          changeBlocked={dirty}
          testId={testId}
        />
      ) : null}

      {shown ? (
        <Example
          clause={shown}
          recipients={isDefault ? null : data.recipients}
          testId={testId}
        />
      ) : null}

      <p className={`${styles.hint} ${styles.resaleFoot}`}>
        {t("deals.resale.firstSale")}
      </p>
      {target.kind === "BOOKING_AGREEMENT" ? (
        <p className={styles.hint}>{t("deals.resale.bookingNote")}</p>
      ) : null}

      {writeError ? (
        <div
          className={`${styles.block} ${styles.blockDanger}`}
          role="alert"
          data-testid={`${testId}-write-error`}
        >
          <p className={`${styles.blockBody} ${styles.dangerText}`}>
            {writeError}
          </p>
        </div>
      ) : null}

      {editable && !changing ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="$3"
            onPress={() => {
              if (canSave && parsed.ok) send(parsed.clause);
            }}
            disabled={!canSave || busy}
            testID={`${testId}-save`}
          >
            {t("deals.resale.save")}
          </Button>
          {dirty ? (
            <Button
              variant="ghost"
              size="$3"
              onPress={() => {
                setForm(seedForm);
                setWriteError(null);
              }}
              disabled={busy}
              testID={`${testId}-reset`}
            >
              {t("deals.resale.reset")}
            </Button>
          ) : saved ? (
            <Button
              variant="ghost"
              size="$3"
              onPress={() => send(null)}
              disabled={busy || resaleOn}
              aria-describedby={resaleOn ? `${testId}-clear-blocked` : undefined}
              testID={`${testId}-clear`}
            >
              {t("deals.resale.clear")}
            </Button>
          ) : null}
          {busy ? <Spinner size="sm" /> : null}
        </div>
      ) : null}
      {editable && !changing && !dirty && saved && resaleOn ? (
        <p
          id={`${testId}-clear-blocked`}
          className={styles.hint}
          data-testid={`${testId}-clear-blocked`}
        >
          {t("deals.resale.clearBlocked")}
        </p>
      ) : null}
    </>
  );
}

function Sentence({ clause }: { clause: ResaleClauseWrite }) {
  const { t } = useDealWords();
  const fmt = useFormatters();
  const s = resaleSentenceOf(clause);
  return (
    <p className={styles.resaleSentence}>
      <strong>
        {t(s.mainKey, {
          // "7,5" in Spanish: the locale's decimal separator.
          percent:
            s.percent === ""
              ? ""
              : fmt.number(Number(s.percent), { maximumFractionDigits: 2 }),
          amount: s.amountCents === null ? "" : Money.format(s.amountCents),
        })}
      </strong>{" "}
      {t(s.payerKey)}
    </p>
  );
}

function portionText(
  portion: "all" | number | undefined,
  t: ReturnType<typeof useDealWords>["t"],
  number: ReturnType<typeof useFormatters>["number"],
): string {
  if (portion === undefined) return t("deals.resale.portionVaries");
  if (portion === "all") return t("deals.resale.portionAll");
  return t("deals.resale.percentOfShare", {
    percent: number(portion, { maximumFractionDigits: 1 }),
  });
}

function Recipients({
  recipients,
  emptyKey,
  onChange,
  changeBlocked,
  testId,
}: {
  recipients: readonly ResaleRecipient[];
  /**
   * What to say when nobody receives it. Only a view with the way to the
   * lines asks anyone to choose.
   */
  emptyKey:
    | "deals.resale.noRecipients"
    | "deals.resale.noRecipientsBooking"
    | "deals.resale.noRecipientsReadOnly";
  onChange?: () => void;
  /**
   * The clause form has unsaved edits: leaving for the lines would drop
   * them, so the link waits until they are saved or undone.
   */
  changeBlocked: boolean;
  testId: string;
}) {
  const { t } = useDealWords();
  const fmt = useFormatters();
  // What each line is really paid of the share, not its stored percentage.
  const portions = recipientPortions(recipients);
  return (
    <div className={styles.resaleGroup} data-testid={`${testId}-recipients`}>
      <div className={styles.resaleGroupHead}>
        <span className={styles.kicker}>{t("deals.resale.recipients")}</span>
        {onChange ? (
          <button
            type="button"
            className={`${styles.link} ${styles.linkButton}`}
            onClick={onChange}
            disabled={changeBlocked}
            aria-describedby={
              changeBlocked ? `${testId}-change-blocked` : undefined
            }
            data-testid={`${testId}-change-recipients`}
          >
            {t("deals.resale.changeRecipients")}
          </button>
        ) : null}
      </div>
      {onChange && changeBlocked ? (
        <p
          id={`${testId}-change-blocked`}
          className={styles.hint}
          data-testid={`${testId}-change-blocked`}
        >
          {t("deals.resale.changeBlocked")}
        </p>
      ) : null}
      {recipients.length === 0 ? (
        <p className={styles.hint} data-testid={`${testId}-no-recipients`}>
          {t(emptyKey)}
        </p>
      ) : (
        <ul className={styles.list}>
          {recipients.map((r) => (
            <li
              key={r.lineId}
              className={`${styles.resaleRow} ${styles.resaleRecipient}`}
            >
              <span className={styles.who}>
                <span className={styles.resaleName}>
                  {r.name ?? t("deals.unnamed")}
                </span>
                <span className={styles.whoMeta}>
                  {[
                    r.kind === "org"
                      ? t("deals.kindGroup")
                      : r.kind === "human"
                        ? t("deals.kindPerson")
                        : null,
                    r.ticketTypeId ? t("deals.resale.oneTicketType") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span
                className={styles.resaleAmount}
                data-testid={`${testId}-portion-${r.lineId}`}
              >
                {portionText(portions?.get(r.lineId), t, fmt.number)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Example({
  clause,
  recipients,
  testId,
}: {
  clause: ResaleClauseWrite;
  recipients: readonly ResaleRecipient[] | null;
  testId: string;
}) {
  const { t } = useDealWords();
  const ex = resaleExample(clause, recipients);
  const unnamed = t("deals.unnamed");
  return (
    <div className={styles.resaleExample} data-testid={`${testId}-example`}>
      <span className={styles.kicker}>
        {t("deals.resale.exampleKicker", {
          original: Money.format(RESALE_EXAMPLE.originalCents),
          ask: Money.format(RESALE_EXAMPLE.askCents),
        })}
      </span>
      <ul className={styles.list}>
        <ExampleRow
          label={t("deals.resale.buyerPays")}
          hint={t("deals.resale.buyerPaysHint")}
          cents={ex.buyerPaysCents}
          testId={`${testId}-example-buyer`}
        />
        <ExampleRow
          label={t("deals.resale.sellerReceives")}
          cents={ex.sellerReceivesCents}
          strong
          testId={`${testId}-example-seller`}
        />
        {ex.parts ? (
          ex.parts.map((p) => (
            <ExampleRow
              key={p.lineId}
              label={p.name ?? unnamed}
              cents={p.cents}
            />
          ))
        ) : (
          <ExampleRow
            label={t("deals.resale.toTheNight")}
            cents={ex.shareCents}
            testId={`${testId}-example-share`}
          />
        )}
        <ExampleRow
          label={t("deals.resale.platform")}
          hint={t("deals.resale.platformHint")}
          cents={0}
        />
      </ul>
      {ex.held ? <p className={styles.hint}>{t("deals.resale.heldNote")}</p> : null}
    </div>
  );
}

function ExampleRow({
  label,
  hint,
  cents,
  strong = false,
  testId,
}: {
  label: string;
  hint?: string;
  cents: number;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <li className={styles.resaleRow} data-testid={testId}>
      <span className={styles.who}>
        <span className={strong ? styles.resaleStrong : styles.resaleName}>
          {label}
        </span>
        {hint ? <span className={styles.whoMeta}>{hint}</span> : null}
      </span>
      <span
        className={`${styles.resaleAmount} ${strong ? styles.resaleStrong : ""}`}
      >
        {Money.format(cents)}
      </span>
    </li>
  );
}

/** The clause in plain words, as one string: the "Not saved" row and the footer. */
function useResaleSentenceText() {
  const { t } = useDealWords();
  const fmt = useFormatters();
  return (clause: ResaleClauseWrite): string => {
    const s = resaleSentenceOf(clause);
    return `${t(s.mainKey, {
      percent:
        s.percent === ""
          ? ""
          : fmt.number(Number(s.percent), { maximumFractionDigits: 2 }),
      amount: s.amountCents === null ? "" : Money.format(s.amountCents),
    })} ${t(s.payerKey)}`;
  };
}
