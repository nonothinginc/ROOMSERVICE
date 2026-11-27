/**
 * Latency profiles + real-time health telemetry.
 *
 * LIVE: interactive output buffer, 60 ms sequencing lookahead (default).
 * SAFE: larger output buffer + 120 ms lookahead for dense sessions. Applies on app restart
 *       because the AudioContext output buffer is fixed at creation.
 *
 * Timing health: every sequencer step records its "slack" = how far ahead of the audio clock
 * the main thread scheduled it. Slack below ~0 means the step was late (heard late / dropped).
 */
const KEY = 'roomservice_latency_mode_v1';

export const LATENCY_PROFILES = {
  LIVE: { latencyHint: 'interactive', lookAhead: 0.06 },
  SAFE: { latencyHint: 'balanced', lookAhead: 0.12 }
};

export function getLatencyMode() {
  try {
    return localStorage.getItem(KEY) === 'SAFE' ? 'SAFE' : 'LIVE';
  } catch {
    return 'LIVE';
  }
}

export function getLatencyProfile() {
  return LATENCY_PROFILES[getLatencyMode()];
}

export function setLatencyMode(mode) {
  try {
    localStorage.setItem(KEY, mode === 'SAFE' ? 'SAFE' : 'LIVE');
  } catch {
    // ignore
  }
}

/** Rolling scheduling-health stats (2 s windows, last window kept for display). */
export const timing = {
  winStart: 0,
  n: 0,
  late: 0,
  minSlack: Infinity,
  sumSlack: 0,
  last: { n: 0, late: 0, minSlackMs: 0, avgSlackMs: 0 },
  totalLate: 0,
  totalSteps: 0
};

export function recordSlack(slackSec, nowSec) {
  if (!timing.winStart) timing.winStart = nowSec;
  timing.n++;
  timing.totalSteps++;
  timing.sumSlack += slackSec;
  if (slackSec < timing.minSlack) timing.minSlack = slackSec;
  if (slackSec < 0.001) {
    timing.late++;
    timing.totalLate++;
  }
  if (nowSec - timing.winStart >= 2) {
    timing.last = {
      n: timing.n,
      late: timing.late,
      minSlackMs: Math.round(timing.minSlack * 1000),
      avgSlackMs: Math.round((timing.sumSlack / timing.n) * 1000)
    };
    timing.winStart = nowSec;
    timing.n = 0;
    timing.late = 0;
    timing.minSlack = Infinity;
    timing.sumSlack = 0;
  }
}

/**
 * Audio-thread health where the browser exposes it (Chromium):
 *  - renderCapacity: fraction of the render quantum budget used
 *  - playoutStats: frames the device had to fill with silence (glitches)
 */
export function attachRenderCapacity(ctx) {
  const out = { load: null, peak: null, underruns: null, supported: false };
  try {
    if (ctx.renderCapacity?.start) {
      ctx.renderCapacity.addEventListener('update', (e) => {
        out.load = e.averageLoad;
        out.peak = e.peakLoad;
        out.underruns = e.underrunRatio;
      });
      ctx.renderCapacity.start({ updateInterval: 1 });
      out.supported = true;
    }
  } catch {
    // not available in this WebView
  }
  return out;
}

export function playoutGlitches(ctx) {
  try {
    const ps = ctx.playoutStats;
    if (ps && typeof ps.fallbackFramesEvents === 'number') return ps.fallbackFramesEvents;
  } catch {
    // ignore
  }
  return null;
}
