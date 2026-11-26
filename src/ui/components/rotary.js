import { input } from '../../input/gamepad.js';

function normFromValue(param, val) {
  if (param.curve === 'exp' && param.min > 0) {
    return Math.log(val / param.min) / Math.log(param.max / param.min);
  }
  return (val - param.min) / Math.max(1e-6, param.max - param.min);
}

function valueFromNorm(param, norm) {
  const t = Math.max(0, Math.min(1, norm));
  let val;
  if (param.curve === 'exp' && param.min > 0) {
    val = param.min * Math.pow(param.max / param.min, t);
  } else {
    val = param.min + (param.max - param.min) * t;
  }
  if (param.step) {
    val = Math.round(val / param.step) * param.step;
  }
  return Math.max(param.min, Math.min(param.max, val));
}

export function formatParamValue(param, val) {
  if (param.id === 'wave') return Math.round(val) === 0 ? 'SAW' : 'SQR';
  if (param.id === 'mode') return Math.round(val) === 0 ? 'SYNTH' : 'RACK';
  if (param.id === 'kit') return ['909', '808', 'RAND', 'COMBO'][Math.round(val)] || '909';
  if (param.id === 'time' && param.unit === '' && param.max === 5) {
    return ['16N', '8N', '8N.', '4N', '4N.', '2N'][Math.round(val)] || '8N.';
  }
  if (param.step >= 1 || Math.abs(val) >= 100) {
    return `${Math.round(val)}${param.unit || ''}`;
  }
  if (param.step >= 0.1) {
    return `${val.toFixed(1)}${param.unit || ''}`;
  }
  return `${val.toFixed(2)}${param.unit || ''}`;
}

export function createRotary({ param, value, size = 46, onChange, onGestureStart, onGestureEnd, compact = false }) {
  const root = document.createElement('div');
  root.className = 'rotary-unit';
  if (compact) root.style.width = '46px';

  let currentVal = value;
  const r = size * 0.38;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = (135 * Math.PI) / 180;
  const sweep = (270 * Math.PI) / 180;

  const lbl = document.createElement('div');
  lbl.className = 'rotary-lbl';
  lbl.textContent = param.label;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.classList.add('rotary-ring');

  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', String(cx));
  track.setAttribute('cy', String(cy));
  track.setAttribute('r', String(r));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'var(--border-strong)');
  track.setAttribute('stroke-width', '1.25');
  svg.appendChild(track);

  const arc = document.createElementNS(svgNS, 'path');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', 'var(--accent)');
  arc.setAttribute('stroke-width', '1.5');
  arc.setAttribute('stroke-linecap', 'round');
  svg.appendChild(arc);

  const pointer = document.createElementNS(svgNS, 'line');
  pointer.setAttribute('stroke', 'var(--ink)');
  pointer.setAttribute('stroke-width', '1.5');
  pointer.setAttribute('stroke-linecap', 'round');
  svg.appendChild(pointer);

  const valEl = document.createElement('div');
  valEl.className = 'rotary-val';

  if (!compact) root.appendChild(lbl);
  root.appendChild(svg);
  root.appendChild(valEl);

  function render(v) {
    currentVal = v;
    const norm = Math.max(0, Math.min(1, normFromValue(param, v)));
    const a1 = startAngle;
    const a2 = startAngle + sweep * norm;

    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    const large = sweep * norm > Math.PI ? 1 : 0;

    if (norm > 0.01) {
      arc.setAttribute('d', `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`);
    } else {
      arc.setAttribute('d', '');
    }

    const innerR = r * 0.42;
    pointer.setAttribute('x1', (cx + innerR * Math.cos(a2)).toFixed(2));
    pointer.setAttribute('y1', (cy + innerR * Math.sin(a2)).toFixed(2));
    pointer.setAttribute('x2', (cx + (r - 1.5) * Math.cos(a2)).toFixed(2));
    pointer.setAttribute('y2', (cy + (r - 1.5) * Math.sin(a2)).toFixed(2));
    valEl.textContent = compact ? param.label : formatParamValue(param, v);
  }

  render(value);

  let dragging = false;
  let startY = 0;
  let startNorm = 0;
  let lastTap = 0;

  root.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const now = performance.now();
    if (now - lastTap < 260) {
      onGestureStart?.();
      render(param.default);
      onChange(param.default);
      onGestureEnd?.();
      lastTap = 0;
      return;
    }
    lastTap = now;
    dragging = true;
    startY = e.clientY;
    startNorm = normFromValue(param, currentVal);
    onGestureStart?.();
    root.setPointerCapture(e.pointerId);
  });

  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const fine = input.isFineModifier() || e.shiftKey ? 0.25 : 1;
    const dy = (startY - e.clientY) / 140;
    const nextVal = valueFromNorm(param, startNorm + dy * fine);
    if (nextVal !== currentVal) {
      render(nextVal);
      onChange(nextVal);
    }
  });

  root.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false;
      onGestureEnd?.();
    }
  });

  root.addEventListener('pointercancel', () => {
    if (dragging) {
      dragging = false;
      onGestureEnd?.();
    }
  });

  return {
    el: root,
    setValue: render
  };
}
