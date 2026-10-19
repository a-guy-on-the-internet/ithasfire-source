"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { SegmentedControl } from "@th/ui";
import { Check, Search, User, Users } from "lucide-react";

import { trpc } from "@/trpc";

import { sameRef, type DealPerson } from "./deal-model";
import { useDealWords } from "./use-deal-words";
import styles from "./deals.module.css";

type Scope = "all" | "human" | "organization";

/**
 * "Add payee": the acts already on the bill or lineup first (lineup-v3
 * FR-011), then a search over people AND groups (FR-003: the picker gains
 * orgs). Picking someone hands them to the caller, which opens a clause for
 * them; nothing is written until that clause is saved.
 */
export function PayeePicker({
  suggestions,
  taken,
  onPick,
  disabled,
  testIdBase,
}: {
  suggestions: readonly DealPerson[];
  /** People already in the deal: shown as added, not offered again. */
  taken: readonly DealPerson["ref"][];
  onPick: (person: DealPerson) => void;
  disabled?: boolean;
  testIdBase: string;
}) {
  const { t } = useDealWords();
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(handle);
  }, [query]);

  const types =
    scope === "all" ? (["human", "organization"] as const) : ([scope] as const);
  const search = trpc.search.autocompleteAdmin.useQuery(
    { query: debounced, types: [...types], limit: 8 },
    {
      enabled: debounced.length >= 2,
      staleTime: 15_000,
      meta: { silent: true },
    },
  );

  const results: DealPerson[] = useMemo(() => {
    const out: DealPerson[] = [];
    for (const s of search.data?.suggestions ?? []) {
      if (s.type === "human")
        out.push({ ref: { kind: "human", id: s.humanId }, name: s.title });
      else if (s.type === "organization")
        out.push({ ref: { kind: "org", id: s.orgId }, name: s.title });
    }
    return out;
  }, [search.data]);

  const open = debounced.length >= 2 && query.trim().length >= 2;
  const listed = open && results.length > 0;
  const optionId = (i: number) => `${listId}-option-${i}`;
  const isTaken = (p: DealPerson) => taken.some((r) => sameRef(r, p.ref));

  const pick = (p: DealPerson) => {
    if (isTaken(p)) return;
    onPick(p);
    setQuery("");
    setDebounced("");
  };

  return (
    <div className={styles.addPanel} data-testid={`${testIdBase}-picker`}>
      <h4 className={styles.sectionTitle}>{t("deals.addPayee")}</h4>

      {suggestions.length > 0 ? (
        <div className={styles.chipRow}>
          <span className={styles.kicker}>{t("deals.fromTheBill")}</span>
          {suggestions.map((p) => {
            const added = isTaken(p);
            return (
              <button
                key={`${p.ref.kind}:${p.ref.id}`}
                type="button"
                className={styles.presetButton}
                disabled={disabled || added}
                onClick={() => pick(p)}
                data-testid={`${testIdBase}-suggestion-${p.ref.id}`}
              >
                {p.name}
                {added ? (
                  <>
                    {" "}
                    <Check size={13} strokeWidth={2} aria-hidden />{" "}
                    <span className={styles.stamp}>{t("deals.added")}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.kicker} htmlFor={inputId}>
          {t("deals.searchPayees")}
        </label>
        <div className={styles.actions}>
          <div className={`${styles.searchWrap} ${styles.searchGrow}`}>
            <input
              id={inputId}
              type="search"
              role="combobox"
              aria-expanded={listed}
              aria-controls={listed ? listId : undefined}
              aria-activedescendant={listed ? optionId(active) : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              value={query}
              disabled={disabled}
              placeholder={t("deals.searchPlaceholder")}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (!open || results.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const p = results[active];
                  if (p) pick(p);
                } else if (e.key === "Escape") {
                  setQuery("");
                }
              }}
              data-testid={`${testIdBase}-search`}
            />
            {/* Searching / no one found: a status beside the box, not an option in it. */}
            <p className={styles.srOnly} role="status">
              {open && results.length === 0
                ? search.isFetching
                  ? t("deals.searching")
                  : t("deals.noResults")
                : ""}
            </p>
            {open && results.length === 0 ? (
              <div className={styles.results} aria-hidden>
                <p className={styles.result}>
                  <Search size={15} strokeWidth={2} aria-hidden />
                  {search.isFetching
                    ? t("deals.searching")
                    : t("deals.noResults")}
                </p>
              </div>
            ) : null}
            {listed ? (
              <ul
                id={listId}
                role="listbox"
                aria-label={t("deals.searchPayees")}
                className={styles.results}
              >
                {results.map((p, i) => (
                  <li key={`${p.ref.kind}:${p.ref.id}`} role="none">
                    <button
                      type="button"
                      role="option"
                      id={optionId(i)}
                      tabIndex={-1}
                      aria-selected={i === active}
                      aria-disabled={isTaken(p) || undefined}
                      className={styles.result}
                      onClick={() => pick(p)}
                      disabled={isTaken(p)}
                    >
                      {p.ref.kind === "org" ? (
                        <Users size={15} strokeWidth={2} aria-hidden />
                      ) : (
                        <User size={15} strokeWidth={2} aria-hidden />
                      )}
                      <span>{p.name}</span>
                      <span className={styles.stamp}>
                        {isTaken(p)
                          ? t("deals.added")
                          : p.ref.kind === "org"
                            ? t("deals.kindGroup")
                            : t("deals.kindPerson")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className={styles.scope}>
            <SegmentedControl<Scope>
              wrap
              size="md"
              value={scope}
              onChange={setScope}
              ariaLabel={t("deals.searchScope")}
              options={[
                { value: "all", label: t("deals.scopeAll") },
                { value: "human", label: t("deals.scopePeople") },
                { value: "organization", label: t("deals.scopeGroups") },
              ]}
              testIdBase={`${testIdBase}-scope`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
