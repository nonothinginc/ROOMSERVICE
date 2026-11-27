import { WORKLETS_OK } from './platform.js';
/**
 * Native output bridge (APK only). The final mix is tapped by an AudioWorklet, converted to
 * 16-bit PCM in 512-frame chunks and handed to MainActivity's NativeAudioOut, which plays it on
 * its own low-latency AudioTrack. The WebView's own output is muted (it still clocks rendering).
 * Without the bridge (browser), the graph plays through the normal destination.
 */
const WORKLET = String.raw`
class NativeTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 512;
    this.buf = new Int16Array(this.frames * 2);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    const L = ch && ch[0];
    if (!L) return true;
    const R = ch[1] || L;
    for (let i = 0; i < L.length; i++) {
      let l = L[i], r = R[i];
      l = l > 1 ? 1 : l < -1 ? -1 : l;
      r = r > 1 ? 1 : r < -1 ? -1 : r;
      this.buf[this.fill++] = l * 32767;
      this.buf[this.fill++] = r * 32767;
      if (this.fill >= this.buf.length) {
        this.port.postMessage(this.buf);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('roomservice-native-tap', NativeTap);
`;

function toBase64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x2000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x2000));
  return btoa(bin);
}

export function hasNativeOut() {
  // Uses an AudioWorklet tap: only where worklets are real-time (see platform.js)
  return WORKLETS_OK && typeof window !== 'undefined' && Boolean(window.RoomserviceAudio?.write);
}

/**
 * Route `source` (a native AudioNode or Tone node) to the native player.
 * Returns { ready: Promise<boolean>, stats(), latencySec() }.
 */
export function attachNativeOut(Tone, source, { targetMs = 60 } = {}) {
  const bridge = window.RoomserviceAudio;
  const ctx = Tone.getContext().rawContext;
  const state = { ok: false, stats: null, latencySec: 0 };
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  const ready = ctx.audioWorklet
    .addModule(url)
    .then(() => {
      const tap = new AudioWorkletNode(ctx, 'roomservice-native-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit'
      });
      // Keep the tap pulled by the graph, but silence the WebView's own output
      const mute = ctx.createGain();
      mute.gain.value = 0;
      tap.connect(mute);
      mute.connect(ctx.destination);
      tap.port.onmessage = (e) => bridge.write(toBase64(new Uint8Array(e.data.buffer)));
      bridge.start(ctx.sampleRate, targetMs);
      Tone.connect(source, tap);
      state.ok = true;
      const poll = () => {
        try {
          state.stats = JSON.parse(bridge.stats());
          state.latencySec = ((state.stats.fillMs || 0) + (state.stats.deviceBufferMs || 0)) / 1000;
        } catch {
          // ignore
        }
      };
      poll();
      setInterval(poll, 1000);
      return true;
    })
    .catch((err) => {
      console.warn('[native-out] unavailable', err);
      return false;
    })
    .finally(() => URL.revokeObjectURL(url));
  return {
    ready,
    get ok() {
      return state.ok;
    },
    stats: () => state.stats,
    latencySec: () => state.latencySec
  };
}
