/* 音符弹跳 · NEON BOUNCE
 * 三轨竖屏 · 小球随节拍弹跳 · 每面墙随机 2 堵、等间距生成
 */
'use strict';

/* ==================== 基础常量 ==================== */
const W = 460, H = 820;
const LANES = 3;
const PAD = 16;
const LANE_W = (W - PAD * 2) / LANES;
const laneCx = i => PAD + LANE_W * (i + 0.5);

const ROW_GAP = 200;      // 相邻墙平面的世界间距（恒定 → 间隔一致）
const WALL_T = 26;        // 墙厚
const BALL_R = 16;
const BOUNCE_H = 122;
const BASE_SY = H * 0.76; // 小球基准线
const CAM_OFF = H - BASE_SY;

const BEST_KEY = 'neon_bounce_best';
const OPT_KEY = 'neon_bounce_opt';
const $ = s => document.querySelector(s);

/* 电脑端操作选项：follow=小球跟随鼠标，snap=跟随但吸附到格子中心 */
const OPT = { follow: true, snap: false };
try {
  const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}');
  if (typeof o.follow === 'boolean') OPT.follow = o.follow;
  if (typeof o.snap === 'boolean') OPT.snap = o.snap;
} catch (e) { }
function saveOpt() { try { localStorage.setItem(OPT_KEY, JSON.stringify(OPT)); } catch (e) { } }
const laneOfX = x => clamp(Math.floor((x - PAD) / LANE_W), 0, LANES - 1);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd = (a, b) => a + Math.random() * (b - a);

/* ==================== 画布 ==================== */
const cv = $('#cv');
const g = cv.getContext('2d');
let dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

/* ==================== 音频引擎 ==================== */
let ctx = null, master = null, analyser = null, freqData = null;
let musicBus = null, sfxBus = null;
let musicStart = 0, beatDur = 0.5, curBPM = 120;
let bufferSrc = null, synthTimer = null, noiseBuf = null;

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.85;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.72;
    master.connect(analyser); analyser.connect(ctx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.5; sfxBus.connect(master);
    const len = Math.floor(ctx.sampleRate * 1.0);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function newMusicBus() {
  if (musicBus) { try { musicBus.disconnect(); } catch (e) { } }
  musicBus = ctx.createGain();
  musicBus.gain.value = 0.9;
  musicBus.connect(master);
  return musicBus;
}

function stopMusic() {
  if (synthTimer) { clearInterval(synthTimer); synthTimer = null; }
  if (bufferSrc) {
    try { bufferSrc.onended = null; bufferSrc.stop(); } catch (e) { }
    try { bufferSrc.disconnect(); } catch (e) { }
    bufferSrc = null;
  }
  if (musicBus && ctx) {
    const t = ctx.currentTime;
    try {
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(musicBus.gain.value, t);
      musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.06);
    } catch (e) { }
    const b = musicBus;
    setTimeout(() => { try { b.disconnect(); } catch (e) { } }, 150);
  }
}

const musicTime = () => ctx ? ctx.currentTime - musicStart : 0;

/* ---------- 合成音色 ---------- */
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function kick(t, gain) {
  gain = gain || 1;
  const o = ctx.createOscillator(), gn = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.exponentialRampToValueAtTime(0.95 * gain, t + 0.006);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(gn); gn.connect(musicBus);
  o.start(t); o.stop(t + 0.32);
}
function noiseHit(t, dur, type, f, q, gain) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter(); bp.type = type; bp.frequency.value = f; bp.Q.value = q;
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(gain, t);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(bp); bp.connect(gn); gn.connect(musicBus);
  s.start(t); s.stop(t + dur + 0.02);
}
function snare(t, g0) { noiseHit(t, 0.17, 'bandpass', 1900, 0.9, g0 || 0.5); noiseHit(t, 0.06, 'highpass', 3200, 0.7, (g0 || 0.5) * 0.6); }
function hat(t, g0) { noiseHit(t, 0.045, 'highpass', 8200, 1.1, g0 || 0.16); }
function wood(t) { noiseHit(t, 0.09, 'bandpass', 2600, 6, 0.3); }

function tone(t, freq, dur, type, gain, cutoff) {
  const o = ctx.createOscillator(), gn = ctx.createGain(), lp = ctx.createBiquadFilter();
  o.type = type; o.frequency.value = freq;
  lp.type = 'lowpass'; lp.frequency.value = cutoff || 6000;
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp); lp.connect(gn); gn.connect(musicBus);
  o.start(t); o.stop(t + dur + 0.03);
}

/* ---------- 内置曲目 ---------- */
const hit = (s, i) => s[i % s.length] !== '.';
const nAt = (a, i) => a[i % a.length];

