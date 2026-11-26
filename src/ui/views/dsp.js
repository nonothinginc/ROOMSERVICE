import { engine } from '../../audio/engine.js';
import { getDevice, getDevicesByCategory } from '../../device-registry.js';
import { store } from '../../state/store.js';
import { attachLongPress } from '../components/longpress.js';
import { createRotary } from '../components/rotary.js';

const FIVE_DOT_SVG = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="3" cy="3" r="1" fill="currentColor"/><circle cx="9" cy="3" r="1" fill="currentColor"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="3" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="9" r="1" fill="currentColor"/></svg>`;

function drawEqCurve(ctx, w, h, vizData, accent, ink, inkDim, bg, border) {
  const padL = 10;
  const padR = 10;
  const padT = 14;
  const padB = 22;
  const pw = w - padL - padR;
  const ph = h - padT - padB;
  const midY = padT + ph * 0.5;

  // Hairline frequency grid
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const x = padL + pw * t;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + ph);
    ctx.stroke();
  });
  [0, 0.5, 1].forEach((t) => {
    const y = padT + ph * t;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pw, y);
    ctx.stroke();
  });

  // Frequency labels matching reference image
  ctx.fillStyle = inkDim;
  ctx.font = '600 13px "Geist Mono", monospace';
  ctx.textBaseline = 'bottom';
  [
    { t: 0.01, l: '20' },
    { t: 0.24, l: '100' },
    { t: 0.56, l: '1k' },
    { t: 0.88, l: '10k' }
  ].forEach((m) => {
    ctx.fillText(m.l, padL + pw * m.t - 8, h - 3);
  });

  const pts = vizData.points || [];
  if (pts.length < 2) return;

  // Fill subtly beneath curve
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = padL + (i / (pts.length - 1)) * pw;
    const y = midY - v * (ph * 0.44);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(padL + pw, padT + ph);
  ctx.lineTo(padL, padT + ph);
  ctx.closePath();
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.restore();

  // Curve stroke
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  pts.forEach((v, i) => {
    const x = padL + (i / (pts.length - 1)) * pw;
    const y = midY - v * (ph * 0.44);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Control band dots
  (vizData.bands || []).forEach((b, idx) => {
    const bx = padL + b.x * pw;
    const by = midY - b.y * (ph * 0.44);
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fillStyle = idx === 1 ? accent : ink;
    ctx.fill();
  });
}

function drawCompCurve(ctx, w, h, vizData, accent, ink, inkDim, bg, border) {
  const splitX = Math.round(w * 0.58);
  const pad = 14;
  const gw = splitX - pad - 10;
  const gh = h - pad * 2;
  const gx = pad + 18;
  const gy = pad;
  const plotW = Math.max(40, gw - 18);

  // Subtle grid & dB labels
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = gy + (i / 3) * gh;
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx + plotW, y);
    ctx.stroke();
    const x = gx + (i / 3) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x, gy + gh);
    ctx.stroke();
  }

  ctx.fillStyle = inkDim;
  ctx.font = '600 12px "Geist Mono", monospace';
  ctx.textBaseline = 'middle';
  ['0', '-12', '-24', '-36'].forEach((lbl, i) => {
    ctx.fillText(lbl, 4, gy + (i / 3) * gh);
  });

  // Transfer curve (-36..0 dB)
  const thresh = Math.max(-36, Math.min(0, vizData.threshold ?? -18));
  const ratio = Math.max(1, vizData.ratio ?? 4);
  const pts = [];
  for (let i = 0; i <= 36; i++) {
    const inDb = -36 + i;
    const outDb = inDb <= thresh ? inDb : thresh + (inDb - thresh) / ratio;
    const nx = (inDb + 36) / 36;
    const ny = Math.max(0, Math.min(1, (outDb + 36) / 36));
    pts.push({ x: gx + nx * plotW, y: gy + gh - ny * gh });
  }

  ctx.beginPath();
  pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.lineTo(gx + plotW, gy + gh);
  ctx.lineTo(gx, gy + gh);
  ctx.closePath();
  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();

  // Knee dot
  const kx = gx + ((thresh + 36) / 36) * plotW;
  const ky = gy + gh - ((thresh + 36) / 36) * gh;
  ctx.beginPath();
  ctx.arc(kx, ky, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = (vizData.grDb || 0) > 0.5 ? accent : ink;
  ctx.fill();

  // Right-hand stacked stats
  const sx = splitX + 12;
  const rows = [
    ['THRESH', `${thresh.toFixed(1)} dB`],
    ['RATIO', `${ratio.toFixed(1)}:1`],
    ['ATTACK', `${vizData.attackMs ?? 10} ms`],
    ['RELEASE', `${vizData.releaseMs ?? 180} ms`]
  ];
  rows.forEach(([k, v], idx) => {
    const ry = pad + 4 + idx * 42;
    ctx.fillStyle = inkDim;
    ctx.font = '600 11px "Geist Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(k, sx, ry);
    ctx.fillStyle = ink;
    ctx.font = '700 15px "Geist Mono", monospace';
    ctx.fillText(v, sx, ry + 14);
  });
}

function drawReverbDepth(ctx, w, h, vizData, accent, ink, inkDim, bg, border) {
  const pad = 14;
  const boxSize = Math.min(h - pad * 2, Math.round(w * 0.52));
  const bx = pad;
  const by = Math.round((h - boxSize) / 2);

  // Outer contour rounded box
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, boxSize, boxSize, 8);
  ctx.stroke();

  const layers = 8;
  const sizeNorm = Math.max(0.2, Math.min(1, vizData.size ?? 0.68));
  const meterBoost = (vizData.meter || 0) * 0.14;
  for (let i = 0; i < layers; i++) {
    const t = 1 - i / layers;
    const span = boxSize * (0.24 + t * 0.72 * (0.65 + sizeNorm * 0.35));
    const rx = bx;
    const ry = by + boxSize - span;
    ctx.save();
    ctx.globalAlpha = 0.07 + (1 - t) * 0.58 + meterBoost;
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.roundRect(rx, ry, span, span, 6);
    ctx.fill();
    ctx.restore();
  }

  // Live accent edge indicator when active
  if ((vizData.meter || 0) > 0.04) {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(bx + 10, by + boxSize - 10, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Stacked stats on right
  const sx = bx + boxSize + 18;
  const rows = [
    ['SIZE', `${Math.round((vizData.size ?? 0.68) * 100)}%`],
    ['DECAY', `${(vizData.decay ?? 0.72).toFixed(2)}s`],
    ['MIX', `${Math.round(vizData.mix ?? 32)}%`]
  ];
  rows.forEach(([k, v], idx) => {
    const ry = by + 6 + idx * 54;
    ctx.fillStyle = inkDim;
    ctx.font = '600 11px "Geist Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(k, sx, ry);
    ctx.fillStyle = ink;
    ctx.font = '700 17px "Geist Mono", monospace';
    ctx.fillText(v, sx, ry + 15);
  });
}

function drawDelayGrid(ctx, w, h, vizData, accent, ink, inkDim, bg, border) {
  const pad = 14;
  const gx = Math.round(w * 0.42);
  const gw = w - gx - pad;
  const gh = h - pad * 2;
  const gy = pad;

  // Left stats
  const rows = [
    ['TIME', String(vizData.division || '8n.')],
    ['FEEDBACK', `${Math.round((vizData.feedback ?? 0.42) * 100)}%`],
    ['MIX', `${Math.round(vizData.mix ?? 35)}%`]
  ];
  rows.forEach(([k, v], idx) => {
    const ry = pad + 4 + idx * 54;
    ctx.fillStyle = inkDim;
    ctx.font = '600 11px "Geist Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(k, pad, ry);
    ctx.fillStyle = ink;
    ctx.font = '700 16px "Geist Mono", monospace';
    ctx.fillText(v, pad, ry + 15);
  });

  // Dotted matrix
  const cols = 8;
  const rRows = 6;
  ctx.fillStyle = border;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rRows; r++) {
      const dx = gx + (c / (cols - 1)) * gw;
      const dy = gy + (r / (rRows - 1)) * gh;
      ctx.beginPath();
      ctx.arc(dx, dy, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Stereo tap stems & dots
  const fb = Math.max(0.1, Math.min(0.92, vizData.feedback ?? 0.42));
  const spread = Math.max(0, Math.min(1, (vizData.spread ?? 80) / 100));
  const tapCount = 4;
  for (let t = 0; t < tapCount; t++) {
    const decayScale = Math.pow(fb, t);
    const tx = gx + 12 + (t / (tapCount - 0.5)) * (gw - 24);
    const offset = (t % 2 === 0 ? -1 : 1) * spread * (gh * 0.24) * (1 - t * 0.14);
    const ty = gy + gh * 0.5 + offset;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tx, gy + gh * 0.5);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(tx, ty, Math.max(2.5, 5.2 * (0.45 + 0.55 * decayScale)), 0, Math.PI * 2);
    ctx.fillStyle = t === 0 && (vizData.meter || 0) > 0.05 ? accent : ink;
    ctx.fill();
  }
}

const FORMULA_NAMES = ['456', 'FERRIC', 'CHROME', 'LO-FI'];
const HEAD_BUMP_HZ = [45, 58, 88, 128];
const LOSS_CUTOFF_HZ = [5200, 9200, 14800, 19500];

function drawTeReel(ctx, cx, cy, r, angle, tapeFrac, ink, inkDim, border, accent, isHot) {
  // Outer flange
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Magnetic tape pack ring
  const hubR = r * 0.34;
  const packR = hubR + (r * 0.56) * Math.max(0.2, Math.min(1, tapeFrac));
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(cx, cy, packR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = inkDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, packR, 0, Math.PI * 2);
  ctx.stroke();

  // 3-spoke Teenage Engineering style reel cutout
  for (let i = 0; i < 3; i++) {
    const a0 = angle + (i * Math.PI * 2) / 3;
    const a1 = a0 + 0.62;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.66, a0, a1);
    ctx.stroke();

    // Spoke rib
    ctx.strokeStyle = inkDim;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a0) * hubR, cy + Math.sin(a0) * hubR);
    ctx.lineTo(cx + Math.cos(a0) * r * 0.9, cy + Math.sin(a0) * r * 0.9);
    ctx.stroke();
  }

  // Center hub & pin
  ctx.fillStyle = isHot ? accent : ink;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.stroke();
}

function drawHysteresisLoop(ctx, x, y, pw, ph, vizData, accent, ink, inkDim, border) {
  const cx = x + pw * 0.5;
  const cy = y + ph * 0.5;

  // Hairline crosshairs & ticks
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, cy);
  ctx.lineTo(x + pw, cy);
  ctx.moveTo(cx, y);
  ctx.lineTo(cx, y + ph);
  ctx.stroke();

  // Idle / reference hysteresis envelope derived from drive/sat/bias
  const driveAmt = 1 + (vizData.drive / 100) * 2.4 + (vizData.sat / 100) * 1.6;
  const hystW = (0.08 + (1 - vizData.bias / 100) * 0.22) * (0.35 + (vizData.sat / 100) * 0.65);

  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = inkDim;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const hVal = -1 + (2 * i) / steps;
    const mVal = Math.tanh((hVal - hystW) * driveAmt) / Math.tanh(driveAmt);
    const px = cx + hVal * (pw * 0.44);
    const py = cy - mVal * (ph * 0.42);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  for (let i = steps; i >= 0; i--) {
    const hVal = -1 + (2 * i) / steps;
    const mVal = Math.tanh((hVal + hystW) * driveAmt) / Math.tanh(driveAmt);
    const px = cx + hVal * (pw * 0.44);
    const py = cy - mVal * (ph * 0.42);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  const tel = vizData.telemetry || {};
  const pts = tel.loopPts || [];
  if (pts.length >= 4 && (tel.inPeak || 0) > 0.004) {
    const isSatHot = (tel.satAmount || 0) > 0.68;
    ctx.strokeStyle = isSatHot ? accent : ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const px = cx + pts[i] * (pw * 0.44);
      const py = cy - pts[i + 1] * (ph * 0.42);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Active magnetic operating point dot
    const lastH = pts[pts.length - 2];
    const lastM = pts[pts.length - 1];
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx + lastH * (pw * 0.44), cy - lastM * (ph * 0.42), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTapeLcd(ctx, w, h, vizData, accent, ink, inkDim, bg, border, isExpanded = false) {
  const tel = vizData.telemetry || {};
  const satPct = Math.round((tel.satAmount || 0) * 100);
  const inPk = Math.min(1, tel.inPeak || 0);
  const outPk = Math.min(1, tel.outPeak || vizData.meter || 0);
  const wfJitter = Math.max(-4, Math.min(4, (tel.flutterMod || 0) * 0.04));
  const isDrop = (tel.dropout || 0) > 0.08;
  const formula = FORMULA_NAMES[vizData.formulaIdx ?? 0] || '456';

  // Crisp TE LCD subtle pixel matrix background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(3.5, 3.5, w - 7, h - 7);

  // Corner LCD ticks
  const tick = 8;
  ctx.strokeStyle = inkDim;
  [
    [4, 4, 1, 1],
    [w - 4, 4, -1, 1],
    [4, h - 4, 1, -1],
    [w - 4, h - 4, -1, -1]
  ].forEach(([cx, cy, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * tick);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * tick, cy);
    ctx.stroke();
  });

  if (!isExpanded) {
    // COMPACT CARD LCD (440x196)
    const splitX = Math.round(w * 0.56);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(splitX + 0.5, 8);
    ctx.lineTo(splitX + 0.5, h - 8);
    ctx.stroke();

    // Left: Twin Reel Deck + Tape Path + Head Block
    const deckMidY = Math.round(h * 0.36);
    const reelR = Math.max(12, Math.round(Math.min(h * 0.20, splitX * 0.17)));
    const r1X = Math.round(splitX * 0.27);
    const r2X = Math.round(splitX * 0.73);
    const packOsc = Math.sin(vizData.reelAngle * 0.1) * 0.15;

    drawTeReel(ctx, r1X, deckMidY, reelR, vizData.reelAngle, 0.72 - packOsc, ink, inkDim, border, accent, outPk > 0.75);
    drawTeReel(ctx, r2X, deckMidY, reelR, vizData.reelAngle * 1.04, 0.55 + packOsc, ink, inkDim, border, accent, outPk > 0.75);

    // Tape path across tension rollers & center REC/PB Head
    const headX = Math.round(splitX * 0.5);
    const headY = Math.min(h - 32, deckMidY + reelR + 9 + wfJitter * 0.5);
    const g1X = r1X - reelR * 0.35;
    const g2X = r2X + reelR * 0.35;
    const gY = headY - 3;

    ctx.strokeStyle = isDrop ? accent : ink;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(r1X - reelR * 0.75, deckMidY + reelR * 0.35);
    ctx.lineTo(g1X, gY);
    ctx.lineTo(headX - 10, headY);
    ctx.lineTo(headX + 10, headY);
    ctx.lineTo(g2X, gY);
    ctx.lineTo(r2X + reelR * 0.75, deckMidY + reelR * 0.35);
    ctx.stroke();

    // Magnetic head housing
    ctx.fillStyle = bg;
    ctx.strokeStyle = ink;
    ctx.fillRect(headX - 9, headY - 7, 18, 11);
    ctx.strokeRect(headX - 9, headY - 7, 18, 11);
    ctx.fillStyle = satPct > 50 || outPk > 0.6 ? accent : ink;
    ctx.beginPath();
    ctx.arc(headX, headY - 1.5, 2, 0, Math.PI * 2);
    ctx.fill();

    // Bottom TE mini HUD + segmented VU bar
    ctx.fillStyle = inkDim;
    ctx.font = '700 8.5px "Geist Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(`${vizData.ips} IPS · ${formula}`, 8, h - 27);

    const vuSegs = 12;
    const vuX = 8;
    const vuY = h - 15;
    const vuW = splitX - 16;
    const segW = vuW / vuSegs;
    for (let i = 0; i < vuSegs; i++) {
      const lit = (i + 1) / vuSegs <= outPk;
      ctx.fillStyle = lit ? (i >= vuSegs - 3 ? accent : ink) : border;
      ctx.fillRect(vuX + i * segW, vuY, Math.max(2, segW - 2), 6);
    }

    // Right: Live Hysteresis Loop + Saturation Readout
    const hX = splitX + 8;
    const hY = 9;
    const hW = w - hX - 8;
    const hH = h - 30;
    drawHysteresisLoop(ctx, hX, hY, hW, hH, vizData, accent, ink, inkDim, border);

    ctx.fillStyle = inkDim;
    ctx.font = '600 8px "Geist Mono", monospace';
    ctx.textBaseline = 'bottom';
    ctx.fillText('B-H', hX, h - 7);
    ctx.fillStyle = satPct > 65 ? accent : ink;
    ctx.fillText(`SAT ${String(satPct).padStart(2, '0')}%`, w - 44, h - 7);
    return;
  }

  // EXPANDED FULL-SCREEN TE HARDWARE LCD
  const p1End = Math.round(w * 0.37);
  const p2End = Math.round(w * 0.71);
  const compactHud = w < 640 || h < 165;

  ctx.strokeStyle = border;
  [p1End, p2End].forEach((sx) => {
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, 10);
    ctx.lineTo(sx + 0.5, h - 10);
    ctx.stroke();
  });

  // PANE 1: Transport Deck
  const deckCy = Math.round(h * 0.42);
  const reelR = Math.max(16, Math.round(Math.min(h * 0.22, p1End * 0.17)));
  const r1X = Math.round(p1End * 0.28);
  const r2X = Math.round(p1End * 0.72);
  const packOsc = Math.sin(vizData.reelAngle * 0.1) * 0.15;

  drawTeReel(ctx, r1X, deckCy, reelR, vizData.reelAngle, 0.72 - packOsc, ink, inkDim, border, accent, outPk > 0.75);
  drawTeReel(ctx, r2X, deckCy, reelR, vizData.reelAngle * 1.04, 0.55 + packOsc, ink, inkDim, border, accent, outPk > 0.75);

  const headX = Math.round(p1End * 0.5);
  const headY = Math.min(h - 28, deckCy + reelR + 13 + wfJitter * 0.7);
  ctx.strokeStyle = isDrop ? accent : ink;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(r1X - reelR * 0.72, deckCy + reelR * 0.38);
  ctx.lineTo(r1X - reelR * 0.3, headY - 5);
  ctx.lineTo(headX - 14, headY);
  ctx.lineTo(headX + 14, headY);
  ctx.lineTo(r2X + reelR * 0.3, headY - 5);
  ctx.lineTo(r2X + reelR * 0.72, deckCy + reelR * 0.38);
  ctx.stroke();

  // Pinch roller + Head housing
  ctx.fillStyle = bg;
  ctx.strokeStyle = ink;
  ctx.fillRect(headX - 14, headY - 10, 28, 14);
  ctx.strokeRect(headX - 14, headY - 10, 28, 14);
  ctx.fillStyle = satPct > 50 || outPk > 0.55 ? accent : ink;
  ctx.beginPath();
  ctx.arc(headX, headY - 3, 2.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = ink;
  ctx.font = `700 ${compactHud ? 10 : 12}px "Geist Mono", monospace`;
  ctx.textBaseline = 'top';
  ctx.fillText(`${vizData.ips} IPS // ${formula}`, 12, 10);
  if (isDrop) {
    ctx.fillStyle = accent;
    ctx.fillText('DROP', p1End - 40, 10);
  }
  ctx.fillStyle = inkDim;
  ctx.font = `600 ${compactHud ? 9 : 10.5}px "Geist Mono", monospace`;
  ctx.fillText(`W/F ${Math.round(vizData.flutter)}% WOW ${Math.round(vizData.wow)}%`, 12, h - 19);

  // PANE 2: Real-Time B-H Hysteresis + Scope Overlay
  const hX = p1End + 12;
  const hW = p2End - p1End - 24;
  drawHysteresisLoop(ctx, hX, 26, hW, Math.max(40, h - 50), vizData, accent, ink, inkDim, border);

  // Live waveform overlay at bottom of Pane 2
  const wOut = tel.waveOut || [];
  if (wOut.length > 2) {
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    wOut.forEach((v, idx) => {
      const wx = hX + (idx / (wOut.length - 1)) * hW;
      const wy = h - 32 - v * 14;
      if (idx === 0) ctx.moveTo(wx, wy);
      else ctx.lineTo(wx, wy);
    });
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = ink;
  ctx.font = `700 ${compactHud ? 9.5 : 11}px "Geist Mono", monospace`;
  ctx.textBaseline = 'top';
  ctx.fillText('B-H HYSTERESIS', hX, 10);
  ctx.fillStyle = satPct > 65 ? accent : inkDim;
  ctx.font = `600 ${compactHud ? 9 : 10}px "Geist Mono", monospace`;
  ctx.fillText(`SAT ${satPct}% DRV ${Math.round(vizData.drive)}%`, hX, h - 19);

  // PANE 3: Head Bump / Spacing Loss Response + Dual IN/OUT VU
  const p3X = p2End + 12;
  const p3W = w - p3X - 12;
  ctx.fillStyle = ink;
  ctx.font = `700 ${compactHud ? 9.5 : 11}px "Geist Mono", monospace`;
  ctx.fillText('RESPONSE & VU', p3X, 10);

  const eqY = 28;
  const eqH = Math.max(36, Math.round(h * 0.38));
  const midEqY = eqY + eqH * 0.55;
  ctx.strokeStyle = border;
  ctx.strokeRect(p3X + 0.5, eqY + 0.5, p3W, eqH);
  ctx.beginPath();
  ctx.moveTo(p3X, midEqY);
  ctx.lineTo(p3X + p3W, midEqY);
  ctx.stroke();

  const ipsIdx = vizData.ipsIdx ?? 2;
  const bumpHz = HEAD_BUMP_HZ[ipsIdx];
  const bumpGain = (vizData.bump / 100) * 6.5;
  const lossHz = Math.max(1400, LOSS_CUTOFF_HZ[ipsIdx] * (1 - (vizData.loss / 100) * 0.72));
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const hz = 20 * Math.pow(1000, t);
    const octDist = Math.log2(hz / bumpHz);
    const bumpDb = bumpGain * Math.exp(-(octDist * octDist) / 0.45);
    const lossDb = -10 * Math.log10(1 + Math.pow(hz / lossHz, 2));
    const totalDb = Math.max(-18, Math.min(10, bumpDb + lossDb));
    const px = p3X + t * p3W;
    const py = midEqY - (totalDb / 14) * (eqH * 0.42);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  const vuTop = eqY + eqH + 10;
  const rowGap = Math.min(18, Math.max(12, Math.floor((h - vuTop - 8) / 2)));
  const drawRowVu = (lbl, val, ry) => {
    ctx.fillStyle = inkDim;
    ctx.font = '700 9px "Geist Mono", monospace';
    ctx.fillText(lbl, p3X, ry);
    const barX = p3X + 26;
    const barW = Math.max(20, p3W - 26);
    const segs = 14;
    const sw = barW / segs;
    const barH = Math.max(6, rowGap - 6);
    for (let i = 0; i < segs; i++) {
      const lit = (i + 1) / segs <= val;
      ctx.fillStyle = lit ? (i >= segs - 3 ? accent : ink) : border;
      ctx.fillRect(barX + i * sw, ry + 1, Math.max(2, sw - 2), barH);
    }
  };
  drawRowVu('IN', inPk, vuTop);
  drawRowVu('OUT', outPk, vuTop + rowGap);
}

