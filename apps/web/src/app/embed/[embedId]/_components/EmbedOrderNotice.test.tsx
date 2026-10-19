import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/messages/en";
import es from "@/i18n/messages/es";

/**
 * What the embed says about the order behind the payment step: the two
 * notices and the locked Back button. The translator here reads the REAL
 * app catalog, so a key the components ask for that the catalog lacks shows
 * up as the raw key and fails the copy assertions.
 */

type Catalog = Record<string, Record<string, unknown>>;
const lookup = (catalog: Catalog, key: string): string | undefined => {
  const [block, name] = key.split(".");
  const value = catalog[block ?? ""]?.[name ?? ""];
  return typeof value === "string" ? value : undefined;
};
const translate = (key: string, vars?: Record<string, string | number>) =>
  (lookup(en as unknown as Catalog, key) ?? key).replace(
    /\{(\w+)\}/g,
    (_match, name: string) =>
      vars?.[name] === undefined ? `{${name}}` : String(vars[name]),
  );

// Clock times as the app's formatter prints them, pinned to en-US and UTC so
// the expected strings do not depend on the machine running the test.
const clock = (at: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(at));

vi.mock("@th/ui", () => ({
  useTranslations: () => translate,
  useFormatters: () => ({
    dateTime: (value: string, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
        new Date(value),
      ),
  }),
}));

import { EmbedCheckoutHeader } from "./EmbedCheckoutHeader";
import {
  EmbedEarlierOrderNote,
  EmbedOrderNotice,
  EmbedReservedNotice,
} from "./EmbedOrderNotice";

const KEYS = [
  "embedBackLockedPaying",
  "embedBackLockedCreating",
  "embedPaymentNotCompleted",
  "embedOrderChanged",
  "embedNotCharged",
  "embedTicketsReserved",
  "embedReservationRanOut",
  "embedEarlierOrderReserved",
  "embedPaymentOutcomeUnknown",
  "embedCheckoutTimedOut",
  "embedLetTicketsGo",
  "embedLetTicketsGoBusy",
  "embedLetTicketsGoFailed",
  "embedTicketsReleased",
  "embedEarlierOrderReleased",
] as const;

const CHANGED = "You changed your tickets, so we'll start a new order.";
const NOT_CHARGED = "You have not been charged.";
// The latest an order the buyer left can keep its tickets (80 minutes after
// it was created), and when it usually lets go (50 minutes after): see
// embed-reserved-window.test.ts. Neither is the order's 15-minute countdown.
const EARLIER_UNTIL = "2026-10-10T19:20:00.000Z";
const EARLIER = `Tickets from your earlier order usually go back on sale by ${clock("2026-10-10T18:50:00.000Z")} and can stay reserved until ${clock(EARLIER_UNTIL)}, so they may show as unavailable until then.`;
const CHECK_EMAIL =
  "We could not confirm whether your payment went through. Check your email before trying again.";
const RAN_OUT =
  "Your reservation ran out. Continue to reserve your tickets again; they may no longer be available.";
const RELEASED = "Your tickets are back on sale.";
const EARLIER_RELEASED = "The tickets from your earlier order are back on sale.";
const LET_GO = "Let these tickets go";
const LET_GO_BUSY = "Letting them go…";
const LET_GO_FAILED =
  "We couldn't let these tickets go just now. They are still reserved for you.";