const TRACKS = [
  {
    id: 'neon', name: '霓虹律动', desc: '电子 House · 128 BPM', bpm: 128, len: 16,
    build(i, t, sd) {
      if (hit('x...x...x...x...', i)) kick(t);
      if (hit('..x...x...x...x.', i)) hat(t, 0.14);
      if (hit('....x.......x...', i)) snare(t, 0.42);
      const bass = [45, 0, 45, 0, 48, 0, 45, 0, 41, 0, 41, 0, 43, 0, 45, 0];
      if (nAt(bass, i)) tone(t, mtof(nAt(bass, i)), sd * 1.7, 'sawtooth', 0.3, 900);
      const arp = [69, 72, 76, 81, 76, 72, 69, 72, 74, 77, 81, 84, 81, 77, 74, 72];
      if (i % 2 === 0) tone(t, mtof(nAt(arp, i)), sd * 1.2, 'triangle', 0.12, 5000);
    }
  },
  {
    id: 'ink', name: '水墨国风', desc: '五声音阶 · 96 BPM', bpm: 96, len: 16,
    build(i, t, sd) {
      if (hit('x.......x.......', i)) kick(t, 0.7);
      if (hit('....x.......x...', i)) wood(t);
      if (hit('..x...x...x...x.', i)) hat(t, 0.07);
      const mel = [74, 0, 71, 69, 0, 67, 69, 0, 62, 0, 64, 67, 0, 69, 0, 0];
      if (nAt(mel, i)) tone(t, mtof(nAt(mel, i)), sd * 2.4, 'triangle', 0.2, 3200);
      if (i % 16 === 0) tone(t, mtof(38), sd * 6, 'sine', 0.26, 500);
      if (i % 16 === 8) tone(t, mtof(43), sd * 6, 'sine', 0.26, 500);
    }
  },
  {
    id: 'chip', name: '像素冲刺', desc: 'Chiptune · 150 BPM', bpm: 150, len: 16,
    build(i, t, sd) {
      if (hit('x...x...x..xx...', i)) kick(t, 0.9);
      if (hit('....x.......x...', i)) snare(t, 0.34);
      if (hit('x.x.x.x.x.x.x.x.', i)) hat(t, 0.1);
      const lead = [72, 76, 79, 84, 79, 76, 72, 74, 77, 81, 84, 86, 84, 81, 77, 74];
      tone(t, mtof(nAt(lead, i)), sd * 0.9, 'square', 0.1, 4200);
      const bass = [48, 48, 0, 48, 55, 0, 53, 0, 48, 48, 0, 48, 51, 0, 53, 0];
      if (nAt(bass, i)) tone(t, mtof(nAt(bass, i)), sd * 1.2, 'square', 0.16, 800);
    }
  }
];

function startSynth(track) {
  newMusicBus();
  const sd = 60 / track.bpm / 4;
  const t0 = ctx.currentTime + 0.18;
  musicStart = t0;
  let step = 0;
  const tick = () => {
    const ahead = ctx.currentTime + 0.25;
    let guard = 0;
    while (t0 + step * sd < ahead && guard++ < 300) {
      try { track.build(step, t0 + step * sd, sd); } catch (e) { }
      step++;
    }
  };
  tick();
  synthTimer = setInterval(tick, 25);
}

/* ---------- 音频文件 & BPM ---------- */
function detectBPM(buf) {
  try {
    const ch = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const step = Math.max(1, Math.floor(sr / 11025));
    const total = Math.floor(ch.length / step);
    const limit = Math.min(total, 11025 * 70);
    const frame = 512;
    const frames = Math.floor(limit / frame);
    if (frames < 60) return 120;
    const e = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      const base = i * frame;
      for (let j = 0; j < frame; j++) { const v = ch[(base + j) * step]; s += v * v; }
      e[i] = Math.sqrt(s / frame);
    }
    const o = new Float32Array(frames);
    for (let i = 1; i < frames; i++) o[i] = Math.max(0, e[i] - e[i - 1]);
    let mean = 0;
    for (let i = 0; i < frames; i++) mean += o[i];
    mean /= frames;
    for (let i = 0; i < frames; i++) o[i] -= mean;
    const fps = (sr / step) / frame;
    const minLag = Math.max(2, Math.floor(fps * 60 / 190));
    const maxLag = Math.min(frames - 2, Math.floor(fps * 60 / 60));
    let best = -1e9, bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0, n = frames - lag; i < n; i++) s += o[i] * o[i + lag];
      s /= (frames - lag);
      if (s > best) { best = s; bestLag = lag; }
    }
    let bpm = 60 * fps / bestLag;
    while (bpm < 82) bpm *= 2;
    while (bpm > 178) bpm /= 2;
    return Math.round(bpm) || 120;
  } catch (e) {
    return 120;
  }
}

function playBuffer(buf) {
  newMusicBus();
  bufferSrc = ctx.createBufferSource();
  bufferSrc.buffer = buf;
  bufferSrc.connect(musicBus);
  musicStart = ctx.currentTime + 0.12;
  bufferSrc.start(musicStart);
  return new Promise(res => { bufferSrc.onended = res; });
}

