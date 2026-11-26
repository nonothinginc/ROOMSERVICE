# ROOMSERVICE — Session Handover Hub

**Last Updated:** 2026-11-26  
**Latest Source Commit (`main`):** `8a2af16` (`Add authentic 808/909 samples & VA circuit DSP, Piano Roll pinch-zoom & 4-beat/multi-bar controls, live REC overdub, log faders, pan & FX reorder`)  
**Latest Live Deploy (`gh-pages`):** `c87a0e8` (`status: built`, `HTTP/2 200` at https://nonothinginc.github.io/ROOMSERVICE/)  
**Service Worker Cache:** `roomservice-v6` ([public/sw.js](../public/sw.js))  
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

- **Pending User Review:** User is testing commit `c87a0e8` (`main: 8a2af16`) on their phone via https://nonothinginc.github.io/ROOMSERVICE/.
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
