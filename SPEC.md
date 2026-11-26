# ROOMSERVICE — Technical & UX Specification

## 1. Screen Architecture (`1280x960` 4:3 Layout)
The interface is locked to a 4:3 aspect ratio (centered cleanly with matte letterboxing if viewed on wider desktop monitors during testing, and filling 100% of the RG477V's `1280x960` display).

### Persistent Header Bar
- **Left:** `ROOMSERVICE` wordmark • `[●]` Record arm • `[▶]` Play/Stop • Tabular `BPM` readout • `SWG %` readout
- **Center:** 4 Primary Hardware Mode Tabs (`[ROLL]` • `ARR` • `MIX` • `DSP`)
- **Right:** Active Pattern/View badge (`P01`) + **Persistent Circular Dot-Matrix LED Canvas**

### View 1: `ROLL` (FL-Style Piano Roll — Default Home View)
- **Top Context Strip:** Active Track selector (`02 MONO-303`), Scale/Key Lock badge (`[F# MIN]`), Grid Snap (`[1/16]`), Ghost Pattern selector (`[GHOST: P01]`).
- **Main Grid:** Touch-first MIDI piano roll supporting tap-to-draw, drag-to-resize, horizontal/vertical pinch or stick pan/zoom, and multi-select.
  - **Ghost Notes:** Faint dotted outlines of notes from other patterns in the project rendered behind the active pattern.
  - **FL Slide Notes:** Any note can be toggled into a Slide/Portamento note (`[===↗]`), smoothly gliding pitch to the target note over its duration.
- **Bottom Contextual Lane (`Y` button cycles):**
  1. `VEL` — Per-note velocity bars
  2. `PROB` — Ableton-style per-note trigger probability (`0%–100%`)
  3. `SLIDE` — Toggle FL slide/portamento flags per note
  4. `CUT` — Per-note filter cutoff offset
- **MIDI Randomizer & Riff Machine (`X` button opens modal/overlay):**
  - Root note + 15 scales (Minor, Dorian, Phrygian, Lydian, Hirajoshi, Whole Tone, Chromatic, etc.)
  - Euclidean pulse generator (Steps, Hits, Rotation)
  - Melodic walk / arp generator, Octave spread, Note density `%`, Velocity jitter `%`, and **Seed Lock / Mutate 20%**.

### View 2: `ARR` (FL Playlist + Ableton Warped Audio + FL Automation Clips)
- **Top Clip Dock:** Numbered MIDI Patterns (`P01`–`P64`), Imported/Recorded Warped Audio Clips (`W01`+), and Freeform Automation Clips (`A01`+), plus `[+ IMPORT]` (File System Access API folder picker, drag-and-drop WAV/MP3, and live Mic/USB-C audio capture).
- **Freeform Timeline Grid:** Paint any pattern, audio clip, or automation clip onto any track lane without rigid track-to-instrument locks. Support slice, duplicate, and `Make Unique` (`X`).
- **Auto-BPM Detection & Warping:** On audio import, analyze audio buffer to auto-detect original BPM and transient onsets, auto-stretching to project `Tone.Transport.bpm`. Provide 4 Warp Modes per clip:
  1. `BEATS` (transient-preserving breakbeat stretch)
  2. `TONES` (smooth granular overlap for vocals/melodic loops)
  3. `TEXTURE` (live Grain Size & Spray granular cloud)
  4. `RE-PITCH` (linked speed/pitch)
- **FL Automation Clips (`Y` button `+AUTO`):** Creates an independent Bezier/breakpoint envelope clip on the timeline assignable to any Mixer or DSP device parameter.

### View 3: `MIX` (8-Channel Console Mixer + Return Buses)
- 8 vertical channel strips (`01`–`08`) + `SND A` (Tape Delay) + `SND B` (Algorithmic Reverb) + `MASTER` (with Brickwall Limiter).
- Each strip includes: channel name, `Send A` & `Send B` rotary dials, smooth vertical fader, dot-matrix peak/RMS meter, dB readout, and `[M]` Mute / `[S]` Solo hardware switches.

### View 4: `DSP` (Horizontal Left-to-Right Device Chain)
- Displays the active track's signal chain left-to-right: `[Instrument] ──▶ [EQ-3] ──▶ [COMP] ──▶ [FX...] ──▶ [+ ADD]`.
- Each device renders as a modular Nothing-style card with up to 6 rotary encoders, live mini-visualizer (EQ curve, gain-reduction bar, or grain cloud), and bypass toggle (`B`).

## 2. RG477V Physical Hardware Mapping (`navigator.getGamepads()`)
- `L1 / R1`: Cycle primary views (`ROLL` <-> `ARR` <-> `MIX` <-> `DSP`)
- `L2` (Hold): Fine-tune knob precision / Piano Roll Slide-Note modifier (`L2 + Select` toggles Nothing Black / White theme)
- `R2` (Hold): Transport & Live modifier (`R2 + Start` = Play/Stop, `R2 + Select` = Record, `R2 + D-Pad Left/Right` = Scrub playhead)
- `D-Pad`: Navigate grid cells, timeline bars, mixer channels, or device slots
- `Left Analog Stick`: Pan/Zoom (`ROLL`/`ARR`) or X/Y Performance Morph (`DSP`)
- `Right Analog Stick`: Turn selected rotary encoder, adjust note length/velocity, or ride mixer fader
- `A`: Confirm / Draw note / Paint clip (Long-press 450ms: Open Detail Panel)
- `B`: Delete note/clip / Bypass device / Close Detail Panel
- `X`: Open MIDI Randomizer (`ROLL`) / Make Unique (`ARR`)
- `Y`: Cycle Piano Roll bottom lane (`ROLL`) / Create Automation Clip (`ARR`)

## 3. Stock Factory Devices (`/src/devices/`)
1. `mono303.js` (Instrument): Acid monosynth with oscillator waveform, cutoff, resonance, env mod, decay, and native support for FL slide/glide notes.
2. `drum8.js` (Instrument): 8-voice synthesized + sample-capable drum kit (Kick, Snare, Clap, Closed Hat, Open Hat, Rim, Tom, Perc) mapped to C3–G3 in the Piano Roll.
3. `grain1.js` (Instrument): Granular synthesizer (`Tone.GrainPlayer`) with Grain Size, Overlap, Spray/Scatter, Pitch, Reverse probability, and X/Y stick scrubbing.
4. `polyfm.js` (Instrument): 4-voice polyphonic FM/subtractive synth for chords and pads.
5. `eq3.js` (Effect): 3-band EQ (`Low`, `Mid`, `Mid Freq`, `High`) with live frequency response curve.
6. `comp.js` (Effect): VCA compressor (`Threshold`, `Ratio`, `Attack`, `Release`, `Makeup`) with live gain-reduction meter.
7. `drive.js` (Effect): Warm saturation & bit-depth/sample-rate reducer.
8. `delay.js` (Effect): Tempo-synced ping-pong tape delay with feedback & lowpass damping.
9. `verb.js` (Effect): Lush algorithmic hall/plate reverb with decay, pre-delay, and damping.
