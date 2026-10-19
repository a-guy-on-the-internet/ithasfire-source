#!/usr/bin/env node
/**
 * Lists every Stripe webhook endpoint on the account behind STRIPE_SECRET_KEY
 * and reports whether each one is subscribed to the events the API handles.
 *
 * Prints URLs, statuses and event coverage only — never the key.
 *
 *   STRIPE_SECRET_KEY=sk_live_… node scripts/ops/check-stripe-webhook-events.mjs
 *   STRIPE_SECRET_KEY="$(gcloud secrets versions access latest --secret=hf-prod-stripe-secret-key --project=hearthfire-491918)" \
 *     node scripts/ops/check-stripe-webhook-events.mjs
 *
 * Exit 0 when every enabled endpoint covers every required event, 1 otherwise,
 * 2 on a Stripe/API error.
 */

const REQUIRED_EVENTS = [
  // checkout → order finalization
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  // disputes (lifecycle + evidence mirror)
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
  // early fraud warnings — refund inside the window to avoid the dispute
  "radar.early_fraud_warning.created",
  "radar.early_fraud_warning.updated",
];

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set");
  process.exit(2);
}

const res = await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", {
  headers: { Authorization: `Bearer ${key}` },
});
const body = await res.json();
if (!res.ok || body.error) {
  console.error("Stripe error:", body.error?.message ?? res.status);
  process.exit(2);
}

const mode = key.startsWith("sk_live_") ? "LIVE" : "TEST";
console.log(`Account mode: ${mode} — ${body.data.length} endpoint(s)\n`);

let allCovered = true;
for (const ep of body.data) {
  const events = new Set(ep.enabled_events ?? []);
  const wildcard = events.has("*");
  const missing = REQUIRED_EVENTS.filter((e) => !wildcard && !events.has(e));
  const enabled = ep.status === "enabled";
  console.log(`${ep.url}`);
  console.log(`  status: ${ep.status}  livemode: ${ep.livemode}  api_version: ${ep.api_version ?? "account default"}  events: ${wildcard ? "* (all)" : events.size}`);
  if (missing.length === 0) {
    console.log("  coverage: OK");
  } else {
    console.log(`  MISSING: ${missing.join(", ")}`);
    if (enabled) allCovered = false;
  }
  console.log();
}

if (body.data.length === 0) allCovered = false;
console.log(allCovered ? "All enabled endpoints cover the required events." : "ACTION NEEDED: add the missing events in the Stripe dashboard (Developers → Webhooks).");
process.exit(allCovered ? 0 : 1);
