/**
 * Keeps a door sale from being dropped by navigation.
 *
 * The sale lives in `useDoorSale`, inside the Sell tab. The app shell
 * unmounts a tab on every tab press (`<SlideScreen key={activeScreen}>`), the
 * header's event chip is live on Sell, and Android's back button can finish
 * the activity. Each one used to throw away an open card sale or a key that
 * may hold a sale, and the operator came back to an empty cart with Cash
 * enabled: a double sale.
 *
 * - The Sell screen ATTACHES a live reader of its risk (`useReportSaleGuard`).
 *   It reads the sale's refs, so a tap in the same frame as the press that
 *   created the risk is guarded too.
 * - The app root ASKS before a tab press, an event switch or a hardware back
 *   goes through (`useSaleGuardHost().guard`). "Keep it" stays on the sale.
 *   "Clear it anyway" clears it on purpose (the operator was told what that
 *   means), then navigates.
 * - The host calls `onSaleAtRisk` when a risk first appears (the app pins
 *   the event) and `onSaleIdle` when the Sell screen is idle again or gone
 *   (the app releases that pin). `onRiskChange` gets every risk the screen
 *   commits, null included, with whether it is on the done screen (the
 *   app's hold on an access denial reads it, `use-denial-held-for-sale.ts`).
 * - `clearNow` clears the attached sale the way "Clear it anyway" does,
 *   without asking: for the app, when it must take the Sell screen down. The
 *   risk it cleared is kept as `clearedByApp` for the screen shown instead,
 *   until a Sell screen attaches again, a different operator signs in, or
 *   the app calls `forgetCleared` (the refusal behind it ended).
 * - The CARD-CLEARED notice ("don't take cash for the card sale you cleared") lives
 *   here, in the host, not in the Sell screen: it must survive the Sell
 *   screen unmounting (tab path) and every cart edit, and show on whichever
 *   Sell screen is up next, the same mount included (Android back path).
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BackHandler, Platform } from "react-native";

import type { CardClearedKind, LeaveRisk } from "./sale-attempt";

type GuardEntry = {
  /** Read live at the moment of the tap. */
  getRisk: () => LeaveRisk | null;
  clear: () => void;
};

export type GuardRegistry = {
  attach: (entry: GuardEntry) => void;
  detach: (entry: GuardEntry) => void;
  /**
   * The Sell screen committed a new risk: re-render the confirm, pin. `done`:
   * it is on the done screen (a sale just finished, not moved on yet).
   */
  notify: (risk: LeaveRisk | null, done: boolean) => void;
  /** Browse with an empty cart (or gone): nothing on the till. */
  notifyIdle: (idle: boolean) => void;
  /**
   * The screen's own "Start a new sale": opens the same "Clear this sale?"
   * confirm a tab press does, card warning included. No clear path skips it.
   */
  askToClear: () => void;
};

/** The card-cleared notice, as the Sell screen reads and drives it. */
export type CardClearedNotice = {
  kind: CardClearedKind | null;
  /** The old sale's card total, already formatted, or null if unknown. */
  amount: string | null;
  /**
   * Show it (a new clear). `amount` is the card total the reader was asking
   * for, already formatted. Returns a token for `update`.
   */
  begin: (kind: CardClearedKind, amount?: string | null) => number;
  /** The cancel answered: re-word it, unless it was dismissed or replaced. */
  update: (token: number, kind: CardClearedKind) => void;
  dismiss: () => void;
};

const SaleGuardContext = createContext<GuardRegistry | null>(null);
const CardClearedContext = createContext<CardClearedNotice | null>(null);

export function SaleGuardProvider({
  registry,
  cardCleared,
  children,
}: {
  registry: GuardRegistry;
  cardCleared: CardClearedNotice;
  children?: ReactNode;
}) {
  return createElement(
    SaleGuardContext.Provider,
    { value: registry },
    createElement(CardClearedContext.Provider, { value: cardCleared }, children),
  );
}

/**
 * The Sell screen's side. `getRisk` must read refs (it runs outside render);
 * `risk` and `idle` are the rendered values, sent to the host on change.
 */
