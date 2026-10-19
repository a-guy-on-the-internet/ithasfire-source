/**
 * The notification components ship English defaults and take every word from
 * the host when it has a catalog (apps/web passes Spanish). These pin both
 * halves: host labels reach the DOM, and with no labels the English output is
 * exactly what it was before the props existed.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";

import { AlertsSidebar } from "../AlertsSidebar";
import { NotificationInbox } from "../NotificationInbox";
import {
  NotificationItem,
  timeAgo,
  type NotificationItemData,
} from "../NotificationItem";
import { NotificationAlert } from "../NotificationAlert";
import { NotificationProvider } from "../NotificationProvider";
import { useNotify } from "../useNotify";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function makeNotification(
  over: Partial<NotificationItemData> = {},
): NotificationItemData {
  return {
    id: "n1",
    title: "Payout scheduled",
    body: "A ".repeat(80) + "long body that needs a Show more toggle.",
    kind: "INFO",
    readAt: null,
    action: null,
    createdAt: ago(6 * DAY),
    ...over,
  };
}

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the compact English output byte-identical without a locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(
      [ago(10_000), ago(5 * MIN), ago(3 * HOUR), ago(6 * DAY)].map((d) =>
        timeAgo(d),
      ),
    ).toEqual(["just now", "5m ago", "3h ago", "6d ago"]);
  });

  it("speaks the host's locale through Intl.RelativeTimeFormat", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(
      [ago(10_000), ago(5 * MIN), ago(3 * HOUR), ago(6 * DAY)].map((d) =>
        timeAgo(d, "es"),
      ),
    ).toEqual(["ahora", "hace 5 min", "hace 3 h", "hace 6 d"]);
  });
});

describe("timeAgo without Intl.RelativeTimeFormat", () => {
  const original = Intl.RelativeTimeFormat;
  afterEach(() => {
    Intl.RelativeTimeFormat = original;
    vi.useRealTimers();
  });

  it("falls back to the English form when the runtime lacks it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = undefined;
    expect(timeAgo(ago(6 * DAY), "es")).toBe("6d ago");
  });
});

describe("NotificationItem labels", () => {
  it("renders English by default", () => {
    renderWithProvider(<NotificationItem notification={makeNotification()} />);
    expect(
      screen.getByRole("button", { name: "Dismiss: Payout scheduled" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show more: Payout scheduled" }),
    ).toHaveTextContent("Show more");
  });

  it("takes every word, and the timestamp's locale, from the host", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({
          createdAt: new Date(Date.now() - 6 * DAY),
        })}
        locale="es"
        labels={{
          showMore: "Ver más",
          showLess: "Ver menos",
          showMoreNamed: (s) => `Ver más: ${s}`,
          showLessNamed: (s) => `Ver menos: ${s}`,
          dismissNamed: (s) => `Descartar: ${s}`,
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Descartar: Payout scheduled" }),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("button", {
      name: "Ver más: Payout scheduled",
    });
    expect(toggle).toHaveTextContent("Ver más");
    expect(screen.getByText("hace 6 d")).toBeInTheDocument();

    await user.click(toggle);
    expect(
      screen.getByRole("button", { name: "Ver menos: Payout scheduled" }),
    ).toHaveTextContent("Ver menos");
  });

  it("uses the host's stand-in for a blank subject", () => {
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ title: "  ", body: "  " })}
        labels={{
          genericSubject: "Notificación",
          dismissNamed: (s) => `Descartar: ${s}`,
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Descartar: Notificación" }),
    ).toBeInTheDocument();
  });
});

describe("NotificationInbox labels", () => {
  function inbox(props: Partial<Parameters<typeof NotificationInbox>[0]>) {
    return (
      <NotificationInbox
        notifications={[]}
        activeTab="unread"
        onTabChange={() => {}}
        unreadCount={2}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
        {...props}
      />
    );
  }

  it("renders English by default", () => {
    renderWithProvider(inbox({}));
    expect(
      screen.getByRole("tablist", { name: "Filter notifications" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Unread/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Mark all read" }),
    ).toBeInTheDocument();
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("takes the tabs, mark-all, empty state and load-more from the host, and hands row labels down", () => {
    const { rerender } = renderWithProvider(
      inbox({
        labels: {
          tabs: "Filtrar notificaciones",
          unread: "Sin leer",
          all: "Todas",
          markAllRead: "Marcar todo como leído",
          emptyUnreadTitle: "Todo al día",
        },
      }),
    );
    expect(
      screen.getByRole("tablist", { name: "Filtrar notificaciones" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Sin leer/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Todas" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Marcar todo como leído" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Todo al día")).toBeInTheDocument();

    rerender(
      inbox({
        notifications: [makeNotification()],
        hasMore: true,
        labels: { loadMore: "Cargar más" },
        itemLabels: { dismissNamed: (s) => `Descartar: ${s}` },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Cargar más" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Descartar: Payout scheduled" }),
    ).toBeInTheDocument();
  });
});

describe("AlertsSidebar panel labels", () => {
  it("translates the view tabs and the Activity empty state", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          renderInbox={() => <div />}
          labels={{
            inboxTab: "Bandeja",
            activityTab: "Actividad",
            emptyTitle: "Estás al día",
          }}
        />
      </NotificationProvider>,
    );
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("tab", { name: "Bandeja" }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: /^Actividad/ }));
    expect(within(dialog).getByText("Estás al día")).toBeInTheDocument();
  });

  it("keeps the English tabs and empty state by default", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar platformOverride="web" renderInbox={() => <div />} />
      </NotificationProvider>,
    );
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("tab", { name: "Inbox" }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: /^Activity/ }));
    expect(
      within(dialog).getByText("You're all caught up"),
    ).toBeInTheDocument();
  });
});

describe("NotificationAlert labels", () => {
  function Seeded({ labels }: { labels?: { dismiss?: string } }) {
    const { alert } = useNotify();
    const seeded = useRef(false);
    useEffect(() => {
      if (seeded.current) return;
      seeded.current = true;
      alert.push({ id: "a1", variant: "info", title: "Saved", message: "ok" });
    }, [alert]);
    return <NotificationAlert labels={labels} />;
  }

  it("names the dismiss control from the host, English by default", async () => {
    const { unmount } = renderWithProvider(
      <NotificationProvider>
        <Seeded />
      </NotificationProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Dismiss alert" }),
    ).toBeInTheDocument();
    unmount();

    renderWithProvider(
      <NotificationProvider>
        <Seeded labels={{ dismiss: "Descartar alerta" }} />
      </NotificationProvider>,
    );
    expect(
      await screen.findByRole("button", { name: "Descartar alerta" }),
    ).toBeInTheDocument();
  });
});
