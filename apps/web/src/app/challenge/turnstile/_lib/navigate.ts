/**
 * Leave for the app. `replace`, not `assign`: the challenge page should not
 * sit in history behind the deep link. A module of its own so tests can
 * observe the hop: jsdom's `window.location` cannot be stubbed.
 */
export const replaceLocation = (url: string): void => {
  window.location.replace(url);
};
