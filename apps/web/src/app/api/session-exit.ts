// Leaving a session reloads the page rather than clearing state in place: a reload is
// the only way to be sure no in-flight request or mutation callback from the previous
// session can write its data back into a fresh QueryClient afterwards.

const CHANNEL_NAME = 'pokedex-auth';
const LOGGED_OUT = 'logged-out';

export function reloadSignedOut(): void {
  location.replace('/');
}

/** Tells every other open tab of this origin that the session has ended. */
export function announceLoggedOut(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage(LOGGED_OUT);
  channel.close();
}

/** Calls `onLoggedOut` when another tab logs out; returns the unsubscribe. */
export function onLoggedOutElsewhere(onLoggedOut: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data === LOGGED_OUT) onLoggedOut();
  };
  return () => channel.close();
}
