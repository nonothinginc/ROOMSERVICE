/**
 * Runtime capability flags.
 *
 * WORKLETS_OK: false on old Android System WebView (Chrome < 120, e.g. the RG477V's WebView 113).
 * Measured on device: as soon as an AudioWorklet module is loaded into the realtime context, that
 * WebView moves all audio rendering onto a non-realtime thread; the context then runs at ~1/3 speed
 * and the output crackles. Fresh contexts without worklets run at exactly 1.0x. Modern Chrome is
 * fine. When false, every feature uses its native-node fallback and no addModule() is ever called.
 * Override for testing: localStorage.roomservice_worklets = 'on' | 'off'.
 */
function detect() {
  try {
    const o = localStorage.getItem('roomservice_worklets');
    if (o === 'on') return true;
    if (o === 'off') return false;
  } catch {
    // ignore
  }
  const ua = navigator.userAgent || '';
  const isWebView = /; wv\)/.test(ua);
  const m = ua.match(/Chrome\/(\d+)/);
  if (isWebView && m && Number(m[1]) < 120) return false;
  return true;
}

export const WORKLETS_OK = typeof navigator !== 'undefined' ? detect() : true;
