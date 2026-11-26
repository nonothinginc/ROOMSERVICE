// usage (dev server): node tools/library-test.mjs http://localhost:5173/ "<pack.zip>" <out-prefix> [WxH@dpr]
// Imports a pack through the LIBRARY file picker, checks categories, CHOP / PLAYLIST routing and IndexedDB persistence.
import { chromium } from 'playwright';
const [, , url, zip, out, vp = '640x480@2'] = process.argv;
const [wh, d] = vp.split('@'); const [W, H] = wh.split('x').map(Number);
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H }, deviceScaleFactor: Number(d), hasTouch: true })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.locator('.triage-card', { hasText: 'BLANK' }).click();
await page.waitForTimeout(300);
if (await page.locator('.triage-card').count()) await page.locator('.triage-card').first().click();
await page.waitForTimeout(400);
await page.evaluate(() => [...document.querySelectorAll('.hw-left-rail .rail-btn')].find((b) => b.title === 'LIBRARY').click());
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}-empty.png` });
const t0 = Date.now();
await page.locator('.lib-panel input[type=file]').setInputFiles(zip);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}-importing.png` });
await page.waitForFunction(() => document.querySelectorAll('.lib-row').length > 0, null, { timeout: 120000 });
const secs = (Date.now() - t0) / 1000;
await page.waitForTimeout(300);
const summary = await page.evaluate(async () => {
  const mod = await import('/src/library/library.js').catch(() => null);
  const rows = [...document.querySelectorAll('.lib-row')].map((r) => [r.querySelector('.lib-name').textContent, r.querySelector('.lib-meta').textContent]);
  const cats = [...document.querySelectorAll('.lib-cat')].map((c) => c.innerText.replace(/\n/g, ' '));
  return { cats, n: rows.length, sample: rows.filter((_, i) => i % 12 === 0) };
});
console.log('import secs', secs);
console.log(JSON.stringify(summary, null, 1));
await page.screenshot({ path: `${out}-list.png` });
// select second row via click -> audition + footer
await page.locator('.lib-row').nth(1).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}-selected.png` });
// Category STABS via click, then gamepad-ish keyboard down
await page.locator('.lib-cat', { hasText: 'STABS' }).click();
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}-stabs.png` });
// Send a break to CHOP
await page.locator('.lib-cat', { hasText: 'BREAKS' }).click();
await page.locator('.lib-row').first().click();
await page.waitForTimeout(200);
await page.locator('.lib-foot .ctx-chip', { hasText: 'CHOP' }).click();
await page.waitForTimeout(1200);
const afterChop = await page.evaluate(() => ({ overlay: window.__rs.store.getState().detailOverlay?.type }));
await page.screenshot({ path: `${out}-chop.png` });
// Loop -> playlist from rail
await page.keyboard.press('Escape');
await page.evaluate(() => [...document.querySelectorAll('.hw-left-rail .rail-btn')].find((b) => b.title === 'LIBRARY').click());
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}-reopen.png` });
console.log('REOPEN', await page.evaluate(() => ({ ov: window.__rs.store.getState().detailOverlay, cats: [...document.querySelectorAll('.lib-cat')].map((c) => c.innerText) })));
await page.locator('.lib-cat', { hasText: 'LOOPS' }).click();
await page.locator('.lib-row').first().click();
await page.locator('.lib-foot .ctx-chip.solid').click();
await page.waitForTimeout(800);
const afterPl = await page.evaluate(() => {
  const st = window.__rs.store.getState();
  const c = st.arrClips[st.arrClips.length - 1];
  const ac = st.audioClips[c.refId];
  return { view: st.view, bpm: st.bpm, clip: { lane: c.lane, start: c.startStep, len: c.lengthSteps }, ac: { bpm: ac.detectedBpm, warp: ac.warpMode, dur: ac.duration } };
});
await page.screenshot({ path: `${out}-playlist.png` });
// Persistence: reload and check library count
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const persisted = await page.evaluate(async () => {
  const req = indexedDB.open('roomservice-library');
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  return new Promise((r) => { const q = db.transaction('samples').objectStore('samples').count(); q.onsuccess = () => r(q.result); });
});
console.log(JSON.stringify({ afterChop, afterPl, persisted }, null, 1));
console.log('ERRORS', errs.filter((e) => !/fonts\.g|favicon/.test(e)));
await browser.close();
