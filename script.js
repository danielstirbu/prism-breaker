/* Prism Breaker — vanilla neon brick breaker (canvas 2D + Web Audio).
   Single global namespace: window.Game. No modules, no dependencies. */
(() => {
'use strict';

const VERSION = '1.0.0';

const Config = {
  W: 960,
  H: 640,
  STEP: 1 / 120,          // fixed physics step
  MAX_FRAME_DT: 0.1,      // clamp huge frame gaps (tab switches)
  MAX_COMBO: 8,
  PADDLE: {
    W: 132, MIN_W: 74, MAX_W: 214, H: 16, Y: 594,
    ACCEL: 3200, FRICTION: 14, MAX_SPEED: 640,
    MOUSE_LERP: 24,       // smoothing rate toward mouse/touch target
    DASH_MULT: 1.75, DASH_DRAIN: 1 / 1.2, DASH_REGEN: 1 / 2.6,
  },
  BALL: {
    R: 8,
    SPEED: 340, MIN_SPEED: 250, MAX_SPEED: 640,
    BRICK_GROWTH: 1.025,  // +2.5% per destroyed brick
    LEVEL_GROWTH: 1.015,  // +1.5% per level
    BOUNCE_OFFSET: 72 * Math.PI / 180, // edge hit => 72 deg from vertical
    MAX_ANGLE: 76 * Math.PI / 180,     // never flatter than this vs vertical
    MIN_ANGLE: 0.16,      // never closer to vertical than this (~9 deg)
    ENGLISH: 0.18,        // paddle velocity transfer
    TRAIL: 14,
    RESPAWN_INVULN: 0.6,
    UNSTICK_TIME: 2,
  },
  PHYS: { SUB_TRAVEL: 0.45 }, // keep ball travel per substep <= R * 0.45
  BRICK: {
    COLS: 12, ROWS: 9, TOP: 66, SIDE: 40, ROW_H: 26, GAP: 4,
    POINTS: { normal: 10, armor: 25, explosive: 40, moving: 30, boss: 200 },
    BOSS_HP: { 5: 50, 10: 99 },
  },
  POWER: {
    CHANCE: 0.20, FALL: 150, DURATION: 12, DOUBLE_DURATION: 60, AUTO_DURATION: 5,
    MAX_BALLS: 6, LASER_CD: 0.25, LASER_SPEED: 560, LASER_LIFE: 1.4,
    NEG_MIN_LEVEL: 3, AUTOPILOT_SHARE: 0.02,
  },
  GAME: {
    LIVES: 3, MAX_LIVES: 6, RESPAWN: 0.6, LEVEL_BANNER: 1.5,
    LEVEL_BONUS_PER_LIFE: 100, SLOWMO: 0.15, SLOWMO_SCALE: 0.25,
    SHAKE_DECAY: 6, SHAKE_MAX: 14,
  },
  ROW_COLORS: [
    '#ff2bd6', '#ff5fbe', '#b44bff', '#7b5cff', '#4b8bff',
    '#22c3ff', '#25e8c8', '#41ff8a', '#ffd319',
  ],
};

const Utils = {
  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  rand(lo, hi) { return lo + Math.random() * (hi - lo); },
  randInt(lo, hi) { return Math.floor(Utils.rand(lo, hi + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  },
};

// localStorage wrapper: private mode / disabled storage must never throw.
const Store = {
  _key: 'prismbreaker.',
  _get(name, fallback) {
    try {
      const raw = localStorage.getItem(Store._key + name);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  _set(name, value) {
    try {
      localStorage.setItem(Store._key + name, JSON.stringify(value));
    } catch { /* storage unavailable — run without persistence */ }
  },
  get highScore() { return Store._get('highScore', 0); },
  set highScore(v) { Store._set('highScore', v); },
  get bestLevel() { return Store._get('bestLevel', 1); },
  set bestLevel(v) { Store._set('bestLevel', v); },
  get totalPlays() { return Store._get('totalPlays', 0); },
  set totalPlays(v) { Store._set('totalPlays', v); },
  get muted() { return Store._get('muted', false); },
  set muted(v) { Store._set('muted', v); },
  stampVersion() { Store._set('lastVersion', VERSION); },
};

/* ------------------------------------------------------------------ */
/* AudioEngine — everything synthesized with Web Audio, no assets.     */
/* Started lazily on the first user gesture (autoplay policy).         */
const PAD_LEVEL = 0.02;

const AudioEngine = {
  ctx: null,
  master: null,
  padGain: null,
  noiseBuf: null,
  muted: Store.muted,
  armed: false,

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    // A suspended/paused context must be resumed after tab switches.
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  },

  unlock() {
    if (this._ensure()) this.armed = true;
  },

  setMuted(m) {
    this.muted = m;
    Store.muted = m;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, t, 0.03);
    }
  },

  _tone(type, freq, dur, vol, { at = 0, glideTo = null, filter = null } = {}) {
    if (!this.armed || !this._ensure()) return;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (filter) {
      const bq = this.ctx.createBiquadFilter();
      bq.type = filter.type || 'lowpass';
      bq.frequency.value = filter.freq || 1200;
      node.connect(bq);
      node = bq;
    }
    node.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  },

  _noise(dur, vol, freq, { at = 0, type = 'lowpass', sweep = 0 } = {}) {
    if (!this.armed || !this._ensure()) return;
    const t0 = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    // Fresh buffer per play: one AudioBuffer driven by two overlapping
    // sources jumps sample positions and clicks (chains of explosions).
    const buf = this.ctx.createBuffer(1, this.noiseBuf.length, this.ctx.sampleRate);
    buf.copyToChannel(this.noiseBuf.getChannelData(0), 0);
    src.buffer = buf;
    const bq = this.ctx.createBiquadFilter();
    bq.type = type;
    bq.frequency.setValueAtTime(freq, t0);
    if (sweep) bq.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), t0 + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq);
    bq.connect(gain);
    gain.connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  },

  paddlePock(offset) {
    const f = 190 + Math.abs(offset) * 150;
    this._tone('triangle', f, 0.09, 0.5, { glideTo: f * 0.7 });
  },

  brickTick(combo) {
    const f = 480 + Math.min(combo, Config.MAX_COMBO) * 62;
    this._tone('square', f, 0.05, 0.16, { filter: { type: 'lowpass', freq: 3200 } });
  },

  wallTap() { this._tone('sine', 300, 0.05, 0.14); },

  brickBreak() {
    this._noise(0.18, 0.4, 2600, { sweep: 300 });
    this._tone('triangle', 320, 0.12, 0.2, { glideTo: 140 });
  },

  explosion() {
    this._noise(0.42, 0.55, 900, { sweep: 60 });
    this._tone('sawtooth', 90, 0.35, 0.3, { glideTo: 32 });
  },

  laser() { this._tone('sawtooth', 900, 0.12, 0.14, { glideTo: 220 }); },

  powerup(good) {
    const base = good ? 440 : 220;
    const steps = good ? [0, 4, 7, 12] : [0, 3, 6]; // major vs diminished arpeggio
    steps.forEach((semi, i) => this._tone('triangle', base * Math.pow(2, semi / 12), 0.16, 0.22, { at: i * 0.06 }));
  },

  lifeLost() { this._tone('sawtooth', 440, 0.6, 0.32, { glideTo: 60, filter: { type: 'lowpass', freq: 1600 } }); },

  jingle(notes, gap, dur, vol) {
    notes.forEach((f, i) => this._tone('triangle', f, dur, vol, { at: i * gap }));
  },

  levelJingle() { this.jingle([523.25, 659.25, 783.99, 1046.5], 0.11, 0.22, 0.28); },

  victoryJingle() { this.jingle([523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5], 0.15, 0.3, 0.3); },

  click() { this._tone('sine', 720, 0.06, 0.2); },

  uiHover() { this._tone('sine', 520, 0.04, 0.08); },

  startPad() {
    if (!this.armed || !this._ensure()) return;
    if (this.padGain) { // already running: just restore the level
      this.setPadLevel(AudioEngine.muted ? 0 : PAD_LEVEL);
      return;
    }
    const t = this.ctx.currentTime;
    this.padGain = this.ctx.createGain();
    this.padGain.gain.setValueAtTime(0.0001, t);
    this.padGain.gain.linearRampToValueAtTime(AudioEngine.muted ? 0 : PAD_LEVEL, t + 1.5);
    const bq = this.ctx.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.value = 340;
    this.padOscs = [];
    // Soft A-minor pad (A2 E3 A3 C4), triangle waves: a sawtooth stack at
    // 55/82/110 Hz reads as one continuous buzz.
    [110, 164.81, 220, 261.63].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      osc.detune.value = i * 3 - 4.5;
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.value = 0.06 + i * 0.02;
      lfoGain.gain.value = 3;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start(t);
      osc.connect(bq);
      osc.start(t);
      this.padOscs.push(osc, lfo);
    });
    bq.connect(this.padGain);
    this.padGain.connect(this.master);
  },

  stopPad() {
    if (!this.ctx || !this.padGain) return;
    const t = this.ctx.currentTime;
    const pad = this.padGain;
    const oscs = this.padOscs || [];
    this.padGain = null;
    this.padOscs = [];
    pad.gain.cancelScheduledValues(t);
    pad.gain.setTargetAtTime(0.0001, t, 0.25);
    for (const n of oscs) { try { n.stop(t + 1.2); } catch { /* already stopped */ } }
  },

  setPadLevel(level) {
    if (!this.ctx || !this.padGain) return;
    const p = this.padGain.gain;
    const t = this.ctx.currentTime;
    // Cancel pending fade-in/out ramps first — a linearRamp in flight would
    // otherwise overwrite the duck after it completes.
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
    else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
    p.setTargetAtTime(level, t, 0.2);
  },
};