describe("the embed order copy in the app catalog", () => {
  it("English reads as agreed ('reserved', never 'hold')", () => {
    const checkout = (en as unknown as Catalog).checkout ?? {};
    expect(checkout.embedBackLockedPaying).toBe(
      "Your payment is processing. You can go back when it finishes.",
    );
    expect(
      `${String(checkout.embedOrderChanged)} ${String(checkout.embedNotCharged)}`,
    ).toBe(`${CHANGED} ${NOT_CHARGED}`);
    // Changing the tickets releases these ones, so no clock times here.
    expect(checkout.embedTicketsReserved).toBe(
      "Your tickets are reserved for the next {countdown}. If you change them, you start a new order and these go back on sale.",
    );
    expect(checkout.embedLetTicketsGo).toBe(LET_GO);
    expect(checkout.embedLetTicketsGoBusy).toBe(LET_GO_BUSY);
    expect(checkout.embedLetTicketsGoFailed).toBe(LET_GO_FAILED);
    expect(checkout.embedTicketsReleased).toBe(RELEASED);
    expect(checkout.embedEarlierOrderReleased).toBe(EARLIER_RELEASED);
    // The buyer is on the event or on the details form, never on a ticket
    // picker they could "select again" from: the next step is Continue.
    expect(checkout.embedReservationRanOut).toBe(RAN_OUT);
    expect(checkout.embedEarlierOrderReserved).toBe(
      "Tickets from your earlier order usually go back on sale by {typicalTime} and can stay reserved until {latestTime}, so they may show as unavailable until then.",
    );
    expect(checkout.embedPaymentOutcomeUnknown).toBe(CHECK_EMAIL);
    expect(checkout.embedPaymentNotCompleted).toBe(
      "Payment could not be completed. Please try again.",
    );
    expect(checkout.embedBackLockedCreating).toBe(
      "Your order is being created. You can go back when it finishes.",
    );
    expect(checkout.embedCheckoutTimedOut).toBe(
      "This is taking longer than expected. Try again.",
    );
    for (const key of KEYS) {
      expect(String(checkout[key]).toLowerCase(), key).not.toContain("hold");
    }
  });

  it("Spanish has every key, translated, with the same argument", () => {
    const enCheckout = (en as unknown as Catalog).checkout ?? {};
    const esCheckout = (es as unknown as Catalog).checkout ?? {};
    for (const key of KEYS) {
      expect(typeof esCheckout[key], key).toBe("string");
      expect(esCheckout[key], key).not.toBe(enCheckout[key]);
    }
    expect(esCheckout.embedTicketsReserved).toContain("{countdown}");
    expect(esCheckout.embedReservationRanOut).toBe(
      "Tu reserva expiró. Continúa para reservar tus entradas de nuevo; puede que ya no estén disponibles.",
    );
    expect(esCheckout.embedEarlierOrderReserved).toBe(
      "Las entradas de tu pedido anterior suelen volver a la venta antes de las {typicalTime} y pueden seguir reservadas hasta las {latestTime}, así que pueden aparecer como no disponibles hasta entonces.",
    );
    expect(esCheckout.embedTicketsReserved).toBe(
      "Tus entradas están reservadas durante los próximos {countdown}. Si las cambias, inicias un pedido nuevo y estas vuelven a la venta.",
    );
    expect(esCheckout.embedTicketsReserved).not.toContain("{typicalTime}");
    expect(esCheckout.embedLetTicketsGo).toBe("Liberar estas entradas");
    expect(esCheckout.embedLetTicketsGoBusy).toBe("Liberándolas…");
    expect(esCheckout.embedLetTicketsGoFailed).toBe(
      "No pudimos liberar estas entradas por ahora. Siguen reservadas para ti.",
    );
    expect(esCheckout.embedTicketsReleased).toBe(
      "Tus entradas vuelven a estar a la venta.",
    );
    expect(esCheckout.embedEarlierOrderReleased).toBe(
      "Las entradas de tu pedido anterior vuelven a estar a la venta.",
    );
    expect(esCheckout.embedPaymentNotCompleted).toBe(
      "No se pudo completar el pago. Inténtalo de nuevo.",
    );
    expect(esCheckout.embedBackLockedCreating).toBe(
      "Tu pedido se está creando. Podrás volver cuando termine.",
    );
  });
});

