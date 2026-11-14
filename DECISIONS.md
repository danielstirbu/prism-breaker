# Design Decisions

The brief left some details open; these are the calls I made and why.

## Architecture & runtime

- **One classic `<script>`, one IIFE, `window.Game` as the single global.**
  The spec demanded a single namespace; the IIFE keeps Config, Input,
  AudioEngine, classes and helpers private.
- **Logical resolution 960×640, letterboxed by CSS.** All game math happens in
  logical pixels; the canvas is scaled to fit the window (capped by device
  DPR ≤ 2) so 1366×768 laptops, 1920×1080 desktops and 375×667 phones share
  identical physics. `ResizeObserver` + `resize` both trigger relayout.
- **Fixed 1/120 s physics with accumulator and a 250 ms frame clamp.** A
  backgrounded tab that returns with a huge delta-time cannot teleport the ball
  through bricks.
- **Menu keeps a live ambient ball** bouncing behind the menu overlay so the
  title screen is alive rather than a static image.

## Physics details

- **Sub-stepping per ball** so no sub-step moves the ball more than
  `R × 0.45`; guarantees no tunneling at 640 px/s or at 30 fps.
- **Brick bounce axis**: minimum-penetration axis, plus corner classification —
  if the contact point is closer to a corner than the face, the normal is
  derived from the corner vector, which prevents the classic "ball hugs the
  brick row" vibrato.
- **Angle clamping preserves the vertical direction** (deviation from *current*
  up/down is clamped to 9°–76°). A descending ball stays descending; only its
  steepness is bounded. A global "always clamp to upward cone" rule would make
  the ball magically reverse when falling steeply — that bug existed during
  development and is caught by the sticky/shield tests.
- **`atan2(0, -0) === PI` guard in Multi-Ball**: splitting while the source ball
  is still glued to the paddle used to aim clones straight down (they fell off
  screen). Now clones launch upward when the source is stuck.
- **Combo**: +1 per brick, ×8 cap, resets on paddle touch (classic Arkanoid
  feel), shown as a pulsing chip.
- **One brick per sub-step** so combos cannot be double-counted when a fast
  ball crosses a row.

## Content & balance

- **10 levels** authored as ASCII grids (`LevelManager.LEVELS`); readable,
  diffable, and quick to extend. `#` armor, `@` steel, `*` explosive, `~`
  moving, `X` boss.
- **Steel from level 3, moving bricks from level 4, boss at levels 5 (50 HP)
  and 10 (99 HP)** — escalation follows the brief's pacing hints.
- **Boss phases**: patrolling phase alternating with a pause phase that, below
  75% HP, spawns one minion brick in an adjacent free cell. Its HP bar lives in
  the HUD top strip.
- **Explosive chain reaction**: destroying an explosive queues all destroyable
  bricks in the 3×3 neighbourhood; queued explosives chain once each
  (visited-set), so chains terminate and cannot freeze the frame.
- **Power-up drop table** (20% of destroyable bricks): weighted — Multi 22%,
  then common pool; Autopilot capped at 2% (it is the strongest effect);
  Extra Life converts to Shield at max lives (6). Negative drops (Shrink,
  Fast Ball) appear only from level 3, matching the brief.
- **Durations**: timed effects last 12 s, Score ×2 lasts 60 s (it is a score
  multiplier, not a physical buff), Autopilot only 5 s so it cannot trivialise
  a level.
- **Dash**: ×1.75 paddle speed for ~1.2 s of meter, regenerating in 2.6 s;
  the HUD dash bar is the cooldown indicator the spec asked for.
- **Life system**: 3 lives (max 6); on loss, a 0.6 s respawn with the new ball
  glued to the paddle and 0.6 s of invulnerability (also disables sticky-catch
  during that window so an invulnerable ball cannot be captured).
- **Shield** is a single-use bottom barrier (consumed on one save), shown as a
  HUD chip and a glowing line on canvas.
- **Laser**: twin cannons, 0.25 s cooldown, hold-Space autofire; lasers damage
  bricks (armor takes 2 hits, boss takes 1 per shot) and never destroy steel.

## Presentation

- **All art procedural**: gradient-shaded bricks with bevels and cracks,
  paddle glow + dash trail, ball trail, per-row neon palette, synthwave sun +
  grid horizon background, subtle CRT scanlines/vignette via CSS, particles
  pooled (600 max) so GC pauses cannot stutter the loop.
- **All audio synthesised** (square/triangle/noise + small envelopes):
  paddle pock with pitch proportional to hit offset, brick ping pitched by
  row, armor clank, explosion noise burst, power-up arpeggio (major for good,
  diminished for bad), level-clear jingle, life-lost descending sweep. The
  AudioContext starts suspended and is resumed on the first user gesture
  (autoplay policy).
- **Ambient music is a soft triangle pad, not a sawtooth drone**: a stack of
  detuned sawtooths at 55/82/110 Hz behind a 240 Hz lowpass is perceived as
  one continuous buzz. The pad (A2/E3/A3/C4 triangles through a 340 Hz
  lowpass at gain 0.02) fades in on start, ducks to silence on pause /
  game-over / victory and stops on return to menu. Each noise SFX gets a
  fresh buffer: two sources sharing one AudioBuffer jump sample positions
  and click during explosion chains.
- **Screen shake + 15% hit-stop** on explosions and life loss; shake decays
  exponentially and is capped at 14 px so the view never disorients.

## Testing / tooling

- **`window.__GAME` hook exists only when the URL has `?test=1`**; the game
  itself never reads it, so shipping behaviour is the tested behaviour.
- **The smoke test binds IPv6 `[::1]:8001` first** (in this sandbox an IDE
  service already owns IPv4 `0.0.01` on port 8001) and falls back to an
  ephemeral IPv4 port; it asserts zero console errors/zero page errors for the
  whole session, then takes screenshots into `tools/shots/` (git-ignored).
- `PROMPT.md` and `tools/shots/` are git-ignored per the brief.
