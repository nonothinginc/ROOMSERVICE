// usage (dev server only, uses window.__rs): node tools/func-test.mjs http://localhost:5173/
// Verifies song length > 8 bars, loop wrap bounds, audio clip edits playback/cleanup, and JAM take capture.
import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 640, height: 480 }, deviceScaleFactor: 2, hasTouch: true })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle' });
await page.locator('.triage-card', { hasText: 'BLANK' }).click();
await page.waitForTimeout(300);
if (await page.locator('.triage-card').count()) await page.locator('.triage-card').first().click();
await page.waitForTimeout(500);

const out = await page.evaluate(async () => {
  const { engine, store, getSongEnd } = window.__rs;
  const st = store.getState();
  const res = {};
  await engine.unlock();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) Song longer than 8 bars: clip at bar 12
  st.arrClips.push({ id: 'tclip1', kind: 'pattern', refId: 'P01', lane: 0, startStep: 176, lengthSteps: 16, trackOverride: null });
  res.songEnd = getSongEnd(st);

  // 2) Loop bars 1-2 at fast tempo; playhead must stay inside
  engine.setBpm(240);
  st.playMode = 'SONG';
  store.setLoop({ on: true, start: 16, end: 32 });
  await engine.togglePlay();
  let maxStep = -1, minStep = 999, wrapped = false, prev = -1;
  for (let i = 0; i < 100; i++) {
    await sleep(25);
    const s = st.currentStep;
    maxStep = Math.max(maxStep, s); minStep = Math.min(minStep, s);
    if (prev > 28 && s < 20) wrapped = true;
    prev = s;
  }
  await engine.togglePlay();
  res.loop = { maxStep, minStep, wrapped };

  // 3) Loop off: plays past bar 8
  store.setLoop({ on: false });
  st.currentStep = 0;
  await engine.togglePlay();
  let max2 = 0;
  for (let i = 0; i < 140; i++) { await sleep(25); max2 = Math.max(max2, st.currentStep); }
  await engine.togglePlay();
  res.noLoopMax = max2;

  // 4) Audio: synth 2s sample, import, trim/offset playback mid-clip
  const ctx = new OfflineAudioContext(1, 44100 * 2, 44100);
  const o = ctx.createOscillator(); o.connect(ctx.destination); o.start(); 
  const buf = await ctx.startRendering();
  const ac = engine.registerAudioBuffer('TONE', buf);
  const aclip = st.arrClips[st.arrClips.length - 1];
  res.audioClipLen = aclip.lengthSteps;
  aclip.offsetSteps = 4; aclip.gainDb = -6; aclip.fadeInSteps = 2; aclip.fadeOutSteps = 2; aclip.reverse = true;
  store.setLoop({ on: true, start: 0, end: 16 });
  aclip.startStep = 0;
  await engine.togglePlay();
  await sleep(1200);
  res.audioSources = engine.activeAudioSources.size;
  await engine.togglePlay();
  await sleep(100);
  res.audioSourcesAfterStop = engine.activeAudioSources.size;

  // 5) Jam: brickchord on track 0, record a chord in pass 1 and pass 2, stop in pass 3
  store.addInsertDevice ? null : null;
  const trackId = 1;
  if (st.tracks[trackId].inserts[0]?.deviceId !== 'brickchord') {
    store.setTrackInstrument ? store.setTrackInstrument(trackId, 'brickchord') : store.addInsertDevice(trackId, 'brickchord');
  }
  engine.setBpm(240);
  store.setLoop({ on: true, start: 32, end: 48 }); // 1 bar at 240bpm = 1s per pass
  const labBefore = st.lab.length;
  await engine.startJam(trackId);
  res.jamCount = st.jam?.phase;
  await sleep(1150); // count-in 4 beats at 240 = 1s
  res.jamPhase = st.jam?.phase;
  await sleep(150);
  engine.jamChordOn([60, 64, 67]); await sleep(300); engine.jamChordOff();
  await sleep(700); // into pass 2
  engine.jamChordOn([62, 65, 69]); await sleep(200); engine.jamChordOff();
  await sleep(1000); // into pass 3
  const r = engine.stopJam(true);
  res.jam = r ? { patId: r.patId, takes: r.takes, clip: { start: r.clip.startStep, len: r.clip.lengthSteps, lane: r.clip.lane } } : null;
  if (r) {
    const pat = st.patterns[r.patId];
    res.jamPat = { name: pat.name, len: pat.length, keys: Object.keys(pat.notesByTrack), notes: Object.values(pat.notesByTrack).flat().map((n) => [n.step, n.len, n.midi]) };
  }
  res.labAdded = st.lab.length - labBefore;
  res.labTop = st.lab[0]?.name;
  res.isPlaying = st.isPlaying;
  res.jamState = st.jam;
  return res;
});
console.log(JSON.stringify(out, null, 1));
console.log('ERRORS', errs);
await browser.close();
