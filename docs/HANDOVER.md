# ROOMSERVICE — Session Handover Hub

**Last Updated:** 2026-11-26  
**Latest Source Commit (`main`):** see `git log` (Skin v2 reskin, session 03)  
**Latest Live Deploy (`gh-pages`):** Skin v2 at `https://nonothinginc.github.io/ROOMSERVICE/`, pre-reskin look at `/ROOMSERVICE/legacy/` (tag `skin-legacy-v1`)  
**Service Worker Cache:** `roomservice-v14` ([public/sw.js](../public/sw.js))  
**Local Dev Server:** Vite (`npm run dev -- --host` on port `5173`; local network tunnel probes closed — outbound SSH/tunnel ports `22` and `7844` are blocked on this home network, so deploy to `gh-pages` for remote phone testing).

---

## 1. Locked-In Product & UX Decisions

Every decision below came directly from user feedback and **must not be regressed**:

1. **Zero-Demo Startup & 3×2 Boot Triage ([src/ui/triage.js](../src/ui/triage.js)):**
   - Never boot into a pre-filled demo song. New sessions present a clean 3×2 graphical start triage:
     - `RESUME` (when IndexedDB autosave exists) / `OPEN FILE` (`.roomservice` ZIP)
     - `RANDOM RIFF` -> opens instrument chooser (1st pick starts riff, optional additional instruments via `+`)
     - `AUDIO FILE` -> file picker, auto-BPM/transient detect, timeline clip
     - `MIC INPUT` -> record mic directly to warped clip or MPC pad
     - `DRUM RACK` -> immediate Drum Rack + Wireframe MPC editor
     - `BLANK` -> instrument chooser on empty canvas
2. **Piano Roll Ergonomics ([src/ui/views/roll.js](../src/ui/views/roll.js)):**
   - **Double-tap notes to delete** them cleanly.
   - **High-precision vertical pitch dragging** (`stepWithHysteresis` tracking pixel delta from note center so adjacent semitones never skip on phone touchscreens).
   - **Drum Mode (`DRUM-8`):** Immediately vertically centers **strictly the active drum sources** (`8` voices in `SYNTH` mode; active/loaded pads up to `16` in `RACK` mode).
   - **Decluttered Strip:** Top bar contains `Track/Inst ▾`, `MPC` (drums) or `Scale`, per-pattern `SWG` vertical-drag pill, `LANE` toggle, `RIFF` generator, and `⋯` overflow drawer (for `SNAP`, `LEN`, `GHOST`, `SLIDE`). Bottom `VEL`/`PROB`/`SLIDE`/`CUT` lane starts **hidden** (`rollLaneOpen: false`).
3. **Per-Clip / Per-Pattern Swing (Not Global):**
   - Removed global `SWG` from [src/ui/header.js](../src/ui/header.js).
   - Swing (`0..80%`) lives per Pattern (`patterns[id].swing`, edited via `SWG` in `ROLL`) and per Arrangement Clip (`clip.swing`, edited inside the clip context menu in `ARR`), applied dynamically per odd 16th-note step in `engine.onStep(time)`.
4. **Playlist / Arrangement (`ARR`) ([src/ui/views/arr.js](../src/ui/views/arr.js)):**
   - Single-bar dock (`P01..P64`, `W01+`, `A01+`, `✎` rename, `⋯` clip menu, **`FOLLOW`**, `+` modal).
   - Top `22px` bar ruler (tap to scrub step, horizontal drag to pan) + bottom draggable horizontal scrollbar rail (`.arr-scroll-rail`) + horizontal touch drag on empty space (quick tap paints on release; drag pans; 2-finger drag always pans).
   - `FOLLOW` toggle tracks the `SONG` playhead smoothly while playing.
   - Tapping an existing clip opens its editor (`ROLL` / Audio / Auto); double-tapping deletes it; long-pressing (`380ms`, `14px` move threshold) or tapping `⋯` opens the Clip Context Menu (**`OPEN EDITOR`**, **`RENAME CLIP`**, **`SWING`**, `WARP`, `SLICE`, `DUPLICATE`, `MAKE UNIQUE`, **`+LAB (STASH & HIDE)`**, `DELETE`).
   - Left lane headers display unified track names (`01 MONO-303`, etc.) by default; single-tapping or long-pressing opens the unified track/lane rename modal.
