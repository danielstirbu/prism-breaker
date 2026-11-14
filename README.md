# Prism Breaker

A complete, modern neon Breakout / Arkanoid for the browser: one HTML shell,
one stylesheet, one classic script. No build step, no dependencies, no
downloaded assets — everything is drawn procedurally on a 2D canvas and every
sound is synthesised with the Web Audio API.

## Run it

```bash
cd prism-breaker
python3 -m http.server 8001
```

Then open <http://localhost:8001>. Opening `index.html` directly from the file
system also works (classic `<script>` tag, no modules).

## Controls

| Input | Action |
| --- | --- |
| `←` `→` / `A` `D` | Move the paddle (acceleration + friction) |
| Mouse / touch drag | Move the paddle directly |
| `Shift` | Dash — short speed boost, draining meter with cooldown (HUD bar) |
| `Space` / click / tap | Launch the ball · fire lasers · release a sticky ball |
| `P` / `Esc` | Pause / resume |
| `M` | Mute / unmute |

## Features

- **10 hand-authored levels** as character-grid data (normal, armor, steel,
  explosive, moving and boss bricks), ending in a 99-HP final boss and a
  victory screen.
- **Solid physics**: fixed 1/120 s steps with an accumulator, velocity-based
  sub-stepping (no tunneling), minimum-penetration-axis circle↔AABB resolution,
  one brick destroyed per sub-step, paddle-angle control (±72° from the hit
  offset + paddle "english"), speed clamps and a >2 s anti-stuck watchdog.
- **Progression**: ball speeds up +2.5% per brick and +1.5% per level (capped),
  combo multiplier up to ×8, life bonus per level, high score + best level in
  `localStorage`.
- **Positive power-ups** with timed HUD chips: Wide Paddle, Multi-Ball (cap 6),
  Laser Paddle, Slow Ball, Sticky Paddle, Shield (single-use), Extra Life,
  Score ×2, Autopilot.
- **Negative power-ups from level 3**: Shrink Paddle and Fast Ball.
- **Game feel**: particle pools, screen shake, hit-stop slow motion, brick
  popups, confetti, trail, CRT-style vignette and scanlines, synthwave
  background, chiptune-style Web Audio SFX (paddle, brick, steel, explosion,
  power-up, level jingle) with a lazily unlocked AudioContext.
- **Robust flow**: MENU → PLAYING ⇄ PAUSED → LEVEL_CLEAR → … → GAME_OVER /
  VICTORY, animated overlays, auto-pause when the tab is hidden, delta-time
  clamping, responsive layout from 375×667 phones to 1920×1080 desktops with
  no scrolling or clipping.

## Validate it

```bash
node tools/smoke-test.mjs   # needs Playwright; see the header comment
```

The script serves the folder on port 8001, drives the real UI with Chromium,
checks gameplay, power-ups, boss phases, persistence and layout, saves
screenshots to `tools/shots/` and fails on any console error or page error.

## Files

- `index.html` — shell, HUD, overlays
- `style.css` — layout, typography, overlay/HUD animations
- `script.js` — the whole engine (Config, Input, AudioEngine, Particles,
  Ball/Paddle/Brick/PowerUp, LevelManager, Collision, Game, Store)
- `README.md` — this file
- `DECISIONS.md` — design decisions taken where the spec was ambiguous
- `tools/smoke-test.mjs` — Playwright validation (not needed at runtime)
