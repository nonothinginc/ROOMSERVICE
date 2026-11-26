# ROOMSERVICE — Hardware Industrial Design System

Visual grammar blends **Dieter Rams / Braun** functional precision with **Nothing Phone 3** monochromatic hardware surfaces, soft `6px`–`8px` modular geometry, high-contrast tabular monospace (`Geist Mono`), and crisp `#D71921` Nothing Red active accents.

## 1. Dual Hardware Finishes (`L2 + Select` or Right Rail Toggle)

| Token | Nothing Black (Default) | Nothing White | Role |
| :--- | :--- | :--- | :--- |
| `--bg` | `#0D0D0F` | `#F4F4F2` | Primary canvas & recessed well |
| `--surface` | `#141418` | `#EAEAE6` | Card, rail, header & modal surface |
| `--surface-elev` | `#1C1C22` | `#FFFFFF` | Active clips & elevated pills |
| `--surface-recessed` | `#09090B` | `#DFDFDA` | Segmented wells, meter troughs, pads |
| `--border` | `rgba(255,255,255,0.09)` | `rgba(0,0,0,0.09)` | Structural `1px` hairlines |
| `--ink` | `#F2F0EC` | `#111113` | High-contrast labels, values & active fills |
| `--accent` | `#D71921` | `#D71921` | Playhead, record arm, peak meter segments |

## 2. 3-Zone Hardware Frame

- **Left Navigation Rail (`46px` wide, `38px` under `560px`):** `1.5px` geometric SVG icon buttons for `ROLL`, `ARR`, `MIX`, `DSP`, `LAB` (with Nothing Red dot badge when items exist), and bottom `PROJECT`/Settings gear. Active state fills a soft rounded square (`var(--ink)` background / `var(--bg)` icon).
- **Slim Top Header (`44px` tall):**
  - Left: `ROOMSERVICE` wordmark (opens Project modal), pattern badge (`P01`), `PAT` / `SONG` mode toggle.
  - Center: `■` Stop, `▶`/`❚❚` Play/Pause, `●` Record arm, vertical-drag `BPM` readout.
  - Right: `↶` Undo (hold 450ms for History/Sessions drawer), `↷` Redo, and responsive mobile Dot-Matrix mount slot.
- **Right Telemetry Rail (`46px` wide, collapses `< 560px`):** Top circular [dot-matrix.js](../src/ui/dot-matrix.js) canvas cutout (tap cycles Wave/Grain/Ring; long-press opens full-screen telemetry), middle twin vertical Master L/R bar meters, bottom hardware theme dot.

## 3. Custom Module Visualizers & Controls

- **Rams Rotary Encoders (`rotary.js`):** Thin `1.25px` open-circle track, `1.5px` Nothing Red value arc, crisp radial tick indicator, `L2`/Shift `0.25x` fine control, double-tap default reset.
- **Segmented Discrete Selectors (`dsp.js`):** Params with `control: 'segmented'` render inside recessed pill tracks (`--surface-recessed`) with solid inverted active buttons (e.g., `DRUM-8` `SYNTH | RACK`, `909 | 808 | RAND | COMBO`; `MONO-303` `SAW | SQR`).
- **Bespoke DSP Cards:**
  - `EQ-3`: Smooth logarithmic curve (`20`–`10k`) with live low/mid/high control dots.
  - `COMP`: Gain reduction transfer curve (`-36..0 dB`) + knee dot alongside stacked `THRESH / RATIO / ATTACK / RELEASE` numbers.
  - `VERB`: Concentric tonal room depth contours + live edge pulse alongside `SIZE / DECAY / MIX`.
  - `DELAY`: Dotted `8×6` tap matrix with stereo ping-pong tap stems alongside `TIME / FEEDBACK / MIX`.
- **Mixer (`mix.js`):** Scrollable 8-channel + `SND A` / `SND B` bay beside a **pinned right-side `MASTER` dock** with calibrated `+6 / 0 / -6 / -12 / -24 / -∞` dB scales, unity tick, upright **18-segment peak-hold bar meters** (twin L/R on Master), and tappable/swipeable bottom channel labels.

## 4. Physical RG477V Gamepad Bindings (`src/input/gamepad.js`)

- `L1 / R1`: Cycle primary views (`ROLL` <-> `ARR` <-> `MIX` <-> `DSP`).
- `L2 + Select`: Toggle Nothing Black / Nothing White theme.
- `R2 + Start`: Play/Stop (`R2 + Select` = Record arm, `R2 + D-Pad L/R` = Scrub step).
- `D-Pad`: Grid cursor / track / lane / DSP slot navigation.
- `Left Stick`: Pan/Zoom (`ROLL`/`ARR`) or X/Y morph (`DSP`).
- `Right Stick`: Rotary value / note length & velocity / mixer fader (`L2` fine mode).
- `A` tap / `A` hold (450ms): Confirm/draw / Open contextual hardware detail overlay.
- `B`: Delete selection / Bypass insert FX / Dismiss overlay.
- `X` / `Y`: Randomizer / Unique clip (`X`); Cycle bottom Roll lane / Create Auto clip (`Y`).
