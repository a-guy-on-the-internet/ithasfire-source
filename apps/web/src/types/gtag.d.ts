/**
 * Extends the global `Window` interface with the Google Tag Manager
 * `dataLayer` array used by gtag.js / Google Analytics.
 */
interface Window {
  dataLayer?: IArguments[];
}