/* ---------- 音效 ---------- */
function sfxMove() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), gn = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(880, t + 0.07);
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  o.connect(gn); gn.connect(sfxBus); o.start(t); o.stop(t + 0.12);
}
function sfxPass(combo) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const base = mtof(72 + Math.min(14, Math.floor(combo / 4)));
  [0, 7].forEach((semi, k) => {
    const o = ctx.createOscillator(), gn = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = base * Math.pow(2, semi / 12);
    const st = t + k * 0.035;
    gn.gain.setValueAtTime(0.0001, st);
    gn.gain.exponentialRampToValueAtTime(0.13, st + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, st + 0.22);
    o.connect(gn); gn.connect(sfxBus); o.start(st); o.stop(st + 0.24);
  });
}
function sfxCrash() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3000, t);
  lp.frequency.exponentialRampToValueAtTime(200, t + 0.5);
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(0.55, t);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  s.connect(lp); lp.connect(gn); gn.connect(sfxBus); s.start(t); s.stop(t + 0.6);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(180, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
  og.gain.setValueAtTime(0.3, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  o.connect(og); og.connect(sfxBus); o.start(t); o.stop(t + 0.5);
}

/* ==================== 关卡生成（自适应） ==================== */
const gen = { prev: 1, same: 0, mode: 0, modeLeft: 0 };

function genGap() {
  let cand = [];
  for (let d = -1; d <= 1; d++) {
    const v = gen.prev + d;
    if (v >= 0 && v < LANES) cand.push(v);
  }
  if (gen.same >= 2) {
    const f = cand.filter(v => v !== gen.prev);
    if (f.length) cand = f;
  }
  if (gen.modeLeft <= 0) {
    gen.mode = Math.random() < 0.45 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    gen.modeLeft = 2 + Math.floor(Math.random() * 5);
  }
  gen.modeLeft--;
  let pick;
  const dirTarget = clamp(gen.prev + gen.mode, 0, LANES - 1);
  if (gen.mode !== 0 && cand.indexOf(dirTarget) >= 0 && Math.random() < 0.7) pick = dirTarget;
  else pick = cand[Math.floor(Math.random() * cand.length)];
  if (pick === gen.prev) gen.same++; else gen.same = 0;
  gen.prev = pick;
  return pick;
}
function resetGen() { gen.prev = 1; gen.same = 0; gen.mode = 0; gen.modeLeft = 0; }

/* ==================== 游戏状态 ==================== */
const S = {
  mode: 'menu',
  rows: [], nextRow: 3,
  progressY: 0, lastMt: 0,
  lane: 1, ballX: laneCx(1), prevBallX: laneCx(1), mouseX: null,
  score: 0, combo: 0, maxCombo: 0, passed: 0,
  bpr: 1.55, baseBPR: 1.55,
  shake: 0, flash: 0, glow: 0,
  trail: [], parts: [],
  deadT: 0, finished: false, hintT: 0, paused: false
};

function resetGame() {
  S.rows = []; S.nextRow = 3;
  S.progressY = 0; S.lastMt = 0;
  S.lane = 1; S.ballX = laneCx(1); S.prevBallX = S.ballX; S.mouseX = null;
  S.score = 0; S.combo = 0; S.maxCombo = 0; S.passed = 0;
  S.bpr = S.baseBPR;
  S.shake = 0; S.flash = 0; S.glow = 0;
  S.trail = []; S.parts = [];
  S.deadT = 0; S.finished = false; S.hintT = 2.6; S.paused = false;
  resetGen();
}
function addRow(k) { S.rows.push({ y: k * ROW_GAP, gap: genGap(), passed: false }); }

/* ==================== 输入 ==================== */
function move(dir) {
  if (S.mode !== 'playing' || S.paused) return;
  const n = clamp(S.lane + dir, 0, LANES - 1);
  if (n !== S.lane) {
    S.lane = n;
    // 连续跟随模式下，键盘也把“鼠标位置”挪过去，避免被鼠标位置拽回
    if (OPT.follow && !OPT.snap) S.mouseX = laneCx(n);
    sfxMove();
  }
}
window.addEventListener('keydown', e => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') { move(-1); e.preventDefault(); }
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') { move(1); e.preventDefault(); }
  else if (e.code === 'Space' || e.code === 'Escape') { togglePause(); e.preventDefault(); }
  else if (e.code === 'KeyM') { toggleFollow(); }
  else if (e.code === 'Enter' && S.mode === 'over') { try { startGame(); } catch (err) { } }
});

/* 鼠标跟随：无需按下，指针在画布内移动即可带动小球 */
function followPointer(e) {
  if (e.pointerType === 'touch' || e.pointerType === 'pen') return false;
  if (!OPT.follow || S.mode !== 'playing' || S.paused) return false;
  const r = cv.getBoundingClientRect();
  if (!r.width) return false;
  const x = (e.clientX - r.left) / r.width * W;
  S.mouseX = clamp(x, PAD + BALL_R, W - PAD - BALL_R);
  return true;
}

let pd = false, px = 0, moved = 0;
cv.addEventListener('pointerdown', e => {
  if (followPointer(e)) { pd = false; return; }
  pd = true; px = e.clientX; moved = 0;
  if (cv.setPointerCapture) cv.setPointerCapture(e.pointerId);
});
cv.addEventListener('pointermove', e => {
  if (followPointer(e)) return;
  if (!pd) return;
  const dx = e.clientX - px;
  if (Math.abs(dx) > 26) { move(dx > 0 ? 1 : -1); px = e.clientX; moved += Math.abs(dx); }
});
cv.addEventListener('pointerup', e => {
  if (!pd) return;
  pd = false;
  if (moved < 12) {
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W;
    if (x < S.ballX - 8) move(-1);
    else if (x > S.ballX + 8) move(1);
  }
});
cv.addEventListener('pointercancel', () => { pd = false; });

