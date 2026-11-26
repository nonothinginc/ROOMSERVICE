export function analyzeAudioBuffer(audioBuffer) {
  const sr = audioBuffer.sampleRate || 44100;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const len = ch0.length;
  const duration = audioBuffer.duration || len / sr;

  // Downsample peaks for waveform display (160 bars)
  const peakCount = 160;
  const peaks = new Float32Array(peakCount);
  const block = Math.max(1, Math.floor(len / peakCount));
  for (let i = 0; i < peakCount; i++) {
    const start = i * block;
    const end = Math.min(len, start + block);
    let max = 0;
    for (let j = start; j < end; j += Math.max(1, Math.floor(block / 32))) {
      const v = Math.abs(ch0[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }

  // Energy-flux transient onset detection (10ms windows)
  const hop = Math.max(128, Math.floor(sr * 0.01));
  const numFrames = Math.floor(len / hop);
  const energies = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const offset = f * hop;
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const s = ch1 ? (ch0[offset + i] + ch1[offset + i]) * 0.5 : ch0[offset + i];
      sum += s * s;
    }
    energies[f] = Math.sqrt(sum / hop);
  }

  const transients = [];
  let avgEnergy = 0.01;
  let lastOnsetFrame = -10;
  for (let f = 1; f < numFrames; f++) {
    const e = energies[f];
    const diff = e - energies[f - 1];
    avgEnergy = avgEnergy * 0.94 + e * 0.06;
    if (diff > Math.max(0.025, avgEnergy * 0.65) && f - lastOnsetFrame >= 7) {
      transients.push((f * hop) / sr);
      lastOnsetFrame = f;
    }
  }

  // Inter-onset interval BPM histogram folded into 70..175 BPM
  const bins = new Float32Array(180);
  const maxCheck = Math.min(transients.length, 64);
  for (let i = 0; i < maxCheck; i++) {
    for (let j = i + 1; j < Math.min(maxCheck, i + 8); j++) {
      const dt = transients[j] - transients[i];
      if (dt <= 0.14 || dt >= 2.2) continue;
      let bpm = 60 / dt;
      while (bpm < 72) bpm *= 2;
      while (bpm > 175) bpm /= 2;
      const rounded = Math.round(bpm);
      if (rounded >= 72 && rounded <= 175) {
        bins[rounded] += 1;
        bins[rounded - 1] += 0.4;
        bins[rounded + 1] += 0.4;
      }
    }
  }

  let bestBpm = 128;
  let bestScore = -1;
  for (let b = 72; b <= 175; b++) {
    if (bins[b] > bestScore) {
      bestScore = bins[b];
      bestBpm = b;
    }
  }

  // Fallback to duration-based bar assumption if sparse transients
  if (bestScore < 1.5 && duration > 0.5) {
    const barsGuess = [1, 2, 4, 8];
    for (const bars of barsGuess) {
      const cand = (bars * 4 * 60) / duration;
      if (cand >= 80 && cand <= 165) {
        bestBpm = Math.round(cand);
        break;
      }
    }
  }

  return {
    detectedBpm: bestBpm,
    transients,
    peaks: Array.from(peaks),
    duration
  };
}

export function createDemoBreakBuffer(audioCtx, bpm = 128) {
  const sr = audioCtx.sampleRate || 44100;
  const beats = 8; // 2 bars
  const duration = (60 / bpm) * beats;
  const len = Math.floor(sr * duration);
  const buf = audioCtx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  const stepDur = (60 / bpm) / 4; // 16th note
  const totalSteps = 32;

  for (let step = 0; step < totalSteps; step++) {
    const start = Math.floor(step * stepDur * sr);
    const isKick = step % 8 === 0 || step === 10 || step === 22;
    const isSnare = step % 8 === 4 || step === 15 || step === 30;
    const isHat = step % 2 === 0;

    if (isKick) {
      const kLen = Math.min(len - start, Math.floor(sr * 0.22));
      for (let i = 0; i < kLen; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 14);
        const f = 48 + 115 * Math.exp(-t * 36);
        const s = Math.sin(2 * Math.PI * f * t) * env * 0.8;
        L[start + i] += s;
        R[start + i] += s;
      }
    }
    if (isSnare) {
      const sLen = Math.min(len - start, Math.floor(sr * 0.16));
      for (let i = 0; i < sLen; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 20);
        const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 28) * 0.35;
        const noise = (Math.random() * 2 - 1) * env * 0.45;
        L[start + i] += body + noise;
        R[start + i] += body + noise * 0.92;
      }
    }
    if (isHat) {
      const hLen = Math.min(len - start, Math.floor(sr * 0.055));
      for (let i = 0; i < hLen; i++) {
        const t = i / sr;
        const env = Math.exp(-t * 62);
        const hp = ((i % 2 === 0 ? 1 : -1) * 0.5 + (Math.random() * 2 - 1) * 0.5) * env * 0.22;
        L[start + i] += hp;
        R[start + i] += hp * 0.85;
      }
    }
  }

  for (let i = 0; i < len; i++) {
    L[i] = Math.tanh(L[i]);
    R[i] = Math.tanh(R[i]);
  }
  return buf;
}
