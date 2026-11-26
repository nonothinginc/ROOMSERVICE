# ROOMSERVICE — Technical Architecture

## 1. Directory Map

```text
ROOMSERVICE/
├── index.html                   # Fullscreen viewport, Geist Mono font, manifest/icon links
├── vite.config.js               # base: './', server host: true (5173)
├── public/
│   ├── icon.svg                 # Monochrome Nothing/Rams vector icon
│   ├── manifest.webmanifest     # Landscape fullscreen PWA manifest (./ relative URLs)
│   └── sw.js                    # Offline cache ('roomservice-v3') & cache fallback
├── src/
│   ├── main.js                  # 3-zone chassis bootstrap, modal router, autosave & 120fps loop
│   ├── device-registry.js       # import.meta.glob('./devices/*.js', { eager: true }) auto-discovery
│   ├── styles/main.css          # Dark/Light theme tokens, 3-zone rails, Mix/ARR/DSP/MPC/Triage styling
│   ├── audio/
│   │   ├── engine.js            # Tone.js v15 AudioEngine, Transport clock, LAB preview, ZIP buffer I/O
│   │   ├── bpm-detector.js      # Peak & transient onset detection for imported/mic audio clips
│   │   └── drum-kits.js         # Offline synthesized 909/808 PCM kits + custom USER sample pool
│   ├── devices/
│   │   ├── mono303.js           # Acid mono synth (SAW|SQR segmented + FL slide portamento)
│   │   ├── drum8.js             # Hybrid 8-voice Synth & 16-pad Sampler Rack (SYNTH|RACK, 909|808|RAND|COMBO)
│   │   ├── grain1.js            # Granular synth + grain cloud particle visualizer
│   │   ├── polyfm.js            # 4-voice FM poly synth
│   │   ├── eq3.js               # 3-band EQ + interactive curve/band dot visualizer ('eq-curve')
│   │   ├── comp.js              # Compressor + transfer curve & telemetry ('comp-curve')
│   │   ├── drive.js             # Saturation + bitcrusher
│   │   ├── delay.js             # Ping-pong delay + stereo tap dot matrix ('delay-grid')
│   │   └── verb.js              # Reverb + concentric room contour visualizer ('reverb-depth')
│   ├── input/
│   │   └── gamepad.js           # 120Hz Web Gamepad API polling for RG477V controls & modifiers
│   ├── state/
│   │   ├── scales.js            # 15 scales, Euclidean pulses, riff/melody randomizer engine
│   │   └── store.js             # Global reactive store, 200-step undo/redo, 50-slot sessions, LAB silo
│   ├── storage/
│   │   ├── zip-wav.js           # Pure-JS STORE ZIP archiver/parser + PCM Float32->WAV encoder
│   │   └── project-archive.js   # .roomservice ZIP import/export & IndexedDB autosave
│   └── ui/
│       ├── dot-matrix.js        # Persistent circular micro-LED visualizer + full telemetry overlay
│       ├── header.js            # Left nav rail, slim transport header, Right master meter rail, Project/History modals
│       ├── inst-menu.js         # Unified top-left Instrument / Add Channel / Sampler switcher modal
│       ├── lab.js               # LAB vault modal with waveform solo preview & channel routing
│       ├── triage.js            # Zero-demo 3x2 Boot Triage + initial instrument chooser
│       ├── components/
│       │   ├── longpress.js     # Unified 450ms touch hold detector
│       │   └── rotary.js        # Rams thin-ring SVG rotary dial (shift/L2 fine control, double-tap reset)
│       └── views/
│           ├── roll.js          # Piano Roll / Drum Grid + per-pattern SWG + bottom VEL/PROB/SLIDE/CUT lane
│           ├── arr.js           # Playlist timeline, bar ruler, horizontal touch/rail pan, FOLLOW, clip rename/menu
│           ├── mix.js           # Scrollable channels + returns & pinned Master dock w/ 18-seg meters & dB scales
│           ├── dsp.js           # Auto-generated modular DSP strip w/ segmented controls & custom visualizers
│           └── mpc-editor.js    # Wireframe 4x4 MPC pad editor + needle chopper + SLICE/ZONE/MAP tabs
```

## 2. Audio Signal Flow & Latency Model

- **Context Tuning (`src/audio/engine.js`):** Configured on init with `latencyHint: 'interactive'`, `lookAhead: 0.02` (`20ms`), and `updateInterval: 0.015`.
- **Zero-Wait Live Triggers:** `Tone.immediate()` is used across all voice monotonic schedulers (`mono303.js`, `drum8.js`, `polyfm.js`, `grain1.js`), and `engine.previewNote()` executes synchronously whenever `store.getState().audioUnlocked` is true.
- **Channel Routing:**
  - `Instrument Slot 0` -> `[Active Insert FX 1..N]` -> `Channel Fader` -> `Panner` -> `Master Bus` -> `Master Gain` -> `Limiter` -> `Destination`.
  - Default `sendA` (Delay Return) and `sendB` (Reverb Return) gains are initialized to **`0`** on all 8 tracks.
- **Per-Pattern & Per-Clip Swing Scheduling:**
  - `Tone.getTransport().swing` remains `0`.
  - In `engine.onStep(time)`:
    - `PAT` mode offsets odd 16th steps (`localStep % 2 === 1`) by `(pat.swing / 100) * (stepDur * 0.5)`.
    - `SONG` mode resolves `clip.swing ?? pat.swing ?? 0` independently for each active pattern clip on the timeline.
- **Drum Sample Playback (`drum8.js`):** Rack mode triggers pads via `Tone.getContext().createBufferSource()` + `createGain()` connected to `bus` via `Tone.connect()`, avoiding `new Tone.Player()` allocation overhead on every drum hit.

## 3. Modular DSP Device Plugin Contract (`/src/devices/*.js`)

All `.js` files inside `/src/devices/` are automatically discovered by `src/device-registry.js` and rendered dynamically by `src/ui/views/dsp.js`:

- **`meta` Object:**
  - `{ id, name, category: 'instrument' | 'effect', visualizer, params }` (max 6 params per device).
  - **Continuous param (default rotary):** `{ id, label, min, max, default, step, unit, curve?: 'linear' | 'exp' }`.
  - **Discrete segmented pill param:** `{ id, label, control: 'segmented', options: [...], showWhen?: { param, equals }, min, max, default, step, unit }`.
- **`createNode(Tone)` Return API:**
  - `.input`, `.output`, `.setParam(id, value)`, `.dispose()`
  - Optional: `.getMeter()`, `.getVisualizerData()`, `.triggerNote(...)`, `.triggerSlide(...)`, `.releaseAll(...)`, `.setXY(x, y)`.

## 4. `.roomservice` Archive & Persistence

- **IndexedDB Autosave (`roomservice-autosave-v1`):** Debounced (`900ms`) snapshots triggered on note, arrangement, LAB, mixer, DSP, or restore events so `RESUME` appears immediately on next launch.
- **`.roomservice` ZIP Format (`src/storage/project-archive.js`):** Standard `.zip` archive (STORE method via `zip-wav.js`) containing:
  - `manifest.json` (format metadata & timestamp)
  - `project.json` (tracks, patterns, per-pattern swing, audio/auto clip metadata, timeline clips, return buses)
  - `lab.json` (LAB vault items with saved instrument state & MIDI notes)
  - `sessions.json` (session checkpoint history)
  - `samples/*.wav` and `pads/*.wav` (embedded PCM WAV audio buffers)
