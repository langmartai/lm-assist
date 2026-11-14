/**
 * The cloud-connect confirm card (Settings → Connection) — when it may arm, and what it
 * says. Kept pure so it is testable without rendering the settings page.
 *
 * `/api/auth/cloud-connect` 303s ANY caller to `/settings#cloudConnect=1&key=…&hubUrl=…`,
 * so the hand-off is attacker-craftable: a link carrying the attacker's own key for the
 * real platform hub passes the hub check. One click on Connect then rebinds this node to
 * the attacker's account. The click is the only control, so:
 *
 *  - it is refused inside a frame (a hijacked click needs the page framed; the legitimate
 *    fallback always lands in the sign-in popup, a top-level window). The dashboard also
 *    sends `frame-ancestors` (next.config.ts); this check does not depend on a proxy in
 *    front of the web passing that header through;
 *  - the copy does not claim a sign-in happened (nothing records that this browser
 *    started one), says the account will control this device, and says so louder when
 *    it would REPLACE the account the device is already bound to.
 */

export type CloudConnectArm =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'arm'; key: string; hubUrl: string };

export const CLOUD_CONNECT_FRAMED_ERROR = 'Open Settings in its own browser tab to connect this device to a cloud account.';

/** True when this window is the top-level browsing context (not inside any frame). */
export function isTopLevelWindow(win: { self: unknown; top: unknown } | undefined | null): boolean {
  if (!win) return false;
  try {
    return win.self === win.top;
  } catch {
    // A cross-origin top can throw on access: that is a frame.
    return false;
  }
}

/**
 * Decide what the `#cloudConnect=1&key=…&hubUrl=…` fragment may do. The caller scrubs the
 * fragment from the address bar whenever `cloudConnect=1` is present, whatever this says.
 */
export function decideCloudConnectArm(
  hash: string,
  opts: { isTopLevel: boolean; platformHubUrls: readonly string[] },
): CloudConnectArm {
  const h = new URLSearchParams((hash || '').replace(/^#/, ''));
  if (h.get('cloudConnect') !== '1') return { kind: 'none' };
  if (!opts.isTopLevel) return { kind: 'error', message: CLOUD_CONNECT_FRAMED_ERROR };
  const key = h.get('key') || '';
  const hubUrl = h.get('hubUrl') || '';
  if (!key) return { kind: 'error', message: 'The cloud sign-in did not return a key. Try Sign In again.' };
  if (!opts.platformHubUrls.includes(hubUrl)) {
    return { kind: 'error', message: 'The cloud sign-in returned an unknown hub address, so it was ignored. Try Sign In again.' };
  }
  return { kind: 'arm', key, hubUrl };
}

/** Confirm-card copy. Honest about what is known (a link arrived, not "you signed in"). */
export function cloudConnectPrompt(alreadyBound: boolean): { text: string; confirmLabel: string; warn: boolean } {
  if (alreadyBound) {
    return {
      text:
        'This device is already connected to a cloud account. A sign-in link asks to REPLACE it with another ' +
        'account, which could then control this device (sessions, terminals, files). Only continue if you ' +
        'just clicked Sign In on this page yourself.',
      confirmLabel: 'Replace account',
      warn: true,
    };
  }
  return {
    text:
      'A sign-in link asks to connect this device to a cloud account, which could then control this device ' +
      '(sessions, terminals, files). Only continue if you just clicked Sign In on this page yourself.',
    confirmLabel: 'Connect',
    warn: false,
  };
}
