"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, User, Users } from "lucide-react";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import formStyles from "./RequestToPlayBlock.module.css";
import styles from "./BookingBillEditor.module.css";

/**
 * The bill's Name field (board F1): one input that searches platform people
 * AND groups through `search.autocompleteAdmin` — the same eligibility the
 * create path re-checks for a tagged act (`_shared/taggable-humans.ts`) — and
 * otherwise takes a free-text name. Picking a result makes a TAGGED act;
 * editing the text after a pick drops the pick, so what the field shows is
 * always what will be added.
 *
 * Why not the event builder's `HumanSearchCombobox`: it searches people only,
 * has no ARIA combobox semantics or keyboard selection, and is Tamagui while
 * this form is plain HTML on the entity-page theme vars. Changing it would
 * change the builder; this mirrors its query (debounce, ≥ 2 chars, limit 8)
 * instead.
 *
 * WAI-ARIA 1.2 combobox, list autocomplete: ArrowDown/ArrowUp move the active
 * option (`aria-activedescendant`), Enter picks it, Escape closes. Enter
 * never submits the pitch from here; with no open option it asks the add
 * form to add (`onEnterWithoutPick`).
 */

export type BillActPick = {
  ownerType: "human" | "org";
  ownerId: string;
  name: string;
};

type Suggestion = BillActPick & { key: string; detail: string | null };

