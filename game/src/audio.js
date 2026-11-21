// audio.js — Port Verda sound, pure WebAudio (Builder B3).
//
// Written from scratch in this session. No audio files, no network, no library.
// Every sound is synthesized with oscillators / filtered noise at call time.
// Safe in headless Chromium (AudioContext may be suspended or absent) and in
// Node (no window/AudioContext): every public function no-ops instead of
// throwing when audio is unavailable.
//
// Lifecycle (main.js B1): call initAudio() once from the first user gesture
// (Enter/click on the title screen), then call updateAudio(state, dt) every
// frame — it drives the engine hum from speed and the siren from wanted level.
// toggleMute() (M key) flips state.muted and the master gain.

let ctx = null;
let master = null;
let engineOsc = null;
let engineOsc2 = null;
let engineGain = null;
let sirenOsc = null;
let sirenGain = null;
let sirenLfo = null;
let muted = false;
let started = false;

function audioContextClass() {
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

export function isAudioReady() {
  return ctx !== null && ctx.state === 'running';
}

export function isMuted() {
  return muted;
}

/** Create the AudioContext + master gain. Call from a user gesture. */
export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }
  const AC = audioContextClass();
  if (!AC) return false;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    started = true;
    startEngine();
    startSiren();
    return true;
  } catch {
    ctx = null;
    return false;
  }
}

function startEngine() {
  if (!ctx || engineOsc) return;
  try {
    engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 50;
    engineOsc2 = ctx.createOscillator();
    engineOsc2.type = 'square';
    engineOsc2.frequency.value = 25;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    engineOsc.connect(filter);
    engineOsc2.connect(filter);
    filter.connect(engineGain);
    engineGain.connect(master);
    engineOsc.start();
    engineOsc2.start();
  } catch {
    engineOsc = null;
  }
}

function startSiren() {
  if (!ctx || sirenOsc) return;
  try {
    sirenOsc = ctx.createOscillator();
    sirenOsc.type = 'sine';
    sirenOsc.frequency.value = 700;
    sirenLfo = ctx.createOscillator();
    sirenLfo.type = 'square';
    sirenLfo.frequency.value = 0.6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    sirenLfo.connect(lfoGain);
    lfoGain.connect(sirenOsc.frequency);
    sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    sirenOsc.connect(sirenGain);
    sirenGain.connect(master);
    sirenOsc.start();
    sirenLfo.start();
  } catch {
    sirenOsc = null;
  }
}

/** Engine hum follows speed; call every frame with the live state. */
export function updateEngine(state) {
  if (!ctx || !engineOsc || !engineGain) return;
  try {
    const pl = (state && state.player) || {};
    // Speed lives on the player on foot; in a car it lives on the car
    // (B2: render.js reads car.speed). Prefer the car when driving.
    let speed = Math.abs(pl.speed ?? 0);
    if (pl.inCar && Array.isArray(state.cars)) {
      const car = state.cars.find((c) => c && c.id === pl.carId);
      if (car && typeof car.speed === 'number') speed = Math.abs(car.speed);
    }
    const inCar = !!pl.inCar;
    const t = ctx.currentTime;
    const targetGain = inCar ? 0.05 + Math.min(0.12, speed / 4000) : 0;
    engineGain.gain.setTargetAtTime(targetGain, t, 0.08);
    const freq = 45 + Math.min(160, speed * 0.35);
    engineOsc.frequency.setTargetAtTime(freq, t, 0.08);
    engineOsc2.frequency.setTargetAtTime(freq / 2, t, 0.08);
  } catch {
    // Headless/suspended context: stay silent, never throw.
  }
}

/** Police siren audible while wanted > 0. Call every frame. */
export function updateSiren(state) {
  if (!ctx || !sirenGain) return;
  try {
    const wanted = (state && state.wanted) || 0;
    const t = ctx.currentTime;
    const target = wanted > 0 ? 0.045 + Math.min(0.05, wanted * 0.01) : 0;
    sirenGain.gain.setTargetAtTime(target, t, 0.2);
  } catch {
    // Silent fallback.
  }
}

