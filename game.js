'use strict';

/* =========================================================
   WHITE DASH — a tiny one-button runner.
   Press to jump. Hold to jump higher. Don't touch the dashes.
   ========================================================= */

/* ---------- DOM & canvas ---------- */
const canvas   = document.getElementById('game');
const ctx      = canvas.getContext('2d');
const scoreEl  = document.getElementById('score');
const bestEl   = document.getElementById('best');
const screenEl = document.getElementById('screen');
const soundBtn = document.getElementById('sound');

/* ---------- Palette & tuning ---------- */
const INK  = '#161616';
const GREY = '#c9c9c5';
const DARK = '#2b2b2b';

const PLAYER_SIZE  = 30;
const GRAVITY      = 2600;
const JUMP_V       = -980;
const JUMP_CUT     = 0.42;   // release early → shorter hop
const JUMP_BUFFER  = 0.13;   // pressing just before landing still jumps
const BASE_SPEED   = 340;
const MAX_SPEED    = 740;
const SPEED_PER_PT = 7;

/* ---------- State ---------- */
const READY = 'ready', PLAYING = 'playing', DYING = 'dying', OVER = 'over';
let state = READY;

let W = 0, H = 0, GROUND = 0, t = 0;
let score = 0, streak = 0, speed = BASE_SPEED;
let best = Number(lsGet('wd_best', '0'));
let beatBest = false;          // crossed the old record during this run
let newBest = false;           // record actually improved at death
let spawnIn = 0, scrollX = 0, runDust = 0;
let buffer = 0;                // jump input buffer time left
let flash = 0, shake = 0, dieT = 0, overAt = 0;

const player = { x: 0, y: 0, vy: 0, ground: true, rot: 0, spin: 0, sq: 0 };
let obstacles = [], particles = [], rings = [], stars = [];

/* localStorage can throw in sandboxed frames — never crash over saves */
function lsGet(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function lsSet(key, value)    { try { localStorage.setItem(key, value); } catch {} }

/* ---------- Sizing ---------- */
function makeStars() {
  stars = [];
  for (let i = 0; i < 55; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * GROUND * 0.8,
      r: 0.7 + Math.random() * 1.4,        // square size
      p: Math.random() * Math.PI * 2,      // twinkle phase
      s: 1 + Math.random() * 2,            // twinkle speed
    });
  }
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  GROUND = Math.round(H * 0.72);
  player.x = W * 0.24;
  makeStars();
}
window.addEventListener('resize', resize);

/* ---------- Sound (tiny Web Audio synth, no assets) ---------- */
let actx = null;
let muted = lsGet('wd_muted', '0') === '1';

function audio() {
  if (muted) return null;
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function blip(f0, f1, dur, type, vol) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const sfx = {
  jump:  () => blip(150, 340, 0.09, 'square', 0.06),
  // each point in a row climbs a semitone — streak dings sound musical
  score: () => {
    const step = Math.pow(2, Math.min(streak, 12) / 12);
    blip(520 * step, 720 * step, 0.12, 'sine', 0.10);
  },
  die:   () => blip(240, 40, 0.4, 'sawtooth', 0.12),
  start: () => blip(320, 560, 0.08, 'triangle', 0.07),
};

function applyMuteLabel() {
  soundBtn.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
}

function toggleMute(webAudioReady) {
  muted = !muted;
  lsSet('wd_muted', muted ? '1' : '0');
  applyMuteLabel();
  if (!muted && webAudioReady) blip(440, 660, 0.08, 'sine', 0.08);
}

soundBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  audio(); // unlock Web Audio inside the user gesture
  toggleMute(true);
});

/* ---------- Screens ---------- */
function showStart() {
  screenEl.innerHTML = `
    <div class="card">
      <div class="title"><span class="logo"></span>HELLO AI</div>
      <div class="rules">
        SPACE / CLICK / TAP to jump<br>
      </div>
      <div class="start">PRESS TO START</div>
    </div>`;
}

function showOver() {
  screenEl.innerHTML = `
    <div class="card">
      <div class="over-label">F*CK!</div>
      <div class="final">${score}</div>
      <div class="best-line">${newBest ? '<span class="newbest">NEW BEST!</span>' : 'BEST ' + best}</div>
      <div class="start">PRESS TO RETRY</div>
    </div>`;
}

/* ---------- Game flow ---------- */
function reset() {
  score = 0; streak = 0; speed = BASE_SPEED;
  beatBest = false; newBest = false;
  spawnIn = 1.4; scrollX = 0; runDust = 0; buffer = 0;
  flash = 0; shake = 0;
  obstacles = []; particles = []; rings = [];
  player.y = GROUND - PLAYER_SIZE;
  player.vy = 0; player.ground = true;
  player.rot = 0; player.spin = 0; player.sq = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = 'BEST ' + best;
}

