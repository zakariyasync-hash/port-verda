// audio.js — Port Verda: semua suara lewat WebAudio, tanpa file audio.
//
// Prinsip: tidak ada jaringan, tidak ada aset. Setiap bunyi dibuat dari
// oscillator / noise buffer yang dibuat di tempat. initAudio() HARUS
// dipanggil dari dalam gesture pengguna (klik / tekan tombol) karena
// browser memblokir AudioContext sebelum itu. Semua fungsi lain aman
// dipanggil sebelum init — mereka diam-diam tidak melakukan apa-apa.
//
// Bunyi yang tersedia lewat playSound(name):
//   'shoot'   — letupan noise pendek (tembakan)
//   'punch'   — debuk rendah (pukulan)
//   'pickup'  — blip naik dua nada (ambil item / paket)
//   'mission' — jingle tiga nada (misi selesai)
//   'fail'    — dua nada turun (misi gagal)
//   'siren'   — dua nada bergantian, sekali jalan (dipakai polisi / updateEngine)
//   'click'   — klik menu pendek
//   'start'   — arpeggio naik saat permainan dimulai (dipanggil main.js)
//   'busted'  — dua nada sirene turun (ditangkap polisi, dipanggil main.js)
//   'wasted'  — nada rendah turun panjang (tumbang, dipanggil main.js)
// updateEngine(state) mengurus dua bunyi kontinu: mesin mobil (frekuensi
// ikut kecepatan) dan sirene (hidup saat wanted > 0).

let audioCtx = null;
let masterGain = null;
let noiseBuffer = null;
let muted = false;

// Bunyi kontinu: mesin.
let engineOsc = null;
let engineOsc2 = null;
let engineGain = null;
let engineFilter = null;

// Bunyi kontinu: sirene.
let sirenOsc = null;
let sirenGain = null;
let sirenHigh = false;
let sirenTimerId = null;

function audioSupported() {
  return (
    typeof window !== 'undefined' &&
    (typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function')
  );
}

export function initAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }
  if (!audioSupported()) return null;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctor();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : 0.9;
    masterGain.connect(audioCtx.destination);
    // Buffer noise putih sepanjang 1 detik, dipakai ulang oleh 'shoot'.
    const length = Math.floor(audioCtx.sampleRate * 1);
    noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  } catch (err) {
    audioCtx = null;
    masterGain = null;
    noiseBuffer = null;
  }
  return audioCtx;
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = m === true;
  if (masterGain && audioCtx) {
    masterGain.gain.setTargetAtTime(muted ? 0 : 0.9, audioCtx.currentTime, 0.02);
  }
  if (muted) {
    stopEngineSound();
    stopSirenSound();
  }
  return muted;
}

// --- Pembangun bunyi sekali jalan -------------------------------------------

function tone(freq, duration, type, volume, when, slideTo) {
  if (!audioCtx || !masterGain) return;
  const t0 = audioCtx.currentTime + (when || 0);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + duration);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume || 0.2, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function noiseBurst(duration, volume, filterFreq) {
  if (!audioCtx || !masterGain || !noiseBuffer) return;
  const t0 = audioCtx.currentTime;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq || 1800;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(volume || 0.35, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  src.start(t0);
  src.stop(t0 + duration + 0.05);
}

export function playSound(name) {
  if (!audioCtx || muted) return;
  // main.js memanggil playSound('start') tepat dari gesture Enter; bila
  // context masih tersuspensi, coba bangunkan supaya jingle terdengar.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  try {
    switch (name) {
      case 'shoot':
        noiseBurst(0.14, 0.4, 2400);
        tone(180, 0.08, 'square', 0.12, 0, 60);
        break;
      case 'punch':
        tone(110, 0.14, 'sine', 0.5, 0, 45);
        noiseBurst(0.07, 0.18, 700);
        break;
      case 'pickup':
        tone(660, 0.09, 'sine', 0.22);
        tone(880, 0.12, 'sine', 0.22, 0.09);
        break;
      case 'mission':
        tone(523, 0.14, 'triangle', 0.28);
        tone(659, 0.14, 'triangle', 0.28, 0.13);
        tone(784, 0.26, 'triangle', 0.3, 0.26);
        break;
      case 'fail':
        tone(392, 0.18, 'sawtooth', 0.16);
        tone(294, 0.3, 'sawtooth', 0.16, 0.17);
        break;
      case 'siren':
        tone(720, 0.22, 'square', 0.07);
        tone(960, 0.22, 'square', 0.07, 0.22);
        tone(720, 0.22, 'square', 0.07, 0.44);
        tone(960, 0.22, 'square', 0.07, 0.66);
        break;
      case 'click':
        tone(1200, 0.05, 'sine', 0.15);
        break;
      case 'start':
        tone(392, 0.1, 'triangle', 0.25);
        tone(523, 0.1, 'triangle', 0.25, 0.09);
        tone(659, 0.18, 'triangle', 0.28, 0.18);
        break;
      case 'busted':
        tone(960, 0.2, 'square', 0.07);
        tone(720, 0.2, 'square', 0.07, 0.2);
        tone(960, 0.2, 'square', 0.07, 0.4);
        tone(620, 0.4, 'square', 0.07, 0.6);
        break;
      case 'wasted':
        tone(220, 0.35, 'sawtooth', 0.18, 0, 110);
        tone(110, 0.6, 'sawtooth', 0.18, 0.3, 55);
        break;
      default:
        break;
    }
  } catch (err) {
    // Suara tidak boleh mematikan game: abaikan kegagalan audio.
  }
}

