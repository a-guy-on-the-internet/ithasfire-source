/**
 * Re-export from the canonical shared location module.
 * Keeping this file so existing imports within checkout don't break.
 */
export {
  COUNTRIES,
  getRegionsForCountry,
  getCountryName,
  getStateName,
  type CountryOption,
  type StateOption,
} from "@/lib/location/address-data";
