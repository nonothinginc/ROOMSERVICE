# ROOMSERVICE — Always-On Engineering & Industrial Design Rules

## 1. Project Identity & Target Hardware
- **App Name:** ROOMSERVICE
- **Target Device:** Anbernic RG477V (Android 14, MediaTek Dimensity 8300, 12GB LPDDR5X RAM, 4.7" 1280x960 4:3 120Hz capacitive touchscreen, D-Pad, ABXY, L1/R1/L2/R2, Start/Select, Dual Hall Analog Sticks).
- **Stack:** Vite + Vanilla JavaScript/TypeScript + HTML5 Canvas (120fps) + `tone` (Tone.js v15+) + WebAudio `AudioWorklet` + Offline Progressive Web App (`vite-plugin-pwa` or custom service worker + manifest). Must run fullscreen in Chrome/Brave on Android with zero browser UI.

## 2. Strict Industrial Design System (Nothing Phone 3 + Dieter Rams)
- **Zero Text Clutter:** Never render explainer paragraphs, onboarding tooltips, or verbose labels inside the UI. Rely strictly on crisp tabular numbers, monospaced geometric typography (`Geist Mono` / `JetBrains Mono` / `DIN`), `1px` structural hairlines, and unambiguous geometric indicators.
- **Dual Hardware Finishes (`L2 + Select` toggles live):**
  - **Nothing Black (Default):** `#0D0D0F` matte obsidian chassis, `rgba(255,255,255,0.10)` smoked-glass modular borders, `#F2F0EC` bone-white ink, `#D71921` Nothing Red active playhead/record accents.
  - **Nothing White:** `#F4F4F2` ceramic matte chassis, `rgba(0,0,0,0.12)` exposed trace hairlines, `#111113` ink, `#D71921` Nothing Red active accents.
- **Persistent Circular Dot-Matrix Display:** A circular micro-LED dot-matrix Canvas component must remain persistently mounted in the top-right header cutout across all 4 primary views (`ROLL`, `ARR`, `MIX`, `DSP`). It renders live reactive audio waveforms, granular particle clouds, or CPU/peak rings with zero text labels.
- **Long-Press Detail Panels:** Long-pressing (450ms touch hold or `A` button hold) on the circular dot-matrix display, any active view, or any DSP device card must open a full-screen dedicated hardware inspection overlay (e.g., full-screen high-res dot-matrix visualizer + CPU/voice/buffer telemetry, expanded Piano Roll scale/randomizer matrix, or full-screen EQ/granular canvas). Press `B` or tap close to dismiss.

## 3. Modular DSP Plugin Architecture (`/src/devices/*.js`)
- Never hardcode synth or effect UIs into the main shell.
- Every instrument and effect must live as a self-contained module inside `/src/devices/` exporting:
  1. `meta`: `{ id, name, category: 'instrument' | 'effect', visualizer?: 'waveform' | 'curve' | 'grains' | 'meter', params: [{ id, label, min, max, default, step, unit, curve?: 'linear' | 'exp' }] }` (max 6 rotary encoders/toggles per module).
  2. `createNode(Tone)`: Instantiates and returns a connected Tone.js / WebAudio / AudioWorklet processing node with `.input`, `.output`, `.setParam(id, value)`, `.getMeter()` (optional), and `.dispose()`.
- Automatically discover all modules in `/src/devices/` using `import.meta.glob('./devices/*.js', { eager: true })` so dropping a new vibe-coded `.js` device file into `/src/devices/` immediately registers it in the `DSP` rack browser with auto-generated Nothing/Rams rotary controls.

## 4. Performance & Audio Stability
- Strictly decouple audio scheduling (`Tone.getTransport()` lookahead clock) from UI rendering (`requestAnimationFrame`).
- Always unlock `Tone.start()` cleanly on first touch or Gamepad button press.
- Deliver complete, working code with zero placeholder stubs or `TODO` omissions.