function begin() {
  reset();
  state = PLAYING;
  screenEl.innerHTML = '';
  sfx.start();
}

function die() {
  state = DYING;
  dieT = 0.7;
  if (score > best && score > 0) {
    best = score;
    newBest = true;
    lsSet('wd_best', String(best));
  }
  player.ground = false;
  player.spin = -7; // tumble backwards off the obstacle
  flash = 1;
  shake = 16;
  sfx.die();
  // burst of debris
  const cx = player.x + PLAYER_SIZE / 2;
  const cy = player.y + PLAYER_SIZE / 2;
  for (let i = 0; i < 26; i++) {
    const life = 0.4 + Math.random() * 0.5;
    particles.push({
      x: cx, y: cy,
      vx: -speed * 0.25 + (Math.random() - 0.35) * 300,
      vy: -Math.random() * 320,
      grav: 900,
      life, max: life,
      size: 2 + Math.random() * 4,
      color: Math.random() < 0.7 ? INK : GREY,
    });
  }
}

function press() {
  if (state === READY) { begin(); return; }
  if (state === OVER) {
    if (t - overAt > 0.35) begin(); // small guard against accidental restarts
    return;
  }
  if (state === PLAYING) {
    if (player.ground) doJump();
    else buffer = JUMP_BUFFER;
  }
}

function release() {
  if (state === PLAYING && player.vy < 0) player.vy *= JUMP_CUT;
}

function doJump() {
  player.vy = JUMP_V;
  player.ground = false;
  player.sq = -1;          // stretch on takeoff
  dust(player.x + 8, GROUND - 4, 4);
  sfx.jump();
}

/* ---------- Particles ---------- */
function dust(x, y, n) {
  for (let i = 0; i < n; i++) {
    const life = 0.25 + Math.random() * 0.35;
    particles.push({
      x: x + (Math.random() - 0.5) * 12,
      y: y + (Math.random() - 0.5) * 6,
      vx: -40 - Math.random() * 90,
      vy: -(10 + Math.random() * 80),
      grav: 600,
      life, max: life,
      size: 2 + Math.random() * 3,
      color: GREY,
    });
  }
}

/* ---------- Obstacles ---------- */
function spawnDash() {
  // after 5 points some dashes get tall → hold the jump longer
  const tall = score >= 5 && Math.random() < 0.3;
  const w = tall ? 14 + Math.random() * 8 : 12 + Math.random() * 18;
  const h = tall ? 54 + Math.random() * 26 : 24 + Math.random() * 14;
  obstacles.push({ x: W + 60, w, h, passed: false });
}

/* ---------- Update ---------- */
function update(dt) {
  t += dt;

  // stars drift & twinkle in every state
  for (const s of stars) {
    s.p += s.s * dt;
    s.x -= 9 * dt;
    if (s.x < -4) s.x = W + 4;
  }

  // particles & rings
  for (const p of particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += p.grav * dt;
  }
  particles = particles.filter((p) => p.life > 0);
  for (const r of rings) {
    r.r += 170 * dt;
    r.a -= 2.4 * dt;
    if (state === PLAYING) r.x -= speed * dt;
  }
  rings = rings.filter((r) => r.a > 0);

  flash = Math.max(0, flash - 3.4 * dt);
  shake = Math.max(0, shake - 42 * dt);

  // squash/stretch springs back to neutral
  player.sq += -player.sq * Math.min(1, 12 * dt);

  if (state === READY) {
    scrollX += 60 * dt;                       // the world idles along
    player.sq = Math.sin(t * 4) * 0.05;       // gentle breathing
  }

  if (state === PLAYING) {
    speed = Math.min(MAX_SPEED, BASE_SPEED + score * SPEED_PER_PT);
    scrollX += speed * dt;

    // spawn dashes; tighter timing as the score climbs
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawnDash();
      const tight = 1 / (1 + Math.min(0.5, score * 0.012));
      spawnIn = (0.8 + Math.random() * 0.6) * tight;
    }

    // jump input buffer: press slightly early → still jumps on landing
    if (buffer > 0) buffer -= dt;

    // physics
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    const floor = GROUND - PLAYER_SIZE;
    if (player.y >= floor) {
      player.y = floor;
      if (!player.ground) {
        player.ground = true;
        player.sq = 1; // landing squash
        dust(player.x + PLAYER_SIZE / 2, GROUND - 4, 8);
        if (buffer > 0) { buffer = 0; doJump(); }
      }
      player.vy = 0;
    } else {
      player.ground = false;
    }
    if (player.ground) {
      runDust -= dt;
      if (runDust <= 0) { runDust = 0.09; dust(player.x + 4, GROUND - 4, 1); }
    }

    // move / score / collide
    for (const o of obstacles) {
      o.x -= speed * dt;
      if (!o.passed && o.x + o.w < player.x) {
        o.passed = true;
        score++;
        streak++;
        scoreEl.textContent = score;
        scoreEl.classList.remove('pop');
        void scoreEl.offsetWidth; // restart the pop animation
        scoreEl.classList.add('pop');
        rings.push({ x: o.x + o.w / 2, y: GROUND - o.h / 2, r: 10, a: 0.9 });
        sfx.score();
        if (score % 10 === 0) shake = Math.max(shake, 7); // milestone nudge
        if (!beatBest && best > 0 && score > best) {
          beatBest = true;
          bestEl.textContent = 'NEW BEST!';
        }
      }
    }

    const pad = 6; // forgiving hitbox
    for (const o of obstacles) {
      if (player.x + PLAYER_SIZE - pad > o.x &&
          player.x + pad < o.x + o.w &&
          player.y + PLAYER_SIZE - pad > GROUND - o.h) {
        die();
        break;
      }
    }
    obstacles = obstacles.filter((o) => o.x > -60);
  }

  if (state === DYING) {
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    player.rot += player.spin * dt;
    const floor = GROUND - PLAYER_SIZE;
    if (player.y >= floor) {
      player.y = floor;
      player.vy = 0;
      if (!player.ground) { player.ground = true; dust(player.x + PLAYER_SIZE / 2, GROUND - 4, 10); }
    }
    dieT -= dt;
    if (dieT <= 0) {
      state = OVER;
      overAt = t;
      showOver();
    }
  }
}

