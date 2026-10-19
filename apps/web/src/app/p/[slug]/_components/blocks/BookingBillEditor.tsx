"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "@th/ui";

import { BillActCombobox, type BillActPick } from "./BillActCombobox";
import {
  BOOKING_BILL_LINK_MAX,
  BOOKING_BILL_MAX_ROWS,
  BOOKING_BILL_ROLE_KEYS,
  BOOKING_BILL_ROLE_LABEL_MAX,
  BOOKING_BILL_ROLES,
  billAddRefusal,
  billIndexLabel,
  billRowNames,
  bookingBillRowCount,
  moveBillAct,
  type BookingBillActDraft,
  type BookingBillRole,
} from "./booking-bill.helpers";
import formStyles from "./RequestToPlayBlock.module.css";
import styles from "./BookingBillEditor.module.css";
import standardsStyles from "./BookingStandards.module.css";

/**
 * "The bill" inside the PERFORM pitch's "Your act" section (lineup-booking-
 * requests v3 FR-002 / L12 / L13; owner-picked board F1, the ledger).
 *
 * Optional: an empty bill sends the request from the sender alone. The
 * sender's own act is the "I'm on the bill" switch — never a tag (the server
 * refuses a self tag) — and always sits at position 01 (SELF stays first on
 * create), so only the other acts move. Performer mode gates that row and
 * nothing else (v2 D3): without it the switch is off and disabled, with the
 * panel's one-click enable beside it.
 *
 * Consent (NFR-002): a tagged act reads "Will be asked to join" — it has not
 * joined — and a by-name act reads "By name", never like a linked identity.
 */

export type BillSender = {
  ownerType: "human" | "org";
  ownerId: string;
  performerEnabled: boolean;
};

type AddErrors = { name?: string; link?: string };