const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export function BillActCombobox({
  id,
  labelId,
  value,
  pick,
  onTextChange,
  onPick,
  onEnterWithoutPick,
  excluded,
  describedBy,
  invalid,
  disabled,
}: {
  id: string;
  /** The visible label's id — also names the listbox. */
  labelId: string;
  value: string;
  pick: BillActPick | null;
  /** Typing — the parent drops any pick. */
  onTextChange: (text: string) => void;
  onPick: (pick: BillActPick) => void;
  onEnterWithoutPick: () => void;
  /** Identities never offered: the sender, and acts already on the bill. */
  excluded: ReadonlySet<string>;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations();
  const listId = useId();
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Every deliberate close (blur, Escape, a pick) cancels the pending search
  // too: a debounce that fires AFTER the close would reopen the popup under a
  // field the reader has left — at 320px, over the Link field below it.
  const cancelPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The field emptied — by the reader, or by the add form after "Add to the
  // bill" — or a result was picked: close the popup and drop the last search,
  // so no stale "no one matches" line hangs under an empty input.
  const fieldShort = value.trim().length < MIN_QUERY;
  useEffect(() => {
    if (fieldShort || pick !== null) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setDebounced("");
      setOpen(false);
      setActive(-1);
    }
  }, [fieldShort, pick]);

  const query = debounced.trim();
  const searching = query.length >= MIN_QUERY && pick === null;

  const search = trpc.search.autocompleteAdmin.useQuery(
    { query, types: ["human", "organization"], limit: 8 },
    {
      enabled: searching,
      staleTime: 15_000,
      retry: false,
      meta: { silent: true },
    },
  );

  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    for (const s of search.data?.suggestions ?? []) {
      if (s.type === "human") {
        if (excluded.has(`human:${s.humanId}`)) continue;
        out.push({
          key: `human:${s.humanId}`,
          ownerType: "human",
          ownerId: s.humanId,
          name: s.title,
          detail: s.username ? `@${s.username}` : null,
        });
      } else if (s.type === "organization") {
        if (excluded.has(`org:${s.orgId}`)) continue;
        out.push({
          key: `org:${s.orgId}`,
          ownerType: "org",
          ownerId: s.orgId,
          name: s.title,
          detail: s.subtitle,
        });
      }
    }
    return out;
  }, [search.data, excluded]);

  const showPopup = open && searching;
  const hasOptions = showPopup && !search.isFetching && suggestions.length > 0;
  const activeIndex = hasOptions && active < suggestions.length ? active : -1;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const choose = (s: Suggestion) => {
    onPick({ ownerType: s.ownerType, ownerId: s.ownerId, name: s.name });
    cancelPending();
    setOpen(false);
    setActive(-1);
  };

  const status = !showPopup
    ? null
    : search.isError
      ? String(t("admin.bkBillSearchError"))
      : search.isFetching || search.isPending
        ? String(t("admin.bkBillSearchLoading"))
        : suggestions.length === 0
          ? String(t("admin.bkBillSearchNoResults"))
          : null;

  return (
    <div
      className={styles.comboWrap}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          cancelPending();
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <div className={styles.comboField}>
        <Search
          size={16}
          aria-hidden
          className={`${styles.comboIcon} ${styles.comboSearchIcon}`}
        />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasOptions}
          aria-controls={listId}
          aria-activedescendant={
            activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          maxLength={120}
          disabled={disabled}
          // The input IS the boxed field, like its siblings: the app-wide
          // input reset (globals.css, specificity 0,6,1) paints every native
          // input, so a box drawn by a wrapper doubled up beside it. Inline
          // padding is the one way past that reset to clear the icon.
          className={formStyles.input}
          style={{ paddingLeft: "2.25rem" }}
          value={value}
          placeholder={String(t("admin.bkBillNamePlaceholder"))}
          onChange={(e) => {
            const text = e.target.value;
            onTextChange(text);
            setActive(-1);
            cancelPending();
            timer.current = setTimeout(() => {
              timer.current = null;
              // Belt and braces: only a field that still has focus opens.
              // (Refocusing re-runs the search from `onFocus`.)
              if (inputRef.current !== document.activeElement) return;
              setDebounced(text);
              setOpen(text.trim().length >= MIN_QUERY);
            }, DEBOUNCE_MS);
          }}
          onFocus={() => {
            if (pick === null && value.trim().length >= MIN_QUERY) {
              setDebounced(value);
              setOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open && searching) setOpen(true);
              if (hasOptions) {
                setActive((i) => (i + 1) % suggestions.length);
              }
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (hasOptions) {
                setActive((i) =>
                  i <= 0 ? suggestions.length - 1 : i - 1,
                );
              }
            } else if (e.key === "Enter") {
              // Never submit the whole pitch from the add form.
              e.preventDefault();
              const chosen =
                activeIndex >= 0 ? suggestions[activeIndex] : undefined;
              if (chosen) choose(chosen);
              else onEnterWithoutPick();
            } else if (e.key === "Escape" && (open || timer.current)) {
              // Consumed only while there is a popup (or one about to open)
              // to dismiss; otherwise Escape reaches the dialog as usual.
              e.preventDefault();
              e.stopPropagation();
              cancelPending();
              setOpen(false);
              setActive(-1);
            }
          }}
        />
      </div>

      <div
        className={styles.comboPopup}
        hidden={!hasOptions && status === null}
      >
        {status && (
          <p className={styles.comboStatus} role="status">
            {status}
          </p>
        )}
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          className={styles.comboList}
          hidden={!hasOptions}
        >
          {hasOptions &&
            suggestions.map((s, i) => (
              <li
                key={s.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={styles.comboOption}
                // mousedown, not click: fires before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {s.ownerType === "human" ? (
                  <User size={14} aria-hidden className={styles.comboIcon} />
                ) : (
                  <Users size={14} aria-hidden className={styles.comboIcon} />
                )}
                <span className={styles.comboOptionText}>
                  <span className={styles.comboOptionName}>{s.name}</span>
                  {s.detail && (
                    <span className={styles.comboOptionDetail}>
                      {s.detail}
                    </span>
                  )}
                </span>
                <span className={styles.comboOptionKind}>
                  {String(
                    t(
                      s.ownerType === "human"
                        ? "admin.bkBillResultPerson"
                        : "admin.bkBillResultGroup",
                    ),
                  )}
                </span>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
