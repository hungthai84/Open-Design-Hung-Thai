/** POC browser handoff; desktop builds retain vela CLI's browser lifecycle. */
export function createCloudDeviceLogin(
  browser: Pick<Window, 'open' | 'location'> | undefined = typeof window === 'undefined' ? undefined : window,
) {
  const enabled = process.env.NEXT_PUBLIC_OD_CLOUD_POC === '1' && Boolean(browser);
  const configuredBase = process.env.NEXT_PUBLIC_OD_CLOUD_AUTH_BASE_URL;
  const activationBases = configuredBase
    ? [configuredBase]
    : ['https://open-design.powerformer.net/cloud', 'https://open-design.ai/cloud'];
  let generation = 0;
  let popup: Window | null = null;
  let completed = false;
  let activationUrl: string | null = null;
  const close = (attempt = generation) => {
    if (attempt !== generation) return;
    try { popup?.close(); } catch { /* Cross-origin isolation may detach the window. */ }
    popup = null;
  };
  return {
    begin() {
      if (!enabled) return;
      close();
      generation += 1;
      completed = false;
      activationUrl = null;
      // Open before the first await while the click still grants user activation.
      // Detach the opener before navigating to Vela; keep the handle for cleanup.
      try {
        popup = browser!.open('about:blank', '_blank');
        if (popup) popup.opener = null;
      } catch { popup = null; }
      // A blocked popup leaves the existing manual activation link available.
      return generation;
    },
    isCurrent(attempt?: number) { return attempt === undefined || attempt === generation; },
    activate(value?: string, attempt = generation) {
      if (attempt !== generation || !enabled || !popup || popup.closed || !value || value === activationUrl) return;
      try {
        const url = new URL(value);
        const allowed = activationBases.some((base) => {
          const expected = new URL(base);
          return expected.protocol === 'https:' && !expected.username && !expected.password
            && !expected.port && !expected.search && !expected.hash
            && ['/', '/cloud', '/cloud/'].includes(expected.pathname)
            && url.origin === expected.origin
            && url.pathname === `${expected.pathname.replace(/\/$/, '')}/cli/activate`;
        });
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !allowed) return;
        popup.location.replace(url.href);
        activationUrl = value;
      } catch { close(); }
    },
    finish() {
      if (!enabled) return false;
      if (!completed) {
        completed = true;
        close();
        // The successful status response has installed the HttpOnly session.
        // Enter Home in a fresh document ONCE, so pre-login workspace failures
        // and desktop onboarding effects cannot send the new session back.
        // No timer/retry reload: later 401s still use the normal sign-out guard.
        browser!.location.replace('/');
      }
      return true;
    },
    close,
  };
}
