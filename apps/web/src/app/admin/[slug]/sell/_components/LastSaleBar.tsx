"use client";

import { useEffect, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Modal, Spinner, Text } from "@th/ui";
import { Undo2 } from "lucide-react";

import { formatCents } from "@/lib/format";
import {
  refundWindowLeftMs,
  type LastSale,
} from "./sell-stage";

/**
 * "Rang that up wrong" — the undo for the sale you just took.
 *
 * There is a 15-minute gate-refund window in the API and, until this, nothing
 * anywhere called it. A mis-tapped **Comp** mints free tickets, marks them
 * SUCCEEDED and auto-admits them in one transaction, and when this was built
 * the only listed escape was the Orders page, whose card refund cannot take a
 * cash or comp sale (`refundFullOrder` refuses an order with no
 * PaymentIntent). So the mistake most likely to happen at a door had no route
 * back. Since door-sales step 9b there are two more, both after this bar's 15
 * minutes: Owners, Admins and Finance refund from the Orders panel's "Refund
 * cash sale", and Owners, Admins and Editors from Sell → Cash taken tonight,
 * each until event end + 7 days (`orgRefundCashSale`).
 *
 * WHO SEES IT. Both refund use cases are `ORG_EDIT_ROLES` — deliberately NOT
 * scanner, because refund authority is separated from selling authority on
 * purpose. So this renders only for Owner/Admin/Editor. A scanner-only
 * operator is not shown a button that would refuse them; the help article
 * tells them to fetch someone, which is the honest answer.
 *
 * WHEN IT DISAPPEARS. On the client's estimate of the window, which is
 * deliberately generous — see `refundWindowLeftMs`. The server decides.
 */
export function LastSaleBar({
  sale,
  canRefund,
  onRefund,
  busy,
}: {
  sale: LastSale;
  canRefund: boolean;
  onRefund: () => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  // Re-render once a second so the remaining time counts down and the bar
  // retires itself without needing a sale to happen first.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const leftMs = refundWindowLeftMs(sale, now);
  if (leftMs <= 0) return null;

  const minutesLeft = Math.ceil(leftMs / 60_000);
  const isComp = sale.tender === "comp";
  const what = `${sale.ticketCount} ${sale.ticketCount === 1 ? "ticket" : "tickets"}`;
  const amountLabel = isComp ? "Comped" : formatCents(sale.amountCents);

  return (
    <>
      <XStack
        gap="$3"
        padding="$3"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        borderWidth={1}
        borderColor="$borderColor"
        backgroundColor="$surfaceMuted"
        data-testid="last-sale-bar"
      >
        <YStack gap="$1" flex={1} minWidth={180}>
          <Text variant="bodySmall" weight="bold">
            Last sale · {amountLabel} · {what}
          </Text>
          <Text variant="caption" tone="muted">
            {canRefund
              ? `Refundable for ${minutesLeft} more ${minutesLeft === 1 ? "minute" : "minutes"}`
              : "Only an owner, admin or editor can reverse this"}
          </Text>
        </YStack>

        {canRefund ? (
          <Button
            variant="secondary"
            size="$3"
            minHeight={44}
            disabled={busy}
            onPress={() => setConfirming(true)}
            data-testid="last-sale-refund"
          >
            <Undo2 size={14} aria-hidden="true" />
            Refund
          </Button>
        ) : null}
      </XStack>

      <Modal
        open={confirming}
        onClose={() => (busy ? undefined : setConfirming(false))}
      >
        <Modal.Panel width={460}>
          <Modal.Header
            title={isComp ? `Take back ${what}?` : `Refund ${amountLabel}?`}
            subtitle={`Last sale · ${what}`}
            onClose={() => setConfirming(false)}
          />
          <Modal.Body gap="$3">
            <Text variant="body">
              {sale.tender === "card"
                ? "The card is refunded and the tickets stop working — including the admission that was granted at the sale. The tickets go back on sale."
                : isComp
                  ? "The tickets stop working, including the admission granted when you comped them. The tickets go back on sale."
                  : "The tickets stop working, including the admission granted at the sale. The tickets go back on sale. Hand the cash back yourself — this records the reversal, it doesn't move money."}
            </Text>
            <Text variant="caption" tone="muted">
              {sale.tender === "card"
                ? "This can't be undone from here."
                : "The till total updates to match. This can't be undone from here."}
            </Text>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              size="$3"
              disabled={busy}
              onPress={() => setConfirming(false)}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              size="$3"
              disabled={busy}
              data-testid="last-sale-refund-confirm"
              onPress={() => {
                setConfirming(false);
                onRefund();
              }}
            >
              {busy ? <Spinner size="small" /> : null}
              {isComp ? "Take them back" : "Refund"}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </>
  );
}