/* ==================== 循环 ==================== */
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (S.mode === 'playing' && !S.paused) update(dt);
  else if (S.mode === 'dead') updateDead(dt);
  render(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function update(dt) {
  const mt = musicTime();
  const dBeat = Math.max(0, (mt - S.lastMt) / beatDur);
  S.lastMt = mt;

  const t = Math.min(1, S.passed / 70);
  S.bpr = S.baseBPR * (1 - 0.32 * t);
  S.progressY += ROW_GAP * (dBeat / S.bpr);

  while (S.nextRow * ROW_GAP < S.progressY + H + 320) { addRow(S.nextRow); S.nextRow++; }

  const camY = S.progressY - CAM_OFF;
  const phase = mt > 0 ? (mt / beatDur) % 1 : 0;
  const bounce = 4 * BOUNCE_H * phase * (1 - phase);
  const ballWY = S.progressY + bounce;
  const ballSY = H - (ballWY - camY);

  // 水平目标：跟随鼠标时直接指向鼠标 x（可选吸附到格心），否则指向当前格
  let tx;
  if (OPT.follow && S.mouseX !== null) {
    if (OPT.snap) { S.lane = laneOfX(S.mouseX); tx = laneCx(S.lane); }
    else { S.lane = laneOfX(S.mouseX); tx = S.mouseX; }
  } else {
    tx = laneCx(S.lane);
  }
  S.prevBallX = S.ballX;
  S.ballX += (tx - S.ballX) * Math.min(1, dt * (OPT.follow && S.mouseX !== null ? 26 : 20));
  S.ballX = clamp(S.ballX, PAD + BALL_R, W - PAD - BALL_R);
  S.trail.push({ x: S.ballX, y: ballSY });
  if (S.trail.length > 14) S.trail.shift();

  const rr = BALL_R - 3;
  // 扫掠检测：用上一帧到这一帧的 x 区间，防止快速甩鼠标“穿过”墙
  const xLo = Math.min(S.prevBallX, S.ballX) - rr;
  const xHi = Math.max(S.prevBallX, S.ballX) + rr;
  for (const r of S.rows) {
    if (r.y - S.progressY < -160) continue;
    const yB = H - (r.y - camY);
    const yT = yB - WALL_T;
    if ((ballSY + rr > yT) && (ballSY - rr < yB)) {
      for (let i = 0; i < LANES; i++) {
        if (i === r.gap) continue;
        const x0 = PAD + i * LANE_W + 3, x1 = PAD + (i + 1) * LANE_W - 3;
        if (xHi > x0 && xLo < x1) { die(ballSY); return; }
      }
    }
    if (!r.passed && S.progressY > r.y + WALL_T * 0.9) {
      r.passed = true; S.passed++;
      S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
      S.score += 10 + Math.min(40, Math.floor(S.combo / 5) * 5);
      S.glow = 1; S.flash = Math.min(1, S.flash + 0.35);
      sfxPass(S.combo);
      burst(laneCx(r.gap), yB - WALL_T / 2, '#39e6ff', 10);
      const cb = $('#comboChip');
      cb.classList.add('hit');
      setTimeout(() => cb.classList.remove('hit'), 120);
    }
  }
  while (S.rows.length && S.rows[0].y < camY - 220) S.rows.splice(0, 1);

  S.shake *= 0.86; S.flash *= 0.9; S.glow *= 0.88;
  S.hintT = Math.max(0, S.hintT - dt);
  updateParts(dt);
  syncHUD();
}

function updateDead(dt) {
  S.deadT += dt;
  S.shake *= 0.9;
  updateParts(dt);
  if (S.deadT > 0.85 && !S.finished) { S.finished = true; showOver(); }
}

function die(ballSY) {
  S.mode = 'dead'; S.deadT = 0;
  S.shake = 16; S.flash = 1;
  sfxCrash();
  burst(S.ballX, ballSY, '#ff4fd8', 34, 280);
  burst(S.ballX, ballSY, '#ffd84a', 18, 190);
  stopMusic();
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { } }
}

function burst(x, y, color, n, spd) {
  spd = spd || 150;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = rnd(spd * 0.25, spd);
    S.parts.push({
      x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: rnd(0.35, 0.85), max: 0.85, color: color, r: rnd(1.5, 4)
    });
  }
}
function updateParts(dt) {
  for (let i = S.parts.length - 1; i >= 0; i--) {
    const p = S.parts[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vy += 380 * dt; p.vx *= 0.97;
    if (p.life <= 0) S.parts.splice(i, 1);
  }
}

function syncHUD() {
  $('#score').textContent = S.score;
  $('#combo').textContent = S.combo;
}

/* ==================== 渲染 ==================== */
let bgGrad = null, vig = null, lowE = 0, midE = 0;
let timeSec = 0;

function buildGrads() {
  bgGrad = g.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#0a0a26');
  bgGrad.addColorStop(0.42, '#121033');
  bgGrad.addColorStop(0.78, '#1a0f33');
  bgGrad.addColorStop(1, '#2a0f36');
  vig = g.createRadialGradient(W / 2, H * 0.55, H * 0.22, W / 2, H * 0.5, H * 0.78);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.62)');
}
buildGrads();