/* ------------------------------------------------------------------ */
/* Input — keyboard + mouse + touch normalized into one state object.  */
const Input = {
  left: false,
  right: false,
  shift: false,
  space: false,
  pointerX: null,       // logical canvas x while pointer controls are active
  pointerActive: false,
  action: false,        // one-shot: Space / click / tap (consumed by Game)

  init(canvas, onFirstGesture) {
    window.addEventListener('keydown', (e) => this._key(e, true));
    window.addEventListener('keyup', (e) => this._key(e, false));
    window.addEventListener('blur', () => this.reset());

    const toLogicalX = (clientX) => {
      const r = canvas.getBoundingClientRect();
      return (clientX - r.left) / r.width * Config.W;
    };
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || this.pointerActive) {
        this.pointerX = toLogicalX(e.clientX);
        this.pointerActive = true;
      }
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (onFirstGesture) onFirstGesture();
      if (e.pointerType === 'touch') {
        this.pointerX = toLogicalX(e.clientX);
        this.pointerActive = true;
      }
      this.action = true;
      e.preventDefault();
    });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    window.addEventListener('contextmenu', (e) => {
      if (e.target === canvas) e.preventDefault();
    });
  },

  _key(e, down) {
    if (e.target && e.target.tagName === 'BUTTON') return;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': this.left = down; e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': this.right = down; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': this.shift = down; break;
      case 'Space':
        if (down && !e.repeat) this.action = true;
        this.space = down;
        e.preventDefault();
        break;
      default: break;
    }
  },

  consumeAction() {
    const a = this.action;
    this.action = false;
    return a;
  },

  // Keyboard input should take over from the pointer immediately.
  notifyKeyboardMove() { this.pointerActive = false; },

  reset() {
    this.left = this.right = this.shift = this.action = this.space = false;
  },
};