// --- Bunyi kontinu: mesin ---------------------------------------------------

function startEngineSound() {
  if (!audioCtx || !masterGain || engineOsc) return;
  try {
    engineOsc = audioCtx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 55;
    engineOsc2 = audioCtx.createOscillator();
    engineOsc2.type = 'square';
    engineOsc2.frequency.value = 28;
    engineFilter = audioCtx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 420;
    engineGain = audioCtx.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineFilter);
    engineOsc2.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(masterGain);
    engineOsc.start();
    engineOsc2.start();
  } catch (err) {
    engineOsc = null;
    engineOsc2 = null;
    engineGain = null;
    engineFilter = null;
  }
}

function stopEngineSound() {
  try {
    if (engineOsc) engineOsc.stop();
  } catch (err) {}
  try {
    if (engineOsc2) engineOsc2.stop();
  } catch (err) {}
  engineOsc = null;
  engineOsc2 = null;
  engineGain = null;
  engineFilter = null;
}

// --- Bunyi kontinu: sirene --------------------------------------------------

function startSirenSound() {
  if (!audioCtx || !masterGain || sirenOsc) return;
  try {
    sirenOsc = audioCtx.createOscillator();
    sirenOsc.type = 'square';
    sirenOsc.frequency.value = 720;
    sirenGain = audioCtx.createGain();
    sirenGain.gain.value = 0.045;
    sirenOsc.connect(sirenGain);
    sirenGain.connect(masterGain);
    sirenOsc.start();
    sirenHigh = false;
    sirenTimerId = setInterval(() => {
      if (!sirenOsc || !audioCtx) return;
      sirenHigh = !sirenHigh;
      sirenOsc.frequency.setTargetAtTime(sirenHigh ? 960 : 720, audioCtx.currentTime, 0.03);
    }, 450);
  } catch (err) {
    sirenOsc = null;
    sirenGain = null;
  }
}

function stopSirenSound() {
  if (sirenTimerId !== null) {
    clearInterval(sirenTimerId);
    sirenTimerId = null;
  }
  try {
    if (sirenOsc) sirenOsc.stop();
  } catch (err) {}
  sirenOsc = null;
  sirenGain = null;
}

// --- Update tiap frame ------------------------------------------------------
// Dipanggil main.js setiap frame dengan state penuh. Mengatur mesin (ikut
// kecepatan mobil) dan sirene (ikut wanted). Aman sebelum initAudio().
export function updateEngine(state) {
  if (!audioCtx || muted) {
    if (muted) {
      stopEngineSound();
      stopSirenSound();
    }
    return;
  }
  // Browser menahan AudioContext dalam keadaan 'suspended' sampai ada
  // gesture pengguna. main.js memanggil initAudio() dari gesture, tapi
  // bila context sempat tersuspensi lagi, coba bangunkan di sini.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  try {
    const player = (state && state.player) || {};
    const driving = player.onFoot === false && typeof player.speed === 'number';
    const speed = Math.abs(player.speed || 0);

    if (driving) {
      startEngineSound();
      if (engineOsc && engineGain && audioCtx) {
        const t = audioCtx.currentTime;
        // 55 Hz diam -> ~220 Hz pada kecepatan penuh (diasumsikan ~600 px/dtk).
        const freq = 55 + Math.min(1, speed / 600) * 165;
        engineOsc.frequency.setTargetAtTime(freq, t, 0.08);
        engineOsc2.frequency.setTargetAtTime(freq / 2, t, 0.08);
        engineFilter.frequency.setTargetAtTime(350 + Math.min(1, speed / 600) * 900, t, 0.1);
        engineGain.gain.setTargetAtTime(0.05 + Math.min(1, speed / 600) * 0.045, t, 0.1);
      }
    } else if (engineGain && audioCtx) {
      engineGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
    }

    const wanted = state && typeof state.wanted === 'number' ? state.wanted : 0;
    if (wanted > 0) startSirenSound();
    else stopSirenSound();
  } catch (err) {
    // Suara tidak boleh mematikan game.
  }
}