/** One frame of audio updates: engine + siren. */
export function updateAudio(state) {
  if (!ctx) return;
  updateEngine(state);
  updateSiren(state);
}

function tone({ type = 'sine', from = 440, to = null, dur = 0.15, vol = 0.2, when = 0 }) {
  if (!ctx || !master) return;
  try {
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {
    // Silent fallback.
  }
}

function noiseBurst({ dur = 0.12, vol = 0.3, freq = 1200 }) {
  if (!ctx || !master) return;
  try {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start();
  } catch {
    // Silent fallback.
  }
}

export function playShot() {
  noiseBurst({ dur: 0.1, vol: 0.35, freq: 1800 });
  tone({ type: 'square', from: 220, to: 60, dur: 0.08, vol: 0.12 });
}

export function playPunch() {
  noiseBurst({ dur: 0.08, vol: 0.25, freq: 300 });
  tone({ type: 'sine', from: 140, to: 70, dur: 0.09, vol: 0.2 });
}

export function playPickup() {
  tone({ type: 'sine', from: 660, to: 990, dur: 0.12, vol: 0.2 });
}

export function playClick() {
  tone({ type: 'square', from: 800, to: 800, dur: 0.04, vol: 0.08 });
}

export function playMissionComplete() {
  // Rising major arpeggio: C5 E5 G5 C6.
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone({ type: 'triangle', from: f, dur: 0.22, vol: 0.22, when: i * 0.11 }));
}

export function playMissionFailed() {
  // Descending minor: A4 F4 D4.
  const notes = [440, 349.23, 293.66];
  notes.forEach((f, i) => tone({ type: 'sawtooth', from: f, dur: 0.25, vol: 0.14, when: i * 0.14 }));
}

export function playBusted() {
  tone({ type: 'sawtooth', from: 330, to: 110, dur: 0.7, vol: 0.2 });
  tone({ type: 'sine', from: 220, to: 55, dur: 0.8, vol: 0.18, when: 0.1 });
}

export function playWasted() {
  tone({ type: 'sawtooth', from: 220, to: 55, dur: 0.9, vol: 0.2 });
}

export function playEngineStart() {
  tone({ type: 'sawtooth', from: 40, to: 90, dur: 0.35, vol: 0.12 });
}

/** Flip mute; also mirrors onto state.muted when a state is passed. */
export function toggleMute(state) {
  muted = !muted;
  if (master && ctx) {
    try {
      master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
    } catch {
      // Silent fallback.
    }
  }
  if (state) state.muted = muted;
  return muted;
}

export function setMuted(value, state) {
  muted = !!value;
  if (master && ctx) {
    try {
      master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.05);
    } catch {
      // Silent fallback.
    }
  }
  if (state) state.muted = muted;
  return muted;
}

/**
 * The createAudio(state) object main.js expects. Lazily starts the shared
 * AudioContext on first use (a user gesture has usually happened by then)
 * and maps main.js's one-word sound names onto the players above. Audio
 * never throws and never breaks gameplay: every call is guarded.
 */
export function createAudio(state) {
  const players = {
    punch: playPunch,
    shoot: playShot,
    shot: playShot,
    mission: playMissionComplete,
    pickup: playPickup,
    click: playClick,
    busted: playBusted,
    wasted: playWasted,
    hit: playPunch,
  };
  return {
    play(name) {
      if (state && state.muted) return;
      try { initAudio(); } catch { /* silent */ }
      const fn = players[name];
      if (typeof fn === 'function') {
        try { fn(); } catch { /* silent */ }
      }
    },
    setMuted(value) { setMuted(value, state); },
    update(s) { updateAudio(s || state); },
  };
}

/** For tests: reset module singletons (only meaningful in Node/headless). */
export function __resetAudioForTest() {
  try {
    if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
  } catch {
    // Ignore.
  }
  ctx = null;
  master = null;
  engineOsc = null;
  engineOsc2 = null;
  engineGain = null;
  sirenOsc = null;
  sirenGain = null;
  sirenLfo = null;
  muted = false;
  started = false;
}

export { started as audioStarted };
