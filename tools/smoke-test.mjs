/* Prism Breaker smoke test — Playwright, headless.
 * Usage: node tools/smoke-test.mjs   (needs the `playwright` package resolvable
 * via NODE_PATH / global npm root; uses /usr/bin/chromium when present).
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  const roots = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  roots.push('/usr/local/lib/node_modules', '/tmp/pwharness/node_modules');
  for (const root of roots) {
    try {
      ({ chromium } = require(path.join(root, 'playwright')));
      break;
    } catch { /* try next root */ }
  }
}
if (!chromium) throw new Error('playwright package not found (set NODE_PATH)');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'tools', 'shots');
const EXEC = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// Resolve true when `port` can be bound on `host` right now.
function listenProbe(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  // 1) Serve the game from the project directory on :8001. If [::1]:8001 is
  //    taken inside this sandbox, fall forward to a free IPv4 port.
  let PORT = 8001;
  let bind = '::1';
  if (!(await listenProbe(8001, '::1'))) {
    PORT = null;
    for (let p = 8001; p < 8011; p++) {
      if (await listenProbe(p, '127.0.0.1')) { PORT = p; break; }
    }
    bind = '127.0.0.1';
    console.log(`note: [::1]:8001 busy in this sandbox, using 127.0.0.1:${PORT}`);
  }
  const URL = `http://localhost:${PORT}/?test=1`;

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', bind], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d.toString(); });

  // 2) Wait for the server, then open the page with console/pageerror capture.
  let up = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !up) {
    const probeUrls = bind === '::1'
      ? [`http://[::1]:${PORT}/`, `http://localhost:${PORT}/`]
      : [`http://127.0.0.1:${PORT}/`];
    for (const probeUrl of probeUrls) {
      try {
        const res = await fetch(probeUrl, { method: 'HEAD' });
        if (res.ok) { up = true; break; }
      } catch { /* retry */ }
    }
    if (!up) await sleep(150);
  }
  if (!up) {
    server.kill();
    throw new Error(`http server did not come up on :${PORT}. stderr: ${serverErr}`);
  }

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let browser;

  try {
    browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--mute-audio'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(URL, { waitUntil: 'load' });
    await sleep(400);

    const menuState = await page.evaluate(() => window.__GAME?.state);
    check('menu shown on load (__GAME.state === MENU)', menuState === 'MENU', `state=${menuState}`);
    await page.screenshot({ path: path.join(SHOTS, 'menu.png') });

    // 3) Start, launch the ball, play ~8s with keyboard + mouse.
    await page.click('#start-btn');
    await sleep(200);
    await page.keyboard.press('Space');
    await sleep(200);

    let ballStart = null;
    let ballEnd = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const snap = await page.evaluate(() => ({
        balls: window.__GAME.balls,
        score: window.__GAME.score,
      }));
      if (snap.balls.length) {
        if (!ballStart) ballStart = { ...snap.balls[0] };
        ballEnd = { ...snap.balls[snap.balls.length - 1] };
      }
      // Keyboard wiggle (accelerated paddle movement)...
      if (Date.now() % 800 < 400) await page.keyboard.down('ArrowRight');
      else await page.keyboard.up('ArrowRight');
      await sleep(150);
      await page.keyboard.up('ArrowRight');
      // ...plus mouse steering toward the falling ball.
      if (snap.balls.length) {
        const rect = await page.evaluate(() => {
          const r = document.getElementById('game-canvas').getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        });
        const b = snap.balls[0];
        await page.mouse.move(rect.left + (b.x / 960) * rect.width, rect.top + rect.height * 0.9);
      } else {
        await page.keyboard.press('Space'); // re-launch a respawned (stuck) ball
      }
      await sleep(150);
    }

    // 4) Core assertions.
    await sleep(600); // let the HUD count-up catch up
    const finalState = await page.evaluate(() => window.__GAME.state);
    check('state left MENU and is playing', finalState === 'PLAYING', `state=${finalState}`);

    const ballMoved = ballStart && ballEnd &&
      (Math.abs(ballStart.x - ballEnd.x) > 5 || Math.abs(ballStart.y - ballEnd.y) > 5);
    check('ball moved (coordinates changed)', !!ballMoved,
      ballStart && ballEnd ? `(${ballStart.x.toFixed(0)},${ballStart.y.toFixed(0)}) -> (${ballEnd.x.toFixed(0)},${ballEnd.y.toFixed(0)})` : 'no ball sample');

    const score = await page.evaluate(() => window.__GAME.score);
    check('score increased (>= 1 brick destroyed)', score > 0, `score=${score}`);

    const hudScore = await page.textContent('#hud-score');
    check('HUD shows score != 0', hudScore !== null && Number(hudScore) !== 0, `hud=${hudScore}`);

    await page.screenshot({ path: path.join(SHOTS, 'playing.png') });

    // 5a) Pause with P, then resume.
    await page.keyboard.press('KeyP');
    await sleep(250);
    const paused = await page.evaluate(() => window.__GAME.state);
    check('P pauses the game', paused === 'PAUSED', `state=${paused}`);
    await page.keyboard.press('KeyP');
    await sleep(250);
    const resumed = await page.evaluate(() => window.__GAME.state);
    check('P resumes the game', resumed === 'PLAYING', `state=${resumed}`);

    // 5b) Level clear banner (forced through the test hook) + screenshot.
    await page.evaluate(() => window.__GAME.forceClear());
    await sleep(350);
    const cleared = await page.evaluate(() => window.__GAME.state);
    check('LEVEL_CLEAR banner shows', cleared === 'LEVEL_CLEAR', `state=${cleared}`);
    await page.screenshot({ path: path.join(SHOTS, 'level-clear.png') });
    await page.waitForFunction(() => window.__GAME.state !== 'LEVEL_CLEAR', null, { timeout: 5000 });
    const afterClear = await page.evaluate(() => window.__GAME.state);
    check('auto-advances back to PLAYING', afterClear === 'PLAYING', `state=${afterClear}`);

    // 5c) Game over via losing all balls (3 lives), then restart from the overlay.
    //     Space between kills launches the respawned ball; it must stop the
    //     moment GAME_OVER shows, since Space also confirms the game-over screen.
    let overState = '';
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__GAME.killAllBalls());
      await sleep(300);
      overState = await page.evaluate(() => window.__GAME.state);
      if (overState === 'GAME_OVER') break;
      await page.keyboard.press('Space');
      await sleep(300);
    }
    check('losing all balls ends in GAME_OVER', overState === 'GAME_OVER', `state=${overState}`);
    await page.screenshot({ path: path.join(SHOTS, 'game-over.png') });

    await page.click('#restart-btn');
    await sleep(300);
    const restarted = await page.evaluate(() => ({ state: window.__GAME.state, score: window.__GAME.score }));
    check('restart from game over works', restarted.state === 'PLAYING' && restarted.score === 0,
      `state=${restarted.state} score=${restarted.score}`);

    // High score persisted to storage.
    const storedHigh = await page.evaluate(() => JSON.parse(localStorage.getItem('prismbreaker.highScore') || '0'));
    check('high score persisted in localStorage', storedHigh > 0, `highScore=${storedHigh}`);
    await page.reload({ waitUntil: 'load' });
    await sleep(300);
    const menuHigh = await page.textContent('#menu-highscore');
    check('menu shows persisted high score after reload', Number(menuHigh) > 0, `menu=${menuHigh}`);

    // 5d) Mobile viewport resize: no errors, no page scroll.
    await page.setViewportSize({ width: 375, height: 667 });
    await sleep(400);
    const noScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      document.documentElement.scrollHeight <= window.innerHeight + 1);
    check('no page scroll at 375x667', noScroll);
    await page.screenshot({ path: path.join(SHOTS, 'mobile-375x667.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(300);

    // 6) Deep power-up & level-content suite (uses the ?test=1 hook).
    await page.evaluate(() => window.__GAME.setLives(5)); // headroom for ball losses

    const snap = () => page.evaluate(() => window.__GAME);
    const fxChips = () => page.evaluate(() => document.querySelectorAll('#fx-list .fx-item').length);

    // Level content: steel from L3, moving from L4, boss (50 HP) at L5.
    await page.evaluate(() => window.__GAME.forceLevel(3));
    await sleep(250);
    let types = await page.evaluate(() => window.__GAME.brickTypes);
    check('steel bricks present at level 3+', !!types.steel, JSON.stringify(types));
    await page.evaluate(() => window.__GAME.forceLevel(4));
    await sleep(250);
    types = await page.evaluate(() => window.__GAME.brickTypes);
    check('moving bricks present at level 4+', !!types.moving, JSON.stringify(types));
    await page.evaluate(() => window.__GAME.forceLevel(5));
    await sleep(250);
    let boss = await page.evaluate(() => window.__GAME.boss);
    check('boss brick at level 5 with 50 HP', !!boss && boss.hp === 50, JSON.stringify(boss));
    const bossBarVisible = await page.evaluate(() =>
      document.getElementById('boss-wrap').classList.contains('visible'));
    check('boss HP bar visible', bossBarVisible);
    // Boss damage path: hitBoss(15) puts it at 70% HP (<75% threshold), which
    // makes its timed phase switch spawn a minion brick; the HP bar must shrink.
    const total0 = await page.evaluate(() => {
      window.__GAME.hitBoss(15);
      return window.__GAME.bricksTotal;
    });
    await sleep(250);
    boss = await page.evaluate(() => window.__GAME.boss);
    const bossBarWidth = await page.evaluate(() => document.getElementById('boss-fill').style.width);
    check('boss takes damage (HP 50 -> 35)', !!boss && boss.hp === 35, JSON.stringify(boss));
    check('boss bar shrinks below 100%', bossBarWidth !== '100%', `width=${bossBarWidth}`);
    await sleep(4500); // phase switch at <75% HP spawns a minion
    const total1 = await page.evaluate(() => window.__GAME.bricksTotal);
    check('boss phase spawns a minion brick', total1 > total0, `total ${total0} -> ${total1}`);
    // Real collision path: balls fired at the boss column must deal damage.
    await page.evaluate(() => {
      const b = window.__GAME.boss;
      if (!b) return;
      for (let i = 0; i < 8; i++) {
        window.__GAME.pokeBall(b.x + b.w / 2 + (i % 2 ? 12 : -12), 350, 0, -520);
      }
    });
    await sleep(1800);
    boss = await page.evaluate(() => window.__GAME.boss);
    check('balls damage the boss via collisions', !boss || boss.hp < 35, JSON.stringify(boss));

    // Wide / Shrink paddle.
    const w0 = (await snap()).paddle.width;
    await page.evaluate(() => window.__GAME.grantPower('wide'));
    await sleep(150);
    let pw = (await snap()).paddle.width;
    check('Wide Paddle grows the paddle', pw > w0 + 20, `${w0} -> ${pw}`);
    check('wide effect chip in HUD', (await snap()).effects.includes('wide'));
    await page.evaluate(() => window.__GAME.grantPower('shrink'));
    await sleep(150);
    pw = (await snap()).paddle.width;
    check('Shrink Paddle (negative) shrinks the paddle', pw < w0 - 5, `${w0} -> ${pw}`);
    check('shrink chip replaces wide chip', (await snap()).effects.includes('shrink') &&
      !(await snap()).effects.includes('wide'));

    // Extra Life.
    const lives0 = (await snap()).lives;
    await page.evaluate(() => window.__GAME.grantPower('life'));
    await sleep(150);
    const lives1 = (await snap()).lives;
    check('Extra Life adds a life', lives1 === Math.min(6, lives0 + 1), `${lives0} -> ${lives1}`);
    const lifeIcons = await page.evaluate(() => document.querySelectorAll('#hud-lives .life-icon').length);
    check('HUD life icons match lives', lifeIcons === lives1, `icons=${lifeIcons} lives=${lives1}`);

    // Multi-Ball: clear the field, let the respawn ball attach to the paddle,
    // then split — 1 -> 3 -> 5 -> 6 (hard cap MAX_BALLS).
    await page.evaluate(() => {
      window.__GAME.setLives(6);
      window.__GAME.killAllBalls();
    });
    await sleep(600); // respawn attaches one stuck ball
    await page.evaluate(() => window.__GAME.grantPower('multi'));
    await sleep(150);
    const nb1 = (await snap()).balls.length;
    await page.evaluate(() => window.__GAME.grantPower('multi'));
    await sleep(150);
    const nb2 = (await snap()).balls.length;
    await page.evaluate(() => window.__GAME.grantPower('multi'));
    await sleep(150);
    const nb3 = (await snap()).balls.length;
    check('Multi-Ball splits 1 -> 3 -> 5 -> 6 with a hard cap at 6',
      nb1 === 3 && nb2 === 5 && nb3 === 6, `counts ${nb1}/${nb2}/${nb3}`);
    // Launch everything so later tests have live balls in play.
    await page.keyboard.press('Space');
    await sleep(200);

    // Laser Paddle: holding Space fires projectiles.
    await page.evaluate(() => window.__GAME.grantPower('laser'));
    await sleep(150);
    check('laser effect active', (await snap()).effects.includes('laser'));
    await page.keyboard.down('Space');
    await sleep(400);
    const laserShots = (await snap()).lasers;
    await page.keyboard.up('Space');
    check('Laser Paddle fires on Space', laserShots > 0, `lasers=${laserShots}`);

    // Slow Ball / Fast Ball scale ball speed (MIN_SPEED clamp + per-brick
    // growth make the exact ratio imprecise; assert direction + chips).
    await page.evaluate(() => window.__GAME.grantPower('slow'));
    await sleep(200);
    const speed0 = (await snap()).balls[0].speed;
    const slowChip = (await snap()).effects.includes('slow');
    const speedSlow = (await snap()).balls[0].speed;
    check('Slow Ball slows the ball + HUD chip', slowChip && speedSlow <= speed0 + 1 && speed0 <= 341,
      `chip=${slowChip} speed=${speed0.toFixed(0)} (base 340)`);
    await page.evaluate(() => window.__GAME.grantPower('fast'));
    await sleep(200);
    const speedFast = (await snap()).balls[0].speed;
    const fastChip = (await snap()).effects.includes('fast');
    check('Fast Ball (negative) speeds the ball + HUD chip', fastChip && speedFast > speedSlow * 1.2,
      `${speedSlow.toFixed(0)} -> ${speedFast.toFixed(0)} chip=${fastChip}`);

    // Sticky Paddle: descending ball sticks, Space relaunches.
    await page.evaluate(() => window.__GAME.grantPower('sticky'));
    await sleep(150);
    const pdl = (await snap()).paddle;
    await page.evaluate(([x]) => window.__GAME.pokeBall(x, 400, 0, 320), [pdl.x]);
    await page.waitForFunction(
      (px) => window.__GAME.balls.some((b) => b.stuck && Math.abs(b.x - px) < 80), pdl.x,
      { timeout: 3000 },
    ).catch(() => {});
    const stuckAny = await page.evaluate((px) =>
      window.__GAME.balls.some((b) => b.stuck && Math.abs(b.x - px) < 80), pdl.x);
    check('Sticky Paddle catches a descending ball', stuckAny);
    if (stuckAny) {
      await page.keyboard.press('Space');
      await sleep(200);
      const stillStuck = await page.evaluate((px) =>
        window.__GAME.balls.some((b) => b.stuck && Math.abs(b.x - px) < 80), pdl.x);
      check('Space relaunches the sticky ball', !stillStuck);
    }

    // Shield: single-use barrier at the bottom.
    await page.evaluate(() => window.__GAME.grantPower('shield'));
    await sleep(120);
    const shieldOn = (await snap()).shield;
    const shieldChip = await page.evaluate(() =>
      !!document.querySelector('#fx-list .fx-item[data-key="shieldfx"]'));
    check('Shield active + HUD chip', shieldOn === 1 && shieldChip);
    await page.evaluate(([x]) => window.__GAME.pokeBall(x, 622, 0, 300), [pdl.x]);
    await page.waitForFunction(() => window.__GAME.shield === 0, null, { timeout: 2500 }).catch(() => {});
    const shieldAfter = (await snap()).shield;
    check('Shield consumed once saving a falling ball', shieldAfter === 0, `shield=${shieldAfter}`);

    // Score x2.
    const mult0 = (await snap()).scoreMult;
    await page.evaluate(() => window.__GAME.grantPower('double'));
    await sleep(120);
    const mult1 = (await snap()).scoreMult;
    check('Score x2 doubles multiplier', mult0 === 1 && mult1 === 2, `${mult0} -> ${mult1}`);

    // Autopilot steers the paddle even while the mouse is pinned far left.
    await page.evaluate(() => window.__GAME.setLives(6)); // survive stray ball losses during the autopilot wait
    const rect2 = await page.evaluate(() => {
      const r = document.getElementById('game-canvas').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    await page.mouse.move(rect2.left + 5, rect2.top + rect2.height - 20);
    await sleep(350);
    const pxBefore = (await snap()).paddle.x;
    await page.evaluate(() => window.__GAME.grantPower('auto'));
    await sleep(900);
    const pxAfter = (await snap()).paddle.x;
    check('Autopilot moves the paddle on its own', Math.abs(pxAfter - pxBefore) > 25,
      `${pxBefore.toFixed(0)} -> ${pxAfter.toFixed(0)}`);
    const snapNow = await snap();
    const fxCount = await fxChips();
    check('HUD chip count matches active effects + shield',
      fxCount === snapNow.effects.length + snapNow.shield,
      `chips=${fxCount} effects=${snapNow.effects.length} shield=${snapNow.shield}`);
    await page.screenshot({ path: path.join(SHOTS, 'powerups.png') });

    // Autopilot expires after ~5 s (short by design).
    await page.waitForFunction(() => !window.__GAME.effects.includes('auto'), null, { timeout: 7000 });
    check('Autopilot expires after its duration', true);

    // 1920x1080 desktop layout sanity (acceptance criterion).
    await page.setViewportSize({ width: 1920, height: 1080 });
    await sleep(400);
    const noScroll1080 = await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1 &&
      document.documentElement.scrollHeight <= window.innerHeight + 1);
    check('no page scroll at 1920x1080', noScroll1080);
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(200);

    // Whole-session zero-error assertions.
    check('zero pageerror events', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
    check('zero console error messages', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 400));
    if (consoleWarnings.length) console.log(`note: ${consoleWarnings.length} console warning(s): ${consoleWarnings.join(' | ').slice(0, 300)}`);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM'); // 7) stop the server we started
  }

  console.log('----------------------------------------');
  if (failures.length) {
    console.log(`SMOKE TEST FAILED (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED — 0 pageerrors, 0 console errors');
}

main().catch((err) => {
  console.error('SMOKE TEST CRASHED:', err);
  process.exit(2);
});
