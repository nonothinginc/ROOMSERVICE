# ROOMSERVICE — RG477V Dimensions, Overlap Elimination & Reference-Driven UI Spec

**Prepared:** 2026-11-26  
**Target Hardware:** Anbernic RG477V — 4.7" `1280×960` (4:3, 340.4 PPI) 120Hz capacitive touchscreen, Android 14, D-Pad, ABXY, L1/R1/L2/R2, Start/Select, Dual Hall Analog Sticks (L3/R3).  
**Companion Docs to Read First:** `AGENTS.md`, `docs/DESIGN_SYSTEM.md`, `docs/HANDOVER.md`, `docs/ARCHITECTURE.md`.  
**Original Visual Reference Sheets (User-Provided):**
- `/Users/nonothing/.gemini/antigravity/brain/e6ce40eb-7b21-480f-b91e-6b48c3f68067/.user_uploaded/media_1795677413777_cce053a4.jpg`
- `/Users/nonothing/.gemini/antigravity/brain/e6ce40eb-7b21-480f-b91e-6b48c3f68067/.user_uploaded/media_1795677414346_f8d62ca9.jpg`
- `/Users/nonothing/.gemini/antigravity/brain/e6ce40eb-7b21-480f-b91e-6b48c3f68067/.user_uploaded/media_1795677414985_b3d97cc5.jpg`

---

## 1. Real Anbernic RG477V Viewport & Ergonomics Math

A 4.7" `1280×960` panel has **340.4 PPI**. Android 14 maps this to **`xhdpi` (`devicePixelRatio = 2.0`)** by default (or `1.5` when display scaling is reduced):

| Mode on RG477V | CSS Viewport | Scale Factor | Physical Size of `32 CSS px` |
| :--- | :--- | :--- | :--- |
| Fullscreen PWA (`DPR 2.0`, primary) | **`640 × 480 CSS px`** | 1 mm ≈ 5.35 CSS px | ~6.0 mm (comfortable thumb tap) |
| Chrome w/ URL bar (`DPR 2.0`) | **`640 × 424 CSS px`** | 1 mm ≈ 5.35 CSS px | ~6.0 mm |
| Reduced Android scaling (`DPR 1.5`) | **`853 × 640 CSS px`** | 1 mm ≈ 7.13 CSS px | ~4.5 mm |
| Native 1:1 / Desktop preview (`DPR 1.0`) | **`1280 × 960 CSS px`** | Desktop | — |

### Root Cause of Almost Every Layout Failure Found in Live Chrome Audit
1. Existing CSS media queries (`@media (max-width: 760px)` and `@media (max-width: 720px)`) collapse multi-column handheld layouts (`MPC`, `BRICKCHORD`, `LEAD`, `DOT-MATRIX`) into portrait-phone single columns **right at the RG477V's native `640×480` CSS width**, pushing essential controls completely off-screen.
2. `.chassis` enforces `aspect-ratio: 4 / 3` (`width: min(100vw, calc(100dvh * 4 / 3))`) down to `561px`. In Android Chrome with a URL bar (`640×424`), this shrinks the app horizontally to `565×424` with wasted black pillarboxes on both sides.
3. Minimum interactive touch targets on `640×480` are currently `24px` (`4.5 mm`) and `7.5px–9px` font labels, making touch precision unnecessarily tight on a 4.7" screen.

### Viewport Breakpoint Contract (Enforce Across `src/styles/main.css`)
- **Full-bleed mobile & handheld chassis (`max-width: 960px`):** Remove forced `4/3` pillarbox shrinking; let `.chassis` fill `width: 100vw; height: 100dvh; aspect-ratio: auto; border: none; border-radius: 0;`. Keep the centered `4/3` framed chassis only on desktop (`min-width: 961px`).
- **4:3 Landscape Handheld (`561px..960px`, including `640×480` & `640×424`):** KEEP 2-column / 3-column hardware layouts (`MPC`, `BRICKCHORD`, `LEAD`, `DOT-MATRIX`) side-by-side!
- **Portrait Phone Only (`max-width: 560px`):** Collapse right rail into header dot slot, collapse multi-column overlays into scrollable single-column stacks.
- **Zero Background Focus Leakage:** Whenever `st.detailOverlay`, `st.randomizerOpen`, or `st.devicePickerOpen` is open, toggle `inert` on `leftRail.el`, `centerCol`, and `rightRail.el` so focus and clicks cannot leak underneath modals.