5. **LAB Vault & `.roomservice` Native ZIP Archive ([src/ui/lab.js](../src/ui/lab.js), [src/storage/project-archive.js](../src/storage/project-archive.js)):**
   - `+LAB` stashes/hides any clip (instead of losing ideas) while remembering its original `instrumentId`, `instrumentName`, `instrumentParams`, `notes`, `bpm`, and audio ref.
   - Full-screen `LAB` modal (`●` rail icon with badge dot) supports live solo waveform preview (`engine.previewLabItem`) and one-tap route to **`→ NEW CHANNEL`** or **`→ CURRENT TRACK`**.
   - Projects save/load as self-contained `.roomservice` ZIP archives (`manifest.json`, `project.json`, `lab.json`, `sessions.json`, `samples/*.wav`, `pads/*.wav`) via pure-JS uncompressed STORE ZIP + PCM WAV writer (`zip-wav.js`), alongside IndexedDB autosave and 50-slot Session Checkpoints + 200-step Undo/Redo history (`↶` hold).
6. **Calibrated Metering, Channel FX Access & Clean Zero-Send Mixing ([src/audio/engine.js](../src/audio/engine.js), [src/ui/views/mix.js](../src/ui/views/mix.js)):**
   - Uses `Tone.Context({ latencyHint: 'interactive', lookAhead: 0.02, updateInterval: 0.015 })`, `Tone.immediate()` on live triggers, synchronous `previewNote()` when unlocked, and lightweight native `BufferSource` triggers in `drum8.js`.
   - Default `sendA` and `sendB` on all 8 tracks are **`0`**.
   - `createStereoMeter(rawCtx)` provides true L/R Peak, RMS, `-0.1 dBFS` clip latch, and Master Limiter Gain Reduction (`grDb`) mapped on an IEC `0 / -6 / -12 / -24 / -48 dB` curve with `1.2s` peak hold and tappable Peak/Clip reset badges (`.mix-peak-badge`).
   - Channel strips include an `FX` rack pill (`.mix-fx-btn`) for inspecting, bypassing, deleting, or adding channel/return inserts directly from `MIX`, plus tappable bottom nameplates synced with `ARR` and `inst-menu.js`.
7. **Modular DSP Controls, MPC Pad Modulation & `TAPE-1` LCD ([src/ui/views/dsp.js](../src/ui/views/dsp.js), [src/ui/views/mpc-editor.js](../src/ui/views/mpc-editor.js), [src/devices/tape.js](../src/devices/tape.js)):**
   - Discrete params like `DRUM-8` `MODE`/`KIT`, `MONO-303` `WAVE`, and `TAPE-1` `IPS`/`TAPE` declare `control: 'segmented'`. Compact cards stay `<= 6` params while optional `meta.extendedParams` unlock inside full-screen hardware detail overlays.
   - `DRUM-8` features per-pad modulation (`P.TUNE`, `P.ENV`, `ATK`, `DEC`, `LP/HP/BP CUT`, `RES`, `DRV`, `PAN`, `LVL`) in both `RACK` & `SYNTH` modes plus global bus sculpting (`PUNCH`, `GLUE`, `SUB`, `AIR`, `HPF`, `WIDTH`) in the `MOD | SLICE | MAP | GLOBAL` MPC tabs.
   - `TAPE-1` (`src/devices/tape.js`) runs a 2x oversampled RK2 Jiles-Atherton hysteresis + modulated W/F delay `AudioWorklet` (`roomservice-tape-hysteresis`) paired with a real-time Teenage Engineering–inspired vector LCD (`drawTapeLcd`) showing twin rotating reels, magnetic head block, live `B-H` hysteresis loop, and expanded EQ/VU telemetry.
