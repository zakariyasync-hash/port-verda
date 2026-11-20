// main.js — boot, layar, dan satu-satunya loop Port Verda.
//
// Layar yang ada: title, playing, paused, busted, wasted. Tiap frame:
// baca input, majukan dunia dengan delta yang dibatasi, lalu gambar.
// Semua pekerjaan dunia tinggal di modul fitur dan dipanggil dari sini
// dalam urutan tetap, supaya setiap sistem melihat state yang sama:
//
//   jalan kaki -> aksi (E/F/klik) -> vehicles -> peds -> police
//   -> combat -> wanted -> missions -> bendera misi -> kamera
//
// Kamera: state.camera adalah titik tengah pandangan dalam piksel dunia;
// ia mengejar pemain dengan lerp halus. Canvas mengisi jendela (dengan
// device pixel ratio) dan dunia digambar dalam piksel dunia.
//
// Dua jalur input hidup berdampingan: modul input (state.input) untuk
// gameplay — tombol yang ditahan, klik mouse, koordinat dunia mouse —
// dan antrean keydown/mousedown milik file ini (uiPressed/uiClicked)
// untuk transisi layar, supaya ketukan cepat tidak hilang di antara frame.
//
// ?seed=N mengunci kota. ?shot=title|play|chase|harbor memanggung satu
// adegan diam untuk screenshot, menggambarnya dua kali, lalu menyetel
// window.__shotReady.
//
// window.__portVerda adalah kait uji (bukan bagian permainan): play-test
// membaca state/screen/city lewat sini untuk memastikan skenario lolos.

import { CFG } from './config.js';
import { buildCity } from './city.js';
import { drawWorld, drawMinimap } from './render.js';
import { saveGame, loadGame, hasSave } from './save.js';
import { mulberry32, rand, pick } from './rng.js';
import { updateVehicles, enterCar, exitCar, spawnTraffic } from './vehicles.js';
import { updatePeds, spawnPeds } from './peds.js';
import { updatePolice, updateWanted } from './police.js';
import { updateCombat, punch, shoot } from './combat.js';
import { updateMissions, freshMissionList } from './missions.js';
import { drawHUD, drawTitle, drawPause, drawGameOver, drawMissionBrief } from './hud.js';
import { initAudio, playSound, setMuted, updateEngine } from './audio.js';
import { createInput } from './input.js';

// Frame terpanjang yang dimajukan loop; stall yang lebih lama dibuang,
// bukan diulang.
const MAX_DT = 0.05;
const AUTOSAVE_SECONDS = 30;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : CFG.CITY_SEED;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');