function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function camY() { return S.progressY - CAM_OFF; }

function ballScreenY() {
  const mt = S.mode === 'playing' ? musicTime() : timeSec;
  const ph = mt > 0 ? (mt / beatDur) % 1 : 0;
  return H - (S.progressY + 4 * BOUNCE_H * ph * (1 - ph) - camY());
}

function render(dt) {
  timeSec += dt;
  g.save();
  if (S.shake > 0.3) g.translate(rnd(-S.shake, S.shake) * 0.5, rnd(-S.shake, S.shake) * 0.5);

  // 频谱能量
  let low = 0, mid = 0;
  if (analyser && S.mode !== 'menu') {
    analyser.getByteFrequencyData(freqData);
    for (let i = 0; i < 8; i++) low += freqData[i];
    low = low / (8 * 255);
    for (let i = 10; i < 60; i++) mid += freqData[i];
    mid = mid / (50 * 255);
  } else {
    low = 0.22 + 0.14 * Math.sin(timeSec * 2.1);
    mid = 0.18 + 0.1 * Math.sin(timeSec * 1.3 + 1);
  }
  lowE += (low - lowE) * 0.22;
  midE += (mid - midE) * 0.18;

  g.fillStyle = bgGrad;
  g.fillRect(-24, -24, W + 48, H + 48);

  // 头顶光晕
  const pulse = 0.16 + lowE * 0.5;
  const gg = g.createRadialGradient(W / 2, H * 0.2, 10, W / 2, H * 0.2, H * 0.55);
  gg.addColorStop(0, 'rgba(90,120,255,' + (pulse * 0.55).toFixed(3) + ')');
  gg.addColorStop(0.5, 'rgba(160,60,220,' + (pulse * 0.2).toFixed(3) + ')');
  gg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gg;
  g.fillRect(0, 0, W, H);

  drawGrid();
  drawSpectrum();
  drawRows();
  drawBeatLine();
  if (S.mode === 'playing' || S.mode === 'dead') drawBall();
  drawParts();

  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);

  if (S.flash > 0.01) {
    g.fillStyle = 'rgba(255,255,255,' + (S.flash * 0.22).toFixed(3) + ')';
    g.fillRect(0, 0, W, H);
  }
  if (S.glow > 0.01) {
    g.strokeStyle = 'rgba(57,230,255,' + (S.glow * 0.5).toFixed(3) + ')';
    g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
  }
  g.restore();

  if (S.hintT > 0 && S.mode === 'playing') {
    g.save();
    const a = Math.min(1, S.hintT / 0.6);
    g.globalAlpha = a * (0.55 + 0.45 * Math.sin(timeSec * 4));
    g.fillStyle = '#eaf0ff';
    g.font = '600 15px system-ui, sans-serif';
    g.textAlign = 'center';
    const tip = OPT.follow ? '移动鼠标，小球跟着你走' : '← 左右滑动 / ←→ 键 切换格子 →';
    g.fillText(tip, W / 2, H * 0.42);
    g.restore();
  }
}