---

## 2. Verified P0/P1 Bugs & Overlaps to Fix (Zero Overlaps Permitted)

Every issue below was confirmed directly in headless Chrome renders at `640×480@2`, `640×424@2`, `853×640@1.5`, and `1280×960@1`:

### Bug 1 [P0 CRASH]: `LEAD + DRONE` Overlay Renders Completely Blank (`src/ui/views/lead-pad.js`)
- **Cause:** `lead-pad.js` treats `SCALES` as a keyed dictionary (`SCALES[st.scaleId] || SCALES.MIN` and `Object.keys(SCALES)`), whereas `src/state/scales.js` exports `SCALES` as an **Array** of `{ id, name, intervals }` objects plus `getScale(scaleId)`. `renderLeadOverlay()` throws `TypeError` immediately before appending `.overlay-panel`, leaving an empty blurred dark screen with no close button.
- **Fix:**
  - Import `{ ROOT_NOTES, SCALES, getScale, midiToName }` from `../../state/scales.js`.
  - In `getScaleMidi(degree, octShift)`: read `const sc = getScale(st.scaleId).intervals;`.
  - Cycle scale via `const idx = SCALES.findIndex((s) => s.id === st.scaleId); st.scaleId = SCALES[(idx + 1) % SCALES.length].id;`.