function resize() {
  // Backing store dalam piksel perangkat, gambar dalam piksel CSS: transform
  // memetakan satu piksel CSS ke `ratio` piksel perangkat, jadi kode dunia
  // di bawah tidak pernah memikirkan kerapatan layar.
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function announce(message) {
  if (status) status.textContent = message;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

const CAR_COLORS = ['#c94f42', '#4b8fd9', '#e0a83c', '#7fb069', '#9b7ede', '#d8d8d8', '#3a3f47', '#e07a9b'];
const PARKED_MODELS = ['sedan', 'hatch', 'van', 'pickup', 'taxi'];
const PED_SHIRTS = ['#d95f4b', '#4b8fd9', '#e0a83c', '#7fb069', '#9b7ede', '#e07a9b', '#e74c3c', '#3498db'];

// Ruas roadGraph terdekat dari sebuah titik, beserta posisi sepanjang ruas.
// Dipakai pejalan kaki (main.js dan spawnGangPeds) supaya setiap ped punya
// _edge yang sah — updatePeds membaca _edge tiap frame.
function nearestEdge(city, x, y) {
  const edges = city.roadGraph.edges;
  const nodes = city.roadGraph.nodes;
  let best = null;
  let bestD = Infinity;
  let bestT = 0;
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = (x - px) * (x - px) + (y - py) * (y - py);
    if (d < bestD) {
      bestD = d;
      best = e;
      bestT = t;
    }
  }
  return { edge: best, t: bestT };
}

let gangCounter = 0;

// Anggota geng misi 5: bentuknya sama seperti makePed di peds.js
// (termasuk _edge hasil snap ke roadGraph terdekat), ditambah gang:true.
function spawnGangPeds(state, city, x, y, count) {
  const total = Math.max(0, count || 0);
  for (let i = 0; i < total; i++) {
    const gx = x + (i % 2 === 0 ? -1 : 1) * (18 + ((i * 13) % 40));
    const gy = y + (i < 2 ? -1 : 1) * (16 + ((i * 11) % 36));
    const snap = nearestEdge(city, gx, gy);
    state.peds.push({
      id: 'gang_' + (gangCounter++),
      x: gx,
      y: gy,
      angle: 0,
      speed: CFG.PED_SPEED_MIN + Math.random() * (CFG.PED_SPEED_MAX - CFG.PED_SPEED_MIN),
      state: 'walk',
      gang: true,
      health: CFG.PED_HEALTH,
      color: '#8e2f23',
      _edge: { a: snap.edge.a, b: snap.edge.b },
      _t: snap.t,
      _dir: Math.random() < 0.5 ? 1 : -1,
      _side: Math.random() < 0.5 ? 1 : -1,
      _pause: 0,
      _fleeFrom: null,
      _fleeTimer: 0,
      _crimeAt: -999,
      _downTimer: 0,
      _seed: Math.random() * Math.PI * 2,
    });
  }
}

// State segar untuk permainan baru (atau dari simpanan).
function createState(city, saved) {
  const rng = mulberry32(seed + 7);
  const state = {
    seed,
    city,
    time: 0,
    money: CFG.START_MONEY,
    health: CFG.PLAYER_MAX_HEALTH,
    wanted: 0,
    player: {
      x: city.spawns.player.x,
      y: city.spawns.player.y,
      angle: -Math.PI / 2,
      speed: 0,
      onFoot: true,
      carId: null,
      // Raka mulai dengan pistol dan peluru secukupnya: kota ini keras,
      // dan tembak-menembak adalah bagian permainan sejak menit pertama.
      weapon: 'pistol',
      ammo: CFG.PISTOL_AMMO_START,
    },
    cars: [],
    peds: [],
    police: [],
    bullets: [],
    pickups: [],
    missions: { current: 0, list: freshMissionList(), active: null, completed: [] },
    camera: { x: city.spawns.player.x, y: city.spawns.player.y },
    input: {},
    flags: { muted: false, hasSave: hasSave(), busted: false, bustTimer: 0 },
  };
  // Mobil parkir dari titik spawn kota. Mobil lalu lintas yang bergerak
  // bukan dibuat di sini — spawnTraffic (vehicles.js) yang membuatnya
  // saat permainan mulai, dengan _node/_from/_cruise yang benar.
  city.spawns.cars.slice(0, CFG.PARKED_COUNT).forEach((s, i) => {
    state.cars.push({
      id: 'spawn_' + i,
      x: s.x,
      y: s.y,
      angle: s.angle,
      speed: 0,
      color: CAR_COLORS[i % CAR_COLORS.length],
      model: PARKED_MODELS[i % PARKED_MODELS.length],
      traffic: false,
      parked: true,
      driver: null,
      health: CFG.CAR_HEALTH,
    });
  });
  // Pejalan kaki di dekat jalan. Bentuknya sama seperti makePed di
  // peds.js: _edge, _t, _dir, _side dan semua lapangan cadangannya harus
  // ada, karena updatePeds membacanya tiap frame.
  for (let i = 0; i < CFG.PED_COUNT; i++) {
    const road = pick(rng, city.roads);
    let x;
    let y;
    if (road.dir === 'h') {
      x = rand(rng, 60, CFG.WORLD_W - 60);
      y = road.y1 + pick(rng, [-1, 1]) * (road.width / 2 + rand(rng, 8, 26));
    } else {
      x = road.x1 + pick(rng, [-1, 1]) * (road.width / 2 + rand(rng, 8, 26));
      y = rand(rng, 60, CFG.HARBOR_STRIP_TOP - 60);
    }
    const snap = nearestEdge(city, x, y);
    state.peds.push({
      id: i,
      x,
      y,
      angle: rand(rng, 0, Math.PI * 2),
      speed: rand(rng, CFG.PED_SPEED_MIN, CFG.PED_SPEED_MAX),
      state: 'walk',
      health: CFG.PED_HEALTH,
      color: PED_SHIRTS[i % PED_SHIRTS.length],
      _edge: { a: snap.edge.a, b: snap.edge.b },
      _t: snap.t,
      _dir: rng() < 0.5 ? 1 : -1,
      _side: rng() < 0.5 ? 1 : -1,
      _pause: 0,
      _fleeFrom: null,
      _fleeTimer: 0,
      _crimeAt: -999,
      _downTimer: 0,
      _seed: rng() * Math.PI * 2,
    });
  }
  if (saved) applySave(state, saved);
  return state;
}

function applySave(state, saved) {
  state.money = saved.money ?? state.money;
  state.health = saved.health ?? state.health;
  state.wanted = saved.wanted ?? 0;
  state.time = saved.time ?? 0;
  state.player.x = saved.player.x;
  state.player.y = saved.player.y;
  state.player.angle = saved.player.angle || 0;
  state.player.onFoot = saved.player.onFoot !== false;
  state.player.weapon = saved.player.weapon || 'fists';
  state.player.ammo = saved.player.ammo || 0;
  state.missions.completed = saved.missions?.completed || [];
  state.missions.current = saved.missions?.current ?? 0;
  state.camera.x = state.player.x;
  state.camera.y = state.player.y;
}

// Gerak jalan kaki: WASD/panah, Shift = lari. Tabrakan per sumbu melawan
// bangunan dan air, supaya pemain meluncur di sepanjang dinding, bukan
// menempel. (Di dalam mobil, vehicles.js yang menggerakkan pemain.)
function movePlayerOnFoot(state, dt, city) {
  const player = state.player;
  const input = state.input;
  if (!player || !input || typeof input.isDown !== 'function') return;
  const left = input.isDown('KeyA') || input.isDown('ArrowLeft');
  const right = input.isDown('KeyD') || input.isDown('ArrowRight');
  const up = input.isDown('KeyW') || input.isDown('ArrowUp');
  const down = input.isDown('KeyS') || input.isDown('ArrowDown');
  const mx = (right ? 1 : 0) - (left ? 1 : 0);
  const my = (down ? 1 : 0) - (up ? 1 : 0);
  if (mx === 0 && my === 0) {
    player.speed = 0;
    return;
  }
  const len = Math.hypot(mx, my);
  const dx = mx / len;
  const dy = my / len;
  const running = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
  const speed = running ? CFG.RUN_SPEED : CFG.WALK_SPEED;
  player.angle = Math.atan2(dy, dx);
  player.speed = speed;
  const r = CFG.PLAYER_RADIUS;
  const nx = player.x + dx * speed * dt;
  const ny = player.y + dy * speed * dt;
  const blocked = (x, y) => (
    x < r || y < r || x > CFG.WORLD_W - r || y > CFG.WORLD_H - r
    || (typeof city.pointInWater === 'function' && city.pointInWater(x, y))
    || city.collidesBuilding(x, y, r)
  );
  if (!blocked(nx, player.y)) player.x = nx;
  if (!blocked(player.x, ny)) player.y = ny;
  // Jaring pengaman: pemain tidak pernah boleh lolos dari batas dunia
  // (mis. terdorong keluar oleh suatu sistem), karena dari luar sana
  // semua gerak terblokir dan pemain terjebak.
  player.x = clamp(player.x, r, CFG.WORLD_W - r);
  player.y = clamp(player.y, r, CFG.WORLD_H - r);
}

// Bendera antar modul yang missions.js setel dan main.js yang wujudkan
// di dunia: geng misi 5 dan mobil target misi 4.
function handleMissionFlags(state, city) {
  if (state.flags.spawnGang) {
    const g = state.flags.spawnGang;
    spawnGangPeds(state, city, g.x, g.y, g.count || 4);
    state.flags.spawnGang = null;
  }
  if (state.flags.targetCarNeeded) {
    const spawn = state.flags.targetCarSpawn;
    const exists = state.cars.some((c) => c && c.id === 'target-car');
    if (!exists && spawn) {
      state.cars.push({
        id: 'target-car',
        x: spawn.x,
        y: spawn.y,
        angle: 0,
        speed: 0,
        color: '#e0a83c', // Falcon GT warna kuning, sesuai brief misi 4
        model: 'Falcon GT',
        isTarget: true,
        parked: true,
        driver: null,
        health: CFG.CAR_HEALTH,
      });
    }
  } else {
    // Misi 4 selesai/gagal: singkirkan mobil target, kecuali pemain
    // sedang mengendarainya (baru selesai mengantar ke bengkel).
    const idx = state.cars.findIndex((c) => c && c.id === 'target-car');
    if (idx !== -1 && state.player.carId !== 'target-car') {
      state.cars.splice(idx, 1);
    }
  }
}

// Panggung adegan diam untuk screenshot: tanpa loop, dua kali gambar,
// lalu siap.
function stageShot(name, city, state) {
  const rng = mulberry32(seed + 99);
  if (name === 'play' || name === 'chase' || name === 'harbor') {
    state.missions.active = {
      id: 'm1',
      title: 'Antar paket ke Dermaga 7',
      target: city.spawns.missionSpots.harbor,
    };
    if (name === 'harbor') {
      state.player.x = 700;
      state.player.y = 1930;
      state.camera.x = 700;
      state.camera.y = 1930;
    }
    if (name === 'chase') {
      state.wanted = 3;
      state.player.onFoot = false;
      const car = state.cars[0];
      state.player.carId = car.id;
      state.player.x = car.x;
      state.player.y = car.y;
      state.camera.x = car.x;
      state.camera.y = car.y;
      for (let i = 0; i < 3; i++) {
        state.police.push({
          car: { x: car.x - 120 - i * 70, y: car.y + rand(rng, -40, 40), angle: 0 },
        });
      }
    }
  }
  return name === 'title' ? 'title' : 'playing';
}

function runShot(name) {
  const city = buildCity(seed);
  const state = createState(city, null);
  // Adegan diam pun menampilkan kota yang hidup: lalu lintas + pejalan kaki.
  spawnTraffic(state, city);
  spawnPeds(state, city);
  const screen = stageShot(name, city, state);
  let painted = 0;
  function paint() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (screen === 'title') drawTitle(ctx, state);
    else {
      drawWorld(ctx, state.camera, state, city);
      drawHUD(ctx, state);
      drawMinimap(ctx, state, city);
    }
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  resize();
  requestAnimationFrame(paint);
}

function runGame() {
  const city = buildCity(seed);
  let state = createState(city, null);
  const input = createInput();
  // Tanpa attach, modul input tidak pernah menerima event keyboard/mouse
  // dan tombol WASD tidak akan menggerakkan apa pun.
  input.attach(canvas);
  state.input = input;
  let screen = 'title';
  let last = performance.now();
  let autosaveIn = AUTOSAVE_SECONDS;
  let prevMouseDown = false;
  let muted = false;

  // Kait uji untuk play-test (Playwright): membaca state/screen/city.
  window.__portVerda = {
    get state() { return state; },
    get screen() { return screen; },
    get city() { return city; },
  };

  // Tombol UI dilacak di sini, di main.js, dengan antrean event: keydown
  // masuk ke `uiPressed` dan baru dibersihkan setelah satu frame
  // mengonsumsinya, jadi ketukan yang sangat cepat (turun+naik dalam satu
  // frame) tidak pernah hilang. Tombol gameplay tinggal di modul input.
  const uiPressed = new Set();
  let uiClicked = false;
  window.addEventListener('keydown', (e) => {
    uiPressed.add(e.code);
  });
  canvas.addEventListener('mousedown', () => {
    uiClicked = true;
  });

  initAudio();

  function justPressed(code) {
    return uiPressed.has(code);
  }

  function mouseClicked() {
    const down = !!(input.mouse && input.mouse.down);
    const clicked = uiClicked || (down && !prevMouseDown);
    prevMouseDown = down;
    uiClicked = false;
    return clicked;
  }

  function snapshotInput() {
    uiPressed.clear();
    if (typeof input.endFrame === 'function') input.endFrame();
  }

  function startGame(saved) {
    state = createState(city, saved || null);
    state.input = input;
    state.city = city;
    // Lalu lintas + pejalan kaki hidup sekali saat permainan mulai.
    spawnTraffic(state, city);
    spawnPeds(state, city);
    screen = 'playing';
    autosaveIn = AUTOSAVE_SECONDS;
    // Buang klik/tombol yang memulai permainan, supaya klik yang sama
    // tidak langsung menembak di frame pertama.
    if (typeof input.consumeClick === 'function') input.consumeClick();
    if (typeof input.endFrame === 'function') input.endFrame();
    uiClicked = false;
    announce('Bermain sebagai Raka, kurir pelabuhan Port Verda.');
    playSound('start');
  }

  function endGame(kind) {
    screen = kind; // 'busted' atau 'wasted'
    playSound(kind);
    announce(kind === 'busted' ? 'Ditangkap polisi. Raka ditahan.' : 'Raka tumbang. Misi gagal.');
  }

  function handleUi() {
    if (justPressed('KeyM')) {
      muted = !muted;
      setMuted(muted);
      state.flags.muted = muted;
    }
    if (screen === 'title') {
      if (justPressed('Enter') || justPressed('Space') || mouseClicked()) startGame(null);
      else if (justPressed('KeyL') && hasSave()) startGame(loadGame());
    } else if (screen === 'playing') {
      // Buang klik yang sudah dipakai menembak, supaya tidak bocor ke
      // layar busted/wasted dan langsung memulangkan ke title.
      uiClicked = false;
      if (justPressed('KeyP') || justPressed('Escape')) {
        screen = 'paused';
        saveGame(state);
        announce('Jeda. Progres tersimpan.');
      }
    } else if (screen === 'paused') {
      if (justPressed('KeyP') || justPressed('Escape') || justPressed('Enter')) {
        screen = 'playing';
        announce('Lanjut bermain.');
      } else if (justPressed('KeyR')) {
        startGame(null);
      }
    } else if (screen === 'busted' || screen === 'wasted') {
      if (justPressed('KeyR')) {
        startGame(null);
      } else if (justPressed('Enter') || justPressed('Space') || mouseClicked()) {
        screen = 'title';
        state.flags.hasSave = hasSave();
        announce('Port Verda. Tekan Enter untuk mulai.');
      }
    }
  }

  function step(dt) {
    state.time += dt;
    const player = state.player;
    // Jalan kaki + aksi sekali tekan (E/F/klik) sebelum sistem lain jalan.
    if (player.onFoot) movePlayerOnFoot(state, dt, city);
    if (typeof input.pressed === 'function') {
      if (input.pressed('KeyE')) {
        if (player.onFoot) {
          if (enterCar(state)) playSound('click');
        } else if (exitCar(state)) {
          playSound('click');
        }
      }
      if (input.pressed('KeyF')) {
        if (punch(state)) playSound('punch');
      }
    }
    if (typeof input.updateWorldCoords === 'function') {
      input.updateWorldCoords(state.camera);
      if (typeof input.consumeClick === 'function' && input.consumeClick()) {
        if (shoot(state, input.mouse.worldX, input.mouse.worldY)) playSound('shoot');
      }
    }
    updateVehicles(state, dt, city);
    updatePeds(state, dt, city);
    updatePolice(state, dt, city);
    updateCombat(state, dt, city);
    updateWanted(state, dt);
    const events = updateMissions(state, dt, city);
    for (const ev of events) {
      if (ev.indexOf('mission_complete:') === 0) playSound('mission');
      else if (ev.indexOf('mission_failed:') === 0) playSound('fail');
      else if (ev === 'target_car_stolen') playSound('pickup');
    }
    handleMissionFlags(state, city);
    // Kamera mengejar pemain.
    const k = Math.min(1, CFG.CAMERA_LERP * dt);
    state.camera.x += (state.player.x - state.camera.x) * k;
    state.camera.y += (state.player.y - state.camera.y) * k;
    state.camera.x = Math.max(0, Math.min(CFG.WORLD_W, state.camera.x));
    state.camera.y = Math.max(0, Math.min(CFG.WORLD_H, state.camera.y));
    // Akhir permainan.
    if (state.health <= 0) endGame('wasted');
    else if (state.flags.busted) endGame('busted');
    // Autosave selama bermain.
    autosaveIn -= dt;
    if (autosaveIn <= 0) {
      autosaveIn = AUTOSAVE_SECONDS;
      saveGame(state);
    }
  }

  // Suara mesin/sirene butuh state "diam" saat tidak bermain, supaya bunyi
  // kontinu padam di jeda dan game over.
  function silencedState() {
    return {
      ...state,
      player: { ...state.player, onFoot: true, speed: 0 },
      wanted: 0,
    };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    handleUi();
    if (screen === 'playing') {
      step(dt);
      updateEngine(state);
    } else {
      updateEngine(silencedState());
    }
    // Gambar.
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (screen === 'title') {
      drawWorld(ctx, state.camera, state, city);
      drawTitle(ctx, state);
    } else if (screen === 'playing') {
      drawWorld(ctx, state.camera, state, city);
      drawHUD(ctx, state);
      drawMinimap(ctx, state, city);
      if (state.flags.showBrief) drawMissionBrief(ctx, state);
    } else if (screen === 'paused') {
      drawWorld(ctx, state.camera, state, city);
      drawHUD(ctx, state);
      drawMinimap(ctx, state, city);
      drawPause(ctx, state);
    } else {
      drawWorld(ctx, state.camera, state, city);
      drawGameOver(ctx, state, screen);
    }
    snapshotInput();
  }

  // Keluar tab menjeda permainan yang sedang jalan, bukan membiarkan kota
  // berjalan tanpa terlihat.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === 'playing') {
      screen = 'paused';
      saveGame(state);
      announce('Jeda. Progres tersimpan.');
    }
  });

  window.addEventListener('resize', resize);
  resize();
  state.flags.hasSave = hasSave();
  announce('Port Verda. Tekan Enter untuk mulai, L untuk lanjutkan simpanan.');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot);
else runGame();
