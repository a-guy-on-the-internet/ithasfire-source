# Android release keystore (Ithas Fire)

Which key signs the Android builds, where to read each fingerprint, and where each fingerprint must be registered.

| App | Package (`android.package` in `app.config.ts`) | EAS credentials |
| --- | --- | --- |
| Consumer app, `apps/mobile` | `com.ithasfire` | `credentialsSource: "remote"` in `eas.json` `build.production.android` |
| Scanner, `apps/scanner` | `com.ithasfire.scan` | not set, so EAS's default, `remote` |

## Two keys per app

- **Upload key.** EAS holds it (`remote` credentials, the default for every profile) and signs every Android build with it: the `production` AABs and the `development` / `preview` APKs alike, unless the EAS project keeps separate build credentials per profile. Read it with `cd apps/<mobile|scanner> && eas credentials -p android`, then the production keystore's SHA‑1 and SHA‑256.
- **App-signing key.** With Play App Signing, Google re-signs what users install with its own key. Read it in Play Console → the app → **Test and release → Setup → App integrity** (older consoles: **Setup → App integrity**).

## Where each fingerprint goes

- **Google OAuth Android client** (Google Cloud Console → APIs & Services → Credentials, package name as above, SHA‑1): register the **app-signing** fingerprint, which is what store installs present, and the upload key's for builds installed outside Play. Its client id reaches Terraform as `TF_VAR_google_android_client_id` (`infra/terraform/oauth.tf`).
- **`apps/web/public/.well-known/assetlinks.json`** (passkeys, App Links): SHA‑256. Read `docs/runbooks/passkey-testing.md` before changing it; a wrong fingerprint breaks verification for the whole file.

## `scripts/generate-android-keystore-and-store.sh`

The script makes a self-signed PKCS#12 keystore with OpenSSL (no JDK), prints its SHA‑1 and SHA‑256, and with `--store` writes it to Secret Manager as **`th-<env>-android-release-keystore`** and **`th-<env>-android-release-keystore-password`**, in whatever project `gcloud config get-value project` returns (or `PROJECT_ID`). `--env` defaults to `dev`; its Terraform auto-detection looks for `infra/scripts/tf.sh`, which doesn't exist (`tf.sh` is at `infra/terraform/scripts/tf.sh`), so `--env` is what decides.

Nothing in the repo reads those secrets, and EAS doesn't use the keystore unless someone uploads it with `eas credentials`. This page's first version (commit 4cd642497) recorded one run that stored `th-dev-*` in the pre-rename project `tickethunter-476820`; later find-and-replace renames changed the page to `hf-dev-*` in `hearthfire-491918`, names the script never writes.

The script's default output, `./keystores/`, is gitignored.