function drawGrid() {
  // 轨道底
  for (let i = 0; i < LANES; i++) {
    const x = PAD + i * LANE_W;
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(1, 'rgba(120,160,255,' + (0.05 + midE * 0.06).toFixed(3) + ')');
    g.fillStyle = gr;
    g.fillRect(x, 0, LANE_W, H);
  }
  // 分隔线
  g.strokeStyle = 'rgba(160,190,255,.16)';
  g.lineWidth = 1;
  g.setLineDash([9, 13]);
  g.lineDashOffset = -(camY() % 22);
  for (let i = 1; i < LANES; i++) {
    const x = PAD + i * LANE_W;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  g.setLineDash([]);
  // 边框
  g.strokeStyle = 'rgba(160,190,255,.22)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(PAD, 0); g.lineTo(PAD, H);
  g.moveTo(W - PAD, 0); g.lineTo(W - PAD, H);
  g.stroke();
}

function drawSpectrum() {
  const n = 30, bw = (W - PAD * 2) / n;
  const base = H - 6;
  for (let i = 0; i < n; i++) {
    let v;
    if (analyser && S.mode !== 'menu') {
      const idx = 4 + Math.floor(i * 2.2);
      v = (freqData[idx] || 0) / 255;
    } else {
      v = 0.14 + 0.13 * Math.sin(timeSec * 1.6 + i * 0.4) + 0.08 * Math.sin(timeSec * 2.7 + i);
      v = Math.abs(v);
    }
    const h = 8 + v * 92;
    const x = PAD + i * bw;
    const gr = g.createLinearGradient(0, base - h, 0, base);
    gr.addColorStop(0, 'rgba(57,230,255,.55)');
    gr.addColorStop(1, 'rgba(255,79,216,.08)');
    g.fillStyle = gr;
    g.fillRect(x + 1, base - h, bw - 2, h);
  }
}

function drawRows() {
  const cy = camY();
  const nextIdx = (() => {
    for (let i = 0; i < S.rows.length; i++) if (!S.rows[i].passed) return i;
    return -1;
  })();

  for (let k = 0; k < S.rows.length; k++) {
    const r = S.rows[k];
    const yB = H - (r.y - cy);
    if (yB < -80 || yB > H + 80) continue;
    const yT = yB - WALL_T;
    const isNext = k === nextIdx;

    // 缺口引导光带
    const gx = PAD + r.gap * LANE_W + 5;
    const gw = LANE_W - 10;
    const gg = g.createLinearGradient(0, yT - 90, 0, yB);
    gg.addColorStop(0, 'rgba(91,255,165,0)');
    gg.addColorStop(1, 'rgba(91,255,165,' + (isNext ? 0.2 : 0.09) + ')');
    g.fillStyle = gg;
    g.fillRect(gx, yT - 90, gw, 90 + WALL_T);

    for (let i = 0; i < LANES; i++) {
      if (i === r.gap) continue;
      const x = PAD + i * LANE_W + 3;
      const w = LANE_W - 6;
      if (r.passed) {
        g.fillStyle = 'rgba(120,130,190,.16)';
        rr(x, yT, w, WALL_T, 7); g.fill();
        continue;
      }
      const grad = g.createLinearGradient(x, yT, x + w, yB);
      if (isNext) {
        grad.addColorStop(0, '#ff5ad8');
        grad.addColorStop(1, '#a56bff');
      } else {
        grad.addColorStop(0, '#7a4bd6');
        grad.addColorStop(1, '#4b3aa8');
      }
      g.save();
      g.shadowColor = isNext ? 'rgba(255,90,216,.85)' : 'rgba(120,90,240,.5)';
      g.shadowBlur = isNext ? 18 : 9;
      g.fillStyle = grad;
      rr(x, yT, w, WALL_T, 7); g.fill();
      g.restore();
      // 顶面高光
      g.fillStyle = isNext ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)';
      rr(x + 2, yT + 2, w - 4, 3, 2); g.fill();
      // 纹理
      g.strokeStyle = 'rgba(255,255,255,.10)';
      g.lineWidth = 1;
      for (let s = 1; s < 4; s++) {
        const sx = x + (w / 4) * s;
        g.beginPath(); g.moveTo(sx, yT + 6); g.lineTo(sx, yB - 4); g.stroke();
      }
    }

    // 缺口箭头
    if (isNext && !r.passed) {
      g.save();
      g.globalAlpha = 0.65 + 0.35 * Math.sin(timeSec * 8);
      g.fillStyle = '#5bffa5';
      const cx = laneCx(r.gap);
      g.beginPath();
      g.moveTo(cx - 9, yT - 12);
      g.lineTo(cx + 9, yT - 12);
      g.lineTo(cx, yT - 2);
      g.closePath(); g.fill();
      g.restore();
    }
  }
}

