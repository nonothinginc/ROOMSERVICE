// usage (needs `npm i -D playwright` or a global install + Chrome): node tools/ui-audit.mjs <url> <outdir> [WxH@dpr ...]
// Walks views + overlays, screenshots each, and reports runtime errors, overlapping
// interactive controls and controls clipped outside their scroll-less containers.
import { chromium } from 'playwright';
import fs from 'node:fs';

const [, , url, out, ...sizes] = process.argv;
fs.mkdirSync(out, { recursive: true });
const viewports = (sizes.length ? sizes : ['640x480@2']).map((s) => {
  const [wh, d] = s.split('@');
  const [w, h] = wh.split('x').map(Number);
  return { w, h, dpr: Number(d || 1), tag: s.replace('@', '_') };
});

const report = [];
const browser = await chromium.launch({ channel: 'chrome' });

// In-page geometry check over the topmost interactive layer
const geomCheck = () => {
  const layer =
    document.querySelector('.mode-wheel-backdrop[style*="flex"]') ||
    [...document.querySelectorAll('.overlay-backdrop')].pop() ||
    document.querySelector('.chassis');
  const sel = 'button, .rotary-unit, .hdr-num, .badge, .ctx-chip, .mpc-pad, .bc-pad, .triage-card, input, select';
  const vw = innerWidth, vh = innerHeight;
  const els = [...layer.querySelectorAll(sel)].filter((e) => {
    if (e.closest('.rotary-unit') && !e.matches('.rotary-unit')) return false;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && e.offsetParent !== null;
  });
  // Visible part = intersection with every scrolling/clipping ancestor
  const visRect = (e) => {
    let r = e.getBoundingClientRect();
    let L = r.left, T = r.top, R = r.right, B = r.bottom;
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        const pr = p.getBoundingClientRect();
        L = Math.max(L, pr.left); T = Math.max(T, pr.top); R = Math.min(R, pr.right); B = Math.min(B, pr.bottom);
      }
    }
    L = Math.max(L, 0); T = Math.max(T, 0); R = Math.min(R, vw); B = Math.min(B, vh);
    return { L, T, R, B, full: r };
  };
  const scrolls = (e) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && (p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1)) return true;
    }
    return false;
  };
  const name = (e) => (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : e.tagName) + ` "${(e.innerText || e.title || '').trim().slice(0, 14).replace(/\n/g, ' ')}"`;
  const issues = [];
  const rects = els.map((e) => ({ e, v: visRect(e) }));
  for (const { e, v } of rects) {
    const fr = v.full;
    const visW = v.R - v.L, visH = v.B - v.T;
    if ((visW < fr.width - 2 || visH < fr.height - 2) && !scrolls(e)) {
      issues.push(`CLIPPED ${name(e)} vis ${Math.max(0, visW).toFixed(0)}x${Math.max(0, visH).toFixed(0)} of ${fr.width.toFixed(0)}x${fr.height.toFixed(0)}`);
    }
    if (visW > 0 && visH > 0 && (fr.height < 22 || fr.width < 22) && !e.matches('.dsp-bypass-sq, .theme-dot, input, select, .mix-peak-badge')) {
      issues.push(`SMALL ${name(e)} ${fr.width.toFixed(0)}x${fr.height.toFixed(0)}`);
    }
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const ix = Math.min(a.v.R, b.v.R) - Math.max(a.v.L, b.v.L);
      const iy = Math.min(a.v.B, b.v.B) - Math.max(a.v.T, b.v.T);
      if (ix > 2 && iy > 2) issues.push(`OVERLAP ${name(a.e)} x ${name(b.e)} (${ix.toFixed(0)}x${iy.toFixed(0)})`);
    }
  }
  return [...new Set(issues)];
};