export function useReportSaleGuard(args: {
  getRisk: () => LeaveRisk | null;
  risk: LeaveRisk | null;
  idle: boolean;
  /** On the done screen: a sale just finished and the operator hasn't moved on. */
  done?: boolean;
  clear: () => void;
}) {
  const registry = useContext(SaleGuardContext);
  const getRiskRef = useRef(args.getRisk);
  const clearRef = useRef(args.clear);
  useEffect(() => {
    getRiskRef.current = args.getRisk;
    clearRef.current = args.clear;
  });
  useEffect(() => {
    if (!registry) return;
    const entry: GuardEntry = {
      getRisk: () => getRiskRef.current(),
      clear: () => clearRef.current(),
    };
    registry.attach(entry);
    // Unmounted: nothing left to guard.
    return () => registry.detach(entry);
  }, [registry]);
  const done = args.done ?? false;
  useEffect(() => {
    registry?.notify(args.risk, done);
  }, [registry, args.risk, done]);
  useEffect(() => {
    registry?.notifyIdle(args.idle);
  }, [registry, args.idle]);
}

/** The Sell screen's way to ask to clear its sale (inert without a host). */
export function useAskToClearSale(): () => void {
  const registry = useContext(SaleGuardContext);
  return useCallback(() => registry?.askToClear(), [registry]);
}

const NO_NOTICE: CardClearedNotice = {
  kind: null,
  amount: null,
  begin: () => 0,
  update: () => undefined,
  dismiss: () => undefined,
};

/** The card-cleared notice for the Sell screen (inert without a host). */
export function useCardClearedNotice(): CardClearedNotice {
  return useContext(CardClearedContext) ?? NO_NOTICE;
}

export type PendingLeave = {
  risk: LeaveRisk;
  keep: () => void;
  clearAnyway: () => void;
};

