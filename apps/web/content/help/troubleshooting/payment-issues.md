---
title: "Payment issues"
description: "Card declines, pending charges, 3-D Secure, and double charges."
category: "troubleshooting"
order: 1
tags: ["payment", "declined", "stripe", "3ds"]
related:
  ["buying-tickets/how-to-buy", "buying-tickets/refunds-and-cancellations"]
---

Most payment issues are bank-side blocks or small data errors. Here's how to diagnose and fix them in order.

## Card declined

Check in this order:

1. **Card details** — double-check number, expiry, CVC, and billing postcode. One wrong digit is the most common cause.
2. **Bank block** — banks commonly block unfamiliar merchants on the first purchase. Call the number on the back of your card.
3. **Insufficient funds** — especially common with debit cards and prepaid cards.
4. **3-D Secure** — if your bank requires verification, you'll be prompted. Complete the challenge and try again.
5. **Try a wallet method** — Apple Pay, Google Pay, or Cash App Pay often bypass bank blocks.

:::tip
Ask your bank to whitelist "Ithas Fire" or "Stripe" if you plan to buy tickets regularly. That prevents future declines.
:::

## Pending charges

If payment fails but a charge appears on your bank statement:

- It's an **authorisation hold**, not a completed charge
- Holds drop off automatically in 3–7 business days
- No ticket was issued and no money was actually taken

:::warning
If a pending charge is still there after 10 business days, contact your bank directly — they can release the hold manually.
:::

## Double charges

Tried twice quickly and see two pending charges? Only one will settle — the one tied to a successful ticket order. The other drops off in 3–7 business days.

Check [/my-tickets](/my-tickets) to see which purchase actually completed. If you see **two successful orders** there, contact [support@ithasfire.com](mailto:support@ithasfire.com) — we'll refund the duplicate.

## 3-D Secure failures

Some banks reject the first 3DS challenge silently. Try in this order:

1. Close checkout and reopen the event
2. Use a different browser or clear cookies
3. Switch to Apple Pay, Google Pay, or Cash App Pay — they handle 3DS differently

## ACH / US bank account

If you chose **US bank account** as your payment method and see a `requires_action` status, check your email for Stripe's microdeposit verification — you'll enter two small deposit amounts Stripe sends to verify the account.