8. **Brickchord Pocket Chord Synth for Anbernic RG477V ([src/devices/brickchord.js](../src/devices/brickchord.js), [src/audio/brickchord-theory.js](../src/audio/brickchord-theory.js), [src/ui/views/brickchord-pad.js](../src/ui/views/brickchord-pad.js)):**
   - Inspired by `michaeltietjen/brickchord` (MIT): auto-discovered DSP instrument with 6 polyphonic engines (`JUNO | BRASS | PWM | PLUCK | FM | ORGAN`), 6 performance styles (`CHORD | FOLK | POP | HARP | ARP | REP`), resonant LP + wet ping-pong delay/reverb bus, and dedicated dry punchy synth bass follower.
   - Dedicated RG477V Performance Overlay (`PAD` / `CHORD` chip across `ROLL`, `DSP`, `MIX`, `inst-menu`, `triage`) switches `src/input/gamepad.js` into **raw 120Hz performance passthrough mode**: D-Pad (`I..IV`), `X/A/B` (`V..vii°`), held modifiers (`Y=FLIP`, `L1=7TH`, `R1=SUS4`, `L1+R1=9TH`), Left Hall Stick (8-way chord bends), Right Hall Stick (Cutoff X / Wet & Res Y + `R3` Hold), `L2` Latch, `L3` Style cycle, `R2` chord step-stamp to Pattern (`engine.recordChordToPattern`), `SELECT + D-Pad/Y` Key/Oct/Scale, and `SELECT + B` exit. Full multi-touch mirror on phones.

9. **Skin v2 Visual Grammar ([docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)):**
   - No outlined buttons; ghost / soft-key / primary / selector variants only. Engaged = red LED dot, never `ON/OFF` text. SVG icons only (no unicode control glyphs). Overlay titles `SECTION` + dim subtitle, no `//`. Close = single ✕ icon.
   - Red reserved for playhead, record, clip, active-view tick, LED, live hits. Rotary arcs are ink.
   - Mixer meters are user-approved: do not restyle them.
   - LIBRARY (`src/library/`) is the home for samples; Tone runs on a native AudioContext (see ARCHITECTURE §2).
   - Run `node tools/ui-audit.mjs <url> <out> 640x480@2 640x424@2 853x640@1.5 1280x960@1 412x915@2.6` before deploying UI changes; it must report 0 issues.

---

## 2. Session Handover Protocol

**Start of every new chat:**
1. Read `AGENTS.md` and `docs/HANDOVER.md`.
2. Check `git status` and recent commits in `docs/sessions/` before touching files.

**End of every working session (or milestone batch):**
1. Bump `CACHE_NAME` in `public/sw.js` if frontend assets changed.
2. Verify `npm run build` exits `0`.
3. Update `docs/HANDOVER.md` (latest commit hashes, changed architecture/UI decisions, open items) and add/update a dated log under `docs/sessions/YYYY-MM-DD-session-NN.md`.
4. Commit & push `main` and redeploy `dist/` to `gh-pages` (see `docs/DEPLOY.md`).

---

## 3. Open Items & Immediate Next Priorities