/** The app root's side: `guard(go)` runs `go` now, or after a confirm. */
export function useSaleGuardHost(options?: {
  onSaleAtRisk?: () => void;
  onSaleIdle?: () => void;
  /**
   * Every risk the Sell screen commits, `null` included (the done screen,
   * browse), with whether it is on the done screen. A `null` is only passed
   * on when the live risk agrees. `onSaleAtRisk` fires only for a risk.
   */
  onRiskChange?: (risk: LeaveRisk | null, done: boolean) => void;
  /**
   * The signed-in user's id, or null while signed out. A card-cleared notice
   * belongs to the operator who cleared the sale: it is dismissed when a
   * DIFFERENT signed-in id arrives, and kept through a null (a re-sign-in).
   */
  userId?: string | null;
}) {
  const entryRef = useRef<GuardEntry | null>(null);
  const onRiskRef = useRef(options?.onSaleAtRisk);
  const onIdleRef = useRef(options?.onSaleIdle);
  const onRiskChangeRef = useRef(options?.onRiskChange);
  useEffect(() => {
    onRiskRef.current = options?.onSaleAtRisk;
    onIdleRef.current = options?.onSaleIdle;
    onRiskChangeRef.current = options?.onRiskChange;
  });
  // Bumped when the Sell screen's risk changes, so the confirm re-reads it.
  const [committedRisk, setCommittedRisk] = useState<LeaveRisk | null>(null);
  const [asking, setAsking] = useState<{ go: () => void } | null>(null);
  const askingRef = useRef(asking);
  useEffect(() => {
    askingRef.current = asking;
  }, [asking]);

  const askToClearRef = useRef<() => void>(() => undefined);
  const [clearedByApp, setClearedByApp] = useState<LeaveRisk | null>(null);
  const registry = useMemo<GuardRegistry>(
    () => ({
      askToClear: () => askToClearRef.current(),
      attach: (entry) => {
        entryRef.current = entry;
        // The Sell screen is back: what it says about the till takes over.
        setClearedByApp(null);
      },
      detach: (entry) => {
        if (entryRef.current === entry) entryRef.current = null;
        setCommittedRisk(null);
        onIdleRef.current?.();
      },
      notify: (risk, done) => {
        setCommittedRisk(risk);
        // The committed value may lag the live risk by a frame (as in
        // `notifyIdle`): a null while a press is already sending is not news.
        if (risk !== null || entryRef.current?.getRisk() == null) {
          onRiskChangeRef.current?.(risk, done);
        }
        if (risk !== null) onRiskRef.current?.();
      },
      notifyIdle: (idle) => {
        // Not while a press is sending or a card is open: the Sell screen's
        // `idle` is a rendered value and may lag the live risk by a frame.
        if (idle && entryRef.current?.getRisk() == null) onIdleRef.current?.();
      },
    }),
    [],
  );

  // ── The card-cleared notice ────────────────────────────────────────────
  const [notice, setNotice] = useState<{
    token: number;
    kind: CardClearedKind;
    amount: string | null;
  } | null>(null);
  const noticeTokenRef = useRef(0);
  const noticeHeldRef = useRef(false);
  const begin = useCallback((kind: CardClearedKind, amount?: string | null) => {
    noticeTokenRef.current += 1;
    const token = noticeTokenRef.current;
    noticeHeldRef.current = true;
    setNotice({ token, kind, amount: amount ?? null });
    return token;
  }, []);
  // An answer for an older clear, or for a notice since dismissed, is dropped
  // (the token no longer matches). A dismiss also retires the token, so a
  // late answer can't bring a dismissed notice back.
  const update = useCallback((token: number, kind: CardClearedKind) => {
    setNotice((current) =>
      current !== null && current.token === token
        ? { ...current, kind }
        : current,
    );
  }, []);
  const dismiss = useCallback(() => {
    noticeHeldRef.current = false;
    setNotice(null);
  }, []);
  const cardCleared = useMemo<CardClearedNotice>(
    () => ({
      kind: notice?.kind ?? null,
      amount: notice?.amount ?? null,
      begin,
      update,
      dismiss,
    }),
    [notice, begin, update, dismiss],
  );

  // A different operator signed in: the old operator's notice isn't theirs.
  // A sign-out on the way (a 401 mid-shift sets the session to null) is not a
  // different operator: the same one signing back in still needs the notice,
  // so only a change between two non-null ids dismisses it. Holding it through
  // the signed-out stretch can't trap back: the Sell screen isn't attached.
  const userId = options?.userId ?? null;
  const lastSignedInRef = useRef<string | null>(userId);
  useEffect(() => {
    if (userId === null) return;
    const last = lastSignedInRef.current;
    lastSignedInRef.current = userId;
    if (last !== null && last !== userId) {
      dismiss();
      setClearedByApp(null);
    }
  }, [userId, dismiss]);

  // ── Asking ─────────────────────────────────────────────────────────────
  const liveRisk = useCallback(() => entryRef.current?.getRisk() ?? null, []);

  const guard = useCallback(
    (go: () => void) => {
      if (liveRisk() === null) {
        go();
        return;
      }
      setAsking({ go });
    },
    [liveRisk],
  );

  useEffect(() => {
    // Only the confirm: "Clear it anyway" clears, and there is nowhere to go.
    askToClearRef.current = () => guard(() => undefined);
  }, [guard]);

  // The sale moved on while the confirm was up (it reached the done screen,
  // the card closed): nothing is at risk any more, so stop asking. The tap
  // that opened it is dropped, not replayed; the operator taps again.
  useEffect(() => {
    if (asking && committedRisk === null && liveRisk() === null) setAsking(null);
  }, [asking, committedRisk, liveRisk]);

  // Android back. While the confirm is up it means "Keep it". While a sale is
  // at risk it opens the confirm instead of finishing the activity (which
  // unmounts the whole tree, sale included). "Clear it anyway" from a back
  // press only clears; a second back leaves as usual. While a card-cleared
  // notice is held AND the Sell screen is attached (so the notice is on
  // screen with its Dismiss), back is swallowed too: finishing the activity
  // would drop the only thing telling the operator not to take cash. On any
  // other screen the notice isn't shown, so back works as usual there.
  useEffect(() => {
    // Android only: iOS has no back button, and react-native-web logs an
    // error for any BackHandler use.
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (askingRef.current) {
        setAsking(null);
        return true;
      }
      if (liveRisk() !== null) {
        setAsking({ go: () => undefined });
        return true;
      }
      return noticeHeldRef.current && entryRef.current !== null;
    });
    return () => sub.remove();
  }, [liveRisk]);

  // The copy follows the LIVE risk (a "sending" press may since have become
  // an unresolved key).
  const risk = asking ? (liveRisk() ?? committedRisk) : null;
  const pending: PendingLeave | null =
    asking && risk
      ? {
          risk,
          keep: () => setAsking(null),
          clearAnyway: () => {
            setAsking(null);
            entryRef.current?.clear();
            asking.go();
          },
        }
      : null;

  // The app must take the Sell screen down (an access denial held past its
  // cap): clear the sale the way "Clear it anyway" does, so an open card sale
  // gets its cancel and the "don't take cash" notice. A plain unmount does
  // neither. A press still sending or an unresolved key has no cancel: the
  // risk is kept so the next screen can say the sale may have gone through.
  const clearNow = useCallback(() => {
    setAsking(null);
    const entry = entryRef.current;
    if (!entry) return;
    setClearedByApp(entry.getRisk());
    entry.clear();
  }, []);

  const forgetCleared = useCallback(() => setClearedByApp(null), []);

  return {
    registry,
    cardCleared,
    guard,
    pending,
    clearNow,
    clearedByApp,
    forgetCleared,
  };
}