/* ---------- Draw ---------- */
function rrPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  ctx.fillStyle = '#f2f2f0';
  ctx.fillRect(0, 0, W, H);

  // stars — little twinkling squares
  ctx.fillStyle = GREY;
  for (const s of stars) {
    ctx.globalAlpha = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(s.p));
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;

  // screen shake
  let ox = 0, oy = 0;
  if (shake > 0) {
    ox = (Math.random() - 0.5) * shake;
    oy = (Math.random() - 0.5) * shake;
  }
  ctx.save();
  ctx.translate(ox, oy);

  // ground line + scrolling dash texture
  ctx.fillStyle = INK;
  ctx.fillRect(0, GROUND, W, 2);
  const gap = 46, gw = 16;
  ctx.fillStyle = GREY;
  for (let x = -(scrollX % gap); x < W; x += gap) ctx.fillRect(x, GROUND + 12, gw, 2);

  // speed lines appear as things get fast
  if (state === PLAYING && speed > BASE_SPEED + 80) {
    ctx.fillStyle = GREY;
    ctx.globalAlpha = Math.min(0.3, (speed - BASE_SPEED) / 1200);
    for (let i = 0; i < 5; i++) {
      const sx = W - ((t * speed * 1.6 + i * 210) % (W + 140));
      const sy = GROUND - 90 - (i % 3) * 44;
      ctx.fillRect(sx, sy, 46, 2);
    }
    ctx.globalAlpha = 1;
  }

  // score rings (expanding circle where you cleared a dash)
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  for (const r of rings) {
    ctx.globalAlpha = Math.max(0, r.a);
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // obstacles
  ctx.fillStyle = DARK;
  for (const o of obstacles) {
    rrPath(o.x, GROUND - o.h, o.w, o.h, 3);
    ctx.fill();
  }

  // particles
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  // soft shadow under the player
  const hover = Math.min(1, (GROUND - PLAYER_SIZE - player.y) / 170);
  ctx.globalAlpha = 0.16 * (1 - hover * 0.7);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.ellipse(player.x + PLAYER_SIZE / 2, GROUND + 11, 18 * (1 - hover * 0.45), 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // the little square itself
  ctx.save();
  ctx.translate(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2);
  ctx.rotate(player.rot);
  ctx.scale(1 + 0.24 * player.sq, 1 - 0.26 * player.sq);
  ctx.fillStyle = INK;
  rrPath(-PLAYER_SIZE / 2, -PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE, 4);
  ctx.fill();
  ctx.restore();

  // impact flash
  if (flash > 0) {
    ctx.globalAlpha = Math.min(0.85, flash * 0.8);
    ctx.fillStyle = '#111';
    ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/* ---------- Loop ---------- */
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000); // clamp: tab-away safe
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

/* ---------- Input ---------- */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    if (!e.repeat) press();
  } else if (e.code === 'KeyM') {
    audio();
    toggleMute(true);
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') release();
});
window.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  press();
});
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------- Boot ---------- */
resize();
reset();
applyMuteLabel();
showStart();
requestAnimationFrame(frame);