describe("EmbedOrderNotice — why the order the buyer had is gone", () => {
  const notice = (
    kind: "changed" | "expired" | "released" | null,
    mayHaveBeenCharged: boolean,
    earlierOrderReserved: boolean,
  ) =>
    render(
      <EmbedOrderNotice
        kind={kind}
        mayHaveBeenCharged={mayHaveBeenCharged}
        earlierReservedUntil={earlierOrderReserved ? EARLIER_UNTIL : null}
      />,
    );

  it("a reservation that ran out while an EARLIER order is known paid and nothing is unknown: no 'we could not confirm' (the widget's banner says the earlier payment went through)", () => {
    render(
      <EmbedOrderNotice
        kind="expired"
        mayHaveBeenCharged
        outcomeUnknown={false}
        earlierReservedUntil={null}
      />,
    );
    const said = screen.getByRole("status").textContent ?? "";
    expect(said).toContain("Your reservation ran out.");
    expect(said).not.toContain("We could not confirm");
  });

  it("a changed cart while an earlier order is known paid: still never 'You have not been charged'", () => {
    render(
      <EmbedOrderNotice
        kind="changed"
        mayHaveBeenCharged
        outcomeUnknown={false}
        earlierReservedUntil={null}
      />,
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "You have not been charged",
    );
  });

  it("the two times are on the clock: when the order usually lets go, and the latest it can", () => {
    // 30 minutes apart (one clean-up period), the later one as handed in.
    expect(EARLIER).toContain("by 6:50");
    expect(EARLIER).toContain("until 7:20");
  });

  it("a changed cart: a new order, no charge was taken, and the earlier order's tickets stay reserved", () => {
    notice("changed", false, true);
    expect(screen.getByRole("status").textContent).toBe(
      `${CHANGED} ${NOT_CHARGED} ${EARLIER}`,
    );
  });

  it("the earlier order's reservation is said only while it has time left", () => {
    notice("changed", false, false);
    expect(screen.getByRole("status").textContent).toBe(
      `${CHANGED} ${NOT_CHARGED}`,
    );
  });

  it("a changed cart after a payment nobody could confirm: never 'you have not been charged'", () => {
    notice("changed", true, true);
    expect(screen.getByRole("status").textContent).toBe(
      `${CHANGED} ${EARLIER}`,
    );
  });

  it("a reservation that ran out: Continue reserves again, and the tickets may be gone", () => {
    notice("expired", false, false);
    expect(screen.getByRole("status").textContent).toBe(RAN_OUT);
  });

  it("a reservation that ran out with its payment unsettled: the invitation to reserve again comes with 'check your email'", () => {
    notice("expired", true, false);
    expect(screen.getByRole("status").textContent).toBe(
      `${RAN_OUT} ${CHECK_EMAIL}`,
    );
  });

  it("a reservation that ran out while its order still holds the tickets: the buyer's own order may be why they are unavailable", () => {
    notice("expired", false, true);
    expect(screen.getByRole("status").textContent).toBe(
      `${RAN_OUT} ${EARLIER}`,
    );
  });

  it("back on an event whose order was left behind: only what is still true of it", () => {
    notice(null, false, true);
    expect(screen.getByRole("status").textContent).toBe(EARLIER);
  });

  it("nothing to say: nothing rendered", () => {
    notice(null, false, false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("beside a refused checkout: the same sentence, by itself", () => {
    render(<EmbedEarlierOrderNote reservedUntil={EARLIER_UNTIL} />);
    expect(screen.getByRole("status").textContent).toBe(EARLIER);
  });

  it("a time that cannot be read is not printed", () => {
    render(<EmbedEarlierOrderNote reservedUntil="not a date" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tickets the buyer let go: back on sale, and no charge was taken", () => {
    notice("released", false, false);
    expect(screen.getByRole("status").textContent).toBe(
      `${RELEASED} ${NOT_CHARGED}`,
    );
  });

  it("tickets the buyer let go after a payment nobody could confirm on another order: never 'you have not been charged'", () => {
    notice("released", true, false);
    expect(screen.getByRole("status").textContent).toBe(RELEASED);
  });

  it("an earlier order that was released: its tickets are back on sale, said after why the order is gone", () => {
    render(
      <EmbedOrderNotice
        kind="changed"
        mayHaveBeenCharged={false}
        earlierReservedUntil={null}
        earlierReleased
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      `${CHANGED} ${NOT_CHARGED} ${EARLIER_RELEASED}`,
    );
  });

  it("an earlier order that was released, with nothing else to say: that sentence alone", () => {
    render(
      <EmbedOrderNotice
        kind={null}
        mayHaveBeenCharged={false}
        earlierReservedUntil={null}
        earlierReleased
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(EARLIER_RELEASED);
  });

  it("takes focus from a script (the control that was pressed is gone) and is no tab stop", () => {
    const noticeRef = { current: null as HTMLParagraphElement | null };
    render(
      <EmbedOrderNotice
        kind="released"
        mayHaveBeenCharged={false}
        earlierReservedUntil={null}
        noticeRef={noticeRef}
      />,
    );
    const status = screen.getByRole("status");
    expect(noticeRef.current).toBe(status);
    expect(status.getAttribute("tabindex")).toBe("-1");

    noticeRef.current?.focus();

    expect(document.activeElement).toBe(status);
  });
});

describe("EmbedReservedNotice — an order waiting while the buyer looks at the event again", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T18:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const RESERVED =
    /^Your tickets are reserved for the next (\d+:\d\d)\. If you change them, you start a new order and these go back on sale\.$/;
  const UNTIL = "2026-10-10T18:09:30.000Z";
  const sentence = () => screen.getByText(/^Your tickets are reserved/);
  const letGo = () => screen.getByRole("button");

  it("counts down the order's time to pay, and says a change puts these back on sale", async () => {
    render(<EmbedReservedNotice reservedUntil={UNTIL} />);
    const text = () => sentence().textContent ?? "";
    expect(text()).toBe(
      "Your tickets are reserved for the next 9:30. If you change them, you start a new order and these go back on sale.",
    );
    expect(text()).toMatch(RESERVED);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(text()).toContain("8:59");
  });

  it("without the control (an order a payment may have gone through on): the sentence, no button, no live region", () => {
    render(<EmbedReservedNotice reservedUntil={UNTIL} />);
    expect(sentence()).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the control: a real button, named for what it does, that calls back once per press", () => {
    const onLetGo = vi.fn();
    render(<EmbedReservedNotice reservedUntil={UNTIL} onLetGo={onLetGo} />);

    expect(letGo().tagName).toBe("BUTTON");
    expect(letGo().getAttribute("type")).toBe("button");
    expect(letGo().textContent).toBe(LET_GO);
    expect(letGo().getAttribute("aria-disabled")).toBeNull();
    // A touch target, on the button and not on the sentence.
    expect(Number.parseFloat(letGo().style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(sentence().style.minHeight).toBe("");

    fireEvent.click(letGo());

    expect(onLetGo).toHaveBeenCalledTimes(1);
  });

  it("hands the widget the button itself (`letGoRef`): what the widget compares with the focused element to move focus on after a release", () => {
    // EmbedWidget.test.tsx mocks this component and relies on exactly this:
    // the ref is the pressed button, with or without a release out.
    const letGoRef = { current: null as HTMLButtonElement | null };
    const { rerender } = render(
      <EmbedReservedNotice
        reservedUntil={UNTIL}
        onLetGo={() => undefined}
        letGoRef={letGoRef}
      />,
    );
    expect(letGoRef.current).toBe(letGo());
    letGo().focus();
    expect(document.activeElement).toBe(letGoRef.current);

    rerender(
      <EmbedReservedNotice
        reservedUntil={UNTIL}
        onLetGo={() => undefined}
        lettingGo
        letGoRef={letGoRef}
      />,
    );

    // The same node, still focused, while the release is out.
    expect(letGoRef.current).toBe(letGo());
    expect(document.activeElement).toBe(letGoRef.current);
  });

  it("the real notices carry focus from the button to the sentence, as the widget does it", () => {
    // The widget's own rule, on the real components: focus moves when the
    // focused element IS the button (`letGoRef`), to `noticeRef`.
    const letGoRef = { current: null as HTMLButtonElement | null };
    const noticeRef = { current: null as HTMLParagraphElement | null };
    const { rerender } = render(
      <EmbedReservedNotice
        reservedUntil={UNTIL}
        onLetGo={() => undefined}
        lettingGo
        letGoRef={letGoRef}
      />,
    );
    letGo().focus();
    const wasOnTheButton = document.activeElement === letGoRef.current;
    expect(wasOnTheButton).toBe(true);

    // Released: the reserved notice goes, the order notice comes.
    rerender(
      <EmbedOrderNotice
        kind="released"
        mayHaveBeenCharged={false}
        earlierReservedUntil={null}
        noticeRef={noticeRef}
      />,
    );
    expect(document.activeElement).toBe(document.body);
    noticeRef.current?.focus();

    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(screen.getByRole("status").textContent).toBe(
      `${RELEASED} ${NOT_CHARGED}`,
    );
  });

  it("while the release is out: the button says so, is aria-disabled (not disabled, so it keeps focus) and takes no second press", () => {
    const onLetGo = vi.fn();
    render(
      <EmbedReservedNotice reservedUntil={UNTIL} onLetGo={onLetGo} lettingGo />,
    );

    expect(letGo().textContent).toBe(LET_GO_BUSY);
    expect(letGo().getAttribute("aria-disabled")).toBe("true");
    expect((letGo() as HTMLButtonElement).disabled).toBe(false);
    letGo().focus();
    expect(document.activeElement).toBe(letGo());

    fireEvent.click(letGo());
    fireEvent.click(letGo());

    expect(onLetGo).not.toHaveBeenCalled();
  });

  it("a release that did not happen: said in a live region that was already in the page, and the button is there to press again", () => {
    const onLetGo = vi.fn();
    const { rerender } = render(
      <EmbedReservedNotice reservedUntil={UNTIL} onLetGo={onLetGo} lettingGo />,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");

    rerender(
      <EmbedReservedNotice reservedUntil={UNTIL} onLetGo={onLetGo} letGoFailed />,
    );

    // The same node: a screen reader announces text arriving in a region it
    // already knows.
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe(LET_GO_FAILED);
    expect(letGo().textContent).toBe(LET_GO);
    expect(letGo().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(letGo());
    expect(onLetGo).toHaveBeenCalledTimes(1);

    // Pressed again: the old failure is not said over the new attempt.
    rerender(
      <EmbedReservedNotice
        reservedUntil={UNTIL}
        onLetGo={onLetGo}
        lettingGo
        letGoFailed
      />,
    );
    expect(region.textContent).toBe("");
  });

  it("the countdown is in no live region, with the control there too: only the failure line is announced", async () => {
    render(
      <EmbedReservedNotice reservedUntil={UNTIL} onLetGo={() => undefined} />,
    );
    const region = screen.getByRole("status");
    const before = sentence().textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(sentence().textContent).not.toBe(before);
    expect(sentence().closest("[role], [aria-live]")).toBeNull();
    expect(region.contains(sentence())).toBe(false);
    expect(region.textContent).toBe("");
    // Nor is the button inside it: its label changing is not an announcement.
    expect(region.contains(letGo())).toBe(false);
  });

  it("is not a live region: text that changes every second would be read out every second", async () => {
    render(<EmbedReservedNotice reservedUntil="2026-10-10T18:09:30.000Z" />);
    const before = screen.getByText(/^Your tickets are reserved/).textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const notice = screen.getByText(/^Your tickets are reserved/);
    // It did change, and nothing announces it.
    expect(notice.textContent).not.toBe(before);
    expect(screen.queryByRole("status")).toBeNull();
    expect(notice.closest("[role], [aria-live]")).toBeNull();
  });

  it("says nothing once the time is up (the widget discards the order then), or with no time at all", async () => {
    const { rerender } = render(
      <EmbedReservedNotice reservedUntil="2026-10-10T18:00:02.000Z" />,
    );
    expect(screen.getByText(/^Your tickets are reserved/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByText(/^Your tickets are reserved/)).toBeNull();

    rerender(<EmbedReservedNotice reservedUntil={null} />);
    expect(screen.queryByText(/^Your tickets are reserved/)).toBeNull();
  });
});

describe("EmbedCheckoutHeader — Back while an order is created or paid", () => {
  const back = () => screen.getByRole("button", { name: "Back" });
  const header = (props: {
    onBack?: () => void;
    isCreating?: boolean;
    isPaying?: boolean;
    isConfirming?: boolean;
    onPaymentStep?: boolean;
  }) => (
    <EmbedCheckoutHeader
      onBack={props.onBack ?? (() => undefined)}
      isCreating={props.isCreating ?? false}
      isPaying={props.isPaying ?? false}
      isConfirming={props.isConfirming}
      onPaymentStep={props.onPaymentStep ?? false}
    />
  );

  it("idle: Back goes back, and the live region is there with nothing in it", () => {
    const onBack = vi.fn();
    render(header({ onBack }));

    fireEvent.click(back());

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(back().getAttribute("aria-disabled")).toBeNull();
    expect(back().getAttribute("aria-describedby")).toBeNull();
    const note = screen.getByRole("status");
    expect(note.textContent).toBe("");
    // Takes no room on the details step.
    expect(Number.parseFloat(note.style.minHeight)).toBe(0);
  });

  it.each([
    ["with the payment form still in flight", true],
    ["with the payment form idle (Stripe was asked at expiry)", false],
  ])(
    "while the server is asked about a paid order (%s): Back does nothing, stays focusable, and says the ORDER is being confirmed",
    (_what, isPaying) => {
      const onBack = vi.fn();
      render(
        header({ onBack, isPaying, isConfirming: true, onPaymentStep: true }),
      );

      fireEvent.click(back());

      expect(onBack).not.toHaveBeenCalled();
      expect(back().getAttribute("aria-disabled")).toBe("true");
      expect((back() as HTMLButtonElement).disabled).toBe(false);
      const note = screen.getByRole("status");
      // The payment is done; "your payment is processing" would be wrong.
      expect(note.textContent).toBe(
        "We are confirming your order. You can go back when it finishes.",
      );
      expect(back().getAttribute("aria-describedby")).toBe(note.id);
    },
  );

  it("while a payment confirms: Back does nothing, stays focusable, and says why", () => {
    const onBack = vi.fn();
    render(header({ onBack, isPaying: true, onPaymentStep: true }));

    fireEvent.click(back());

    expect(onBack).not.toHaveBeenCalled();
    expect(back().getAttribute("aria-disabled")).toBe("true");
    // Not the native attribute: a disabled button drops out of the tab order
    // and its description is never read.
    expect((back() as HTMLButtonElement).disabled).toBe(false);
    const note = screen.getByRole("status");
    expect(note.textContent).toBe(
      "Your payment is processing. You can go back when it finishes.",
    );
    expect(back().getAttribute("aria-describedby")).toBe(note.id);
  });

  it("the reason arrives in a region that was already in the page, in a space already held for it", () => {
    const { rerender } = render(header({ onPaymentStep: true }));
    const before = screen.getByRole("status");
    expect(before.textContent).toBe("");
    const heldHeight = before.style.minHeight;
    expect(heldHeight).toBe("34px");

    rerender(header({ onPaymentStep: true, isPaying: true }));

    const during = screen.getByRole("status");
    // The same node: a screen reader announces text arriving in a region it
    // knows, and the form below does not move.
    expect(during).toBe(before);
    expect(during.textContent).not.toBe("");
    expect(during.style.minHeight).toBe(heldHeight);

    rerender(header({ onPaymentStep: true }));
    expect(screen.getByRole("status")).toBe(before);
    expect(before.textContent).toBe("");
  });

  it("while the order is being created: Back does nothing (its answer must not land on another cart), and says why without moving the form", () => {
    const onBack = vi.fn();
    render(header({ onBack, isCreating: true }));

    fireEvent.click(back());

    expect(onBack).not.toHaveBeenCalled();
    expect(back().getAttribute("aria-disabled")).toBe("true");
    // The reason is the button's description, from an element that takes no
    // room: nothing is printed above the details form.
    const reason = document.getElementById(
      back().getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe(
      "Your order is being created. You can go back when it finishes.",
    );
    expect(reason?.hidden).toBe(true);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(Number.parseFloat(region.style.minHeight)).toBe(0);
  });
});
