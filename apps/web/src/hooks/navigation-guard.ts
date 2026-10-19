/**
 * Page-level navigation guard, for navigations that are not link clicks.
 *
 * `useUnsavedChangesGuard` catches `<a href>` clicks itself, but a lot of
 * the app's chrome navigates from a button: the admin bottom bar, the
 * workspace switcher, the rail's back control, keyboard Enter in the search
 * palette, a notification row. Those call `router.push` directly and would
 * skip the guard, so they send the push through `guardedNavigate` instead.
 * While a page with unsaved edits is mounted it holds the navigation behind
 * its prompt; with no guard registered the navigation runs at once.
 *
 * A stack: the most recently registered guard is the live one, and
 * unregistering removes only its own entry, so an outgoing page unmounting
 * after the incoming one mounted cannot take the new guard down with it.
 * Module state, the same pattern as `spotlight-store.ts`: no provider to
 * thread through the shell.
 */

/** Runs `go` now, or holds it until the user confirms leaving. */
export type NavigationGuard = (go: () => void) => void;

type Entry = { guard: NavigationGuard };

const stack: Entry[] = [];

/** Registers the page's guard; returns the unregister function. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  // An entry object, not the function: the same function registered twice
  // still gets two independent registrations.
  const entry: Entry = { guard };
  stack.push(entry);
  return () => {
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
  };
}

/** Sends a programmatic navigation through the live guard, if any. */
export function guardedNavigate(go: () => void): void {
  const live = stack[stack.length - 1];
  if (live) live.guard(go);
  else go();
}
