---
title: "Security and passwords"
description: "Change your password, enable 2FA, and manage account security."
category: "account"
order: 2
tags: ["password", "security", "2fa", "oauth"]
related: ["account/edit-your-profile", "troubleshooting/faq"]
---

Security settings live on their own page at [/account/settings/security](/account/settings/security) — **Settings → Security** in the settings navigation. Not every option is available to every account: OAuth-only accounts see fewer controls.

## Change your password

1. Open **Settings → Security**.
2. Click **Change password**.
3. Enter your current password, then the new one twice.
4. Click **Save**. You can tick **Sign out other sessions** to revoke any other devices at the same time.

Minimum password length is 8 characters.

## Reset a forgotten password

On the [sign-in page](/sign-in), click **Forgot password**. Enter your email and we'll send a reset link. On the reset page you'll set a new password.

:::tip
If you signed up with Google or Apple, you can use the same forgot-password flow to create a password for your account. After that, you can sign in either way.
:::

## Two-factor authentication (2FA)

Ithas Fire supports **TOTP-based 2FA** — any standard authenticator app (Google Authenticator, 1Password, Authy, etc.) works.

**To enable:**

1. Open **Settings → Security**.
2. Click **Enable two-factor**.
3. Scan the QR code (or copy the setup secret) into your authenticator app.
4. Enter the 6-digit code to confirm.
5. Save the **backup codes** shown next — you'll need them if you lose access to your authenticator.

:::warning
Accounts that signed up with Google or Apple only (no password set) can't enable 2FA on Ithas Fire — use the 2FA built into your Google or Apple account instead.
:::

**To disable or regenerate backup codes**, return to the same page.

### Signing in with two-factor on

Sign in with your password, then enter the code from your authenticator app. Without your app, choose **Email code** (shown as **Email / SMS code** when texts are offered) under **Other verification methods** and click **Send code**. The code goes to your verified phone number by text if you have one (US numbers only), otherwise by email. If the text can't be sent, the code comes by email. Or choose **Backup code**.

A passkey signs you in on its own when your device asks for your PIN, fingerprint or face. A security key that doesn't ask for a PIN can't sign you in.

Signing in without your password, with Google, Apple, or an emailed sign-in code or link, doesn't work for an account with two-factor on. Try Google or Apple and you land back on the sign-in page, asked to use your password or a passkey.

## Account deletion

Open [Settings → Delete account](/account/settings/danger) — pinned to the bottom of the settings navigation — then click **Delete account** and confirm by typing your account email; if your account has a password, you'll also re-enter it. Deletion is immediate. Accounts with purchase or ticket history can't be deleted self-serve — those records are retained for accounting, so contact support if that applies to you.