function drawBeatLine() {
  const mt = S.mode === 'playing' ? musicTime() : timeSec;
  const ph = mt > 0 ? (mt / beatDur) % 1 : 0;
  const near = Math.max(0, 1 - Math.min(ph, 1 - ph) * 6);
  const y = BASE_SY;
  g.save();
  g.strokeStyle = 'rgba(255,216,74,' + (0.14 + near * 0.5).toFixed(3) + ')';
  g.lineWidth = 1 + near * 2;
  g.beginPath(); g.moveTo(PAD, y); g.lineTo(W - PAD, y); g.stroke();
  if (near > 0.02) {
    const r0 = 20 + (1 - near) * 46;
    g.globalAlpha = near * 0.5;
    g.strokeStyle = '#ffd84a';
    g.lineWidth = 2;
    g.beginPath(); g.ellipse(S.ballX, y, r0, r0 * 0.28, 0, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

function drawBall() {
  const y = ballScreenY();
  // 拖尾
  for (let i = 0; i < S.trail.length; i++) {
    const p = S.trail[i];
    const a = (i / S.trail.length) * 0.45;
    g.fillStyle = 'rgba(57,230,255,' + a.toFixed(3) + ')';
    g.beginPath();
    g.arc(p.x, p.y, BALL_R * (0.25 + 0.6 * (i / S.trail.length)), 0, Math.PI * 2);
    g.fill();
  }
  // 光晕
  const glowR = BALL_R * (1.9 + lowE * 0.9);
  const gg = g.createRadialGradient(S.ballX, y, 2, S.ballX, y, glowR);
  gg.addColorStop(0, 'rgba(120,240,255,.55)');
  gg.addColorStop(1, 'rgba(120,240,255,0)');
  g.fillStyle = gg;
  g.beginPath(); g.arc(S.ballX, y, glowR, 0, Math.PI * 2); g.fill();
  // 本体
  const bg = g.createRadialGradient(S.ballX - 5, y - 6, 2, S.ballX, y, BALL_R);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.45, '#7ff0ff');
  bg.addColorStop(1, '#1c9fd6');
  g.save();
  g.shadowColor = 'rgba(80,230,255,.9)';
  g.shadowBlur = 16;
  g.fillStyle = bg;
  g.beginPath(); g.arc(S.ballX, y, BALL_R, 0, Math.PI * 2); g.fill();
  g.restore();
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.beginPath(); g.arc(S.ballX - 5, y - 6, 4, 0, Math.PI * 2); g.fill();
}

function drawParts() {
  for (const p of S.parts) {
    const a = Math.max(0, p.life / p.max);
    g.globalAlpha = a;
    g.fillStyle = p.color;
    g.beginPath(); g.arc(p.x, p.y, p.r * a + 0.5, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

/* 菜单背景滚动 */
function menuScroll(dt) {
  S.progressY += 46 * dt;
  while (S.nextRow * ROW_GAP < S.progressY + H + 320) { addRow(S.nextRow); S.nextRow++; }
  const cy = camY();
  while (S.rows.length && S.rows[0].y < cy - 220) S.rows.splice(0, 1);
  S.ballX += (laneCx(S.lane) - S.ballX) * Math.min(1, dt * 3);
  S.trail.push({ x: S.ballX, y: ballScreenY() });
  if (S.trail.length > 14) S.trail.shift();
  let target = 1;
  for (const r of S.rows) if (!r.passed) { target = r.gap; break; }
  S.lane = clamp(target, 0, LANES - 1);
  for (const r of S.rows) if (!r.passed && S.progressY > r.y) r.passed = true;
}
setInterval(() => { if (S.mode === 'menu') menuScroll(0.05); }, 50);

/* ==================== UI ==================== */
const DIFFS = [
  { name: '轻松', bpr: 2.0 },
  { name: '普通', bpr: 1.55 },
  { name: '挑战', bpr: 1.1 }
];
let localSongs = [], selected = null, selKey = '', diffIdx = 1, pendingBuf = null;
let uploaded = [];

function show(id) {
  ['#menu', '#loading', '#over'].forEach(s => { $(s).hidden = (s !== id); });
}
function hideAll() { ['#menu', '#loading', '#over'].forEach(s => { $(s).hidden = true; }); }
function setLoadTxt(t) { $('#loadTxt').textContent = t; }

let toastT = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

function renderList() {
  const box = $('#songList');
  const q = ($('#search').value || '').trim().toLowerCase();
  box.innerHTML = '';
  const mk = (tag, title, sub, key, onPick) => {
    const d = document.createElement('div');
    d.className = 'song' + (key === selKey ? ' on' : '');
    d.innerHTML = '<span class="tag"></span><div class="m"><div class="t"></div><div class="s"></div></div>';
    d.querySelector('.tag').textContent = tag;
    d.querySelector('.t').textContent = title;
    d.querySelector('.s').textContent = sub;
    d.onclick = () => {
      selKey = key; onPick();
      renderList();
      $('#btnStart').disabled = false;
      updateTrackLabel();
    };
    box.appendChild(d);
  };

  TRACKS.forEach(t => mk('内置', t.name, t.desc, 'synth:' + t.id, () => {
    selected = { kind: 'synth', track: t, name: t.name };
  }));

  uploaded.forEach((f, i) => mk('本地', f.name.replace(/\.[^.]+$/, ''), '已上传 · ' + (f.size / 1048576).toFixed(1) + ' MB', 'up:' + i, () => {
    selected = { kind: 'file', file: f, name: f.name };
  }));

  const shown = localSongs.filter(s =>
    !q || (s.title || '').toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q) || (s.file || '').toLowerCase().includes(q)
  );
  shown.forEach(s => mk('曲库', s.title, (s.artist ? s.artist + ' · ' : '') + s.sizeText, 'local:' + s.id, () => {
    selected = { kind: 'local', song: s, name: s.title };
  }));

  if (!localSongs.length && !uploaded.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = '未找到本地曲库。<br>可点击下方「上传本地音乐」，<br>或用 <b>server.py</b> 启动后自动读取手机里的 58 首歌。';
    box.appendChild(e);
  } else if (!box.children.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '没有匹配的歌曲';
    box.appendChild(e);
  }
  $('#songCount').textContent = localSongs.length ? '本地 ' + localSongs.length + ' 首' : '';
}

function updateTrackLabel() {
  if (!selected) { $('#bpmTxt').textContent = '-- · 未选曲'; return; }
  if (selected.kind === 'synth') $('#bpmTxt').textContent = selected.track.bpm + ' BPM · ' + selected.name;
  else if (curBPM && curBPM !== 120) $('#bpmTxt').textContent = curBPM + ' BPM · ' + selected.name;
  else $('#bpmTxt').textContent = '自动测速 · ' + selected.name;
}

async function fetchSongs() {
  try {
    const r = await fetch('/api/songs', { cache: 'no-store' });
    const j = await r.json();
    localSongs = j.songs || [];
  } catch (e) {
    localSongs = [];
  }
  renderList();
}

async function startGame() {
  if (!selected) return;
  show('#loading');
  setLoadTxt('准备音频…');
  ensureCtx();
  await new Promise(r => setTimeout(r, 40));
  try {
    stopMusic();
    pendingBuf = null;
    if (selected.kind === 'synth') {
      curBPM = selected.track.bpm;
      setLoadTxt('生成伴奏…');
      await new Promise(r => setTimeout(r, 60));
    } else {
      setLoadTxt('读取音乐文件…');
      await new Promise(r => setTimeout(r, 30));
      let ab;
      if (selected.kind === 'local') {
        const res = await fetch('/music/' + selected.song.id);
        if (!res.ok) throw new Error('无法读取 ' + selected.song.title);
        ab = await res.arrayBuffer();
      } else {
        ab = await selected.file.arrayBuffer();
      }
      setLoadTxt('解码音频…');
      await new Promise(r => setTimeout(r, 30));
      const buf = await ctx.decodeAudioData(ab);
      setLoadTxt('分析节拍 BPM…');
      await new Promise(r => setTimeout(r, 30));
      curBPM = detectBPM(buf);
      pendingBuf = buf;
    }
  } catch (err) {
    toast('音乐加载失败：' + (err && err.message ? err.message : err));
    show('#menu');
    return;
  }
  beatDur = 60 / curBPM;
  S.baseBPR = DIFFS[diffIdx].bpr;
  resetGame();
  hideAll();
  S.mode = 'playing';
  S.lastMt = musicTime();
  updateTrackLabel();
  syncOptUI();
  if (selected.kind === 'synth') startSynth(selected.track);
  else playBuffer(pendingBuf).then(() => { if (S.mode === 'playing') endByFinish(); });
}

function endByFinish() {
  S.mode = 'dead'; S.deadT = 0; S.finished = false;
  stopMusic();
  toast('歌曲结束，完美通关！');
  setTimeout(() => showOver(), 400);
}

function showOver() {
  S.mode = 'over';
  const st0 = document.querySelector('#stage');
  if (st0) st0.classList.remove('aim');
  let best = 0;
  try { best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0; } catch (e) { }
  if (S.score > best) {
    best = S.score;
    try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) { }
  }
  $('#overScore').textContent = S.score;
  $('#overBest').textContent = best;
  $('#overCombo').textContent = S.maxCombo;
  $('#overRows').textContent = S.passed;
  show('#over');
}

function togglePause() {
  if (S.mode !== 'playing') return;
  S.paused = !S.paused;
  if (!ctx) return;
  if (S.paused) { ctx.suspend(); toast('已暂停（空格继续）'); }
  else { ctx.resume(); S.lastMt = musicTime(); }
  $('#btnPause').textContent = S.paused ? '▶' : '❚❚';
}

/* ---------- 事件绑定 ---------- */
$('#diffs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  diffIdx = parseInt(b.dataset.d, 10) || 0;
  [].forEach.call($('#diffs').children, c => c.classList.toggle('on', c === b));
});

function syncOptUI() {
  const box = $('#opts');
  if (!box) return;
  [].forEach.call(box.children, c => {
    c.classList.toggle('on', c.dataset.o === 'follow' ? OPT.follow : OPT.snap);
  });
  const st = document.querySelector('#stage');
  if (st) st.classList.toggle('aim', OPT.follow && S.mode === 'playing');
}
function toggleFollow() {
  OPT.follow = !OPT.follow;
  saveOpt(); syncOptUI();
  toast(OPT.follow ? (OPT.snap ? '鼠标跟随：开（吸附格子）' : '鼠标跟随：开') : '鼠标跟随：关 · 用滑动或 ←→ 键');
}
$('#opts').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.o === 'follow') OPT.follow = !OPT.follow;
  else OPT.snap = !OPT.snap;
  saveOpt(); syncOptUI();
  toast(OPT.follow
    ? (OPT.snap ? '鼠标跟随 · 吸附到格子中心' : '鼠标跟随 · 连续跟手')
    : '已关闭鼠标跟随，用滑动 / ←→ 键');
});
$('#btnStart').onclick = () => startGame();
$('#btnAgain').onclick = () => startGame();
$('#btnMenu').onclick = () => { S.mode = 'menu'; stopMusic(); show('#menu'); renderList(); };
$('#btnPause').onclick = () => togglePause();
$('#search').addEventListener('input', renderList);
$('#btnUpload').onclick = () => $('#file').click();
$('#file').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  uploaded.unshift(f);
  selKey = 'up:0';
  selected = { kind: 'file', file: f, name: f.name };
  renderList();
  $('#btnStart').disabled = false;
  updateTrackLabel();
  toast('已选择：' + f.name);
});
$('#btnRescan').onclick = async () => {
  toast('正在刷新曲库…');
  try { await fetch('/api/rescan', { cache: 'no-store' }); } catch (e) { }
  await fetchSongs();
  toast('曲库已更新：' + localSongs.length + ' 首');
};

/* ---------- 启动 ---------- */
resetGame();
renderList();
fetchSongs();
updateTrackLabel();
syncOptUI();
