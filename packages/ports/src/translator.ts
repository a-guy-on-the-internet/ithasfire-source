/**
 * Machine translation port (category-translations spec, 2026-10-16).
 *
 * Used only to PREFILL staff forms: a suggestion is shown, edited and saved
 * by a person, never written unseen. The production adapter is Google Cloud
 * Translation on the API's existing GCP service account; tests and local dev
 * without credentials use a fake.
 */
export interface TranslatorPort {
  /**
   * Translate `text` from the `source` locale into each of `targets`
   * (BCP-47 language codes, e.g. "en", "es").
   *
   * Resolves to the translations keyed by target locale. A target the
   * service returned nothing for is simply absent from the result. Throws on
   * a transport or service failure; callers that treat translation as
   * optional catch and report it.
   */
  translate(input: {
    text: string;
    source: string;
    targets: string[];
  }): Promise<Record<string, string>>;
}
