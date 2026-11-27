/**
 * Native-node Freeverb: same topology and tunings as Tone.Freeverb, without its AudioWorklets.
 *
 * Tone.Freeverb builds 8 FeedbackCombFilter AudioWorklets per instance. On the RG477V that cost
 * ~10.5% of a big core per reverb (measured with OfflineAudioContext), ~20x any other device.
 * Here each comb is a DelayNode feedback loop: w[n] = x[n] + r * w[n - D], out = w[n - D]
 * (identical to Tone's worklet), preceded by the same one-pole lowpass. ~2.3% per instance.
 * All comb delays are >= 1116 samples, above Web Audio's 128-frame minimum for cycles; the
 * cycle's extra render quantum is subtracted so the tunings match Tone's exactly.
 *
 * Interface: { input, output } are native AudioNodes (mono or stereo in, stereo out),
 * roomSize.setTargetAtTime(value, time, tc), dampening (Hz, setter), dispose().
 */
const COMB_TUNINGS = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((s) => s / 44100);
const ALLPASS_FREQS = [225, 556, 441, 341];

function onePoleLowpass(ctx, freq) {
  // Same coefficients as Tone.OnePoleFilter (lowpass)
  const t = 1 / (2 * Math.PI * freq);
  const a0 = 1 / (t * ctx.sampleRate);
  return ctx.createIIRFilter([a0, 0], [1, a0 - 1]);
}

export function createNativeFreeverb(ctx, { roomSize = 0.7, dampening = 3000 } = {}) {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const output = ctx.createGain();
  input.connect(split);
  merge.connect(output);

  const feedbacks = [];
  const combs = [];
  const half = COMB_TUNINGS.length / 2;

  for (let side = 0; side < 2; side++) {
    // Allpass chain for this side, into the merger
    const aps = ALLPASS_FREQS.map((f) => {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = f;
      return ap;
    });
    for (let i = 0; i < aps.length - 1; i++) aps[i].connect(aps[i + 1]);
    aps[aps.length - 1].connect(merge, 0, side);

    const tunings = side === 0 ? COMB_TUNINGS.slice(0, half) : COMB_TUNINGS.slice(half);
    for (const delayTime of tunings) {
      const lp = onePoleLowpass(ctx, dampening);
      const sum = ctx.createGain();
      const delay = ctx.createDelay(0.1);
      // Whole samples, rounded exactly as Tone's worklet does (float32 param, floor, +1 for its
      // write-then-read order): no interpolation smearing inside the loop. Minus the render
      // quantum (128 frames) Chrome adds to a DelayNode that closes a cycle. Bit-exact vs Tone.
      const frames = Math.floor(Math.fround(delayTime) * ctx.sampleRate) + 1;
      delay.delayTime.value = (frames - 128) / ctx.sampleRate;
      const fb = ctx.createGain();
      fb.gain.value = roomSize;
      split.connect(lp, side);
      lp.connect(sum);
      sum.connect(delay);
      delay.connect(fb);
      fb.connect(sum);
      delay.connect(aps[0]);
      feedbacks.push(fb);
      combs.push({ side, lp, sum, delay, fb, aps });
    }
  }

  let damp = dampening;

  return {
    input,
    output,
    roomSize: {
      setTargetAtTime(value, time, tc) {
        for (const fb of feedbacks) fb.gain.setTargetAtTime(value, time, tc);
      }
    },
    get dampening() {
      return damp;
    },
    set dampening(freq) {
      if (!(freq > 0) || freq === damp) return;
      damp = freq;
      // IIR coefficients are fixed: swap in a new lowpass per comb (as Tone.OnePoleFilter does)
      for (const c of combs) {
        const next = onePoleLowpass(ctx, freq);
        split.connect(next, c.side);
        next.connect(c.sum);
        const old = c.lp;
        c.lp = next;
        try {
          split.disconnect(old);
        } catch {
          // already gone
        }
        old.disconnect();
      }
    },
    dispose() {
      try {
        input.disconnect();
        split.disconnect();
        for (const c of combs) {
          c.lp.disconnect();
          c.sum.disconnect();
          c.delay.disconnect();
          c.fb.disconnect();
        }
        for (const c of combs) for (const ap of c.aps) ap.disconnect();
        merge.disconnect();
        output.disconnect();
      } catch {
        // ignore
      }
    }
  };
}