/* ------------------------------------------------------------------ */
/* Particles — pooled, fixed cap, allocation-free during play.         */
const Particles = {
  MAX: 700,
  pool: [],
  active: [],

  init() {
    this.pool.length = 0;
    for (let i = 0; i < this.MAX; i++) {
      this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 3, color: '#fff', gravity: 0, spark: false });
    }
    this.active.length = 0;
  },

  _spawn() {
    const p = this.pool.pop();
    if (!p) this.active.shift(); // recycle oldest when saturated
    return p || this.active[0];
  },

  burst(x, y, color, count, opts = {}) {
    for (let i = 0; i < count; i++) {
      const p = this._spawn();
      if (!p) return;
      const ang = opts.angle !== undefined ? opts.angle + Utils.rand(-opts.spread, opts.spread) : Utils.rand(0, Math.PI * 2);
      const spd = Utils.rand(opts.speedMin || 60, opts.speedMax || 320);
      p.x = x + Utils.rand(-3, 3);
      p.y = y + Utils.rand(-3, 3);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.max = p.life = Utils.rand(opts.lifeMin || 0.25, opts.lifeMax || 0.7);
      p.size = Utils.rand(2, opts.sizeMax || 5);
      p.color = color;
      p.gravity = opts.gravity === undefined ? 520 : opts.gravity;
      p.spark = !!opts.spark;
      this.active.push(p);
    }
  },

  ring(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      const p = this._spawn();
      if (!p) return;
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * 240;
      p.vy = Math.sin(ang) * 240;
      p.max = p.life = 0.35;
      p.size = 2.5;
      p.color = color;
      p.gravity = 0;
      p.spark = true;
      this.active.push(p);
    }
  },

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.active.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  },

  draw(ctx) {
    ctx.save();
    for (const p of this.active) {
      const t = p.life / p.max;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      if (p.spark) {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * t + 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  },

  clear() {
    while (this.active.length) this.pool.push(this.active.pop());
  },
};

/* ------------------------------------------------------------------ */
/* Geometry helpers shared by collision + entities.                    */
const Geo = {
  // Circle vs AABB: returns minimum penetration axis or null.
  // nx/ny = push direction for the circle, pen = overlap depth.
  circleRect(cx, cy, r, rx, ry, rw, rh) {
    const halfW = rw / 2, halfH = rh / 2;
    const dx = cx - (rx + halfW);
    const dy = cy - (ry + halfH);
    const px = halfW + r - Math.abs(dx);
    if (px <= 0) return null;
    const py = halfH + r - Math.abs(dy);
    if (py <= 0) return null;
    // Closest-corner case: corner distance test keeps round edges round.
    const cdx = Math.abs(dx) - halfW;
    const cdy = Math.abs(dy) - halfH;
    if (cdx > 0 && cdy > 0) {
      const d2 = cdx * cdx + cdy * cdy;
      if (d2 > r * r) return null;
      const d = Math.sqrt(d2) || 1;
      return { nx: (cdx / d) * Math.sign(dx), ny: (cdy / d) * Math.sign(dy), pen: r - d };
    }
    if (px < py) return { nx: Math.sign(dx) || 1, ny: 0, pen: px };
    return { nx: 0, ny: Math.sign(dy) || -1, pen: py };
  },
};

/* ------------------------------------------------------------------ */
/* Ball                                                               */
class Ball {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.speed = Config.BALL.SPEED;
    this.r = Config.BALL.R;
    this.alive = true;
    this.stuck = true;          // glued to paddle until launch
    this.stuckOffset = 0;       // relative x offset while stuck
    this.invuln = 0;            // spawn protection after losing a life
    this.trail = [];
    this._cell = null;          // unstick watchdog
    this._cellTime = 0;
  }

  setSpeed(s) {
    this.speed = Utils.clamp(s, Config.BALL.MIN_SPEED, Config.BALL.MAX_SPEED);
    const cur = Math.hypot(this.vx, this.vy);
    if (cur > 0) {
      this.vx = this.vx / cur * this.speed;
      this.vy = this.vy / cur * this.speed;
    }
  }

  launch(angle = Utils.rand(-0.42, 0.42)) {
    this.stuck = false;
    this.vx = Math.sin(angle) * this.speed;
    this.vy = -Math.cos(angle) * this.speed;
  }

  stick(paddle) {
    this.stuck = true;
    this.vx = this.vy = 0;
    this.stuckOffset = Utils.clamp((this.x - paddle.x) / (paddle.width / 2), -0.8, 0.8);
  }

  // Keep |angle from vertical| <= MAX_ANGLE so the ball never travels
  // flat-horizontal nor loops forever straight up/down.
  clampAngle() {
    const maxA = Config.BALL.MAX_ANGLE;
    const minA = Config.BALL.MIN_ANGLE;
    if (this.vx === 0 && this.vy === 0) return;
    const mag = Math.hypot(this.vx, this.vy) || this.speed;
    // Clamp deviation from the *current* vertical direction (up or down) so
    // the ball never runs flat-horizontal and never pins to pure vertical,
    // while its vertical direction is preserved.
    const dev = Utils.clamp(Math.atan2(Math.abs(this.vx), Math.abs(this.vy)), minA, maxA);
    const sx = this.vx === 0 ? 1 : Math.sign(this.vx);
    const sy = this.vy === 0 ? -1 : Math.sign(this.vy);
    this.vx = Math.sin(dev) * mag * sx;
    this.vy = Math.cos(dev) * mag * sy;
  }

  update(dt, game) {
    if (this.invuln > 0) this.invuln -= dt;
    if (this.stuck) {
      const p = game.paddle;
      this.x = p.x + this.stuckOffset * (p.width / 2);
      this.y = p.y - this.r - p.h / 2 - 1;
      this.trail.length = 0;
    }
  }

  pushTrail() {
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > Config.BALL.TRAIL) this.trail.shift();
  }

  draw(ctx, time) {
    const glow = 0.75 + 0.25 * Math.sin(time * 6);
    for (let i = 0; i < this.trail.length; i++) {
      const t = (i + 1) / this.trail.length;
      ctx.globalAlpha = t * 0.35;
      ctx.fillStyle = '#9be9ff';
      ctx.beginPath();
      ctx.arc(this.trail[i].x, this.trail[i].y, this.r * t * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = this.invuln > 0 ? 0.45 + 0.3 * Math.sin(time * 30) : 1;
    ctx.save();
    ctx.shadowColor = '#63e8ff';
    ctx.shadowBlur = 14 * glow;
    const grad = ctx.createRadialGradient(this.x - 2, this.y - 2, 1, this.x, this.y, this.r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.6, '#aee9ff');
    grad.addColorStop(1, '#38b6ff');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Paddle                                                             */
class Paddle {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = Config.W / 2;
    this.y = Config.PADDLE.Y;
    this.h = Config.PADDLE.H;
    this.baseWidth = Config.PADDLE.W;
    this.factor = 1;
    this.width = Config.PADDLE.W;
    this.vx = 0;
    this.dash = 1;          // 0..1 energy
    this.dashing = false;
    this.sticky = false;
    this.laser = false;
    this.laserCd = 0;
    this.autopilot = 0;
  }

  setFactor(f) {
    this.factor = f;
    this.width = Utils.clamp(this.baseWidth * f, Config.PADDLE.MIN_W, Config.PADDLE.MAX_W);
  }

  get half() { return this.width / 2; }

  update(dt, game) {
    const P = Config.PADDLE;
    const target = this.autopilot > 0 ? this._autopilotTarget(game) : null;
    if (this.autopilot > 0) {
      this.autopilot -= dt;
      if (this.autopilot <= 0) game.refreshPowerHud();
    }

    // Dash: only while actively moving with keyboard and energy remains.
    const wantsDash = Input.shift && (Input.left || Input.right) && this.dash > 0.05;
    this.dashing = wantsDash;
    if (wantsDash) {
      this.dash = Math.max(0, this.dash - P.DASH_DRAIN * dt);
    } else {
      this.dash = Math.min(1, this.dash + P.DASH_REGEN * dt);
    }

    const maxSpeed = P.MAX_SPEED * (this.dashing ? P.DASH_MULT : 1);
    if (target !== null) {
      // Autopilot: critically-damped chase of nearest descending ball/powerup.
      const k = 1 - Math.exp(-9 * dt);
      const step = (target - this.x) * k;
      this.vx = Utils.clamp(step / Math.max(dt, 1e-4), -P.MAX_SPEED, P.MAX_SPEED);
      this.x += step;
    } else if (Input.pointerActive && Input.pointerX !== null) {
      const next = Utils.clamp(Input.pointerX, this.half, Config.W - this.half);
      const k = 1 - Math.exp(-P.MOUSE_LERP * dt);
      const step = (next - this.x) * k;
      this.vx = Utils.clamp(step / Math.max(dt, 1e-4), -P.MAX_SPEED, P.MAX_SPEED);
      this.x += step;
      if (Math.abs(next - this.x) < 0.4) this.vx = 0;
    } else {
      const dir = (Input.left ? -1 : 0) + (Input.right ? 1 : 0);
      if (dir !== 0) {
        this.vx += dir * P.ACCEL * (this.dashing ? P.DASH_MULT : 1) * dt;
      } else {
        this.vx -= this.vx * Math.min(1, P.FRICTION * dt);
      }
      this.vx = Utils.clamp(this.vx, -maxSpeed, maxSpeed);
      this.x += this.vx * dt;
    }
    this.x = Utils.clamp(this.x, this.half, Config.W - this.half);
    if (this.laserCd > 0) this.laserCd -= dt;
  }

  _autopilotTarget(game) {
    let best = null;
    for (const b of game.balls) {
      if (b.stuck) continue;
      if (b.vy > 0 && (best === null || b.y > best.y)) best = b;
    }
    if (!best && game.powerups.length) {
      const p = game.powerups[0];
      return p.x;
    }
    return best ? best.x : Config.W / 2;
  }

  draw(ctx) {
    const x = this.x - this.half, y = this.y - this.h / 2, w = this.width;
    ctx.save();
    ctx.shadowColor = this.sticky ? '#ffd319' : this.laser ? '#ff5f6d' : '#22e8ff';
    ctx.shadowBlur = 16;
    const grad = ctx.createLinearGradient(x, y, x, y + this.h);
    grad.addColorStop(0, '#e9fbff');
    grad.addColorStop(0.5, this.laser ? '#ff8b95' : this.sticky ? '#ffe57a' : '#7fe8ff');
    grad.addColorStop(1, this.laser ? '#c22b3d' : this.sticky ? '#c79a00' : '#1592c9');
    ctx.fillStyle = grad;
    Paddle._roundRectPath(ctx, x, y, w, this.h, 7);
    ctx.fill();
    if (this.dashing) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#22e8ff';
      Paddle._roundRectPath(ctx, x - this.vx * 0.02, y + 2, w, this.h - 4, 6);
      ctx.fill();
    }
    ctx.restore();
  }

  static _roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}

/* ------------------------------------------------------------------ */
/* Brick — one class, distinct behaviors by type:                       */
/* normal | armor | steel | explosive | moving | boss                  */
class Brick {
  constructor(col, row, type, grid) {
    this.col = col;
    this.row = row;
    this.grid = grid;
    this.type = type;
    const B = Config.BRICK;
    const cellW = (Config.W - B.SIDE * 2) / B.COLS;
    this.w = cellW - B.GAP;
    this.h = B.ROW_H - B.GAP;
    this.x = B.SIDE + col * cellW;
    this.y = B.TOP + row * B.ROW_H;
    this.hp = type === 'armor' ? 2 : type === 'boss' ? (B.BOSS_HP[grid.level] || 60) : 1;
    this.maxHp = this.hp;
    this.alive = true;
    this.flash = 0;
    this.cracked = false;
    this.points = B.POINTS[type] !== undefined ? B.POINTS[type] : 10;
    this.destroyable = type !== 'steel';
    this.baseColor = type === 'steel' ? '#8d99ae'
      : type === 'explosive' ? '#ff9f1c'
      : type === 'moving' ? '#25e8c8'
      : type === 'boss' ? '#ff2b4e'
      : Config.ROW_COLORS[Math.min(row, Config.ROW_COLORS.length - 1)];
    // Moving bricks patrol between columns [moveLo, moveHi] of the grid.
    this.moveLo = this.moveHi = col;
    this.dir = Math.random() < 0.5 ? -1 : 1;
    this.moveSpeed = Utils.rand(40, 80);
    // Boss phases: alternate "move fast" / "teleport + spawn minions".
    this.phase = 0;
    this.phaseTimer = Utils.rand(2, 3.5);
  }

  update(dt, game) {
    if (!this.alive) return;
    if (this.flash > 0) this.flash -= dt * 6;
    if (this.type === 'moving' || (this.type === 'boss' && this.phase === 0)) {
      const B = Config.BRICK;
      const cellW = (Config.W - B.SIDE * 2) / B.COLS;
      const lo = B.SIDE + this.moveLo * cellW;
      const hi = B.SIDE + this.moveHi * cellW;
      const speed = this.type === 'boss' ? this.moveSpeed * 1.6 : this.moveSpeed;
      this.x += this.dir * speed * dt;
      if (this.x <= lo) { this.x = lo; this.dir = 1; }
      if (this.x >= hi) { this.x = hi; this.dir = -1; }
    }
    if (this.type === 'boss') this._updateBoss(dt, game);
  }

  _updateBoss(dt, game) {
    this.phaseTimer -= dt;
    if (this.phaseTimer > 0) return;
    // Every phase switch costs HP-ish rhythm: boss shifts lane and, once
    // below 2/3 HP, periodically spawns a normal brick in an empty slot.
    this.phase = (this.phase + 1) % 2;
    if (this.phase === 0) {
      const B = Config.BRICK;
      this.moveLo = Utils.randInt(0, Math.max(0, B.COLS - 4));
      this.moveHi = Math.min(B.COLS - 1, this.moveLo + 3);
      this.dir = Math.random() < 0.5 ? -1 : 1;
      this.phaseTimer = Utils.rand(2.2, 3.4);
    } else {
      this.phaseTimer = 1.2;
      if (this.hp / this.maxHp < 0.75) {
        game.grid.spawnMinionNear(this);
      }
    }
  }

  // Returns true when this hit destroyed the brick.
  hit(dmg, game) {
    if (!this.alive || !this.destroyable) return false;
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp > 0) {
      if (this.type === 'armor') this.cracked = true;
      return false;
    }
    this.alive = false;
    return true;
  }

  draw(ctx) {
    if (!this.alive) return;
    const x = this.x, y = this.y, w = this.w, h = this.h;
    ctx.save();
    ctx.shadowColor = this.baseColor;
    ctx.shadowBlur = 10;
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, this._shade(this.baseColor, 45));
    grad.addColorStop(0.5, this.baseColor);
    grad.addColorStop(1, this._shade(this.baseColor, -55));
    ctx.fillStyle = grad;
    Paddle._roundRectPath(ctx, x, y, w, h, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    // glossy top strip
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#ffffff';
    Paddle._roundRectPath(ctx, x + 2, y + 2, w - 4, h * 0.32, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (this.type === 'steel') {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(x + 4, y + h - 4);
      ctx.lineTo(x + w - 4, y + 4);
      ctx.moveTo(x + 4, y + 4);
      ctx.lineTo(x + w - 4, y + h - 4);
      ctx.stroke();
    }
    if (this.cracked) {
      ctx.strokeStyle = 'rgba(10,5,20,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.2, y + h * 0.15);
      ctx.lineTo(x + w * 0.42, y + h * 0.55);
      ctx.lineTo(x + w * 0.3, y + h * 0.9);
      ctx.moveTo(x + w * 0.62, y + 2);
      ctx.lineTo(x + w * 0.55, y + h * 0.4);
      ctx.lineTo(x + w * 0.78, y + h * 0.75);
      ctx.stroke();
    }
    if (this.type === 'explosive') {
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 130);
      ctx.fillStyle = `rgba(255,255,210,${pulse})`;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.type === 'boss') {
      const bw = w - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x + 5, y + h - 7, bw, 4);
      ctx.fillStyle = '#ff5f6d';
      ctx.fillRect(x + 5, y + h - 7, bw * (this.hp / this.maxHp), 4);
    }
    if (this.flash > 0) {
      ctx.globalAlpha = Math.min(1, this.flash);
      ctx.fillStyle = '#ffffff';
      Paddle._roundRectPath(ctx, x, y, w, h, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // Lighten (+) / darken (-) a #rrggbb color by amt.
  _shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Utils.clamp(((n >> 16) & 255) + amt, 0, 255);
    const g = Utils.clamp(((n >> 8) & 255) + amt, 0, 255);
    const b = Utils.clamp((n & 255) + amt, 0, 255);
    return `rgb(${r},${g},${b})`;
  }
}

/* ------------------------------------------------------------------ */
/* BrickGrid — 2D cell lookup for cheap collision + explosion radius,  */
/* plus the flat list used for update/draw.                            */
class BrickGrid {
  constructor(level) {
    this.level = level;
    const B = Config.BRICK;
    this.cells = Array.from({ length: B.ROWS }, () => new Array(B.COLS).fill(null));
    this.bricks = [];
    this.movers = [];
  }

  add(brick) {
    this.bricks.push(brick);
    this.cells[brick.row][brick.col] = brick;
    if (brick.type === 'moving' || brick.type === 'boss') this.movers.push(brick);
  }

  destructibleCount() {
    let n = 0;
    for (const b of this.bricks) if (b.alive && b.destroyable) n++;
    return n;
  }

  // Bricks overlapping a ball's bounding box, in reading order.
  nearby(x, y, r) {
    const B = Config.BRICK;
    const cellW = (Config.W - B.SIDE * 2) / B.COLS;
    const out = [];
    const c0 = Utils.clamp(Math.floor((x - r - B.SIDE) / cellW) - 1, 0, B.COLS - 1);
    const c1 = Utils.clamp(Math.floor((x + r - B.SIDE) / cellW) + 1, 0, B.COLS - 1);
    const r0 = Utils.clamp(Math.floor((y - r - B.TOP) / B.ROW_H), 0, B.ROWS - 1);
    const r1 = Utils.clamp(Math.floor((y + r - B.TOP) / B.ROW_H), 0, B.ROWS - 1);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const b = this.cells[row][col];
        if (b && b.alive) out.push(b);
      }
    }
    // Movers drift away from their home cell: test their live rectangle too.
    for (const b of this.movers) {
      if (!b.alive || out.includes(b)) continue;
      if (x + r >= b.x && x - r <= b.x + b.w && y + r >= b.y && y - r <= b.y + b.h) out.push(b);
    }
    return out;
  }

  // Explosive chain: destroy everything in a 1-cell radius, chaining into
  // other explosives (each brick explodes at most once per chain).
  explode(brick, queue) {
    const B = Config.BRICK;
    for (let row = brick.row - 1; row <= brick.row + 1; row++) {
      if (row < 0 || row >= B.ROWS) continue;
      for (let col = brick.col - 1; col <= brick.col + 1; col++) {
        if (col < 0 || col >= B.COLS) continue;
        const b = this.cells[row][col];
        if (!b || !b.alive || !b.destroyable || b.type === 'boss') continue;
        queue.push(b);
      }
    }
  }

  // Boss phase: put a plain brick in an empty cell adjacent to the boss.
  spawnMinionNear(boss) {
    const B = Config.BRICK;
    const free = [];
    for (let row = Math.max(0, boss.row - 1); row <= Math.min(B.ROWS - 1, boss.row + 1); row++) {
      for (let col = Math.max(0, boss.col - 1); col <= Math.min(B.COLS - 1, boss.col + 1); col++) {
        if (!this.cells[row][col]) free.push([row, col]);
      }
    }
    if (!free.length) return;
    const [row, col] = Utils.pick(free);
    this.add(new Brick(col, row, 'normal', this));
  }

  update(dt, game) {
    for (const b of this.bricks) b.update(dt, game);
  }

  draw(ctx) {
    for (const b of this.bricks) b.draw(ctx);
  }

  clear() {
    this.bricks.length = 0;
    this.movers.length = 0;
    for (const row of this.cells) row.fill(null);
  }
}

