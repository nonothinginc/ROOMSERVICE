# ROOMSERVICE — Hardware Industrial Design System (Skin v2)

Skin v2 (2026-11-26) replaced the outlined-chip look. The previous skin is preserved at git tag `skin-legacy-v1` / branch `legacy-skin` and live at `https://nonothinginc.github.io/ROOMSERVICE/legacy/`.

Grammar: Dieter Rams / Braun restraint + Teenage Engineering flatness + Nothing monochrome. **No outlined buttons anywhere.** Hairlines (`1px var(--border)`) only separate structural zones (rails, header, strips, card footers). Red (`--accent`) is reserved for: playhead, record/armed, clip, active-view tick, engaged-toggle LED, live hits.

## 1. Tokens (`src/styles/main.css`)

| Token | Nothing Black | Nothing White | Role |
| :--- | :--- | :--- | :--- |
| `--bg` | `#0D0D0F` | `#F4F4F2` | Chassis, rails, header, stage |
| `--surface` | `#121215` | `#EDEDEA` | Cards, selected strip, wells |
| `--fill` / `--fill-strong` | `ink 5.5% / 11%` | `ink 4.5% / 9%` | Soft-key rest / pressed or engaged |
| `--border` | `rgba(255,255,255,0.10)` | `rgba(0,0,0,0.12)` | Structural hairlines only |
| `--ink` / `--ink-dim` / `--ink-faint` | `#F2F0EC` / 50% / 22% | `#111113` / 52% / 20% | Values / labels / ticks |
| `--accent` | `#D71921` | `#D71921` | See red rule above |
| `--key-black` | `#08080A` | `#CFCFCA` | Piano-roll black keys |
| Type scale | `--t-micro 9` · `--t-label 10` · `--t-body 11` · `--t-value 13` px, weight 400/500 only | | |
| Radii | `3 / 4 / 6px` | | |

## 2. Controls

- **Ghost** (`.hdr-btn`, `.rail-btn`, `.icon-only`): no fill, no border; `--fill` on press. Icons are 16–18px SVG, `1.5` stroke, round caps (`.ico`). Never use unicode glyphs (`↶ ▶ ■ ✕`) for controls.
- **Soft key** (`.ctx-chip`): `--fill`, dim ink. **Engaged** (`.active`): ink text + `4px` red LED dot. State lives in the LED — never write `ON/OFF` in labels.
- **Primary** (`.ctx-chip.solid`): inverted ink block, one per surface max (SAVE, GENERATE, + FX).
- **Selector** (`.ctx-chip.track`): bare label + faint `▼`.
- **Segmented** (`.dsp-seg-bar`, `.mpc-seg-bar`, `.bc-seg-bar`): recessed well, inverted active segment.
- **Rotary** (`rotary.js`): 1px track, 2px **ink** value arc (bipolar params sweep from 12 o'clock), ink pointer. Compact knobs: `.rotary-unit.compact` (46px; 32px inside mixer strips).
- **Gamepad hints**: dim trailing `.pill-hint` (`FLIP  Y`), full binding in `title`.
- **Overlay titles**: `SECTION <i class="oh-sub">detail</i>` — no `//` separators, close is a single ✕ icon (`Close [B]` in title).
- **Native inputs**: range = 1px hairline + 12px ink thumb (red while dragging); selects = flat well + drawn chevron.

## 3. Frame & Views

- **Left rail (48px):** ghost icons in `--ink-dim`; active view = ink icon + 2px red tick on the rail edge. Bottom: mode-wheel ring (opens the L3 wheel directly via `input.emitWheel`), project gear.
- **Header (44px):** `P01` `PAT` · stop / play(pause) / rec glyph icons · hairline · BPM value (vertical drag) · metronome icon with state pip (none = off, red = rec-only, ink = always; count-in shows `1B` / live beat) · undo / redo SVG arrows (hold undo for history).
- **Right rail (48px):** dot-matrix cutout, twin master bars, half-moon finish toggle.
- **Mixer:** strips are flat; selected strip gets `--surface`. A / B / P compact knobs fit 106px strips; IEC meters unchanged.
- **DSP cards:** borderless `--surface` cards; focus shown by the red title dot; footer separated by a hairline.
- **Playlist (ARR):** timeline up to 64 bars; song plays to the last clip's bar. LOOP key (LED + range `1–8`) toggles the loop; ruler (28px) shows the brace — drag its edges to resize, drag inside to move, long-press the ruler and drag to draw a new loop, tap to scrub. Audio clips: drag left/right edge to trim (1/16 snap), tap to open the SAMPLE editor (trim / slip / fade handles on the waveform, GAIN, PITCH, warp mode, REV, SPLIT, FIT, ▶ preview). No D-pad cursor unless a gamepad is connected.
- **CHORD deck JAM:** JAM key → 1-bar count-in (big red digit) → loops the playlist loop (or bars 1–8), each pass is a take (TAKE n + bar strip). Stop → last complete take becomes a `JAMn` pattern clip on the Brickchord track's lane; earlier takes and replaced clips go to the LAB. The jam track's existing parts are muted while jamming.
- **Piano roll:** flat key column, black keys as short recessed bars, firmer hairline at each octave, scale root marked with a faint tick and label.

## 4. Breakpoints

- `<= 960px` wide or `<= 720px` tall: chassis is full-bleed (no 4:3 pillarbox).
- `561–960px` (RG477V 640×480 / 640×424, 853×640): keep MPC, Brickchord, Lead, Dot-matrix side-by-side.
- `<= 560px` (portrait phones): right rail collapses into the header dot slot; overlays stack.
- Verified with `tools/ui-audit.mjs` geometry sweep (0 overlaps / clips / sub-22px targets) at 640×480@2, 640×424@2, 853×640@1.5, 1280×960@1, 412×915@2.6.

## 5. Physical RG477V Gamepad Bindings (`src/input/gamepad.js`)

- `L1 / R1`: Cycle primary views (`ROLL` <-> `ARR` <-> `MIX` <-> `DSP`).
- `L2 + Select`: Toggle Nothing Black / Nothing White theme.
- `R2 + Start`: Play/Stop (`R2 + Select` = Record arm, `R2 + D-Pad L/R` = Scrub step).
- `D-Pad`: Grid cursor / track / lane / DSP slot navigation.
- `Left Stick`: Pan/Zoom (`ROLL`/`ARR`) or X/Y morph (`DSP`).
- `Right Stick`: Rotary value / note length & velocity / mixer fader (`L2` fine mode).
- `A` tap / `A` hold (450ms): Confirm/draw / Open contextual hardware detail overlay.
- `SELECT` (ARR): tap toggles the playlist loop; hold `SELECT` + `←/→` shrinks/grows the loop end, `SELECT` + `↑/↓` slides the loop one bar.
- `SELECT + START` (CHORD deck): start/stop JAM (count-in, loop, take capture). Plain `START` still plays/stops; stopping commits the jam.
- `B`: Delete selection / Bypass insert FX / Dismiss overlay.
- `X` / `Y`: Randomizer / Unique clip (`X`); Cycle bottom Roll lane / Create Auto clip (`Y`).
