/**
 * Country & region data, powered by the `country-state-city` library.
 *
 * Centralised here so every surface (checkout, admin, place editors, etc.)
 * references one canonical list and avoids hand-rolled data.
 */
import { Country, State } from "country-state-city";

export type StateOption = { code: string; name: string };
export type CountryOption = { code: string; name: string };

/**
 * Full country list in {code, name} shape.
 * US is moved to the front since it's the primary market.
 */
export const COUNTRIES: CountryOption[] = (() => {
  const list: CountryOption[] = Country.getAllCountries().map((c) => ({
    code: c.isoCode,
    name: c.name,
  }));
  const usIdx = list.findIndex((c) => c.code === "US");
  if (usIdx > 0) {
    const [us] = list.splice(usIdx, 1);
    list.unshift(us!);
  }
  return list;
})();

/** Return states / regions for a given ISO-3166-1 country code. */
export function getRegionsForCountry(countryCode: string): StateOption[] {
  return State.getStatesOfCountry(countryCode).map((s) => ({
    code: s.isoCode,
    name: s.name,
  }));
}

/** Resolve an ISO-3166-1 country code to its display name, or return the code as-is. */
export function getCountryName(countryCode: string): string {
  const country = Country.getCountryByCode(countryCode);
  return country?.name ?? countryCode;
}

/** Resolve an ISO-3166-2 state code + country code to its display name. */
export function getStateName(stateCode: string, countryCode: string): string {
  const state = State.getStateByCodeAndCountry(stateCode, countryCode);
  return state?.name ?? stateCode;
}
