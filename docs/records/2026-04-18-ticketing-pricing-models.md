# Event Ticketing Pricing Models — Comprehensive Analysis

**Date:** 2026-04-18
**Source:** Platform pricing pages, industry reports, fee calculators, Stripe/PayPal documentation

---

## The Cost Floor

Every US ticketing platform must clear payment processor costs before earning a cent:

| Processor | Rate | Refund policy | Chargeback fee |
|---|---|---|---|
| **Stripe** | 2.9% + $0.30 (cards), 0.8% capped $5 (ACH) | Keeps all fees on refund | $15 ($15 counter fee added June 2025), waived if won |
| **PayPal** | 2.99% + $0.49 (standard), 3.49% + $0.49 (guest) | Returns percentage, keeps $0.49 | $20 |

**On a $10 ticket:** Stripe takes $0.59 (5.9%)
**On a $25 ticket:** Stripe takes $1.03 (4.1%)
**On a $100 ticket:** Stripe takes $3.20 (3.2%)

The fixed $0.30 makes Stripe regressive on cheap tickets. This is the fundamental constraint of indie ticketing pricing.

## 20 Pricing Models Analyzed

### 1. Percentage + flat fee (Eventbrite)
- 3.7% + $1.79 service + 2.9% processing
- Effective: 21.6% on $10, 13.2% on $25, 8.4% on $100
- Crushing at low price points, uncapped

### 2. Percentage only (DICE)
- ~10-12% organizer commission, $0 buyer fee
- Breaks below $10 (processor fixed cost eats margin)

### 3. Flat fee per ticket (Ticket Tailor)
- $0.85 PAYS, $0.30-$0.52 with credits
- Fair across all price points, revenue doesn't scale with ticket price

### 4. Credit-based / pre-paid (Ticket Tailor credits)
- Buy 500 credits for ~$350 ($0.70/ticket), bulk to $0.30
- Never expire, non-refundable on ticket refunds
- Seated events: 2 credits per ticket

### 5. Monthly SaaS + low per-ticket (Eventify, Checkout Page)
- Breaks below ~20 tickets/month

### 6. Monthly SaaS only, zero per-ticket
- Pure software, works for B2B conferences, not public indie music

### 7. Freemium (Eventbrite, Lu.ma, Ticket Tailor)
- Free events free, paid events charged
- Lu.ma: 5% platform + Stripe free tier, Luma Plus $69/mo = 0%

### 8. Revenue share on total event revenue
- Legally fraught, complex accounting, organizer resents

### 9. Buyer-pays vs organizer-pays
- Post-FTC: optical advantage of passthrough is dead (all-in display required)
- DICE: buyer pays $0 (premium brand position)

### 10. Tiered volume pricing
- Per-ticket fee decreases at volume bands

### 11-20. (Dynamic pricing, white-label, tip/donation models, enterprise)
- Dynamic pricing: brand-toxic post-Springsteen/Swift/LN verdict
- Zeffy tip model: 15-17% pre-checked tip, dark-pattern allegations
- White-label: $7K-$60K/year enterprise contracts

## Platform Fee Benchmarks (on $25 ticket)

| Platform | Total fee (buyer pays) | Ithas Fire advantage |
|---|---|---|
| Eventbrite | $3.44 (13.8%) | Save $2.21/ticket |
| Ticketmaster | ~$7+ (27%+) | Save $5.77/ticket |
| DICE | ~$2.50 (10%) | Save $1.27/ticket |
| Posh | $3.49 (14%) | Save $2.26/ticket |
| Humanitix | $1.52 (6.1%) | Save $0.29/ticket |
| SimpleTix | $1.29 (5.2%) | Comparable |
| Ticket Tailor PAYS | $0.85 (3.4%) | TT slightly cheaper |
| Ticket Tailor credits | $0.52 (2.1%) | TT cheaper at volume |
| **Ithas Fire** | **$1.53 (6.1%)** | — |

## Ithas Fire Decided Fee Structure

### Primary Tickets
- **Processing (refund-protected):** 2.9% + $0.30 (Stripe passthrough)
- **Platform fee:** $0.50 flat
- Buyer sees total all-in price from first display (FTC compliant)

### Donations (ADJUSTABLE tickets)
- **Processing:** 2.9% + $0.30 (Stripe passthrough)
- **Platform fee:** 1% uncapped
- Non-refundable (except organizer cancellation)

### Resale
- Original face value → reseller
- Markup split: configurable % to venue/artist per agreement, remainder to reseller
- Ithas Fire takes $0 on resale (or minimal)
- Organizer sets resale price cap per ticket type

### Free Events
- $0 — no payment intent, no fees

## P&L Scenarios

### Scenario A: Indie venue, 150 shows × 80 attendees × $20 ticket = 12,000 tickets, $240K GMV

| Platform | Annual cost | Effective rate |
|---|---|---|
| Eventbrite | $33,960 | 14.2% |
| DICE | $24,000 | 10.0% |
| Ticket Tailor PAYS | $10,200 | 4.3% |
| Ticket Tailor credits | $6,240 | 2.6% |
| **Ithas Fire ($0.50)** | **$6,000** | **2.5%** |

### Scenario B: 500-cap venue, 200 shows × 350 attendees × $35 ticket = 70,000 tickets, $2.45M GMV

| Platform | Annual cost | Effective rate |
|---|---|---|
| Ticketmaster | $661,500 | 27.0% |
| Eventbrite | $237,300 | 9.7% |
| Ticket Tailor credits | $19,600 | 0.8% |
| **Ithas Fire ($0.50)** | **$35,000** | **1.4%** |

### Scenario C: DIY house show, 12 shows × 25 attendees × $10 ticket = 300 tickets, $3K GMV

| Platform | Annual cost | Effective rate |
|---|---|---|
| Eventbrite | $756 | 25.2% |
| Ticket Tailor | $246 | 8.2% |
| **Ithas Fire ($0.50)** | **$150** | **5.0%** |

## FTC All-In Pricing Compliance

- 16 C.F.R. Part 464, effective May 12, 2025
- Total price (face + all mandatory fees) must be displayed more prominently than any component
- Only government taxes and shipping can be excluded
- Penalties: ~$51,744 per violation
- California SB 478, New York § 25.07(4) add state-layer requirements
- Ticketmaster switched to all-in pricing May 2025, SeatGeek followed
- Ithas Fire should default to all-in display regardless of absorb/passthrough setting

## Refund Economics

- Stripe keeps original processing fees on refund (2.9% + $0.30)
- No additional Stripe fee for refund (on standard pricing)
- Chargeback: $15 + reversed charge amount + counts against 0.9% threshold
- **Refund cost per $25 ticket: $1.03 (already collected in fee)**
- **Chargeback cost per $25 ticket: $41.03 (reversed $25 + $15 dispute + $1.03 processing)**
- Auto-refund on cancellation saves $40/ticket vs letting fans dispute

## Key Recommendation

Ithas Fire's $0.50 flat + Stripe passthrough positions at ~5% effective rate — below Eventbrite (13.8%), DICE (10%), and Posh (14%), slightly above Ticket Tailor credits (2.1%). The transparency of separating "refund-protected processing" from "platform fee" is the brand differentiator. No other platform explains why they charge what they charge.
