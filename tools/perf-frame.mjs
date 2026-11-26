// usage (dev server): node tools/perf-frame.mjs http://localhost:5173/ [cpuThrottle=4]
// Per-view script / style / layout ms per frame during playback (CDP Performance metrics).
import { chromium } from 'playwright';
const [, , url, throttle = '4'] = process.argv;
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2, hasTouch: true });
const cdp = await page.context().newCDPSession(page);
await page.goto(url, { waitUntil: 'networkidle' });
await page.locator('.triage-card', { hasText: 'BEAT' }).click();
await page.waitForTimeout(300);
if (await page.locator('.triage-card').count()) await page.locator('.triage-card').first().click();
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(throttle) });
await cdp.send('Performance.enable');
const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const res = {};
for (const v of ['ROLL', 'ARR', 'MIX', 'DSP']) {
  await page.evaluate((v) => { const r = window.__rs; r.store.setView(v); if (!r.store.getState().isPlaying) r.engine.togglePlay(); }, v);
  await page.waitForTimeout(500);
  const m0 = await metric();
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const ts = []; const t0 = performance.now();
    const f = (t) => { ts.push(t); if (t - t0 < 3000) requestAnimationFrame(f); else resolve(ts); };
    requestAnimationFrame(f);
  }));
  const m1 = await metric();
  const d = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const secs = (frames[frames.length - 1] - frames[0]) / 1000;
  res[v] = {
    fps: Math.round(d.length / secs),
    p95ms: +d[Math.floor(d.length * 0.95)].toFixed(1),
    scriptMsPerFrame: +(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / d.length).toFixed(2),
    styleMsPerFrame: +(((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000) / d.length).toFixed(2),
    layoutMsPerFrame: +(((m1.LayoutDuration - m0.LayoutDuration) * 1000) / d.length).toFixed(2),
    recalcs: Math.round((m1.RecalcStyleCount - m0.RecalcStyleCount) / d.length * 10) / 10
  };
}
console.log(JSON.stringify(res, null, 1));
await browser.close();
