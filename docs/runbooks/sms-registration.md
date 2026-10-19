# SMS Registration (AWS)

How Ithas Fire gets US text messages approved and switched on: what to submit to AWS, the reply for the production-access support case, and the steps after approval. Read before touching the AWS SMS console, the `enable_aws` Terraform flag, or the SMS opt-in copy.

Last checked 2026-10-16. AWS facts come from the AWS End User Messaging SMS user guide and pricing page (links at the end); recheck them before submitting if this page is more than a month old.

## Where things stand

- The code sends through SNS `Publish` with `AWS.MM.SMS.OriginationNumber` set to our registered number. With no AWS keys or no number configured, every SMS option stays hidden and phone codes answer 503 (`snsSmsConfig` in `packages/adapters/src/comms/sns-sms-config.ts`).
- Texts go only to US numbers (`isUsSmsNumber` in `packages/ports/src/comms/sms.ts`): no Canada, Caribbean or Pacific territories, no 900 premium or N11 codes. Toll-free and other non-geographic US codes still pass; the US-only protect configuration (step 7) is the rule that actually holds.
- What we text: sign-in and phone-verification codes; volunteer shift reminders (at most 2 per shift, 24 hours and 1 hour before) for people who ticked the box; one text when the hidden location of an event someone is going to is revealed. Nothing else, and never marketing.
- **Two AWS accounts.** The "Hearthfire" console account `724090280106` holds the 10DLC brand "Hearthfire 10DLC Brand" (**Complete**, created 2026-05-18; company "Hearthfire, LLC", website `https://hearthfire.community`, vertical Entertainment) and the May support cases. SMS there is still in the us-east-1 sandbox. Terraform's `terraform-dev` user targets a different account, `513758041680`, which has no registrations or numbers. Read in the console on 2026-10-16.
- **The May "rejection" was a request for more detail.** Both cases (177914643400028, 177914944900018) carry the same thread. The 05-18 message from us was the original request; it cited hearthfire.community and described the phone opt-in as a checkbox. AWS's only answer (05-20) was that it lacked enough information about the use case, with a template to fill in. Nobody replied, so the cases auto-resolved on 05-30. AWS's closing note says to reopen 177914643400028 to continue.

## Decisions for the owner

1. **One AWS account for SMS: `724090280106` (recommended).** The brand, the number, the campaign, the production-access case and the sender IAM user must all be in one account. Point Terraform's AWS provider credentials (`TF_VAR_AWS_ACCESS_KEY_ID` / `TF_VAR_AWS_SECRET_ACCESS_KEY`) at an admin user in `724090280106`, rather than registering a second brand in `513758041680`.
2. **Update the brand's website** from `hearthfire.community` to `https://ithasfire.com` ("Update registration" on the brand). The legal name stays "Hearthfire, LLC"; the owner confirmed on 2026-10-16 that only the product was renamed. An update may send the brand back to review for a day or two, so do it before creating the campaign.
3. **Reopen case 177914643400028** with the reply below, rather than opening a new case. A new case also works if reopening is unavailable.

## Route: one 10DLC campaign

Register one **Low Volume Mixed** 10DLC campaign under the Complete brand, with two sub use cases: **2FA** and **Account Notification**. Request one 10DLC number for it and put that number in both Terraform variables.

Why, over two toll-free numbers:
- The brand, the slow identity-checked part, is already done.
- AWS registers a toll-free number for one use case only, so codes and reminders would need two numbers and two verifications. One Low Volume Mixed campaign carries both.
- On toll-free, a person who replies STOP gets no more sign-in codes until they text START, whatever they do in the app. On 10DLC, a fresh code request counts as a fresh opt-in. Locking someone out of their own sign-in is the outcome to avoid (`docs/pro-social.md`: honest consent, easy STOP, no traps).
- Cost: $2/month for the campaign plus $1/month for the number, against $4/month for two toll-free numbers. Both are small.

Against it: a 10DLC campaign takes up to 4–6 weeks; toll-free verification takes up to 15 business days. If the brand's account can't be used (decision 1), toll-free becomes the faster path. The code needs no change for it: put the codes number in `aws_sms_origination_otp` and the notifications number in `aws_sms_origination_notifications`.

## Owner steps, in order

