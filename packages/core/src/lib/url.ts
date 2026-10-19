/** Strip trailing slashes from a URL string. */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
