/**
 * Tape machine drawing primitives (reels, tape path, heads, transport).
 * The tape "screen" is always a black display, in both hardware finishes.
 */

export const SCREEN = {
  bg: '#0A0A0B',
  ink: '#EDEBE6',
  dim: 'rgba(237, 235, 230, 0.46)',
  faint: 'rgba(237, 235, 230, 0.16)',
  hair: 'rgba(237, 235, 230, 0.09)',
  tape: '#2B2724',
  tapeEdge: '#4A433D',
  accent: '#D71921'
};

const TAU = Math.PI * 2;

/** Tangent point on circle (c, r) for a line coming from point p, on the given side (+1/-1). */
export function tangentPoint(cx, cy, r, px, py, side = 1) {
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d <= r) return { x: cx + (dx / d) * r, y: cy + (dy / d) * r };
  const base = Math.atan2(dy, dx);
  const off = Math.acos(r / d) * side;
  return { x: cx + Math.cos(base + off) * r, y: cy + Math.sin(base + off) * r };
}

/**
 * Detailed reel.
 * @param pack 0..1 fraction of the reel filled with tape
 * @param angle rotation in radians
 */
export function drawReel(ctx, cx, cy, R, angle, pack, opts = {}) {
  const c = { ...SCREEN, ...opts.colors };
  const hubR = R * 0.27;
  const packR = hubR + (R * 0.94 - hubR) * Math.max(0, Math.min(1, pack));

  // Flange backing (smoked)
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fillStyle = 'rgba(237, 235, 230, 0.035)';
  ctx.fill();

  // Tape pack with winding grooves and a soft sheen
  ctx.beginPath();
  ctx.arc(cx, cy, packR, 0, TAU);
  ctx.arc(cx, cy, hubR * 1.02, 0, TAU, true);
  ctx.fillStyle = c.tape;
  ctx.fill('evenodd');
  ctx.lineWidth = 0.6;
  const grooves = Math.max(3, Math.floor((packR - hubR) / 2.2));
  for (let i = 1; i < grooves; i++) {
    const gr = hubR + ((packR - hubR) * i) / grooves;
    ctx.strokeStyle = i % 4 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.035)';
    ctx.beginPath();
    ctx.arc(cx, cy, gr, 0, TAU);
    ctx.stroke();
  }
  ctx.strokeStyle = c.tapeEdge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, packR, 0, TAU);
  ctx.stroke();
  // Sheen fixed to the light, not the reel
  const sheen = ctx.createLinearGradient(cx - packR, cy - packR, cx + packR, cy + packR);
  sheen.addColorStop(0, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(255,255,255,0.04)');
  ctx.beginPath();
  ctx.arc(cx, cy, packR, 0, TAU);
  ctx.arc(cx, cy, hubR, 0, TAU, true);
  ctx.fillStyle = sheen;
  ctx.fill('evenodd');

  // Flange: rim + three windowed spokes that rotate with the reel
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 0.75;
  ctx.strokeStyle = c.faint;
  ctx.beginPath();
  ctx.arc(0, 0, R - 3, 0, TAU);
  ctx.stroke();
  for (let k = 0; k < 3; k++) {
    const a = (k * TAU) / 3;
    const w = 0.2; // spoke half-width (rad) at the rim
    ctx.beginPath();
    ctx.moveTo(Math.cos(a - 0.42) * hubR * 1.05, Math.sin(a - 0.42) * hubR * 1.05);
    ctx.lineTo(Math.cos(a - w) * (R - 3), Math.sin(a - w) * (R - 3));
    ctx.arc(0, 0, R - 3, a - w, a + w);
    ctx.lineTo(Math.cos(a + 0.42) * hubR * 1.05, Math.sin(a + 0.42) * hubR * 1.05);
    ctx.closePath();
    ctx.fillStyle = 'rgba(237, 235, 230, 0.13)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(237, 235, 230, 0.55)';
    ctx.lineWidth = 0.75;
    ctx.stroke();
    // Rivet near the rim
    ctx.beginPath();
    ctx.arc(Math.cos(a) * (R - 9), Math.sin(a) * (R - 9), 1.4, 0, TAU);
    ctx.fillStyle = c.ink;
    ctx.fill();
  }

  // Hub with drive teeth and index mark
  ctx.beginPath();
  ctx.arc(0, 0, hubR, 0, TAU);
  ctx.fillStyle = '#151517';
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1;
  ctx.stroke();
  const teethR = hubR * 0.5;
  ctx.beginPath();
  for (let t = 0; t < 6; t++) {
    const a = (t * TAU) / 6;
    const a2 = a + TAU / 12;
    ctx.lineTo(Math.cos(a) * teethR, Math.sin(a) * teethR);
    ctx.lineTo(Math.cos(a2) * teethR * 0.72, Math.sin(a2) * teethR * 0.72);
  }
  ctx.closePath();
  ctx.fillStyle = c.bg;
  ctx.fill();
  ctx.strokeStyle = c.dim;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(hubR * 0.78, 0, 1.6, 0, TAU);
  ctx.fillStyle = c.accent;
  ctx.fill();
  ctx.restore();

  return { packR, hubR };
}