for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const shot = async (name) => {
    await page.waitForTimeout(380);
    await page.screenshot({ path: `${out}/${vp.tag}-${name}.png` });
    const issues = await page.evaluate(geomCheck);
    report.push({ vp: vp.tag, name, issues, errs: errs.splice(0) });
  };
  const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };
  const rail = (t) => page.evaluate((t) => [...document.querySelectorAll('.hw-left-rail .rail-btn')].find((b) => b.title === t)?.click(), t);
  const clickText = (sel, re) => page.evaluate(([sel, re]) => {
    const b = [...document.querySelectorAll(sel)].find((x) => new RegExp(re).test((x.innerText || x.title || '').trim()));
    if (b) { b.click(); return true; } return false;
  }, [sel, re]);
  const wheelPick = async (idx) => {
    await rail('MODE WHEEL [L3 / TAB]');
    await page.waitForTimeout(250);
    const box = await page.locator('.mode-wheel-canvas').boundingBox();
    if (!box) return false;
    const a = -Math.PI / 2 + (idx * Math.PI * 2) / 8;
    const r = box.width * 0.36;
    await page.mouse.click(box.x + box.width / 2 + Math.cos(a) * r, box.y + box.height / 2 + Math.sin(a) * r);
    await page.waitForTimeout(250);
    return true;
  };

  await shot('00-triage');
  await clickText('.triage-card', 'BEAT');
  await page.waitForTimeout(300);
  await shot('01-triage-beat');
  await page.locator('.triage-card').first().click().catch(() => {});
  await page.waitForTimeout(400);
  await esc();

  for (const v of ['ROLL', 'ARR', 'MIX', 'DSP']) { await rail(v); await shot(`10-${v}`); }

  // Ring button must work repeatedly
  let wheelOk = 0;
  for (let k = 0; k < 4; k++) {
    await rail('MODE WHEEL [L3 / TAB]');
    await page.waitForTimeout(200);
    const open = await page.evaluate(() => getComputedStyle(document.querySelector('.mode-wheel-backdrop')).display !== 'none');
    if (open) wheelOk++;
    if (k === 0) await shot('20-wheel');
    await page.mouse.click(5, 5); // backdrop tap closes
    await page.waitForTimeout(200);
  }
  report.push({ vp: vp.tag, name: 'wheel-repeat', issues: wheelOk === 4 ? [] : [`WHEEL opened ${wheelOk}/4`], errs: [] });

  // Overlays via wheel: MPC(4) CHORD(5) LEAD(6) LAB(7)
  for (const [i, n] of [[4, 'MPC'], [5, 'CHORD'], [6, 'LEAD'], [7, 'LAB']]) {
    await wheelPick(i);
    await shot(`30-${n}`);
    await esc();
    await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click());
    await page.waitForTimeout(200);
  }
  await wheelPick(0);

  // Mixer FX + punch
  await rail('MIX');
  if (await clickText('.mix-fx-btn', '^FX')) { await shot('40-mix-fx'); await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click()); }
  if (await clickText('.mix-fx-btn', 'PUNCH')) { await shot('41-punch'); await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click()); }
  // DSP module browser
  await rail('DSP');
  if (await clickText('.ctx-chip', 'FX$')) { await shot('42-dsp-add'); await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click()); }
  // Roll riff + settings
  await rail('ROLL');
  if (await clickText('.ctx-chip', '^RIFF')) { await shot('43-riff'); await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click()); }
  if (await clickText('.ctx-chip', '^⋯')) { await shot('44-roll-more'); await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click()); }
  // Project
  await rail('PROJECT / ARCHIVE');
  await shot('45-project');
  await page.evaluate(() => document.querySelector('.overlay-backdrop .icon-only')?.click());
  // Theme: white finish
  await page.evaluate(() => document.querySelector('.theme-dot')?.click());
  for (const v of ['ROLL', 'MIX', 'DSP']) { await rail(v); await shot(`50-light-${v}`); }
  await ctx.close();
}
await browser.close();

let total = 0;
for (const r of report) {
  const n = r.issues.length + r.errs.length;
  total += n;
  if (n) {
    console.log(`\n[${r.vp}] ${r.name}`);
    for (const e of [...new Set(r.errs.map((x) => x.split("\n")[0]))]) console.log("  ERROR", e);
    for (const i of r.issues) console.log('  ' + i);
  }
}
console.log(`\nTOTAL ISSUES: ${total}`);