let draftSeq = 0;
const nextDraftKey = () => `bill-act-${++draftSeq}`;

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export function BookingBillEditor({
  idBase,
  sender,
  selfName,
  includeSelf,
  onIncludeSelfChange,
  acts,
  onActsChange,
  onEnablePerformerMode,
  enablePending,
  enableError,
  required = false,
  standardMarker = null,
  describedBy,
}: {
  idBase: string;
  /**
   * The place REQUIRES other acts on the bill (venue-booking-standards, BILL):
   * the heading drops its "· Optional".
   */
  required?: boolean;
  /** The standards marker ("Required" / "Suggested" / "Done"), beside the heading. */
  standardMarker?: ReactNode;
  /** The standards marker + line ids, for the bill group's description. */
  describedBy?: string;
  sender: BillSender;
  /** How the sender's own row reads: the act name typed above, else the sender. */
  selfName: string;
  /** Effective value — already false whenever the sender lacks performer mode. */
  includeSelf: boolean;
  onIncludeSelfChange: (next: boolean) => void;
  acts: readonly BookingBillActDraft[];
  onActsChange: (next: BookingBillActDraft[]) => void;
  onEnablePerformerMode: () => void;
  enablePending: boolean;
  enableError: string | null;
}) {
  const t = useTranslations();
  const ids = {
    heading: `${idBase}-bill`,
    self: `${idBase}-bill-self`,
    selfHint: `${idBase}-bill-self-hint`,
    addHeading: `${idBase}-bill-add`,
    name: `${idBase}-bill-name`,
    nameLabel: `${idBase}-bill-name-label`,
    nameHint: `${idBase}-bill-name-hint`,
    nameError: `${idBase}-bill-name-error`,
    link: `${idBase}-bill-link`,
    linkError: `${idBase}-bill-link-error`,
    role: `${idBase}-bill-role`,
    roleName: `${idBase}-bill-role-name`,
  };

  // ── Add form ──────────────────────────────────────────────────────────────
  const [nameText, setNameText] = useState("");
  const [pick, setPick] = useState<BillActPick | null>(null);
  const [link, setLink] = useState("");
  const [role, setRole] = useState<BookingBillRole>("PERFORMER");
  const [roleName, setRoleName] = useState("");
  const [errors, setErrors] = useState<AddErrors>({});
  const [announcement, setAnnouncement] = useState("");

  const rowCount = bookingBillRowCount({ includeSelf, acts });
  const full = rowCount >= BOOKING_BILL_MAX_ROWS;
  const firstActPosition = includeSelf ? 2 : 1;
  const rowNames = billRowNames(acts, firstActPosition);
  const senderRef = { ownerType: sender.ownerType, ownerId: sender.ownerId };

  // Never offer the sender (the switch is how they go on) or a tagged act twice.
  const excluded = useMemo(() => {
    const set = new Set<string>([`${sender.ownerType}:${sender.ownerId}`]);
    for (const act of acts) {
      if (act.kind === "tagged") set.add(`${act.ownerType}:${act.ownerId}`);
    }
    return set;
  }, [acts, sender.ownerType, sender.ownerId]);

  // ── Focus after a move / remove / add ────────────────────────────────────
  // Buttons are keyed by act + action; a moved act keeps keyboard focus on the
  // same control, or the opposite arrow once it reaches an end.
  const controls = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string[] | null>(null);
  const register = (key: string) => (el: HTMLElement | null) => {
    if (el) controls.current.set(key, el);
    else controls.current.delete(key);
  };
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    pendingFocus.current = null;
    for (const key of wanted) {
      const el =
        key === "name"
          ? (document.getElementById(ids.name) as HTMLElement | null)
          : controls.current.get(key);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus();
        return;
      }
    }
  });

  const roleLabelOf = (act: { role: BookingBillRole; customRoleLabel: string }) =>
    act.role === "OTHER" && act.customRoleLabel.trim()
      ? act.customRoleLabel.trim()
      : String(t(BOOKING_BILL_ROLE_KEYS[act.role]));

  const move = (index: number, direction: -1 | 1) => {
    const act = acts[index];
    if (!act) return;
    const next = moveBillAct(acts, index, direction);
    const dir = direction === -1 ? "up" : "down";
    pendingFocus.current = [
      `${act.key}:${dir}`,
      `${act.key}:${dir === "up" ? "down" : "up"}`,
    ];
    onActsChange(next);
    setAnnouncement(
      String(
        t("admin.bkBillMoved", {
          name: act.name,
          position: firstActPosition + index + direction,
        }),
      ),
    );
  };

  const remove = (index: number) => {
    const act = acts[index];
    if (!act) return;
    const after = acts[index + 1] ?? acts[index - 1];
    pendingFocus.current = after ? [`${after.key}:remove`, "name"] : ["name"];
    onActsChange(acts.filter((_, i) => i !== index));
    setAnnouncement(String(t("admin.bkBillRemoved", { name: act.name })));
  };

  const add = () => {
    const name = pick ? pick.name : nameText.trim();
    const url = link.trim();
    const next: AddErrors = {};
    if (!name) next.name = String(t("admin.bkBillErrName"));
    if (
      !pick &&
      url.length > 0 &&
      (url.length > BOOKING_BILL_LINK_MAX || !isHttpUrl(url))
    ) {
      next.link = String(t("admin.bkBillErrLink"));
    }
    if (!next.name) {
      const refusal = billAddRefusal({
        acts,
        candidate: pick
          ? { kind: "tagged", ownerType: pick.ownerType, ownerId: pick.ownerId }
          : { kind: "external", name },
        sender: senderRef,
        rowCount,
      });
      if (refusal === "duplicate") {
        next.name = String(t("admin.bkBillErrDuplicate"));
      } else if (refusal === "self") {
        next.name = String(t("admin.bkBillErrSelf"));
      } else if (refusal === "full") {
        next.name = String(t("admin.bkBillFull"));
      }
    }
    if (next.name || next.link) {
      setErrors(next);
      return;
    }

    const customRoleLabel = role === "OTHER" ? roleName.trim() : "";
    const draft: BookingBillActDraft = pick
      ? {
          key: nextDraftKey(),
          kind: "tagged",
          ownerType: pick.ownerType,
          ownerId: pick.ownerId,
          name,
          role,
          customRoleLabel,
        }
      : {
          key: nextDraftKey(),
          kind: "external",
          name,
          url,
          role,
          customRoleLabel,
        };
    onActsChange([...acts, draft]);
    setAnnouncement(String(t("admin.bkBillAdded", { name })));
    setNameText("");
    setPick(null);
    setLink("");
    setRole("PERFORMER");
    setRoleName("");
    setErrors({});
    pendingFocus.current = ["name"];
  };

  const addOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  const selfToggleDisabled =
    !sender.performerEnabled || (!includeSelf && acts.length >= BOOKING_BILL_MAX_ROWS);
  const nameHint = pick
    ? String(t("admin.bkBillSourceTagged"))
    : nameText.trim()
      ? String(t("admin.bkBillSourceExternal"))
      : null;

  return (
    <div
      className={styles.bill}
      role="group"
      aria-labelledby={ids.heading}
      aria-describedby={describedBy}
    >
      {standardMarker ? (
        <div className={standardsStyles.labelRow}>
          <p className={formStyles.fieldLabel} id={ids.heading}>
            {String(t("admin.bkBillHeading"))}
            {required ? "" : ` · ${String(t("admin.bkFormOptional"))}`}
          </p>
          {standardMarker}
        </div>
      ) : (
        <p className={formStyles.fieldLabel} id={ids.heading}>
          {String(t("admin.bkBillHeading"))} · {String(t("admin.bkFormOptional"))}
        </p>
      )}

      {/* ── I'm on the bill ─────────────────────────────────────────────── */}
      <div className={styles.selfBlock}>
        <label className={formStyles.checkboxRow} htmlFor={ids.self}>
          <input
            id={ids.self}
            type="checkbox"
            className={formStyles.checkbox}
            checked={includeSelf}
            disabled={selfToggleDisabled}
            aria-describedby={ids.selfHint}
            onChange={(e) => onIncludeSelfChange(e.target.checked)}
          />
          <span className={formStyles.checkboxText}>
            <span className={styles.selfLabel}>
              {String(t("admin.bkBillSelfLabel"))}
            </span>
            <span className={formStyles.fieldHint} id={ids.selfHint}>
              {!sender.performerEnabled
                ? String(t("admin.bkBillSelfNeedsPerformerMode"))
                : selfToggleDisabled
                  ? String(t("admin.bkBillFull"))
                  : String(t("admin.bkBillSelfHint"))}
            </span>
          </span>
        </label>
        {!sender.performerEnabled && (
          <div className={styles.enableRow}>
            <button
              type="button"
              className={styles.textAction}
              disabled={enablePending}
              aria-busy={enablePending || undefined}
              onClick={onEnablePerformerMode}
            >
              {String(t("admin.bkEnablePerformerMode"))}
            </button>
            {enableError && (
              <p className={formStyles.errorText} role="alert">
                {enableError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── The ledger ──────────────────────────────────────────────────── */}
      {rowCount > 0 ? (
        <ol
          className={styles.ledger}
          aria-label={String(t("admin.bkBillHeading"))}
        >
          {includeSelf && (
            <li className={`${styles.row} ${styles.rowSelf}`}>
              <span className={styles.index} aria-hidden>
                {billIndexLabel(1)}
              </span>
              <span className={styles.main}>
                <span className={styles.nameLine}>
                  <span className={styles.name}>{selfName}</span>
                  <span className={styles.headlining}>
                    {String(t("admin.bkBillHeadlining"))}
                  </span>
                </span>
                <span className={styles.source}>
                  {String(t("admin.bkBillSourceSelf"))}
                </span>
              </span>
              <span className={styles.badge}>
                {String(t(BOOKING_BILL_ROLE_KEYS.PERFORMER))}
              </span>
            </li>
          )}
          {acts.map((act, i) => {
            const position = firstActPosition + i;
            const label = rowNames[i] ?? act.name;
            // After a sender switch, a tag can now name the sender itself —
            // which the server refuses. Flag the row where it sits.
            const isSender =
              act.kind === "tagged" &&
              act.ownerType === sender.ownerType &&
              act.ownerId === sender.ownerId;
            return (
              <li
                key={act.key}
                className={styles.row}
                data-flagged={isSender || undefined}
              >
                <span className={styles.index} aria-hidden>
                  {billIndexLabel(position)}
                </span>
                <span className={styles.main}>
                  <span className={styles.nameLine}>
                    <span className={styles.name}>{act.name}</span>
                    {position === 1 && (
                      <span className={styles.headlining}>
                        {String(t("admin.bkBillHeadlining"))}
                      </span>
                    )}
                  </span>
                  <span className={styles.source}>
                    {String(
                      t(
                        act.kind === "tagged"
                          ? "admin.bkBillSourceTagged"
                          : "admin.bkBillSourceExternal",
                      ),
                    )}
                  </span>
                  {isSender && (
                    <span className={`${formStyles.errorText} ${styles.rowFlag}`}>
                      {String(t("admin.bkBillRowIsSender"))}
                    </span>
                  )}
                </span>
                <span className={styles.badge}>{roleLabelOf(act)}</span>
                <button
                  type="button"
                  ref={register(`${act.key}:up`)}
                  className={`${styles.iconButton} ${styles.up}`}
                  aria-label={String(t("admin.bkBillMoveUp", { name: label }))}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ChevronUp size={16} strokeWidth={2.4} aria-hidden />
                </button>
                <button
                  type="button"
                  ref={register(`${act.key}:down`)}
                  className={`${styles.iconButton} ${styles.down}`}
                  aria-label={String(t("admin.bkBillMoveDown", { name: label }))}
                  disabled={i === acts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ChevronDown size={16} strokeWidth={2.4} aria-hidden />
                </button>
                <button
                  type="button"
                  ref={register(`${act.key}:remove`)}
                  className={`${styles.iconButton} ${styles.remove}`}
                  aria-label={String(t("admin.bkBillRemove", { name: label }))}
                  onClick={() => remove(i)}
                >
                  <Trash2 size={16} strokeWidth={2} aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={formStyles.fieldHint}>{String(t("admin.bkBillEmpty"))}</p>
      )}

      {/* ── Add an act ──────────────────────────────────────────────────── */}
      <div
        className={styles.add}
        role="group"
        aria-labelledby={ids.addHeading}
      >
        <span className={styles.addHeading} id={ids.addHeading}>
          {String(t("admin.bkBillAddHeading"))}
        </span>
        {full ? (
          <p className={formStyles.fieldHint}>{String(t("admin.bkBillFull"))}</p>
        ) : (
          <div className={styles.addFields}>
            <div className={`${formStyles.fieldGroup} ${styles.addName}`}>
              <label
                className={formStyles.fieldLabel}
                htmlFor={ids.name}
                id={ids.nameLabel}
              >
                {String(t("admin.bkBillNameLabel"))}
              </label>
              <BillActCombobox
                id={ids.name}
                labelId={ids.nameLabel}
                value={pick ? pick.name : nameText}
                pick={pick}
                excluded={excluded}
                invalid={Boolean(errors.name)}
                describedBy={
                  [errors.name ? ids.nameError : null, nameHint ? ids.nameHint : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onTextChange={(text) => {
                  // Editing after a pick drops it: the field always shows
                  // exactly what will be added.
                  setPick(null);
                  setNameText(text);
                  if (errors.name) setErrors((e) => ({ ...e, name: undefined }));
                }}
                onPick={(next) => {
                  setPick(next);
                  setNameText(next.name);
                  setLink("");
                  setErrors({});
                }}
                onEnterWithoutPick={add}
              />
              {nameHint && (
                <p className={formStyles.fieldHint} id={ids.nameHint}>
                  {nameHint}
                </p>
              )}
              {errors.name && (
                <p className={formStyles.errorText} id={ids.nameError}>
                  {errors.name}
                </p>
              )}
            </div>

            {/* A link only means something for a by-name act; a tagged act
                links to its own page. */}
            {!pick && (
              <div className={`${formStyles.fieldGroup} ${styles.addLink}`}>
                <label className={formStyles.fieldLabel} htmlFor={ids.link}>
                  {String(t("admin.bkBillLinkLabel"))} ·{" "}
                  {String(t("admin.bkFormOptional"))}
                </label>
                <input
                  id={ids.link}
                  type="url"
                  inputMode="url"
                  className={formStyles.input}
                  value={link}
                  placeholder="https://"
                  maxLength={BOOKING_BILL_LINK_MAX}
                  aria-invalid={errors.link ? true : undefined}
                  aria-describedby={errors.link ? ids.linkError : undefined}
                  onKeyDown={addOnEnter}
                  onChange={(e) => {
                    setLink(e.target.value);
                    if (errors.link) setErrors((x) => ({ ...x, link: undefined }));
                  }}
                />
                {errors.link && (
                  <p className={formStyles.errorText} id={ids.linkError}>
                    {errors.link}
                  </p>
                )}
              </div>
            )}

            <div className={`${formStyles.fieldGroup} ${styles.addRole}`}>
              <label className={formStyles.fieldLabel} htmlFor={ids.role}>
                {String(t("admin.bkBillRoleLabel"))}
              </label>
              <select
                id={ids.role}
                className={formStyles.select}
                value={role}
                onChange={(e) => {
                  const next = e.target.value as BookingBillRole;
                  setRole(next);
                  if (next !== "OTHER") setRoleName("");
                }}
              >
                {BOOKING_BILL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {String(t(BOOKING_BILL_ROLE_KEYS[r]))}
                  </option>
                ))}
              </select>
            </div>

            {role === "OTHER" && (
              <div className={`${formStyles.fieldGroup} ${styles.addRoleName}`}>
                <label className={formStyles.fieldLabel} htmlFor={ids.roleName}>
                  {String(t("admin.bkBillRoleNameLabel"))} ·{" "}
                  {String(t("admin.bkFormOptional"))}
                </label>
                <input
                  id={ids.roleName}
                  type="text"
                  className={formStyles.input}
                  value={roleName}
                  maxLength={BOOKING_BILL_ROLE_LABEL_MAX}
                  placeholder={String(t("admin.bkBillRoleNamePlaceholder"))}
                  onKeyDown={addOnEnter}
                  onChange={(e) => setRoleName(e.target.value)}
                />
              </div>
            )}

            <button type="button" className={styles.addButton} onClick={add}>
              <Plus size={14} strokeWidth={2.6} aria-hidden />
              {String(t("admin.bkBillAddButton"))}
            </button>
          </div>
        )}
      </div>

      <p className={styles.count}>
        {String(
          t("admin.bkBillCount", { count: rowCount, max: BOOKING_BILL_MAX_ROWS }),
        )}
      </p>

      <p className={styles.srOnly} aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