1. Make the three decisions above.
2. **Deploy the legal pages first.** Reviewers open `https://ithasfire.com/terms` and `https://ithasfire.com/privacy`. They must be public and must show the SMS text from this build (Terms §12; the privacy policy's phone-number and no-sharing passages). Since 2026-09-15 a registration without both URLs is refused.
3. **Take the opt-in screenshots** on a stack with SMS available (dev, with AWS keys and a test number set): Settings → Security → phone number with the consent line; Settings → Notification preferences with the SMS disclosure; an event page's volunteer signup with the "text me" box unticked; a volunteer ask page (`/v/<askId>`) with its box unticked. PNG, under 400 KB each. Opt-in behind a sign-in must be shown by screenshot.
4. **Create the campaign** (End User Messaging SMS → Registrations → Create → US 10DLC campaign) with [the campaign form](#10dlc-campaign-form) below.
5. **Request a 10DLC number** in the same account and region (`us-east-1`) and associate it with the campaign once it's approved.
6. **Reopen case 177914643400028** in account `724090280106` (or open a new one: Service Quotas → AWS End User Messaging SMS → "SMS Production Access", us-east-1) and paste [the case reply](#support-case-reply). In the same case or a second one, ask to raise `TextMessageMonthlySpend` to $100.
7. **Lock it to the US**: create a protect configuration that allows only the United States and set it as the account default. IAM cannot limit destinations, so this is what stops a leaked key texting the world.
8. **Set a spend alarm** in CloudWatch on SMS spend at $25, well below the limit.
9. **Terraform** (dev first, prod after the API is public):
   - GitHub secrets `TF_VAR_AWS_ACCESS_KEY_ID` / `TF_VAR_AWS_SECRET_ACCESS_KEY` for an admin user in account `724090280106` (decision 1).
   - In `infra/terraform/envs/<env>/<env>.tfvars`: `enable_aws = true`, `enable_ses = false`, both `aws_sms_origination_*` set to the 10DLC number in E.164, `aws_sms_monthly_spend_limit` set to what AWS approved (never above it, or the apply fails). If dev and prod share the account, `aws_manage_sms_preferences = true` in one of them only.
   - Apply through the normal deploy. Never by hand.
10. **Two-way STOP/START**, once per number after the apply:
    `aws pinpoint-sms-voice-v2 update-phone-number --phone-number-id <id> --two-way-enabled --two-way-channel-arn <terraform output aws_sms_inbound_topic_arn>`
    The inbound HTTPS subscription is only created while the API is public (`api_allow_unauthenticated = true`), so prod STOP replies reach our ledger after launch. AWS enforces STOP on its own opt-out list either way.
11. **Keywords**: set the HELP reply on the number to `Ithas Fire: help at support@ithasfire.com or ithasfire.com/help. Msg & data rates may apply. Reply STOP to opt out.` Leave STOP to AWS.
12. **Post-approval check** (dev, then prod):
    - Settings → Security → add your own US number → the code arrives from the 10DLC number, starting "Ithas Fire:". This also proves the sender policy's explicit Deny does not block direct-to-phone sends.
    - Reply HELP: the reply above comes back. Reply STOP: no more texts; the app shows the number opted out. Reply START: texts resume.
    - A UK number in the same form is refused with "We can only text US numbers."
    - Sentry shows no `sns.send.failed` or `auth_otp_sms_budget` events.

## Support case reply

Paste this into the reopened case, filling the bracketed campaign items once the campaign is submitted.

> **Company name:** Hearthfire, LLC, doing business as Ithas Fire.
>
> **Company website:** https://ithasfire.com
>
> **Program name:** Ithas Fire account security and event texts
>
> **Program URL (opt-in shown here):** https://ithasfire.com/terms#sms (Terms §12, SMS communications and consent). Privacy policy: https://ithasfire.com/privacy
>
> **Company relationship:** We send only our own messages, about our own service, to our own users. We do not send on behalf of other businesses.
>
> **Requested monthly spend limit:** $100 USD
>
> **Launch date:** As soon as production access is granted.
>
> **Origination identity:** One US 10DLC number on our campaign under the brand "Hearthfire 10DLC Brand" (brand status: Complete). Campaign [ID] submitted [date]; status [status].
>
> **Use case:** Ithas Fire is a website for finding and running live events (concerts, open mics, community nights). People text-opt in for three things: one-time sign-in and phone-verification codes; reminders before a volunteer shift they signed up for (at most 2 per shift, 24 hours and 1 hour before); and one text when the hidden location of an event they are going to is revealed. No marketing or promotional messages are sent by text.
>
> **Opt-in:** Every opt-in is optional and not required to use the service or complete a signup. Phone codes: the person enters their number under Settings → Security and taps SEND CODE beside a notice naming Ithas Fire, the purpose, frequency, "Msg & data rates may apply", STOP and HELP, with links to the Terms and Privacy Policy. Shift reminders: an unticked "Text me a reminder before my shift" box on the volunteer signup, with the same disclosure. Location texts: an SMS switch, off by default, in Notification preferences, with the same disclosure. Screenshots attached.
>
> **Expected volume:** about 170 messages a day on average, peaks of about 500 a day; under 1 message per second.
>
> **Message templates:**
> 1. Codes: `Ithas Fire: your verification code is 123456. Don't share it with anyone.`
> 2. Shift reminder: `Ithas Fire: Reminder: your "Door" shift at Open Mic Night starts tomorrow. Reply STOP to unsubscribe.`
> 3. Location reveal: `Ithas Fire: Location revealed for Basement Show: The Back Room, 123 Main St, Nashville, TN. https://ithasfire.com/events/basement-show`
>
> **URLs in messages:** Codes and shift reminders contain no links. Location texts may include a link to the event on https://ithasfire.com. No link shorteners.
>
> **Opt-out and help:** STOP, and the other standard keywords, are honoured by AWS and also recorded in our own consent ledger through two-way SMS. HELP returns our support address. START re-subscribes.
>
> **Why the domain differs:** Our earlier request (cases 177914643400028 and 177914944900018) cited hearthfire.community. Hearthfire is the company; Ithas Fire is the product, and its site moved from hearthfire.community to ithasfire.com. Same LLC, same EIN; only the product name changed.
>
> **What changed since the earlier request:** This reply fills in every field of your 05-20 template. We also updated the brand's website to ithasfire.com, made every SMS opt-in optional and separate from accepting the Terms, added the carrier-required disclosure at each opt-in point, added a statement to the privacy policy that mobile numbers and SMS consent are never shared with third parties or affiliates for marketing, restricted sending to US numbers, and capped code sends.

The templates match what the code sends (`send-phone-otp.ts`, `send-volunteer-shift-reminders.ts`, the location-revealed SMS in `renderers.ts`); the event link format is an example.

## 10DLC campaign form

| Field | Value |
| --- | --- |
| Campaign description | Ithas Fire sends one-time sign-in and phone-verification codes, reminders before volunteer shifts people sign up for, and one text when the hidden location of an event someone is going to is revealed. All texts are opt-in and transactional. No marketing. |
| Use case | Low Volume Mixed, sub use cases 2FA and Account Notification |
| Vertical | Technology (or Entertainment, if the form lists it) |
| Terms | https://ithasfire.com/terms (§12) |
| Privacy | https://ithasfire.com/privacy |
| Opt-in workflow (40–2048 characters) | Use the "Opt-in" paragraph of the case reply, plus: "Opt-in is behind a sign-in; screenshots are attached." |
| Opt-in screenshot | The PNGs from step 3 |
| Opt-in keyword | None (web opt-in only) |
| HELP response | `Ithas Fire: help at support@ithasfire.com or ithasfire.com/help. Msg & data rates may apply. Reply STOP to opt out.` |
| STOP response | `Ithas Fire: you're unsubscribed and won't get more texts. Reply START to resubscribe.` |
| Sample messages | Templates 1–3 from the case reply |
| Embedded links | Yes (location texts; ithasfire.com only) |
| Embedded phone numbers | No |
| Age-gated content | No |
| Direct lending | No |

## Why the first request failed

AWS did not refuse on substance: on 05-20 it asked for structured detail the request lacked, and nobody replied. The case reply above answers every field of that template. The May request also cited hearthfire.community, which the brand still lists, and described the phone opt-in as a checkbox; today it is a consent line beside SEND CODE. The reply describes today's flow. The common refusal causes in AWS's review criteria, and where this build stands on each:

| Common refusal cause | Where we stand |
| --- | --- |
| Opt-in not shown or not verifiable; opt-in behind a sign-in with no screenshot | Screenshots of every opt-in point go with the submission (step 3). |
| SMS consent bundled into accepting the Terms; texting required to sign up | Every opt-in is a separate, optional action, and each says it is not required. |
| Pre-checked box | Every box starts unticked (`useState(false)`). |
| Privacy policy lacks the no-sharing clause | Privacy now says mobile numbers and SMS consent are not sold or shared with third parties or affiliates for their marketing or promotional purposes. |
| Disclosure missing brand, frequency, rates, STOP/HELP, links | Each opt-in string carries all of them, with links through `SmsLegalLinks`. |
| Samples lack the brand name | Every text starts "Ithas Fire:". |
| Marketing mixed with transactional | The SMS channel is limited to the transactional category; marketing, announcements and organiser messages never text. |
| Name or website doesn't match the brand | Decision 2 (update the brand's website), and the domain explanation in the case reply. |
| Terms URL or privacy URL not reachable | Step 2: deploy before submitting. |

## Costs (AWS pricing, October 2026)

- 10DLC campaign (Low Volume): $2/month. Number: $1/month. Brand: already paid.
- Each text: about $0.012 a segment in the US ($0.00774 plus a $0.00421 carrier fee).
- At 5,000 texts a month: about $60 a month in texts.
- Toll-free alternative: $2/month per number, two numbers.

## Sources

- AWS End User Messaging SMS user guide: [10DLC registration](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-10dlc.html), [campaign fields](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-10dlc-register-campaign.html), [review criteria](https://docs.aws.amazon.com/sms-voice/latest/userguide/registration-help-review-criteria.html), [toll-free rejection reasons](https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-tfn-rejection-reason.html), [sandbox and production access](https://docs.aws.amazon.com/sms-voice/latest/userguide/sandbox.html), [spend limit](https://docs.aws.amazon.com/sms-voice/latest/userguide/awssupport-spend-threshold.html), [two-way SMS](https://docs.aws.amazon.com/sms-voice/latest/userguide/two-way-sms-phone-number.html), [opt-out keywords](https://docs.aws.amazon.com/sms-voice/latest/userguide/opt-out-list-keywords.html), [timelines](https://docs.aws.amazon.com/sms-voice/latest/userguide/registration-eta.html).
- [SNS: sending SMS](https://docs.aws.amazon.com/sns/latest/dg/sms_sending-overview.html) (`AWS.MM.SMS.OriginationNumber`; sender IDs do not show in the US).
- [AWS End User Messaging pricing](https://aws.amazon.com/end-user-messaging/pricing/).