/* ------------------------------------------------------------------ */
/* PowerUp — falling capsule collected by the paddle.                  */
const POWER_DEFS = {
  wide:    { label: 'WIDE PADDLE',   icon: '↔',  color: '#41ff8a', good: true,  key: 'wide' },
  multi:   { label: 'MULTI-BALL',    icon: '✦',  color: '#ffd319', good: true,  key: 'multi' },
  laser:   { label: 'LASER',         icon: '⌁',  color: '#ff5f6d', good: true,  key: 'laser' },
  slow:    { label: 'SLOW BALL',     icon: '◐',  color: '#22c3ff', good: true,  key: 'slow' },
  sticky:  { label: 'STICKY',        icon: '◎',  color: '#ffd319', good: true,  key: 'sticky' },
  shield:  { label: 'SHIELD',        icon: '▬',  color: '#7b5cff', good: true,  key: 'shield' },
  life:    { label: 'EXTRA LIFE',    icon: '♥',  color: '#ff5fbe', good: true,  key: 'life' },
  double:  { label: 'SCORE x2',      icon: '2×', color: '#b44bff', good: true,  key: 'double' },
  auto:    { label: 'AUTOPILOT',     icon: '☄',  color: '#25e8c8', good: true,  key: 'auto' },
  shrink:  { label: 'SHRINK',        icon: '><', color: '#ff2b4e', good: false, key: 'shrink' },
  fast:    { label: 'FAST BALL',     icon: '≫',  color: '#ff2b4e', good: false, key: 'fast' },
};