### Bug 2 [P0 OVERLAP]: Mixer Rotary Knobs (`A`, `B`, `P`) Collide Across Channel Strips (`src/styles/main.css`, `src/ui/views/mix.js`)
- **Cause:** Global `.rotary-unit { width: 64px; }` (`src/styles/main.css`) forces three `64px` knobs (`192px` total) inside a `106px`-wide `.mix-strip`! `P` overlaps the next channel's `A` knob by `36px`, clips into `.hw-left-rail`, and collides with the Master Dock `LIM` knob at **every viewport including `1280×960`**.
- **Fix (Aligned with Reference Image `f8d62ca9` Mixer):**
  - Give `.mix-strip` `overflow: hidden;` so nothing can ever bleed into adjacent channels or rails.
  - Restructure each channel strip cleanly like Reference Sheet 2 (`f8d62ca9`):
    - **Top row (`.mix-sends`):** 2 compact Send knobs (`A`, `B`) side-by-side (`size: 26`, scoped CSS `.mix-strip .rotary-unit { width: 42px; min-width: 0; gap: 2px; }` — total `86px` inside `106px`, zero overlap!).
    - **FX pill + `M | S` buttons + Peak dBFS badge** (`height: 24px`, crisp alignment).
    - **Fader + Stereo IEC Meter** (`flex: 1; min-height: 110px`).
    - **Bottom single centered `PAN` rotary** (`size: 26`, `width: 44px`) cleanly placed between the fader dB readout and bottom track nameplate (mirroring the reference mixer's bottom pan knob!).
  - On Master Dock: size `LIM` rotary cleanly (`width: 56px; size: 32;`), place `PUNCH` chip cleanly below it, and ensure zero overlap with the channel strip bay.

### Bug 3 [P0 OVERLAP & CUTOFF]: `BRICKCHORD` (and `LEAD`) Overlay Header Collides & Bottom Pads Clip Off-Screen (`src/styles/main.css`, `src/ui/views/brickchord-pad.js`, `src/ui/views/lead-pad.js`)
- **Cause:**
  1. `.overlay-hdr` has fixed `height: 40px` (`34px` under `max-height: 520px`) while `.bc-hdr` uses `flex-wrap: wrap` with 10 pills. At `640×480`, the 2nd wrapped row gets **sliced behind the `PATCH`/`STYLE` segmented bar**, hiding `BASS`, `LATCH`, `REC`, `STAMP`, `DSP`, and `CLOSE [SEL+B]`.
  2. `@media (max-width: 720px)` collapses `.bc-stage` and `.bc-deck` at `640×480`, pushing all 4 modifier pills half off-screen and pushing `V [X]`, `vi [A]`, `vii° [B]` completely outside `.bc-shell { overflow: hidden }`.
  3. At `1280×960`, `.bc-pad` stretches into tall skinny `200px` boxes.
- **Fix:**
  - Change `.overlay-hdr.bc-hdr` to `height: auto; min-height: 36px; padding: 5px 10px; flex-wrap: nowrap; overflow-x: auto;` AND tighten button labels to fit cleanly on ONE row at `640px` (`03 BRICK`, `C`, `MIN`, `0`, `BASS`, `LATCH`, `●`, `R2`, `DSP`, `✕`).
  - Keep `.bc-seg-strip` (`1fr 1fr`), `.bc-stage` (`1fr 1.8fr 1fr`), and `.bc-deck` (`1.2fr 0.85fr 1.15fr`) in their **horizontal multi-column layout down to `561px`!** Only stack vertically under `@media (max-width: 560px)`.
  - Cap `.bc-deck` height (`max-height: 280px`) and give `.bc-pad-cluster` clean centered square-ish pad proportions so pads never distort on `1280×960` and all 7 pads + 5 modifiers + 3 HUD canvases fit cleanly inside `640×480` and `640×424` with **zero clipping and zero scrolling**.

### Bug 4 [P0 OVERFLOW]: `BRICKCHORD` DSP Card `PATCH` Segmented Bar Bursts Past Right Card Border (`src/devices/brickchord.js`, `src/styles/main.css`)
- **Cause:** Inside a `256px` `.dsp-card`, the 6-option segmented bar `PATCH | JUNO | BRASS | PWM | PLUCK | FM | ORGAN` overflows the card's right edge by ~18px.
- **Fix:**
  - In `src/styles/main.css`: add `min-width: 0; overflow: hidden;` on `.dsp-seg-row` and `.dsp-seg-bar`; set `.dsp-seg-btn { min-width: 0; padding: 0 2px; font-size: 8.5px; overflow: hidden; text-overflow: ellipsis; }`.
  - In `src/devices/brickchord.js`: use crisp 3–4 char card option labels (`['JNO', 'BRS', 'PWM', 'PLK', 'FM', 'ORG']` and `['CRD', 'FLK', 'POP', 'HRP', 'ARP', 'REP']`) OR keep full names in the Brickchord overlay while keeping card pills crisp and unclipped.
  - Set `.dsp-card { width: 260px; min-width: 260px; overflow: hidden; }` on `640×480` so 2 cards + arrow sit cleanly inside the `546px` stage.

### Bug 5 [P0 CUTOFF]: `MPC` Overlay Collapses Vertically at `640×480`, Pushing Knobs Off-Screen (`src/styles/main.css`, `src/ui/views/mpc-editor.js`)
- **Cause:** `@media (max-width: 760px)` collapses `.mpc-layout` to 1 column at `640×480`, hiding all modulation knobs below the viewport.
- **Fix (Aligned with Reference Sheet 3 `SAMPLER` & Reference Sheet 2 `MPC`):**
  - Change the `.mpc-layout` single-column breakpoint from `760px` to **`560px`** (`@media (max-width: 560px)`).
  - At `640×480` (`561px..900px`), keep `.mpc-layout` **2-column side-by-side** (`grid-template-columns: 1fr 1.05fr; gap: 10px;`): 4×4 square pads on the left, compact Waveform (`height: 82px`) + `MOD | SLICE | MAP | GLOBAL` tabs + 3-column compact rotary grid (`size: 36`) on the right. Every pad, waveform, and knob is visible at once!

### Bug 6 [P0 CUTOFF]: `DOT-MATRIX` Telemetry Overlay Clips Calibration Bar at `640×480` (`src/styles/main.css`)
- **Cause:** `@media (max-width: 760px)` stacks `.dm-overlay-grid` to 1 column at `640×480`, pushing `ZERO CAL / DZ / STICKS / RESET` off the bottom.
- **Fix:** Change the `.dm-overlay-grid` single-column breakpoint from `760px` to **`560px`**. Use `grid-template-columns: minmax(150px, 210px) 1fr;` and `.dm-overlay-canvas { width: min(200px, 44dvh); height: min(200px, 44dvh); }` under `900px` so the circular LED display + telemetry + 16-button pad monitor + analog stick calibration bar all fit cleanly inside `640×480`.

### Bug 7 [P1 CUTOFF & STYLE VIOLATION]: `RIFF MACHINE` Randomizer Modal (`src/ui/views/roll.js`, `src/styles/main.css`)
- **Cause:**
  1. On `640×480`, `MUTATE 20%` and `GENERATE RIFF` are clipped at the bottom of `.overlay-modal`.
  2. Native Chrome **blue** `<input type="range">` sliders break the strict Nothing / Dieter Rams monochrome + Nothing Red design (`AGENTS.md` + Reference Sheets).
- **Fix:**
  - Style `.rand-range` with `-webkit-appearance: none; appearance: none;` using a crisp `2px` `var(--border-strong)` hairline track and `12px` circular `var(--ink)` thumb (`var(--accent)` on `:active`), matching Reference Sheet 2 (`METRONOME`) & Sheet 3 (`SETTINGS`).
  - Place `MUTATE 20%` and `GENERATE RIFF` in a pinned `.overlay-ftr` bar below `.overlay-body` (with `border-top: 1px solid var(--border); padding: 8px 12px;`) and tighten `.rand-row` padding (`5px 8px`) so all sliders + actions fit cleanly inside `640×480` without clipping.

### Bug 8 [P1 POLISH]: `PUNCH-IN FX`, `INSTRUMENTS` Menu & `ROLL` Detail Drawer
- **`PUNCH-IN FX` (`src/ui/views/mix.js`, `src/styles/main.css`):**
  - Change `.punch-xy-canvas` to `flex: 1; min-height: 180px; height: 100%;` so it fills the overlay body with zero wasted black space.
  - Draw a clean `var(--bg)` pill behind `DUB ECHO` and `TAPE CRUSH` labels so the dashed vertical crosshair never strikes through the text.
- **`INSTRUMENTS` Menu (`src/ui/inst-menu.js`):**
  - Replace truncated gibberish `dev.meta.visualizer.slice(0, 4)` (`BRIC`, `METE`, `GRAI`) with explicit clean category tags (`{ brickchord: 'CHORD', drum8: 'DRUM', grain1: 'GRAIN', mono303: 'ACID', polyfm: 'FM' }`).
  - Remove duplicate `BRICKCHORD` / `DRUM-8` entries: keep the auto-discovered instrument list cleanly and add a small `PAD` / `MPC` open-editor badge directly on `BRICKCHORD` / `DRUM-8` (keeping `+ SAMPLER [WAV]` as the dedicated audio-import action).
- **`ROLL` Detail Overlay (`src/ui/views/roll.js`):**
  - Group controls under crisp `.menu-section-hdr` headers (`GRID & RECORD`, `PATTERN LENGTH`, `KEY & SCALE`, `TRACK ACTIONS`) instead of an ungrouped pile of chips, matching Reference Sheet 3 (`SETTINGS`).

---

## 3. UI & Functional Enhancements Inspired by the 3 Reference Sheets

1. **Cleaner Top Header & Metronome Readout (Reference Sheets 1 & 2):**
   - Keep `CLK` ultra-clean and immediately understandable: use a crisp metronome dot/label (`MET` / `MET·R` / `MET×`, or `● 124.0` + `4/4` beat pulse dot) instead of cryptic `CLK·R+`, and ensure every header button is at least **`28px` tall** (`30px` on `>= 640px`) for reliable thumb tapping on the 4.7" touchscreen.
2. **Piano Roll (`ROLL`) Context Strip Restraint & Piano Key Contrast (Reference Sheets 2 & 3):**
   - On `640×480`, `ROLL`'s context strip currently squeezes 9 chips (`01 MONO-303 ▾`, `LEAD`, `F# MIN`, `4B`, `A·1/16`, `SWG 0%`, `LANE`, `RIFF`, `⋯`) at `24px` height.
   - Increase `.ctx-strip` to `38px` and `.ctx-chip` to `28px` height (`min-width: 30px`) for comfortable 4.7" touch accuracy.
   - Move `SWG 0%` and `A·1/16` into `ROLL` `⋯` when viewport width `<= 680px` (or combine `4B · 1/16` into one compact `4B·16` pill) so the remaining 6 primary chips (`Track ▾`, `MPC`/`CHORD`/`LEAD`, `F# MIN`, `4B`, `RIFF`, `⋯`) breathe effortlessly with zero crowding.
   - Boost Piano Roll white-key vs black-key contrast slightly (`--surface-elev` vs `--bg`) and highlight the active Scale Root (`F#`) subtly on the left key column so melodic navigation is instant.
3. **Arrangement (`ARR`) Inline Track Mute Dot & Level Bar (Reference Sheets 1 & 2):**
   - Reference Sheets 1 & 2 show `[● dot] [TRACK NAME] [mini horizontal level bar] [mini pan ring]` inside each `ARR` lane header.
   - Make the `●` status dot in `ARR` lane headers tappable to toggle track **Mute** (glowing dim when muted, solid ink when active, red when soloed) and draw a slim inline level slider bar (`32px` wide) reflecting `tr.volume` right beside the track name — immediately turning `ARR` lane headers into useful DAW controls!
4. **DSP Card Footer & Breathing Room (Reference Sheets 1–3):**
   - Keep the exact Ref 1–3 silhouette: `● MODULE NAME` top-left + subtle `5-dot` inspect icon top-right, spacious visual canvas, clean bottom encoder row, crisp square bypass indicator (`■` / `□`) bottom-right. Add a subtle `border-top: 1px solid var(--border)` above `.dsp-card-footer` and ensure `font-size` never drops below `9px` anywhere (`min 9.5–10px` on readable labels).
5. **Global Touch Ergonomics & Typography Floor:**
   - Eliminate sub-`9px` micro-text (currently `mix.js` has 55 elements at `7.5px` and 22 at `8.5px`!). Raise `.fader-scale` and `.mix-code` to `9px` minimum (`10px` on primary labels) and ensure all primary tap buttons (`rail-btn`, `hdr-btn`, `ctx-chip`, `ms-btn`, `bc-pad`) meet `>= 28–36px` hit targets.

---

## 4. Verification Protocol (Must Pass Before Deploying)

1. Run `npm run build` — verify exit code `0` and **zero** CSS/JS warnings.
2. Run a headless Chrome audit script (similar to `audit.mjs`) across **`640×480@2` (RG477V PWA)**, **`640×424@2` (RG477V Chrome)**, **`853×640@1.5`**, and **`1280×960@1`** covering ALL 4 views (`ROLL`, `ARR`, `MIX`, `DSP`) AND ALL overlays (`triage`, `inst-menu`, `roll`, `randomizer`, `mpc`, `dsp`, `mix-fx`, `punch`, `dotmatrix`, `brickchord`, `lead`, `mode-wheel`):
   - **0 runtime page errors** (`ov-lead` must render completely with all 7 pads & HUD).
   - **0 element-to-element overlaps** inside the active view or overlay (especially `MIX` knobs, `BRICKCHORD` header/pads, `DSP` segmented bars).
   - **0 clipped buttons/knobs** inside non-scrolling overlays (`MPC`, `BRICKCHORD`, `LEAD`, `DOT-MATRIX`, `RIFF MACHINE`, `PUNCH-IN FX`).
3. Bump `CACHE_NAME` in `public/sw.js` (`roomservice-v9` -> `roomservice-v10`), update `docs/HANDOVER.md` & `docs/sessions/2026-11-26-session-02.md`, push `main`, deploy `dist/` + `.nojekyll` to `gh-pages`, and verify `gh api` `status: "built"` + `curl -sI` `HTTP/2 200`.
