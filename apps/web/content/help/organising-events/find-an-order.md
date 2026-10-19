---
title: "Find an order by its order code"
description: "Paste an order code into admin search to jump straight to the order a customer is asking about."
category: "organising-events"
order: 15
tags: ["orders", "organiser", "search", "support", "refunds"]
related:
  [
    "organising-events/payouts-and-settlements",
    "organising-events/issue-comp-tickets",
    "buying-tickets/manage-your-orders",
  ]
---

When a customer emails you about a purchase, they will usually quote an order code — a short run of eight characters like `DB21B2C3`. You can paste that code straight into your group's search to open the order.

## Before you start

Order lookup is limited to members with **Owner**, **Admin**, or **Finance** access. Editors, viewers and scanners can search events, attendees and places, but orders will not appear in their results.

## Find the order

1. Open your group's admin area and go to **Search**, or press <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows) from any admin page.
2. Paste the order code into the search box.
3. The order appears at the top of the results, above events and attendees. Click it to open that order in your orders list.

The code is not case-sensitive, and you can leave the `#` on the front — `#DB21B2C3`, `DB21B2C3` and `db21b2c3` all find the same order.

:::tip
The full order ID — the long `9f2c1d4e-77a1-…` string in the order page's web address — works too. If a customer forwards you a link rather than a code, paste the whole ID.
:::

## Where the code appears

The same eight-character code identifies an order everywhere it is shown, so whatever your customer is reading from, it will match what you search for:

- their confirmation screen at the end of checkout
- their ticket email
- their order page under **My tickets**
- your dashboard's recent orders, your orders list, and the order itself

## Searching your orders list directly

If you are already in **Orders**, the search box there accepts the same order code alongside buyer names and email addresses. This is the more useful route when you want the order in context — beside the other orders for that event — rather than on its own.

## What can go wrong

**Nothing appears.** Results are deliberately silent about why. A code that does not exist, an order belonging to a different group, and a code you do not have access to all look identical — you simply see no order. This is intentional: it stops search being used to work out whether an order exists somewhere you cannot see.

So if a code returns nothing, check it against the customer's own email rather than assuming the order is missing.

**The customer quotes a ten-character code** such as `dbzsucafur`. Orders briefly carried a second, longer code that is no longer used and will not find anything. Ask them for the code shown on their order page now — it will be the eight-character form.

**You have the right code but the wrong group.** Search only ever covers the group you are currently in. If you run more than one group, switch groups and search again.

:::warning
Two orders can, very rarely, share the same eight-character code. When that happens the code alone is not enough to identify one order and no result is shown. Use the full order ID from the customer's link instead.
:::

## Reading the money on an order

A paid order shows two figures. **Buyer paid** is what the buyer was charged, with its lines below it: the ticket price, the platform fee, the processing fee, any tax, and **Credit applied** when an Ithas Fire credit lowered the charge. The ticket price is always shown; the other lines are left out when they are zero. A credit is why **Buyer paid** can be less than what your event is credited. A few older door cash sales have no line-by-line record, so they show the total alone. An order that took no money, such as a cart the buyer left, is headed **Order total** and says **Nothing was charged.** A bank payment that has not settled yet says **Payment still processing.** Neither shows a credit.

**Credited to the event** is what the sale credited your event. On tickets sold since 13 October 2026 that is the full ticket price, because the buyer pays the platform fee on top. On older orders you also see the platform fee that was taken from the price. If your event's payout terms split ticket money between several payees, the order says so, and each payee receives its share of that figure. A free ticket is credited $0.00. A paid order whose credit has not been written yet shows **Not credited yet** and the credit it is expected to get. If the credit cannot be read when you open the order, it shows **Credit could not be loaded**; open the order again later. A door cash sale shows no credit, since you hold that cash yourself. Resales and comps show none either.

## Next steps

Once you have the order open you can issue a refund, resend tickets, or check its settlement status — see [payouts and settlements](/help/organising-events/payouts-and-settlements) for what happens to the money afterwards.

If the buyer has disputed the charge with their card issuer, the refund controls are replaced by a note saying so. You can refund again once the dispute is won. A lost dispute can't be refunded — the cardholder already has the money back. See [refunds and chargebacks](/help/organising-events/payouts-and-settlements#refunds-and-chargebacks).