/** Rounded head block with a gap line; `active` lights the gap. */
export function drawHead(ctx, x, y, w, h, active, colors = SCREEN) {
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y, w, h, 2.5);
  ctx.fillStyle = '#1A1A1D';
  ctx.fill();
  ctx.strokeStyle = colors.dim;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = active ? colors.accent : colors.faint;
  ctx.fillRect(x - 0.5, y + 1, 1, Math.max(2, h * 0.45));
}

/** Small rotating roller (guide / pinch). */
export function drawRoller(ctx, x, y, r, angle, filled = false, colors = SCREEN) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = filled ? colors.ink : '#141416';
  ctx.fill();
  ctx.strokeStyle = colors.dim;
  ctx.lineWidth = 1;
  ctx.stroke();
  if (!filled) {
    ctx.beginPath();
    ctx.arc(x + Math.cos(angle) * r * 0.55, y + Math.sin(angle) * r * 0.55, Math.max(0.8, r * 0.16), 0, TAU);
    ctx.fillStyle = colors.ink;
    ctx.fill();
  }
}

/**
 * Two-reel transport with tangent-correct tape path.
 * state: { angleL, angleR, packL, packR, speed, rollerAngle, headActive }
 */
export function drawTransport(ctx, x, y, w, h, state, colors = SCREEN) {
  const guideR = Math.max(3.5, h * 0.03);
  const pinchR = Math.max(5, h * 0.04);
  // Tape runs along tapeY; everything below it (pinch roller) must stay inside the box
  const tapeY = y + h - pinchR * 2 - 4;
  const R = Math.min((tapeY - y - guideR * 2 - 10) / 2, w * 0.2);
  const cy = y + 4 + R;
  const lx = x + w * 0.27;
  const rx = x + w * 0.73;
  const L = drawReel(ctx, lx, cy, R, state.angleL, state.packL, { colors });
  const Rr = drawReel(ctx, rx, cy, R, state.angleR, state.packR, { colors });

  const gL = { x: lx - R * 0.15, y: tapeY - guideR };
  const gR = { x: rx + R * 0.15, y: tapeY - guideR };
  const eraseX = x + w * 0.41;
  const headX = x + w * 0.5;
  const capX = x + w * 0.6;
  const capR = Math.max(2, guideR * 0.55);

  // Slack: tape droops between guides when the transport isn't pulling
  const tension = Math.min(1, Math.abs(state.speed));
  const sag = (1 - tension) * h * 0.03;

  // Reel pack -> outer side of each guide (tape wraps under the guide)
  const tL = tangentPoint(lx, cy, L.packR, gL.x - guideR, gL.y, 1);
  const tR = tangentPoint(rx, cy, Rr.packR, gR.x + guideR, gR.y, -1);
  ctx.strokeStyle = colors.tapeEdge;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(tL.x, tL.y);
  ctx.lineTo(gL.x - guideR, gL.y);
  ctx.arc(gL.x, gL.y, guideR, Math.PI, Math.PI / 2, true);
  ctx.quadraticCurveTo((gL.x + headX) / 2, tapeY + sag, headX - 8, tapeY);
  ctx.lineTo(capX + 8, tapeY);
  ctx.quadraticCurveTo((capX + gR.x) / 2, tapeY + sag, gR.x, tapeY);
  ctx.arc(gR.x, gR.y, guideR, Math.PI / 2, 0, true);
  ctx.lineTo(tR.x, tR.y);
  ctx.stroke();

  drawRoller(ctx, gL.x, gL.y, guideR, state.rollerAngle, false, colors);
  drawRoller(ctx, gR.x, gR.y, guideR, -state.rollerAngle, false, colors);
  // Heads sit on the tape (bottom edge touches it)
  const eh = Math.max(8, h * 0.05);
  const ph = Math.max(11, h * 0.07);
  drawHead(ctx, eraseX, tapeY - eh, Math.max(10, w * 0.035), eh, false, colors);
  drawHead(ctx, headX, tapeY - ph, Math.max(14, w * 0.05), ph, state.headActive, colors);
  // Capstan above the tape, pinch roller pressing up from below
  drawRoller(ctx, capX, tapeY - capR, capR, 0, true, colors);
  drawRoller(ctx, capX, tapeY + pinchR + 1, pinchR, state.rollerAngle * 1.6, false, colors);

  return { R, cy, lx, rx, packRL: L.packR, packRR: Rr.packR };
}