class PowerUp {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.def = POWER_DEFS[type];
    this.w = 34;
    this.h = 18;
    this.alive = true;
    this.wobble = Utils.rand(0, Math.PI * 2);
  }

  update(dt) {
    this.y += Config.POWER.FALL * dt;
    this.wobble += dt * 5;
    if (this.y > Config.H + 30) this.alive = false;
  }

  draw(ctx) {
    const x = this.x - this.w / 2, y = this.y - this.h / 2;
    ctx.save();
    ctx.shadowColor = this.def.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = this.def.color;
    Paddle._roundRectPath(ctx, x, y, this.w, this.h, 9);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0a0618';
    ctx.font = 'bold 12px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.def.icon, this.x, this.y + 1 + Math.sin(this.wobble) * 1.2);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Laser projectile fired by the paddle.                               */
class Laser {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.life = Config.POWER.LASER_LIFE;
    this.alive = true;
  }

  update(dt) {
    this.y -= Config.POWER.LASER_SPEED * dt;
    this.life -= dt;
    if (this.y < -20 || this.life <= 0) this.alive = false;
  }

  draw(ctx) {
    ctx.save();
    ctx.shadowColor = '#ff5f6d';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffd0d5';
    ctx.fillRect(this.x - 1.5, this.y, 3, 14);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* LevelManager — levels as data (character grids), build/reset/next.  */
/* Legend: . empty | 1 normal | A armor | S steel | X explosive         */
/*         M moving | B boss                                           */
const LevelManager = {
  LEVELS: [
    [ // 1 — classic wall
      '............',
      '............',
      '111111111111',
      '1AAAAAAAAAA1',
      '111111111111',
      '1AAAAAAAAAA1',
      '111111111111',
      '............',
      '............',
    ],
    [ // 2 — pyramid
      '............',
      '............',
      '.....11.....',
      '....1111....',
      '...111111...',
      '..11111111..',
      '.1111111111.',
      '111111111111',
      '............',
    ],
    [ // 3 — arcade (arch, steel introduced)
      '............',
      '.1111111111.',
      '.11......11.',
      '.1A..SS..A1.',
      '.11......11.',
      '.11......11.',
      'S11......11S',
      '............',
      '............',
    ],
    [ // 4 — checker (moving bricks introduced)
      '............',
      'A.1.M.1.A.1.',
      '.1.A.1.A.1.A',
      'A.1.A.1.M.1.',
      '.1.A.1.A.1.A',
      'A.M.A.1.A.1.',
      '............',
      '............',
      '............',
    ],
    [ // 5 — diamond + mini-boss
      '............',
      '.....11.....',
      '....1AA1....',
      '...1A..A1...',
      '..1A.B..A1..',
      '.1A..XX..A1.',
      '11A......A11',
      '............',
      '............',
    ],
    [ // 6 — tunnel
      '............',
      'SS11111111SS',
      'S.1MMMMMM1.S',
      'S.11111111.S',
      'S.AAAAAAAA.S',
      '............',
      '............',
      '............',
      '............',
    ],
    [ // 7 — clock
      '.....11.....',
      '..11....11..',
      '.1...SS...1.',
      '.1...SS...1.',
      'S1...11...1S',
      '.1........1.',
      '..11....11..',
      '.....11.....',
      '............',
    ],
    [ // 8 — key
      '............',
      '.11111......',
      '1A....1A....',
      '11....11....',
      '.11111......',
      '...11.......',
      '...1M.11....',
      '...11.11....',
      '...11111....',
    ],
    [ // 9 — wave
      '.........AA.',
      '.......1111.',
      '.....1111...',
      '...1111.....',
      '..X111......',
      '....1111....',
      '......1111..',
      '........11M.',
      '............',
    ],
    [ // 10 — boss arena
      '............',
      '.SS......SS.',
      '..11111111..',
      '...AAAAAA...',
      '......B.....',
      '...X1..1X...',
      '..111..111..',
      '...11..11...',
      '............',
    ],
  ],

  TYPE_FOR: { 1: 'normal', A: 'armor', S: 'steel', X: 'explosive', M: 'moving', B: 'boss' },

  load(level, game) {
    const grid = new BrickGrid(level);
    const rows = this.LEVELS[level - 1];
    for (let row = 0; row < rows.length && row < Config.BRICK.ROWS; row++) {
      for (let col = 0; col < rows[row].length && col < Config.BRICK.COLS; col++) {
        const ch = rows[row][col];
        const type = this.TYPE_FOR[ch];
        if (!type) continue;
        const brick = new Brick(col, row, type, grid);
        if (type === 'moving') {
          brick.moveLo = Math.max(0, col - 1);
          brick.moveHi = Math.min(Config.BRICK.COLS - 1, col + 1);
        }
        grid.add(brick);
      }
    }
    return grid;
  },

  count() { return this.LEVELS.length; },
};

/* ------------------------------------------------------------------ */
/* Collision — circle vs AABB with minimum-penetration-axis resolution,*/
/* adaptive sub-stepping (anti-tunneling) and per-substep brick limits.*/
const Collision = {
  // Integrate one ball for dt with enough substeps that it never travels
  // more than R*0.45 per substep, resolving walls/paddle/bricks each step.
  moveBall(ball, dt, game) {
    if (ball.stuck) return;
    const speed = Math.hypot(ball.vx, ball.vy) || 1;
    const steps = Math.max(1, Math.ceil((speed * dt) / (ball.r * Config.PHYS.SUB_TRAVEL)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      this.walls(ball, game);
      this.paddle(ball, game);
      this.bricks(ball, game);
      this.shield(ball, game);
      ball.clampAngle();
      if (!ball.alive) return;
    }
    this._unstick(ball, dt);
  },

  walls(ball, game) {
    const r = ball.r;
    let hit = false;
    if (ball.x < r) { ball.x = r; ball.vx = Math.abs(ball.vx); hit = true; }
    else if (ball.x > Config.W - r) { ball.x = Config.W - r; ball.vx = -Math.abs(ball.vx); hit = true; }
    if (ball.y < r) { ball.y = r; ball.vy = Math.abs(ball.vy); hit = true; } // top is solid
    if (hit) {
      AudioEngine.wallTap();
      Particles.burst(ball.x, ball.y, '#63e8ff', 3, { speedMax: 90, lifeMax: 0.25 });
    }
    // Bottom is open — the owner decides what a lost ball means.
    if (ball.y - r > Config.H) {
      ball.alive = false;
      if (game.onBallLost) game.onBallLost(ball);
    }
  },

  paddle(ball, game) {
    const p = game.paddle;
    const hitBox = Geo.circleRect(ball.x, ball.y, ball.r, p.x - p.half, p.y - p.h / 2, p.width, p.h);
    if (!hitBox) return;
    // Geo.circleRect returns the PUSH direction, so a ball resting on the
    // top surface has ny = -1 (up). Route by the ball center vs the paddle
    // midline instead of by the normal: a fast paddle swipe can bury the
    // center inside the 16px body where the min-penetration axis flips to
    // the horizontal — routing on the normal there ejected the ball out
    // under the paddle ("ball passes through the paddle" bug).
    if (hitBox.nx === 0 || Math.abs(ball.y - p.y) >= Math.abs(ball.x - p.x)) {
      if (ball.y <= p.y) {
        // Top-surface bounce.
        ball.y = p.y - p.h / 2 - ball.r;
        const offset = Utils.clamp((ball.x - p.x) / p.half, -1, 1);
        const angle = offset * Config.BALL.BOUNCE_OFFSET;
        ball.vx = Math.sin(angle) * ball.speed + p.vx * Config.BALL.ENGLISH;
        ball.vy = -Math.abs(Math.cos(angle) * ball.speed);
        ball.clampAngle();
        AudioEngine.paddlePock(offset);
        game.onPaddleTouch();
        Particles.burst(ball.x, ball.y + ball.r, '#7fe8ff', 5, { angle: -Math.PI / 2, spread: 0.9, speedMax: 160, lifeMax: 0.3 });
        if (p.sticky && ball.invuln <= 0) ball.stick(p);
      } else {
        // Skimmed in from below the midline: continue downward, off the body.
        ball.y = p.y + p.h / 2 + ball.r;
        ball.vy = Math.abs(ball.vy);
      }
    } else {
      // Side swipe of the paddle edge.
      ball.x += hitBox.nx * hitBox.pen;
      ball.vx = Math.abs(ball.vx) * hitBox.nx;
    }
  },

  bricks(ball, game) {
    const candidates = game.grid.nearby(ball.x, ball.y, ball.r + 1);
    let resolved = false;
    for (const brick of candidates) {
      const hitBox = Geo.circleRect(ball.x, ball.y, ball.r, brick.x, brick.y, brick.w, brick.h);
      if (!hitBox) continue;
      // One brick impact per substep — no double destroys/combo inflation.
      if (resolved) break;
      resolved = true;
      ball.x += hitBox.nx * hitBox.pen;
      ball.y += hitBox.ny * hitBox.pen;
      if (hitBox.nx !== 0) ball.vx = Math.abs(ball.vx) * hitBox.nx;
      else ball.vy = Math.abs(ball.vy) * hitBox.ny;
      game.onBrickHit(brick, ball);
    }
  },

  shield(ball, game) {
    const sy = Config.H - 10;
    if (game.shield > 0 && ball.vy > 0 && ball.y + ball.r >= sy && ball.y + ball.r <= sy + 22) {
      ball.y = sy - ball.r;
      ball.vy = -Math.abs(ball.vy);
      game.consumeShield();
    }
  },

  // Watchdog: a ball parked inside the same 32px cell for >2s gets kicked.
  _unstick(ball, dt) {
    const cell = `${(ball.x / 32) | 0},${(ball.y / 32) | 0}`;
    if (cell === ball._cell) {
      ball._cellTime += dt;
      if (ball._cellTime > Config.BALL.UNSTICK_TIME) {
        ball._cellTime = 0;
        ball.vx += ball.speed * 0.4 * (Math.random() < 0.5 ? -1 : 1);
        ball.vy = -Math.abs(ball.vy || ball.speed * 0.5) - ball.speed * 0.2;
        ball.clampAngle();
      }
    } else {
      ball._cell = cell;
      ball._cellTime = 0;
    }
  },

  // Lasers vs bricks — axis-aligned, resolve on min-penetration axis too.
  lasers(game, dt) {
    for (const shot of game.lasers) {
      shot.update(dt);
      if (!shot.alive) continue;
      for (const brick of game.grid.nearby(shot.x, shot.y, 8)) {
        if (!brick.destroyable) continue;
        if (shot.x >= brick.x && shot.x <= brick.x + brick.w && shot.y <= brick.y + brick.h && shot.y >= brick.y) {
          shot.alive = false;
          game.onBrickHit(brick, null);
          break;
        }
      }
    }
    game.lasers = game.lasers.filter((l) => l.alive);
  },

  // Falling powerups vs paddle.
  powerups(game, dt) {
    const p = game.paddle;
    for (const pu of game.powerups) {
      pu.update(dt);
      if (!pu.alive) continue;
      if (Geo.circleRect(pu.x, pu.y, 14, p.x - p.half, p.y - p.h / 2, p.width, p.h)) {
        pu.alive = false;
        game.applyPowerUp(pu);
      }
    }
    game.powerups = game.powerups.filter((u) => u.alive);
  },
};

/* ------------------------------------------------------------------ */
/* Renderer — synthwave background, shield, popups, canvas post-FX.    */
const Renderer = {
  bgCache: null,

  drawBackground(ctx, time) {
    const grad = ctx.createLinearGradient(0, 0, 0, Config.H);
    grad.addColorStop(0, '#0b0428');
    grad.addColorStop(0.55, '#12083a');
    grad.addColorStop(1, '#1b0a4a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, Config.W, Config.H);

    // Sun glow behind the playfield.
    const sun = ctx.createRadialGradient(Config.W / 2, 210, 40, Config.W / 2, 210, 360);
    sun.addColorStop(0, 'rgba(255,43,214,0.16)');
    sun.addColorStop(1, 'rgba(255,43,214,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, Config.W, Config.H);

    // Perspective grid anchored to the horizon line.
    const horizon = 380;
    ctx.save();
    ctx.strokeStyle = 'rgba(87,74,255,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const xTop = Utils.lerp(Config.W * 0.32, Config.W * 0.68, t);
      const xBottom = Utils.lerp(-Config.W * 0.6, Config.W * 1.6, t);
      ctx.moveTo(xTop, horizon);
      ctx.lineTo(xBottom, Config.H);
    }
    const scroll = (time * 0.25) % 1;
    for (let i = 0; i < 12; i++) {
      const t = (i + scroll) / 12;
      const y = horizon + (Config.H - horizon) * t * t;
      ctx.moveTo(0, y);
      ctx.lineTo(Config.W, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,43,214,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(Config.W, horizon);
    ctx.stroke();
    ctx.restore();
  },

  drawWalls(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(34,232,255,0.5)';
    ctx.shadowColor = '#22e8ff';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(1.5, Config.H);
    ctx.lineTo(1.5, 1.5);
    ctx.lineTo(Config.W - 1.5, 1.5);
    ctx.lineTo(Config.W - 1.5, Config.H);
    ctx.stroke();
    ctx.restore();
  },

  drawShield(ctx, game, time) {
    if (game.shield <= 0) return;
    const y = Config.H - 10;
    ctx.save();
    ctx.shadowColor = '#7b5cff';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = `rgba(160,140,255,${0.7 + 0.3 * Math.sin(time * 8)})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(6, y);
    ctx.lineTo(Config.W - 6, y);
    ctx.stroke();
    ctx.restore();
  },

  drawPopups(ctx, popups) {
    ctx.save();
    ctx.font = 'bold 17px "Courier New", monospace';
    ctx.textAlign = 'center';
    for (const p of popups) {
      ctx.globalAlpha = Utils.clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();
  },

  // Scanlines + vignette on every frame (cheap, keeps the CRT feel).
  drawPostFx(ctx) {
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#000000';
    for (let y = 0; y < Config.H; y += 4) ctx.fillRect(0, y, Config.W, 2);
    ctx.globalAlpha = 1;
    const v = ctx.createRadialGradient(Config.W / 2, Config.H / 2, Config.H * 0.42, Config.W / 2, Config.H / 2, Config.H * 0.85);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, Config.W, Config.H);
    ctx.restore();
  },
};

/* ------------------------------------------------------------------ */
/* Game — state machine + main loop + scoring + HUD wiring.            */
const Game = {
  state: 'MENU', // MENU | PLAYING | PAUSED | LEVEL_CLEAR | GAME_OVER | VICTORY
  dom: {},
  canvas: null,
  ctx: null,
  scale: 1,

  paddle: null,
  balls: [],
  grid: null,
  powerups: [],
  lasers: [],
  popups: [],
  confetti: [],

  level: 1,
  score: 0,
  displayedScore: 0,
  lives: 3,
  combo: 1,
  maxCombo: 1,
  bricksBroken: 0,
  playTime: 0,
  newRecord: false,

  slowmo: 0,
  timeScale: 1,
  shake: 0,
  shakeX: 0,
  shakeY: 0,
  elapsed: 0,

  effects: {}, // active power-up timers: key -> {remaining, duration, def, forever}
  shield: 0,
  scoreMult: 1,

  _last: 0,
  _acc: 0,
  _raf: 0,

  /* ---------------- boot ---------------- */
  init() {
    this.dom = {
      canvas: document.getElementById('game-canvas'),
      frame: document.getElementById('frame'),
      hudScore: document.getElementById('hud-score'),
      hudBest: document.getElementById('hud-best'),
      hudLevel: document.getElementById('hud-level'),
      hudLives: document.getElementById('hud-lives'),
      dashFill: document.getElementById('dash-fill'),
      muteBtn: document.getElementById('mute-btn'),
      fxList: document.getElementById('fx-list'),
      comboPop: document.getElementById('combo-pop'),
      bossWrap: document.getElementById('boss-wrap'),
      bossFill: document.getElementById('boss-fill'),
      overlayMenu: document.getElementById('overlay-menu'),
      overlayPause: document.getElementById('overlay-pause'),
      overlayClear: document.getElementById('overlay-clear'),
      overlayVictory: document.getElementById('overlay-victory'),
      overlayGameover: document.getElementById('overlay-gameover'),
      startBtn: document.getElementById('start-btn'),
      pauseResumeBtn: document.getElementById('pause-resume-btn'),
      pauseMenuBtn: document.getElementById('pause-menu-btn'),
      restartBtn: document.getElementById('restart-btn'),
      overMenuBtn: document.getElementById('over-menu-btn'),
      playagainBtn: document.getElementById('playagain-btn'),
      clearBonus: document.getElementById('clear-bonus'),
      overStats: document.getElementById('over-stats'),
      victoryStats: document.getElementById('victory-stats'),
      newRecord: document.getElementById('newrecord'),
      newRecordOver: document.getElementById('newrecord-over'),
      menuHighscore: document.getElementById('menu-highscore'),
      menuBestlevel: document.getElementById('menu-bestlevel'),
      menuTotal: document.getElementById('menu-total'),
      controlsList: document.getElementById('controls-list'),
    };
    this.canvas = this.dom.canvas;
    this.ctx = this.canvas.getContext('2d');

    Particles.init();
    Input.init(this.canvas, () => AudioEngine.unlock());
    this.paddle = new Paddle();
    this.grid = new BrickGrid(1);

    this._buildControlsList();
    this._wireButtons();
    this._wireWindow();
    this._fit();
    Store.stampVersion();
    this.refreshMenuStats();
    this._updateMuteBtn();
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  },

  _buildControlsList() {
    const rows = [
      ['← → / A D', 'move paddle'],
      ['Shift', 'dash boost'],
      ['Space / click / tap', 'launch ball · fire laser · unstick'],
      ['P / Esc', 'pause'],
      ['M', 'mute'],
      ['Mouse / touch drag', 'move paddle'],
    ];
    for (const [keys, desc] of rows) {
      const li = document.createElement('li');
      const k = document.createElement('kbd');
      k.textContent = keys;
      const s = document.createElement('span');
      s.textContent = desc;
      li.append(k, s);
      this.dom.controlsList.appendChild(li);
    }
  },

  _wireButtons() {
    const on = (el, fn) => {
      if (!el) return;
      el.addEventListener('click', () => {
        el.blur(); // release keyboard focus so arrows/Space reach the game
        AudioEngine.unlock();
        AudioEngine.click();
        fn();
      });
    };
    on(this.dom.startBtn, () => this.startNewGame());
    on(this.dom.pauseResumeBtn, () => this.setPaused(false));
    on(this.dom.pauseMenuBtn, () => this.toMenu());
    on(this.dom.restartBtn, () => this.startNewGame());
    on(this.dom.overMenuBtn, () => this.toMenu());
    on(this.dom.playagainBtn, () => this.startNewGame());
    on(this.dom.muteBtn, () => {
      AudioEngine.setMuted(!AudioEngine.muted);
      this._updateMuteBtn();
    });
  },

  _wireWindow() {
    window.addEventListener('resize', () => this._fit());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'PLAYING') this.setPaused(true);
    });
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyP': case 'Escape':
          if (this.state === 'PLAYING') this.setPaused(true);
          else if (this.state === 'PAUSED') this.setPaused(false);
          break;
        case 'KeyM':
          AudioEngine.setMuted(!AudioEngine.muted);
          this._updateMuteBtn();
          break;
        case 'ArrowLeft': case 'KeyA': case 'ArrowRight': case 'KeyD':
          Input.notifyKeyboardMove();
          break;
        default: break;
      }
    });
  },

  // Keep the logical 960x640 frame inside the viewport at device pixels.
  _fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const availW = window.innerWidth;
    const availH = window.innerHeight;
    const scale = Math.min(availW / Config.W, availH / Config.H);
    this.scale = scale;
    this.canvas.width = Math.round(Config.W * scale * dpr);
    this.canvas.height = Math.round(Config.H * scale * dpr);
    this.canvas.style.width = `${Math.round(Config.W * scale)}px`;
    this.canvas.style.height = `${Math.round(Config.H * scale)}px`;
    this.ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  },

  _updateMuteBtn() {
    this.dom.muteBtn.textContent = AudioEngine.muted ? '\u266A\u0338' : '\u266A';
    this.dom.muteBtn.classList.toggle('muted', AudioEngine.muted);
    this.dom.muteBtn.setAttribute('aria-pressed', String(AudioEngine.muted));
  },

  refreshMenuStats() {
    this.dom.menuHighscore.textContent = Store.highScore;
    this.dom.menuBestlevel.textContent = Store.bestLevel;
    this.dom.menuTotal.textContent = Store.totalPlays;
    this.dom.hudBest.textContent = Store.highScore;
  },

  /* ---------------- state machine ---------------- */
  _setOverlay(name) {
    const map = {
      MENU: this.dom.overlayMenu,
      PAUSED: this.dom.overlayPause,
      LEVEL_CLEAR: this.dom.overlayClear,
      VICTORY: this.dom.overlayVictory,
      GAME_OVER: this.dom.overlayGameover,
    };
    for (const key of Object.keys(map)) {
      map[key].classList.toggle('visible', key === name);
    }
    const focusMap = {
      MENU: this.dom.startBtn,
      PAUSED: this.dom.pauseResumeBtn,
      GAME_OVER: this.dom.restartBtn,
      VICTORY: this.dom.playagainBtn,
    };
    if (focusMap[name]) requestAnimationFrame(() => focusMap[name].focus());
  },

  toMenu() {
    this.state = 'MENU';
    AudioEngine.stopPad();
    this._setOverlay('MENU');
    this.refreshMenuStats();
    this._resetRun();
    this._spawnMenuBall();
  },

  startNewGame() {
    AudioEngine.unlock();
    AudioEngine.startPad();
    Store.totalPlays = Store.totalPlays + 1;
    this._resetRun();
    this.level = 1;
    this.score = 0;
    this.displayedScore = 0;
    this.lives = Config.GAME.LIVES;
    this.combo = 1;
    this.maxCombo = 1;
    this.bricksBroken = 0;
    this.playTime = 0;
    this.newRecord = false;
    this.loadLevel(1);
    this.state = 'PLAYING';
    this._setOverlay(null);
    this.updateHud();
  },

  setPaused(paused) {
    if (paused && this.state === 'PLAYING') {
      this.state = 'PAUSED';
      AudioEngine.setPadLevel(0);
      this._setOverlay('PAUSED');
    } else if (!paused && this.state === 'PAUSED') {
      this.state = 'PLAYING';
      AudioEngine.setPadLevel(AudioEngine.muted ? 0 : PAD_LEVEL);
      this._setOverlay(null);
      this._last = performance.now(); // avoid a dt spike after resume
    }
  },

  _resetRun() {
    this.grid = new BrickGrid(1);
    this.balls.length = 0;
    this.powerups.length = 0;
    this.lasers.length = 0;
    this.popups.length = 0;
    this.confetti.length = 0;
    Particles.clear();
    this.effects = {};
    this.shield = 0;
    this.scoreMult = 1;
    this.slowmo = 0;
    this.timeScale = 1;
    this.shake = 0;
    this.paddle.reset();
    this.paddle.setFactor(1);
    this.refreshPowerHud();
    this.dom.bossWrap.classList.remove('visible');
  },

  _spawnMenuBall() {
    // Ambient ball bouncing behind the menu panel (pure decoration).
    const b = new Ball(Utils.rand(120, Config.W - 120), Utils.rand(300, 480));
    b.launch(Utils.rand(-0.7, 0.7));
    this.balls.push(b);
  },

  loadLevel(n) {
    this.level = n;
    this.grid = LevelManager.load(n, this);
    this.balls.length = 0;
    this.powerups.length = 0;
    this.lasers.length = 0;
    this.paddle.reset();
    this.paddle.setFactor(1);
    this.effects = {};
    this.refreshPowerHud();
    this.shield = 0;
    this._attachNewBall();
    this.slowmo = 0;
    this.timeScale = 1;
    this._clearGrace = 0;
    this.dom.hudScore.textContent = String(this.displayedScore);
    this._updateBossBar();
    this.updateHud();
  },

  _attachNewBall() {
    const b = new Ball(this.paddle.x, this.paddle.y - 20);
    b.invuln = Config.BALL.RESPAWN_INVULN;
    b.stuckOffset = 0;
    const lvlScale = Math.pow(Config.BALL.LEVEL_GROWTH, this.level - 1);
    b.setSpeed(Config.BALL.SPEED * lvlScale);
    this.balls.push(b);
    return b;
  },
};

/* ------------------------------------------------------------------ */
/* Game — gameplay methods (mixed into the Game object above).         */
Object.assign(Game, {
  /* ---------------- main loop ---------------- */
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (dt > Config.MAX_FRAME_DT) dt = Config.MAX_FRAME_DT; // tab was hidden
    this.elapsed += dt;

    const active = this.state === 'PLAYING' || this.state === 'LEVEL_CLEAR' || this.state === 'MENU' || this.state === 'GAME_OVER' || this.state === 'VICTORY';
    if (this.slowmo > 0) {
      this.slowmo -= dt;
      this.timeScale = Config.GAME.SLOWMO_SCALE;
      if (this.slowmo <= 0) this.timeScale = 1;
    }

    if (active) {
      let scaled = dt * this.timeScale;
      if (this.state === 'MENU') scaled = dt; // ambient drift at normal speed
      this._acc += scaled;
      let guard = 0;
      while (this._acc >= Config.STEP && guard < 8) {
        this._step(Config.STEP);
        this._acc -= Config.STEP;
        guard++;
      }
      if (guard >= 8) this._acc = 0; // drop the backlog after a long stall
    }

    this._decayFx(dt);
    this._draw();
    this._hudFrame(dt);
  },

  _step(dt) {
    if (this.state === 'MENU') {
      for (const b of this.balls) {
        Collision.moveBall(b, dt, MenuProxy);
        b.pushTrail();
      }
      Particles.update(dt);
      return;
    }
    if (this.state === 'VICTORY' || this.state === 'GAME_OVER') {
      this._updateConfetti(dt);
      Particles.update(dt);
      return;
    }
    if (this.state === 'LEVEL_CLEAR') {
      this.levelClearTimer -= dt;
      this.playTime += dt;
      Particles.update(dt);
      this._updatePopups(dt);
      if (this.levelClearTimer <= 0) this._advanceLevel();
      return;
    }

    // PLAYING
    this.playTime += dt;

    if (Input.consumeAction()) this._onAction();

    this.paddle.update(dt, this);

    for (const b of this.balls) b.update(dt, this);
    for (const b of this.balls) {
      Collision.moveBall(b, dt, this);
      b.pushTrail();
    }
    this.balls = this.balls.filter((b) => b.alive);

    this.grid.update(dt, this);
    Collision.lasers(this, dt);
    Collision.powerups(this, dt);
    this._updateEffects(dt);
    this._fireLasersIfHeld(dt);
    Particles.update(dt);
    this._updatePopups(dt);

    if (this.balls.length === 0) this._loseLife();
    else if (this.grid.destructibleCount() === 0 && this._clearGrace <= 0) this._levelClear();
    this._updateBossBar();
  },

  _menuGhostPaddle() {
    // Invisible paddle for the ambient menu ball.
    if (!this._ghost) {
      this._ghost = new Paddle();
      this._ghost.y = Config.PADDLE.Y;
    }
    this._ghost.x = Config.W / 2 + Math.sin(this.elapsed * 0.7) * 240;
    return this._ghost;
  },

  _onAction() {
    if (this.state !== 'PLAYING') return;
    let launched = false;
    for (const b of this.balls) {
      if (b.stuck) {
        b.launch();
        launched = true;
      }
    }
    if (launched) AudioEngine.paddlePock(0);
    else if (this.paddle.laser && this.paddle.laserCd <= 0) {
      this.fireLaser();
    }
  },

  fireLaser() {
    const p = this.paddle;
    p.laserCd = Config.POWER.LASER_CD;
    this.lasers.push(new Laser(p.x - p.half + 8, p.y - p.h / 2));
    this.lasers.push(new Laser(p.x + p.half - 8, p.y - p.h / 2));
    AudioEngine.laser();
  },

  _fireLasersIfHeld() {
    // Space held with laser active: repeat with cooldown once nothing is stuck.
    if (this.paddle.laser && this.paddle.laserCd <= 0 && !this.balls.some((b) => b.stuck) && Input.space) {
      this.fireLaser();
    }
  },

  /* ---------------- scoring / combos ---------------- */
  addScore(base, x, y, labelColor) {
    const gained = Math.round(base * this.combo * this.scoreMult);
    this.score += gained;
    if (this.score > Store.highScore) {
      Store.highScore = this.score;
      this.newRecord = true;
    }
    this.popups.push({ text: `+${gained}`, x, y, life: 0.9, max: 0.9, color: labelColor || '#ffffff' });
  },

  bumpCombo() {
    if (this.combo < Config.MAX_COMBO) this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    if (this.combo >= 2) {
      const el = this.dom.comboPop;
      el.textContent = `COMBO x${this.combo}`;
      el.classList.remove('pulse');
      void el.offsetWidth; // restart the CSS animation
      el.classList.add('pulse');
    }
  },

  onPaddleTouch() {
    this.combo = 1;
    this.dom.comboPop.classList.remove('pulse');
  },

  onBrickHit(brick, ball) {
    const cx = brick.x + brick.w / 2;
    const cy = brick.y + brick.h / 2;
    if (!brick.destroyable) {
      AudioEngine.wallTap();
      Particles.burst(ball ? ball.x : cx, ball ? ball.y : cy, '#c7d0e0', 4, { speedMax: 120, lifeMax: 0.3 });
      return;
    }
    const destroyed = brick.hit(1, this);
    AudioEngine.brickTick(this.combo);
    if (!destroyed) {
      Particles.burst(ball ? ball.x : cx, ball ? ball.y : cy, brick.baseColor, 5, { speedMax: 150, lifeMax: 0.3 });
      this.shake = Math.min(this.shake + 2, 6);
      return;
    }
    this._destroyBrick(brick, cx, cy);
  },

  _destroyBrick(brick, cx, cy) {
    brick.alive = false;
    this.bricksBroken++;
    this.bumpCombo();
    this.addScore(brick.points, cx, cy, brick.baseColor);
    Particles.burst(cx, cy, brick.baseColor, brick.type === 'boss' ? 90 : 18, { sizeMax: brick.type === 'boss' ? 8 : 5 });
    Particles.ring(cx, cy, '#ffffff', brick.type === 'boss' ? 26 : 10);
    this.shake = Math.min(this.shake + (brick.type === 'boss' ? 10 : 3.5), Config.GAME.SHAKE_MAX);
    if (brick.type === 'explosive') this._explode(brick);
    else if (brick.type === 'boss') this._onBossDestroyed(cx, cy);
    else AudioEngine.brickBreak();
    // Speed growth: +2.5% per brick for every live ball.
    for (const b of this.balls) b.setSpeed(b.speed * Config.BALL.BRICK_GROWTH);
    if (brick.type !== 'boss') this._maybeDropPowerUp(cx, cy);
    if (this.grid.destructibleCount() === 0) {
      this.slowmo = Config.GAME.SLOWMO; // cinematic last-brick moment
      this._clearGrace = 0.35;          // let slow-mo breathe before banner
    }
  },

  _explode(origin) {
    AudioEngine.explosion();
    const ox = origin.x + origin.w / 2, oy = origin.y + origin.h / 2;
    Particles.ring(ox, oy, '#ff9f1c', 24);
    Particles.burst(ox, oy, '#ffd319', 30, { speedMax: 420, lifeMax: 0.8, sizeMax: 6 });
    this.shake = Math.min(this.shake + 8, Config.GAME.SHAKE_MAX);
    const queue = [];
    this.grid.explode(origin, queue);
    // Chain reaction: explosives caught in the blast explode too.
    let i = 0;
    while (i < queue.length) {
      const b = queue[i++];
      if (!b.alive) continue;
      const bx = b.x + b.w / 2, by = b.y + b.h / 2;
      this.addScore(b.points, bx, by, b.baseColor);
      this.bricksBroken++;
      b.alive = false;
      Particles.burst(bx, by, b.baseColor, 14, { sizeMax: 5 });
      if (b.type === 'explosive') {
        this.grid.explode(b, queue);
        AudioEngine.explosion();
      } else {
        this._maybeDropPowerUp(bx, by);
      }
    }
    for (const b of this.balls) b.setSpeed(b.speed * Math.pow(Config.BALL.BRICK_GROWTH, 2));
    if (this.grid.destructibleCount() === 0) {
      this.slowmo = Config.GAME.SLOWMO;
      this._clearGrace = 0.35;
    }
  },

  _onBossDestroyed(cx, cy) {
    AudioEngine.explosion();
    AudioEngine.jingle([392, 523.25, 659.25, 784], 0.12, 0.3, 0.3);
    this.dom.bossWrap.classList.remove('visible');
    this.confettiBurst(cx, cy, 80);
  },

  /* ---------------- power-ups ---------------- */
  _maybeDropPowerUp(x, y) {
    if (Math.random() > Config.POWER.CHANCE) return;
    const pool = ['wide', 'multi', 'laser', 'slow', 'sticky', 'shield', 'life', 'double', 'auto'];
    if (this.level >= Config.POWER.NEG_MIN_LEVEL) pool.push('shrink', 'fast');
    let type;
    const roll = Math.random();
    if (roll < Config.POWER.AUTOPILOT_SHARE) type = 'auto';
    else if (roll < Config.POWER.AUTOPILOT_SHARE + 0.22) type = 'multi';
    else if (roll < 0.55) type = Utils.pick(['wide', 'laser', 'sticky', 'slow']);
    else if (this.level >= Config.POWER.NEG_MIN_LEVEL && roll > 0.82) type = Utils.pick(['shrink', 'fast']);
    else type = Utils.pick(['shield', 'life', 'double', 'wide', 'laser']);
    if (type === 'life' && this.lives >= Config.GAME.MAX_LIVES) type = 'shield';
    this.powerups.push(new PowerUp(x, y, type));
  },

  applyPowerUp(pu) {
    const def = pu.def;
    AudioEngine.powerup(def.good);
    this.popups.push({ text: def.label, x: pu.x, y: pu.y - 14, life: 1.1, max: 1.1, color: def.color });
    Particles.ring(pu.x, pu.y, def.color, 14);
    const P = Config.POWER;
    switch (pu.type) {
      case 'wide':
        this._setPaddleFactor(this.paddle.factor * 1.45, 'wide', P.DURATION);
        break;
      case 'shrink':
        this._setPaddleFactor(this.paddle.factor * 0.62, 'shrink', P.DURATION);
        break;
      case 'multi': {
        const src = this.balls.find((b) => !b.stuck) || this.balls[0];
        if (src) {
          const room = P.MAX_BALLS - this.balls.length;
          for (let i = 0; i < Math.min(2, room); i++) {
            const b = new Ball(src.x, src.y);
            b.setSpeed(src.speed);
            // atan2(0, -0) === PI when the source ball is stuck on the paddle,
            // which would launch clones downward off-screen: aim them up instead.
            const baseAng = src.stuck ? 0 : Math.atan2(src.vx, -src.vy);
            b.launch(baseAng + (i === 0 ? 0.5 : -0.5));
            b.clampAngle();
            this.balls.push(b);
          }
        }
        break;
      }
      case 'laser':
        this.paddle.laser = true;
        this._addEffect('laser', P.DURATION);
        break;
      case 'slow':
        for (const b of this.balls) b.setSpeed(b.speed * 0.7);
        this._addEffect('slow', P.DURATION);
        break;
      case 'fast':
        for (const b of this.balls) b.setSpeed(b.speed * 1.3);
        this._addEffect('fast', P.DURATION);
        break;
      case 'sticky':
        this.paddle.sticky = true;
        this._addEffect('sticky', P.DURATION);
        break;
      case 'shield':
        this.shield = 1;
        break;
      case 'life':
        this.lives = Math.min(Config.GAME.MAX_LIVES, this.lives + 1);
        this.updateHud();
        break;
      case 'double':
        this.scoreMult = 2;
        this._addEffect('double', P.DOUBLE_DURATION);
        break;
      case 'auto':
        this.paddle.autopilot = P.AUTO_DURATION;
        this._addEffect('auto', P.AUTO_DURATION);
        break;
      default: break;
    }
    this.refreshPowerHud();
  },

  _setPaddleFactor(factor, effectKey, duration) {
    for (const k of ['wide', 'shrink']) delete this.effects[k];
    this.paddle.setFactor(factor);
    this._addEffect(effectKey, duration);
  },

  _addEffect(key, duration) {
    this.effects[key] = { remaining: duration, duration, def: POWER_DEFS[key] };
  },

  _updateEffects(dt) {
    let expired = false;
    for (const key of Object.keys(this.effects)) {
      const fx = this.effects[key];
      fx.remaining -= dt;
      if (fx.remaining > 0) continue;
      delete this.effects[key];
      expired = true;
      switch (key) {
        case 'wide': case 'shrink':
          this.paddle.setFactor(1);
          break;
        case 'laser':
          this.paddle.laser = false;
          break;
        case 'sticky':
          this.paddle.sticky = false;
          break;
        case 'double':
          this.scoreMult = 1;
          break;
        case 'auto':
          this.paddle.autopilot = 0;
          break;
        default: break;
      }
    }
    if (expired) this.refreshPowerHud();
    if (this._clearGrace > 0) this._clearGrace -= dt;
    this._renderPowerHud();
  },

  consumeShield() {
    this.shield = 0;
    AudioEngine.powerup(true);
    Particles.ring(Config.W / 2, Config.H - 10, '#7b5cff', 30);
    this.refreshPowerHud();
  },

  /* ---------------- HUD ---------------- */
  _powerHudBuilt: false,

  refreshPowerHud() {
    const wrap = this.dom.fxList;
    wrap.innerHTML = '';
    const keys = [...Object.keys(this.effects)];
    if (this.shield > 0) keys.push('shieldfx');
    for (const key of keys) {
      const def = key === 'shieldfx' ? { icon: '▬', color: '#7b5cff', label: 'SHIELD' } : this.effects[key].def;
      const item = document.createElement('div');
      item.className = 'fx-item';
      item.dataset.key = key;
      item.title = def.label;
      const icon = document.createElement('span');
      icon.className = 'fx-icon';
      icon.style.color = def.color;
      icon.textContent = def.icon;
      const bar = document.createElement('span');
      bar.className = 'fx-bar';
      const fill = document.createElement('span');
      fill.className = 'fx-fill';
      fill.style.background = def.color;
      bar.appendChild(fill);
      item.append(icon, bar);
      wrap.appendChild(item);
    }
    this._powerHudBuilt = true;
    this._renderPowerHud();
  },

  _renderPowerHud() {
    for (const item of this.dom.fxList.children) {
      const key = item.dataset.key;
      const fill = item.querySelector('.fx-fill');
      if (key === 'shieldfx') {
        fill.style.width = '100%';
        continue;
      }
      const fx = this.effects[key];
      if (!fx) continue;
      fill.style.width = `${Utils.clamp(fx.remaining / fx.duration, 0, 1) * 100}%`;
    }
  },

  updateHud() {
    this.dom.hudScore.textContent = String(this.displayedScore);
    this.dom.hudLevel.textContent = this.level;
    const lives = this.dom.hudLives;
    lives.innerHTML = '';
    for (let i = 0; i < this.lives; i++) {
      const s = document.createElement('span');
      s.className = 'life-icon';
      s.textContent = '\u2665';
      lives.appendChild(s);
    }
  },

  _hudFrame(dt) {
    // Score count-up easing toward the real value.
    const diff = this.score - this.displayedScore;
    if (diff !== 0) {
      this.displayedScore += Math.sign(diff) * Math.max(1, Math.ceil(Math.abs(diff) * Math.min(1, dt * 8)));
      if ((diff > 0 && this.displayedScore > this.score) || (diff < 0 && this.displayedScore < this.score)) {
        this.displayedScore = this.score;
      }
      this.dom.hudScore.textContent = this.displayedScore;
    }
    this.dom.hudBest.textContent = Store.highScore;
    this.dom.dashFill.style.width = `${this.paddle.dash * 100}%`;
    this.dom.dashFill.classList.toggle('low', this.paddle.dash < 0.25);
  },

  _updateBossBar() {
    const boss = this.grid.bricks.find((b) => b.type === 'boss' && b.alive);
    if (boss) {
      this.dom.bossWrap.classList.add('visible');
      this.dom.bossFill.style.width = `${(boss.hp / boss.maxHp) * 100}%`;
    } else {
      this.dom.bossWrap.classList.remove('visible');
    }
  },
});

/* ------------------------------------------------------------------ */
/* Game — drawing, life/level flow, confetti, boot.                    */
const EMPTY_GRID = {
  bricks: [],
  nearby: () => [],
  destructibleCount: () => 0,
  update: () => {},
};

// Collision target for the decorative menu ball: invisible moving paddle,
// no bricks; balls that fall off recycle to the top instead of costing lives.
const MenuProxy = {
  get paddle() { return Game._menuGhostPaddle(); },
  grid: EMPTY_GRID,
  shield: 0,
  onBallLost(ball) {
    ball.alive = true;
    ball.x = Utils.rand(80, Config.W - 80);
    ball.y = -10;
    ball.vx = Utils.rand(-160, 160);
    ball.vy = Utils.rand(180, 260);
  },
  onPaddleTouch() {},
};

Object.assign(Game, {
  _clearGrace: 0,
  levelClearTimer: 0,

  _decayFx(dt) {
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - this.shake * Config.GAME.SHAKE_DECAY * dt - dt * 2);
      this.shakeX = Utils.rand(-this.shake, this.shake);
      this.shakeY = Utils.rand(-this.shake, this.shake);
    } else {
      this.shakeX = this.shakeY = 0;
    }
  },

  _draw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.shakeX, this.shakeY);
    Renderer.drawBackground(ctx, this.elapsed);
    Renderer.drawWalls(ctx);
    this.grid.draw(ctx);
    for (const pu of this.powerups) pu.draw(ctx);
    for (const l of this.lasers) l.draw(ctx);
    if (this.state !== 'MENU') this.paddle.draw(ctx);
    Renderer.drawShield(ctx, this, this.elapsed);
    for (const b of this.balls) b.draw(ctx, this.elapsed);
    Particles.draw(ctx);
    Renderer.drawPopups(ctx, this.popups);
    this._drawConfetti(ctx);
    ctx.restore();
    Renderer.drawPostFx(ctx);
  },

  _updatePopups(dt) {
    for (const p of this.popups) {
      p.life -= dt;
      p.y -= 34 * dt;
    }
    this.popups = this.popups.filter((p) => p.life > 0);
  },

  /* ---------------- life / level flow ---------------- */
  _loseLife() {
    this.lives--;
    this.combo = 1;
    this.dom.comboPop.classList.remove('pulse');
    this.updateHud();
    AudioEngine.lifeLost();
    this.shake = 10;
    Particles.ring(Config.W / 2, Config.H - 4, '#ff2b4e', 22);
    if (this.lives <= 0) this._gameOver();
    else this._attachNewBall(); // glued to the paddle, 0.6s invulnerable
  },

  _levelClear() {
    this.state = 'LEVEL_CLEAR';
    this.levelClearTimer = Config.GAME.LEVEL_BANNER;
    const bonus = Config.GAME.LEVEL_BONUS_PER_LIFE * this.lives;
    this.score += bonus;
    if (this.score > Store.highScore) {
      Store.highScore = this.score;
      this.newRecord = true;
    }
    this.dom.clearBonus.textContent = `Life bonus +${bonus}`;
    this._setOverlay('LEVEL_CLEAR');
    AudioEngine.levelJingle();
  },

  _advanceLevel() {
    this._setOverlay(null);
    if (this.level >= LevelManager.count()) {
      this._victory();
      return;
    }
    this.loadLevel(this.level + 1);
    this.state = 'PLAYING';
    Store.bestLevel = Math.max(Store.bestLevel, this.level);
  },

  _statsHtml() {
    return `Score <strong>${this.score}</strong> &middot; Level <strong>${this.level}</strong>` +
      ` &middot; Bricks <strong>${this.bricksBroken}</strong> &middot; Time <strong>${Utils.formatTime(this.playTime)}</strong>` +
      ` &middot; Max combo <strong>x${this.maxCombo}</strong><br>High score <strong>${Store.highScore}</strong>`;
  },

  _gameOver() {
    this.state = 'GAME_OVER';
    AudioEngine.setPadLevel(0);
    Store.bestLevel = Math.max(Store.bestLevel, this.level);
    this.dom.overStats.innerHTML = this._statsHtml();
    this.dom.newRecordOver.hidden = !this.newRecord;
    this._setOverlay('GAME_OVER');
    if (this.newRecord) this.confettiRain();
  },

  _victory() {
    this.state = 'VICTORY';
    AudioEngine.setPadLevel(0);
    Store.bestLevel = Math.max(Store.bestLevel, LevelManager.count());
    this.dom.victoryStats.innerHTML = this._statsHtml();
    this.dom.newRecord.hidden = !this.newRecord;
    this._setOverlay('VICTORY');
    AudioEngine.victoryJingle();
    this.confettiRain();
  },

  /* ---------------- confetti ---------------- */
  confettiRain() {
    const colors = ['#ff2bd6', '#22e8ff', '#ffd319', '#41ff8a', '#b44bff'];
    for (let i = 0; i < 160; i++) {
      this.confetti.push({
        x: Utils.rand(0, Config.W),
        y: Utils.rand(-Config.H, 0),
        vx: Utils.rand(-40, 40),
        vy: Utils.rand(90, 260),
        w: Utils.rand(4, 9),
        h: Utils.rand(6, 12),
        rot: Utils.rand(0, Math.PI),
        vr: Utils.rand(-4, 4),
        color: Utils.pick(colors),
      });
    }
  },

  confettiBurst(x, y, n) {
    const colors = ['#ff2bd6', '#22e8ff', '#ffd319', '#41ff8a', '#ffffff'];
    for (let i = 0; i < n; i++) {
      const ang = Utils.rand(0, Math.PI * 2);
      const spd = Utils.rand(80, 380);
      this.confetti.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 120,
        w: Utils.rand(3, 7),
        h: Utils.rand(5, 10),
        rot: Utils.rand(0, Math.PI),
        vr: Utils.rand(-6, 6),
        color: Utils.pick(colors),
      });
    }
  },

  _updateConfetti(dt) {
    for (const c of this.confetti) {
      c.vy += 300 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
    }
    this.confetti = this.confetti.filter((c) => c.y < Config.H + 30);
  },

  _drawConfetti(ctx) {
    if (!this.confetti.length) return;
    ctx.save();
    for (const c of this.confetti) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
    ctx.restore();
  },
});

/* ------------------------------------------------------------------ */
/* Boot + optional Playwright hook (`?test=1` only).                   */
function boot() {
  Game.init();
  Game.toMenu();

  if (new URLSearchParams(window.location.search).get('test') === '1') {
    window.__GAME = {
      get score() { return Game.score; },
      get state() { return Game.state; },
      get level() { return Game.level; },
      get lives() { return Game.lives; },
      get balls() { return Game.balls.map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, stuck: b.stuck, speed: b.speed })); },
      get bricks() { return Game.grid.bricks.filter((b) => b.alive).length; },
      get paddle() { return { x: Game.paddle.x, width: Game.paddle.width }; },
      get combo() { return Game.combo; },
      get effects() { return Object.keys(Game.effects); },
      get shield() { return Game.shield; },
      get scoreMult() { return Game.scoreMult; },
      get brickTypes() {
        const counts = {};
        for (const b of Game.grid.bricks) {
          if (b.alive) counts[b.type] = (counts[b.type] || 0) + 1;
        }
        return counts;
      },
      get lasers() { return Game.lasers.length; },
      get bricksTotal() { return Game.grid.bricks.length; },
      get boss() {
        const boss = Game.grid.bricks.find((b) => b.alive && b.type === 'boss');
        return boss ? { hp: boss.hp, maxHp: boss.maxHp, x: boss.x, y: boss.y, w: boss.w, h: boss.h } : null;
      },
      // Test hook: audio engine internals (probe pad lifecycle).
      get audio() { return AudioEngine; },
      // Test helpers: deterministic power-up injection without waiting for drops.
      grantPower(type) { Game.applyPowerUp(new PowerUp(Game.paddle.x, Game.paddle.y - 60, type)); },
      forceLevel(n) { Game.loadLevel(Utils.clamp(n, 1, LevelManager.count())); Game.state = 'PLAYING'; },
      toMenu() { Game.toMenu(); },
      startGame() { Game.startNewGame(); },
      setPaused(v) { Game.setPaused(v); },
      forceClear() { Game._levelClear(); },
      killAllBalls() { for (const b of Game.balls) b.alive = false; },
      dropBall(x, y) {
        const b = new Ball(x, y);
        Game.balls.push(b);
        b.launch();
      },
      pokeBall(x, y, vx, vy) {
        const b = new Ball(x, y);
        Game.balls.push(b);
        b.stuck = false;
        b.vx = vx;
        b.vy = vy;
        b.clampAngle();
      },
      // Tagged ball for probes: track the REAL object across evaluates.
      pokeTracked(x, y, vx, vy) {
        const b = new Ball(x, y);
        b.__tag = 'P';
        Game.balls.push(b);
        b.stuck = false;
        b.vx = vx;
        b.vy = vy;
        b.clampAngle();
      },
      get ballP() {
        const b = Game.balls.find((x) => x.__tag === 'P');
        return b ? { alive: b.alive, x: b.x, y: b.y, vx: b.vx, vy: b.vy, stuck: b.stuck, inv: b.invuln } : null;
      },
      clearTagged() { for (const b of Game.balls) if (b.__tag) b.alive = false; },
      setLives(n) { Game.lives = n; Game.updateHud(); },
      hitBoss(dmg) {
        const boss = Game.grid.bricks.find((b) => b.alive && b.type === 'boss');
        if (!boss) return false;
        boss.hp -= dmg;
        boss.flash = 1;
        if (boss.hp <= 0) boss.alive = false;
        return true;
      },
    };
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
})();