function drawBrickchordViz(ctx, w, h, vizData, accent, ink, inkDim, bg, border) {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(4.5, 4.5, w - 9, h - 9);

  const chordName = vizData.chordName || '—';
  const roman = vizData.roman || '';
  const patches = ['JUNO', 'BRASS', 'PWM', 'PLUCK', 'FM', 'ORGAN'];
  const styles = ['CHORD', 'FOLK', 'POP', 'HARP', 'ARP', 'REP'];

  ctx.fillStyle = inkDim;
  ctx.font = '700 11px "Geist Mono", monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`${patches[vizData.patchIdx] || 'JUNO'} // ${styles[vizData.styleIdx] || 'CHORD'}`, 14, 12);

  if (roman) {
    ctx.fillStyle = vizData.active ? accent : inkDim;
    ctx.textAlign = 'right';
    ctx.fillText(roman, w - 14, 12);
  }

  ctx.fillStyle = vizData.active ? ink : inkDim;
  ctx.font = '700 32px "Geist Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(chordName, w * 0.5, h * 0.44);

  // Live waveform strip
  const scope = vizData.scope || [];
  if (scope.length > 4) {
    const midY = h * 0.78;
    ctx.strokeStyle = vizData.active ? accent : inkDim;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(scope.length / 64));
    let started = false;
    for (let i = 0; i < scope.length; i += step) {
      const px = 14 + (i / (scope.length - 1)) * (w - 28);
      const py = midY - scope[i] * (h * 0.14);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }
}