- **Pending User Review:** Skin v2 reskin + ring-button fix, playlist LOOP + >8-bar songs, playlist SAMPLE editor, Brickchord JAM (session 03). Compare look against `/ROOMSERVICE/legacy/`.
- **Project is now LOCAL-FIRST (2026-11-27):** the target is a sideloaded APK on the RG477V; GitHub is code backup only (no more Pages deploys needed). Packs live in `local-packs/` → `npm run packs` → `packs/` (both gitignored) and are bundled only into the APK.
- **APK:** Capacitor 8 (`android/`), `npm run apk` → `android/app/build/outputs/apk/debug/ROOMSERVICE.apk`. Needs JDK 21 (`/opt/homebrew/opt/openjdk@21`) + SDK platform 36 / build-tools 36 in `~/Library/Android/sdk` (installed by direct download; sdkmanager stalls). LuLu allows `java` (openjdk@21) since 2026-11-27; Gradle builds work (run outside the Claude sandbox).
- **Phase 1 hardening done** (see ARCHITECTURE §2 "Real-time hardening"). **Next: Phase 0 on the device** — read TELEMETRY (SLACK / LATE / DSP / GLITCH) under a dense session to decide whether a native Oboe engine is needed.
- **RG477V measured on device (2026-11-27):** Android 14, system WebView **Chrome 113** (old: renderCapacity/playoutStats unavailable → DSP/GLITCH show n/a; consider updating Android System WebView), app viewport **732×549 @1.75 DPR** (audit at `732x549@1.75`), AudioContext **48 kHz**, baseLatency **5.33 ms**, outputLatency **24 ms**, 8 cores, 185 GB free. `navigator.getGamepads()` sees **nothing** in the WebView → the native bridge is required; verified A/B/X/Y/L1/R1/L2/R2/SELECT/START map 1:1 to standard indices 0–9 (no swap), both sticks stream.
- **⚠ CURRENT BLOCKER (2026-11-27, end of session 04):** crackling/"bad buffer" sound in the APK. Root cause found on device: the RG477V's system WebView **113** (firmware allows no other WebView provider) moves all Web Audio rendering to a non-realtime thread as soon as any AudioWorklet module loads — the engine context measured **0.34× real time**; fresh contexts without worklets run at **1.0×**; the same code in **Chrome 158** on the device is clean. Fix committed but **untested on device**: `src/audio/platform.js` `WORKLETS_OK=false` on WebView < 120 → no `addModule()` anywhere (stretch falls back to Tone.GrainPlayer, TAPE deck unavailable, DRIVE/TAPE-1 use native fallbacks, native tap off). Next: run `npm run device:serve`, verify engine clock ≈1.0 via CDP and that the user hears clean drums. If WebView output still glitches: switch `native-out.js` tap to a ScriptProcessorNode and enable `NativeAudioOut` (AudioTrack + ring buffer, already in the APK).
- **Live device dev:** `npm run device:dev` (first time: builds dev-shell APK pointing at `http://localhost:5175` via `adb reverse`, installs, serves with hot reload) / `npm run device:serve` (later). Debug: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + CDP (`window.__rs`). WebView 113 allows only one DevTools client — kill hung clients before reconnecting. To return to the standalone app: `npm run apk` + install.
- **Crackle rule (2026-11-27):** on the RG477V WebView, JS AudioWorklets are NOT reliably real-time. Keep only native nodes in the default path: DRIVE's crusher worklet is spliced in only while RATE > 0; the TAPE deck only joins the master while its overlay is open or printing; idle stretch banks are disconnected. Buffer profiles measured on device: TIGHT 'interactive' 5.33 ms, LIVE (default) 0.01 → 10.67 ms, SAFE 'balanced' 20 ms ('playback' = ~300 ms output latency, never use). `window.__rs` is exposed in the APK for adb/CDP debugging.
- **Install over Wi-Fi:** Developer options → Wireless debugging (pair once with code). Then `adb mdns services` → `adb connect <ip:port>` → `adb -s <ip:port> install -r -g --no-streaming android/app/build/outputs/apk/debug/ROOMSERVICE.apk` (~60 s). USB adb fails through the Mac's hubs (pipe stall). Live debugging: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` + CDP.
- **Native gamepad bridge:** `MainActivity.java` maps Android key/motion events to the standard layout and calls `window.__rsNativePad`; B/BACK reach the app as B; immersive, keep-screen-on, landscape.
- **Local build:** `npm run dev:lan` → https://192.168.1.113:5173 (self-signed). `local-packs/*.zip` auto-seed the LIBRARY (local only).
- **TAPE deck** on the master (mode wheel / MIX → TAPE). TAPE-1 + DRIVE worklets now genuinely run (native AudioContext).
- **Sample packs are never committed/deployed** (public repo; third-party licences). Users import packs on-device via LIBRARY.
- **Next (agreed direction pending):** unification plan in `docs/sessions/2026-11-26-session-03.md` (LAB → LIBRARY CLIPS, JAM on all decks, factory kits in LIBRARY).
- **Ideas not built yet:** JAM for LEAD deck and MPC pads; take comping (pick a take from the LAB back onto the loop); gamepad control inside the SAMPLE editor.
- **Likely Next Follow-Ups:**
  1. Polish any mobile touch ergonomics / spacing quirks surfaced during phone testing (e.g., `MIX` pinned master width on sub-390px screens, `ARR` touch feel, or `MPC` pad editing on portrait phones).
  2. Code-split Tone.js / optional manual chunks in Vite if initial mobile load size (`564 kB` JS / `146 kB` gzip) needs trimming.
  3. On-device validation with the Anbernic RG477V (`1280x960` 4:3 touchscreen + Gamepad API bindings).

---

## 4. Next Chat Starter Prompt

Copy and paste this into your next chat:

```text
Continue ROOMSERVICE from /Users/nonothing/Work/ROOMSERVICE. Read AGENTS.md, docs/HANDOVER.md, docs/ARCHITECTURE.md, and the latest file in docs/sessions/ first so you have full context on our locked-in UX decisions, low-latency audio setup, modular DSP spec, and GitHub Pages deploy pipeline (https://nonothinginc.github.io/ROOMSERVICE/). Do not run local network tunnels (ports 22/7844 are blocked here); deploy verified updates to GitHub Pages. Here is my feedback from testing the latest build on my phone:
```