function drawVisualizer(canvas, vizData, accent, ink, inkDim, bg, border, isExpanded = false) {
  const ctx = canvas.getContext('2d');
  if (!vizData) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  if (vizData.type === 'tape-lcd') {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width > 20 ? rect.width : canvas.width;
    const cssH = rect.height > 20 ? rect.height : canvas.height;
    const bw = Math.max(60, Math.round(cssW * dpr));
    const bh = Math.max(40, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTapeLcd(ctx, cssW, cssH, vizData, accent, ink, inkDim, bg, border, isExpanded);
    ctx.restore();
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (vizData.type === 'eq-curve') {
    drawEqCurve(ctx, w, h, vizData, accent, ink, inkDim, bg, border);
    return;
  }
  if (vizData.type === 'comp-curve') {
    drawCompCurve(ctx, w, h, vizData, accent, ink, inkDim, bg, border);
    return;
  }
  if (vizData.type === 'reverb-depth') {
    drawReverbDepth(ctx, w, h, vizData, accent, ink, inkDim, bg, border);
    return;
  }
  if (vizData.type === 'delay-grid') {
    drawDelayGrid(ctx, w, h, vizData, accent, ink, inkDim, bg, border);
    return;
  }
  if (vizData.type === 'brickchord') {
    drawBrickchordViz(ctx, w, h, vizData, accent, ink, inkDim, bg, border);
    return;
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (vizData.type === 'waveform' || vizData.type === 'curve') {
    const pts = vizData.points || [];
    if (pts.length < 2) return;
    ctx.strokeStyle = vizData.type === 'curve' ? accent : ink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    pts.forEach((v, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h / 2 - v * (h * 0.42);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  } else if (vizData.type === 'grains') {
    for (const p of vizData.particles || []) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, Math.max(1.5, p.r), 0, Math.PI * 2);
      ctx.fillStyle = p.x > 0.5 ? accent : ink;
      ctx.fill();
    }
  } else if (vizData.type === 'meter') {
    const val = Math.max(0, Math.min(1, vizData.value || 0));
    const bars = 16;
    const bw = (w - 16) / bars;
    for (let i = 0; i < bars; i++) {
      const active = (i + 1) / bars <= val;
      ctx.fillStyle = active ? (i > 11 ? accent : ink) : border;
      ctx.beginPath();
      ctx.roundRect(8 + i * bw, h * 0.28, Math.max(2, bw - 3), h * 0.44, 2);
      ctx.fill();
    }
  }
}

export function createDspView() {
  const root = document.createElement('div');
  root.className = 'view-root';

  const strip = document.createElement('div');
  strip.className = 'ctx-strip';

  const chainScroll = document.createElement('div');
  chainScroll.className = 'dsp-chain-scroll';

  root.append(strip, chainScroll);

  let vizRefs = [];
  let rotaryRefs = [];

  function render() {
    const st = store.getState();
    const tr = st.tracks[st.selectedTrackId];

    // Context strip (unified track/instrument menu)
    strip.innerHTML = '';
    const trkBtn = document.createElement('button');
    trkBtn.className = 'ctx-chip solid';
    trkBtn.textContent = `${tr.code} ${tr.name} ▾`;
    const openInst = () => {
      st.detailOverlay = { type: 'inst-menu' };
      store.emit('overlay', st.detailOverlay);
    };
    trkBtn.onclick = openInst;
    attachLongPress(trkBtn, openInst);
    strip.appendChild(trkBtn);

    const sp = document.createElement('div');
    sp.className = 'ctx-spacer';
    strip.appendChild(sp);

    const addBtn = document.createElement('button');
    addBtn.className = 'ctx-chip solid';
    addBtn.textContent = '+ FX';
    addBtn.onclick = () => {
      st.devicePickerOpen = true;
      store.emit('device-picker', true);
    };
    strip.appendChild(addBtn);

    // Chain cards
    chainScroll.innerHTML = '';
    vizRefs = [];
    rotaryRefs = [];

    tr.inserts.forEach((slot, slotIdx) => {
      const def = getDevice(slot.deviceId);
      if (!def) return;

      if (slotIdx > 0) {
        const arrow = document.createElement('div');
        arrow.className = 'dsp-arrow';
        arrow.textContent = '──▶';
        chainScroll.appendChild(arrow);
      }

      const card = document.createElement('div');
      card.className = `dsp-card ${st.selectedDeviceSlotIdx === slotIdx ? 'focused' : ''} ${slot.bypass ? 'bypassed' : ''}`;
      card.addEventListener('pointerdown', () => {
        if (st.selectedDeviceSlotIdx !== slotIdx) {
          st.selectedDeviceSlotIdx = slotIdx;
          chainScroll.querySelectorAll('.dsp-card').forEach((c, idx) => c.classList.toggle('focused', idx === slotIdx));
        }
      });

      const hdr = document.createElement('div');
      hdr.className = 'dsp-card-hdr';
      const title = document.createElement('span');
      title.className = 'dsp-card-title';
      title.innerHTML = `<span class="dsp-dot"></span><span>${def.meta.name}</span>`;

      const actions = document.createElement('div');
      actions.className = 'dsp-card-actions';

      const openDetail = () => {
        st.selectedDeviceSlotIdx = slotIdx;
        if (slot.deviceId === 'drum8') {
          st.detailOverlay = { type: 'mpc', trackId: tr.id };
        } else if (slot.deviceId === 'brickchord') {
          st.detailOverlay = { type: 'brickchord', trackId: tr.id };
        } else {
          st.detailOverlay = { type: 'dsp', trackId: tr.id, slotIdx };
        }
        store.emit('overlay', st.detailOverlay);
      };

      if (slotIdx === 0 && slot.deviceId === 'drum8') {
        const mpcBtn = document.createElement('button');
        mpcBtn.className = 'ctx-chip active';
        mpcBtn.textContent = 'MPC';
        mpcBtn.onclick = (e) => {
          e.stopPropagation();
          st.detailOverlay = { type: 'mpc', trackId: tr.id };
          store.emit('overlay', st.detailOverlay);
        };
        actions.appendChild(mpcBtn);
      } else if (slotIdx === 0 && slot.deviceId === 'brickchord') {
        const padBtn = document.createElement('button');
        padBtn.className = 'ctx-chip active';
        padBtn.textContent = 'PAD';
        padBtn.onclick = (e) => {
          e.stopPropagation();
          st.detailOverlay = { type: 'brickchord', trackId: tr.id };
          store.emit('overlay', st.detailOverlay);
        };
        actions.appendChild(padBtn);
      } else if (slotIdx === 0) {
        const swap = document.createElement('button');
        swap.className = 'ctx-chip';
        swap.textContent = 'SWAP';
        swap.onclick = (e) => {
          e.stopPropagation();
          st.devicePickerOpen = true;
          store.emit('device-picker', true);
        };
        actions.appendChild(swap);
      }

      const detailHandle = document.createElement('button');
      detailHandle.className = 'dsp-handle-btn';
      detailHandle.innerHTML = FIVE_DOT_SVG;
      detailHandle.title = 'Inspect Module';
      detailHandle.onclick = (e) => {
        e.stopPropagation();
        openDetail();
      };
      actions.appendChild(detailHandle);

      if (slotIdx > 0) {
        const del = document.createElement('button');
        del.className = 'dsp-handle-btn';
        del.textContent = '✕';
        del.onclick = (e) => {
          e.stopPropagation();
          store.removeInsertDevice(tr.id, slotIdx);
        };
        actions.appendChild(del);
      }

      hdr.append(title, actions);
      attachLongPress(hdr, openDetail);

      const vizWrap = document.createElement('div');
      vizWrap.className = 'dsp-viz';
      const vizCanvas = document.createElement('canvas');
      vizCanvas.width = 440;
      vizCanvas.height = 196;
      vizWrap.appendChild(vizCanvas);
      vizRefs.push({ canvas: vizCanvas, slotIdx });

      attachLongPress(vizWrap, openDetail);

      const segWrap = document.createElement('div');
      segWrap.className = 'dsp-seg-group';

      const segParams = def.meta.params.filter((p) => p.control === 'segmented' && Array.isArray(p.options));
      const rotaryParams = def.meta.params.filter((p) => !(p.control === 'segmented' && Array.isArray(p.options)));

      for (const p of segParams) {
        if (p.showWhen && Math.round(slot.params[p.showWhen.param] ?? 0) !== p.showWhen.equals) {
          continue;
        }
        const row = document.createElement('div');
        row.className = 'dsp-seg-row';
        const lbl = document.createElement('span');
        lbl.className = 'dsp-seg-lbl';
        lbl.textContent = p.label;

        const bar = document.createElement('div');
        bar.className = 'dsp-seg-bar';
        bar.style.gridTemplateColumns = `repeat(${p.options.length}, 1fr)`;

        const curIdx = Math.round(slot.params[p.id] ?? p.default ?? 0);
        p.options.forEach((optLabel, optIdx) => {
          const btn = document.createElement('button');
          btn.className = `dsp-seg-btn ${curIdx === optIdx ? 'active' : ''}`;
          btn.textContent = optLabel;
          btn.onclick = (e) => {
            e.stopPropagation();
            engine.unlock();
            store.pushHistory(`${def.meta.name} ${optLabel}`);
            store.setDeviceParam(tr.id, slotIdx, p.id, optIdx);
            if (slot.deviceId === 'drum8' && p.id === 'kit' && optIdx >= 2) {
              engine.getDrumNode(tr.id)?.rerollKit?.();
              store.emit('drum-pads', { trackId: tr.id });
            }
            render();
          };
          bar.appendChild(btn);
        });

        row.append(lbl, bar);
        segWrap.appendChild(row);
      }

      const knobs = document.createElement('div');
      knobs.className = `dsp-knobs ${rotaryParams.length === 4 ? 'cols-2' : ''}`;
      const slotRotaries = [];

      rotaryParams.forEach((p, pIdx) => {
        const rot = createRotary({
          param: p,
          value: slot.params[p.id],
          size: 46,
          onGestureStart: () => store.beginGesture(`${def.meta.name} ${p.label}`),
          onGestureEnd: () => store.commitGesture(),
          onChange: (val) => store.setDeviceParam(tr.id, slotIdx, p.id, val)
        });
        rot.el.addEventListener('pointerdown', () => {
          st.selectedDeviceSlotIdx = slotIdx;
          st.selectedParamIdx = pIdx;
        });
        knobs.appendChild(rot.el);
        slotRotaries.push({ param: p, rot, pIdx });
      });

      const footer = document.createElement('div');
      footer.className = 'dsp-card-footer';
      const slotTag = document.createElement('span');
      slotTag.className = 'dsp-slot-tag';
      slotTag.textContent = slotIdx === 0 ? 'SRC' : `FX${slotIdx}`;
      footer.appendChild(slotTag);

      if (slotIdx > 0) {
        const moveWrap = document.createElement('div');
        moveWrap.style.display = 'flex';
        moveWrap.style.gap = '4px';
        moveWrap.style.alignItems = 'center';
        if (slotIdx > 1) {
          const leftBtn = document.createElement('button');
          leftBtn.className = 'dsp-handle-btn';
          leftBtn.textContent = '◀';
          leftBtn.title = 'Move Left';
          leftBtn.onclick = (e) => {
            e.stopPropagation();
            store.moveInsertDevice(tr.id, slotIdx, slotIdx - 1);
          };
          moveWrap.appendChild(leftBtn);
        }
        if (slotIdx < tr.inserts.length - 1) {
          const rightBtn = document.createElement('button');
          rightBtn.className = 'dsp-handle-btn';
          rightBtn.textContent = '▶';
          rightBtn.title = 'Move Right';
          rightBtn.onclick = (e) => {
            e.stopPropagation();
            store.moveInsertDevice(tr.id, slotIdx, slotIdx + 1);
          };
          moveWrap.appendChild(rightBtn);
        }
        const byp = document.createElement('button');
        byp.className = `dsp-bypass-sq ${slot.bypass ? 'bypassed' : 'active'}`;
        byp.title = slot.bypass ? 'Enable' : 'Bypass';
        byp.onclick = (e) => {
          e.stopPropagation();
          store.toggleDeviceBypass(tr.id, slotIdx);
        };
        moveWrap.appendChild(byp);
        footer.appendChild(moveWrap);
      } else {
        const swapMini = document.createElement('button');
        swapMini.className = 'dsp-bypass-sq active';
        swapMini.title = 'Swap Instrument';
        swapMini.onclick = (e) => {
          e.stopPropagation();
          st.devicePickerOpen = true;
          store.emit('device-picker', true);
        };
        footer.appendChild(swapMini);
      }

      rotaryRefs[slotIdx] = slotRotaries;
      if (segWrap.childElementCount > 0) {
        card.append(hdr, vizWrap, segWrap, knobs, footer);
      } else {
        card.append(hdr, vizWrap, knobs, footer);
      }
      chainScroll.appendChild(card);
    });

    const addArrow = document.createElement('div');
    addArrow.className = 'dsp-arrow';
    addArrow.textContent = '──▶';

    const addCard = document.createElement('button');
    addCard.className = 'dsp-add-card';
    addCard.textContent = '+ ADD';
    addCard.onclick = () => {
      st.devicePickerOpen = true;
      store.emit('device-picker', true);
    };

    chainScroll.append(addArrow, addCard);
  }

  store.subscribe((_, topic) => {
    if (['track', 'dsp-chain', 'dsp-bypass', 'view', 'history-restore'].includes(topic)) render();
  });
  render();

  function handleAction(action) {
    const st = store.getState();
    if (st.view !== 'DSP' || st.detailOverlay || st.devicePickerOpen) return;
    const tr = st.tracks[st.selectedTrackId];
    const slot = tr.inserts[st.selectedDeviceSlotIdx];
    const def = slot ? getDevice(slot.deviceId) : null;

    if (action.type === 'DPAD') {
      if (action.dir === 'LEFT') {
        st.selectedDeviceSlotIdx = Math.max(0, st.selectedDeviceSlotIdx - 1);
        render();
      } else if (action.dir === 'RIGHT') {
        st.selectedDeviceSlotIdx = Math.min(tr.inserts.length - 1, st.selectedDeviceSlotIdx + 1);
        render();
      } else if (action.dir === 'UP' || action.dir === 'DOWN') {
        const count = def?.meta.params.length || 1;
        st.selectedParamIdx = (st.selectedParamIdx + (action.dir === 'DOWN' ? 1 : -1) + count) % count;
      }
    } else if (action.type === 'A_HOLD') {
      if (slot?.deviceId === 'drum8') {
        st.detailOverlay = { type: 'mpc', trackId: tr.id };
      } else if (slot?.deviceId === 'brickchord') {
        st.detailOverlay = { type: 'brickchord', trackId: tr.id };
      } else {
        st.detailOverlay = { type: 'dsp', trackId: tr.id, slotIdx: st.selectedDeviceSlotIdx };
      }
      store.emit('overlay', st.detailOverlay);
    } else if (action.type === 'B' && st.selectedDeviceSlotIdx > 0) {
      store.toggleDeviceBypass(tr.id, st.selectedDeviceSlotIdx);
    } else if (action.type === 'X') {
      st.devicePickerOpen = true;
      store.emit('device-picker', true);
    } else if (action.type === 'STICKS') {
      if (action.lx || action.ly) {
        store.pushHistoryCoalesced(`dsp-xy-${tr.id}-${st.selectedDeviceSlotIdx}`, `${def?.meta.name || 'DSP'} XY`);
        const handled = engine.setDeviceXY(tr.id, st.selectedDeviceSlotIdx, action.lx, action.ly);
        if (!handled && def && def.meta.params.length >= 2) {
          const p0 = def.meta.params[0];
          const p1 = def.meta.params[1];
          const v0 = p0.min + ((action.lx * 0.5 + 0.5) * (p0.max - p0.min));
          const v1 = p1.min + ((action.ly * -0.5 + 0.5) * (p1.max - p1.min));
          store.setDeviceParam(tr.id, st.selectedDeviceSlotIdx, p0.id, v0);
          store.setDeviceParam(tr.id, st.selectedDeviceSlotIdx, p1.id, v1);
          rotaryRefs[st.selectedDeviceSlotIdx]?.[0]?.rot.setValue(slot.params[p0.id]);
          rotaryRefs[st.selectedDeviceSlotIdx]?.[1]?.rot.setValue(slot.params[p1.id]);
        }
      }
      if (action.ry && def) {
        const p = def.meta.params[st.selectedParamIdx] || def.meta.params[0];
        if (p) {
          store.pushHistoryCoalesced(`dsp-p-${tr.id}-${st.selectedDeviceSlotIdx}-${p.id}`, `${def.meta.name} ${p.label}`);
          const span = p.max - p.min;
          const speed = action.fine ? 0.005 : 0.02;
          const next = slot.params[p.id] - action.ry * span * speed;
          store.setDeviceParam(tr.id, st.selectedDeviceSlotIdx, p.id, next);
          rotaryRefs[st.selectedDeviceSlotIdx]?.[st.selectedParamIdx]?.rot.setValue(slot.params[p.id]);
        }
      }
    }
  }

  let overlayVizCanvas = null;
  let overlaySlotInfo = null;

  function tickOverlay() {
    const st = store.getState();
    if (st.detailOverlay?.type === 'dsp' && overlayVizCanvas && overlaySlotInfo) {
      const styles = getComputedStyle(document.documentElement);
      const accent = styles.getPropertyValue('--accent').trim();
      const ink = styles.getPropertyValue('--ink').trim();
      const inkDim = styles.getPropertyValue('--ink-dim').trim();
      const bg = styles.getPropertyValue('--bg').trim();
      const border = styles.getPropertyValue('--border').trim();
      const data = engine.getDeviceVisualizer(overlaySlotInfo.trackId, overlaySlotInfo.slotIdx);
      drawVisualizer(overlayVizCanvas, data, accent, ink, inkDim, bg, border, true);
    } else {
      overlayVizCanvas = null;
      overlaySlotInfo = null;
    }
  }

  function tick() {
    const st = store.getState();
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent').trim();
    const ink = styles.getPropertyValue('--ink').trim();
    const inkDim = styles.getPropertyValue('--ink-dim').trim();
    const bg = styles.getPropertyValue('--bg').trim();
    const border = styles.getPropertyValue('--border').trim();

    for (const ref of vizRefs) {
      const data = engine.getDeviceVisualizer(st.selectedTrackId, ref.slotIdx);
      drawVisualizer(ref.canvas, data, accent, ink, inkDim, bg, border);
    }
    tickOverlay();
  }

  function renderDevicePickerModal(modalEl) {
    const st = store.getState();
    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>DSP MODULE BROWSER // AUTO-DISCOVERED</span>`;
    const close = document.createElement('button');
    close.className = 'ctx-chip';
    close.textContent = 'CLOSE [B]';
    close.onclick = () => {
      st.devicePickerOpen = false;
      store.emit('device-picker', false);
    };
    hdr.appendChild(close);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    const makeSection = (title, items) => {
      const sec = document.createElement('div');
      sec.style.display = 'flex';
      sec.style.flexDirection = 'column';
      sec.style.gap = '6px';
      const lbl = document.createElement('div');
      lbl.className = 'rotary-lbl';
      lbl.textContent = title;
      const row = document.createElement('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'repeat(3, 1fr)';
      row.style.gap = '8px';

      for (const dev of items) {
        const btn = document.createElement('button');
        btn.className = 'ctx-chip';
        btn.style.height = '36px';
        btn.style.justifyContent = 'space-between';
        btn.innerHTML = `<span>${dev.meta.name}</span><span style="opacity:0.5">${dev.meta.params.length}P</span>`;
        btn.onclick = () => {
          store.addInsertDevice(st.selectedTrackId, dev.meta.id);
          st.devicePickerOpen = false;
          store.emit('device-picker', false);
        };
        row.appendChild(btn);
      }
      sec.append(lbl, row);
      return sec;
    };

    body.append(
      makeSection('INSTRUMENTS (SLOT 01)', getDevicesByCategory('instrument')),
      makeSection('EFFECTS (APPEND INSERT)', getDevicesByCategory('effect'))
    );
    modalEl.append(hdr, body);
  }

  function renderDetailOverlay(panelEl) {
    const st = store.getState();
    const { trackId, slotIdx } = st.detailOverlay;
    const tr = st.tracks[trackId];
    const slot = tr.inserts[slotIdx];
    const def = getDevice(slot.deviceId);

    const hdr = document.createElement('div');
    hdr.className = 'overlay-hdr';
    hdr.innerHTML = `<span>${tr.code} ${tr.name} // ${def.meta.name}</span>`;
    const close = document.createElement('button');
    close.className = 'ctx-chip';
    close.textContent = 'CLOSE [B]';
    close.onclick = () => {
      st.detailOverlay = null;
      store.emit('overlay', null);
    };
    hdr.appendChild(close);

    const body = document.createElement('div');
    body.className = 'overlay-body';

    overlayVizCanvas = document.createElement('canvas');
    overlayVizCanvas.width = 960;
    overlayVizCanvas.height = 240;
    overlayVizCanvas.style.width = '100%';
    overlayVizCanvas.style.height = 'clamp(128px, 35vh, 210px)';
    overlayVizCanvas.style.flexShrink = '0';
    overlayVizCanvas.style.borderRadius = '6px';
    overlayVizCanvas.style.border = '1px solid var(--border)';
    overlaySlotInfo = { trackId, slotIdx };
    requestAnimationFrame(() => tickOverlay());

    const allParams = [...def.meta.params, ...(def.meta.extendedParams || [])];
    const segParams = allParams.filter((p) => p.control === 'segmented' && Array.isArray(p.options));
    const rotaryParams = allParams.filter((p) => !(p.control === 'segmented' && Array.isArray(p.options)));

    if (segParams.length > 0) {
      const segWrap = document.createElement('div');
      segWrap.className = 'dsp-seg-group';
      for (const p of segParams) {
        if (p.showWhen && Math.round(slot.params[p.showWhen.param] ?? 0) !== p.showWhen.equals) {
          continue;
        }
        const row = document.createElement('div');
        row.className = 'dsp-seg-row';
        const lbl = document.createElement('span');
        lbl.className = 'dsp-seg-lbl';
        lbl.textContent = p.label;
        const bar = document.createElement('div');
        bar.className = 'dsp-seg-bar';
        bar.style.gridTemplateColumns = `repeat(${p.options.length}, 1fr)`;
        const curIdx = Math.round(slot.params[p.id] ?? p.default ?? 0);
        p.options.forEach((optLabel, optIdx) => {
          const btn = document.createElement('button');
          btn.className = `dsp-seg-btn ${curIdx === optIdx ? 'active' : ''}`;
          btn.textContent = optLabel;
          btn.onclick = () => {
            store.pushHistory(`${def.meta.name} ${optLabel}`);
            store.setDeviceParam(trackId, slotIdx, p.id, optIdx);
            if (slot.deviceId === 'drum8' && p.id === 'kit' && optIdx >= 2) {
              engine.getDrumNode(trackId)?.rerollKit?.();
              store.emit('drum-pads', { trackId });
            }
            panelEl.innerHTML = '';
            renderDetailOverlay(panelEl);
          };
          bar.appendChild(btn);
        });
        row.append(lbl, bar);
        segWrap.appendChild(row);
      }
      body.append(overlayVizCanvas, segWrap);
    } else {
      body.append(overlayVizCanvas);
    }

    const knobsRow = document.createElement('div');
    knobsRow.className = 'dsp-overlay-knobs';

    rotaryParams.forEach((p) => {
      const rot = createRotary({
        param: p,
        value: slot.params[p.id] ?? p.default,
        size: rotaryParams.length > 6 ? 50 : 62,
        onGestureStart: () => store.beginGesture(`${def.meta.name} ${p.label}`),
        onGestureEnd: () => store.commitGesture(),
        onChange: (v) => store.setDeviceParam(trackId, slotIdx, p.id, v)
      });
      knobsRow.appendChild(rot.el);
    });

    body.append(knobsRow);
    panelEl.append(hdr, body);
  }

  return {
    el: root,
    tick,
    tickOverlay,
    handleAction,
    renderDevicePickerModal,
    renderDetailOverlay
  };
}
