// combat.js — Port Verda: pukul, tembak, peluru & health pack.
//
// Pukul (F): jarak pendek, ada cooldown, melukai pejalan kaki di dekat
// pemain (mereka lari; dua-tiga pukulan menjatuhkan). Tembak (klik mouse):
// butuh weapon 'pistol' dan ammo > 0; peluru adalah proyektil cepat yang
// disimpan di state.bullets supaya render.js bisa menggambarnya. Menembak
// menaikkan wanted +1 lewat police.js. Health pack muncul berkala di kota;
// diambil saat pemain dekat (+25 health).
//
// Kontrak state yang dipakai di sini:
//   state.player {x, y, angle, speed, onFoot, carId, weapon, ammo}
//   state.health: 0..100
//   state.peds[] {id, x, y, state, health}
//   state.cars[] {id, x, y, speed, driver, health}
//   state.bullets[] {id, x, y, vx, vy, life, damage} — DITAMBAH modul ini
//     (render.js menggambar tiap peluru sebagai garis/percik pendek).
//   state.pickups[] {id, x, y, kind: 'health'} — DITAMBAH modul ini.
//   state.flags.lastShot {x, y} + shotAge: dibaca peds.js (lari ketakutan).
//   state.flags.wasted = true saat health habis (main.js mengubah mode).
//
// Catatan integrasi: semua angka tuning modul ini dibaca dari CFG
// (config.js) — satu sumber kebenaran, tanpa mengubah perilaku.
import { CFG } from './config.js';
import { addWanted } from './police.js';

// ---------------------------------------------------------------- tuning --
const WORLD_W = CFG.WORLD_W;
const WORLD_H = CFG.WORLD_H;

const PUNCH_RANGE = CFG.PUNCH_RANGE; // jangkauan pukulan (px)
const PUNCH_DAMAGE = CFG.PUNCH_DAMAGE; // damage per pukulan
const PUNCH_COOLDOWN = CFG.PUNCH_COOLDOWN; // detik antar pukulan
const BULLET_SPEED = CFG.BULLET_SPEED; // px/s
const BULLET_LIFE = CFG.BULLET_LIFE; // detik umur peluru
const BULLET_DAMAGE = CFG.BULLET_DAMAGE; // damage per peluru
const BULLET_HIT_PED = CFG.BULLET_HIT_PED; // radius kena pejalan kaki (px)
const BULLET_HIT_CAR = CFG.BULLET_HIT_CAR; // radius kena mobil (px)
const BULLET_SPREAD = CFG.BULLET_SPREAD; // radian sebaran acak arah tembakan
const HEALTH_PACK_INTERVAL = CFG.HEALTH_PACK_INTERVAL; // detik antar spawn health pack
const HEALTH_PACK_MAX = CFG.HEALTH_PACK_MAX; // health pack maksimum yang hidup bersamaan
const HEALTH_PACK_HEAL = CFG.HEALTH_PACK_HEAL; // health yang dipulihkan
const PICKUP_RADIUS = CFG.PICKUP_RADIUS; // jarak ambil health pack (px)
const MAX_HEALTH = CFG.PLAYER_MAX_HEALTH;

let nextBulletId = 1;
let nextPickupId = 1;
let nextFleePedId = 1;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function ensureFlags(state) {
  if (!state.flags || typeof state.flags !== 'object') state.flags = {};
  return state.flags;
}

function ensureBullets(state) {
  if (!Array.isArray(state.bullets)) state.bullets = [];
  return state.bullets;
}

function ensurePickups(state) {
  if (!Array.isArray(state.pickups)) state.pickups = [];
  return state.pickups;
}

// Kota darurat bila main.js memanggil sebelum city siap (ditulis ulang di
// sini agar modul ini berdiri sendiri, sama seperti modul B2 lainnya).
function fallbackCity() {
  const nodes = [];
  const edges = [];
  let id = 0;
  for (let gx = 0; gx < 5; gx++) {
    for (let gy = 0; gy < 4; gy++) {
      nodes.push({ id: id++, x: 320 + gx * 640, y: 300 + gy * 600 });
    }
  }
  const at = (gx, gy) => gy * 5 + gx;
  for (let gx = 0; gx < 5; gx++) {
    for (let gy = 0; gy < 4; gy++) {
      if (gx < 4) edges.push({ a: at(gx, gy), b: at(gx + 1, gy) });
      if (gy < 3) edges.push({ a: at(gx, gy), b: at(gx, gy + 1) });
    }
  }
  return {
    roadGraph: { nodes, edges },
    isRoad: () => true,
    collidesBuilding: () => false,
    pointInWater: () => false,
  };
}

function usableCity(city) {
  if (city && city.roadGraph && Array.isArray(city.roadGraph.nodes)
    && city.roadGraph.nodes.length > 0
    && typeof city.collidesBuilding === 'function') {
    return city;
  }
  return fallbackCity();
}

// ----------------------------------------------------------------- pukul ---
export function punch(state) {
  const player = state.player;
  if (!player) return false;
  const flags = ensureFlags(state);
  if ((flags.punchCooldown || 0) > 0) return false;
  flags.punchCooldown = PUNCH_COOLDOWN;
  const peds = Array.isArray(state.peds) ? state.peds : [];
  let best = null;
  let bestD = PUNCH_RANGE;
  for (const ped of peds) {
    if (ped.state === 'down') continue;
    const d = dist(player.x, player.y, ped.x, ped.y);
    if (d < bestD) {
      bestD = d;
      best = ped;
    }
  }
  if (!best) return false;
  if (typeof best.health !== 'number') best.health = 100;
  best.health -= PUNCH_DAMAGE;
  // Korban pukulan langsung lari ketakutan menjauhi pemain.
  best.state = 'flee';
  best._fleeFrom = { x: player.x, y: player.y };
  best._fleeTimer = 3.2;
  best._pause = 0;
  if (best.health <= 0) {
    best.state = 'down';
    best._downTimer = 6;
    best.speed = 0;
    // Anggota geng yang tumbang dihitung misi 5 (lihat hurtPed di bawah).
    if (best.gang === true) {
      flags.gangKills = (flags.gangKills || 0) + 1;
    }
  }
  return true;
}

// ---------------------------------------------------------------- tembak ---
export function shoot(state, tx, ty) {
  const player = state.player;
  if (!player) return false;
  if (player.weapon !== 'pistol') return false;
  if (typeof player.ammo !== 'number' || player.ammo <= 0) return false;
  if (typeof tx !== 'number' || typeof ty !== 'number') return false;
  player.ammo -= 1;
  const flags = ensureFlags(state);
  flags.lastShot = { x: player.x, y: player.y };
  flags.shotAge = 0;
  addWanted(state, 1);
  const base = Math.atan2(ty - player.y, tx - player.x);
  const angle = base + (Math.random() - 0.5) * 2 * BULLET_SPREAD;
  // Peluru keluar dari tangan / moncong: sedikit di depan pemain.
  const ox = player.x + Math.cos(base) * 20;
  const oy = player.y + Math.sin(base) * 20;
  ensureBullets(state).push({
    id: 'bul_' + (nextBulletId++),
    x: ox,
    y: oy,
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    life: BULLET_LIFE,
    damage: BULLET_DAMAGE,
  });
  return true;
}

// ------------------------------------------------------------ damage pemain -
export function damagePlayer(state, n) {
  if (typeof state.health !== 'number') state.health = MAX_HEALTH;
  state.health = Math.max(0, state.health - n);
  if (state.health <= 0) {
    ensureFlags(state).wasted = true;
  }
  return state.health;
}

// ------------------------------------------------------------- health pack ---
function spawnHealthPack(state, city) {
  const graph = usableCity(city).roadGraph;
  const node = graph.nodes[Math.floor(Math.random() * graph.nodes.length)];
  const pickups = ensurePickups(state);
  pickups.push({
    id: 'hp_' + (nextPickupId++),
    x: clamp(node.x + (Math.random() - 0.5) * 120, 24, WORLD_W - 24),
    y: clamp(node.y + (Math.random() - 0.5) * 120, 24, WORLD_H - 24),
    kind: 'health',
  });
}

function hurtPed(state, ped, damage, fromX, fromY) {
  if (typeof ped.health !== 'number') ped.health = 100;
  ped.health -= damage;
  if (ped.health <= 0) {
    ped.state = 'down';
    ped._downTimer = 6;
    ped.speed = 0;
    // Anggota geng yang tumbang dihitung misi 5: pejalan kaki 'down'
    // dihapus peds.js setelah beberapa detik, jadi hitungannya harus
    // menetap di flags, bukan hanya di badan ped (lihat countGangDown
    // di missions.js).
    if (ped.gang === true) {
      const flags = ensureFlags(state);
      flags.gangKills = (flags.gangKills || 0) + 1;
    }
  } else {
    ped.state = 'flee';
    ped._fleeFrom = { x: fromX, y: fromY };
    ped._fleeTimer = 3.2;
    ped._pause = 0;
  }
}

function updateBullets(state, dt, city) {
  const bullets = ensureBullets(state);
  const liveCity = usableCity(city);
  const peds = Array.isArray(state.peds) ? state.peds : [];
  const cars = Array.isArray(state.cars) ? state.cars : [];
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    let dead = b.life <= 0
      || b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H;
    if (!dead && liveCity.collidesBuilding
      && liveCity.collidesBuilding(b.x, b.y, 2)) {
      dead = true; // peluru berhenti di dinding bangunan
    }
    if (!dead) {
      const shooter = state.player || { x: b.x, y: b.y };
      for (const ped of peds) {
        if (ped.state === 'down') continue;
        if (dist(b.x, b.y, ped.x, ped.y) < BULLET_HIT_PED) {
          hurtPed(state, ped, b.damage, shooter.x, shooter.y);
          dead = true;
          break;
        }
      }
    }
    if (!dead) {
      for (const car of cars) {
        // Jangan menembak mobil sendiri dari dalam mobil itu.
        if (state.player && !state.player.onFoot
          && car.id === state.player.carId) continue;
        if (dist(b.x, b.y, car.x, car.y) < BULLET_HIT_CAR) {
          car.health = Math.max(0, (car.health || 100) - b.damage);
          if (car.health <= 0) disableCar(state, car);
          dead = true;
          break;
        }
      }
    }
    if (dead) bullets.splice(i, 1);
  }
}

// Cari ruas jalan terdekat dari sebuah titik, supaya pejalan kaki yang
// dibuat dadakan (mis. sopir yang keluar dari mobil hancur) tetap punya
// _edge yang sah — updatePeds membaca ped._edge setiap frame, dan _edge
// null akan menjatuhkan game.
function nearestEdge(graph, x, y) {
  let best = null;
  let bestT = 0;
  let bestD = Infinity;
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = (x - px) * (x - px) + (y - py) * (y - py);
    if (d < bestD) {
      bestD = d;
      best = edge;
      bestT = t;
    }
  }
  return best ? { a: best.a, b: best.b, t: bestT } : null;
}

// Mobil yang hancur ditembak: berhenti; sopir lalu lintas keluar dan lari.
function disableCar(state, car) {
  car.speed = 0;
  if (car.driver === 'traffic') {
    car.driver = null;
    car.parked = true;
    const peds = Array.isArray(state.peds) ? state.peds : [];
    const fleeFrom = state.player
      ? { x: state.player.x, y: state.player.y } : { x: car.x, y: car.y };
    const graph = usableCity(state.city).roadGraph;
    const snap = nearestEdge(graph, car.x + 24, car.y)
      || (graph.edges[0] ? { a: graph.edges[0].a, b: graph.edges[0].b, t: 0 } : null);
    peds.push({
      id: 'ped_flee_' + (nextFleePedId++),
      x: car.x + 24,
      y: car.y,
      angle: 0,
      speed: 175,
      state: 'flee',
      health: 100,
      color: '#e67e22',
      // _edge wajib ada dan sah: updatePeds membacanya tiap frame.
      _edge: snap ? { a: snap.a, b: snap.b } : { a: 0, b: 1 },
      _t: snap ? snap.t : 0,
      _dir: 1,
      _side: 1,
      _pause: 0,
      _fleeFrom: fleeFrom,
      _fleeTimer: 3.2,
      _crimeAt: -999,
      _downTimer: 0,
      _seed: Math.random() * Math.PI * 2,
    });
  }
}

// ----------------------------------------------------------------- update ---
export function updateCombat(state, dt, city) {
  if (!state) return;
  if (!(dt > 0)) return;
  const flags = ensureFlags(state);
  if (typeof state.health !== 'number') state.health = MAX_HEALTH;

  // Cooldown pukulan & umur tembakan menua dengan dt (tidak bergantung
  // pada state.time, supaya modul tetap jalan apa pun main loop B1).
  if ((flags.punchCooldown || 0) > 0) {
    flags.punchCooldown = Math.max(0, flags.punchCooldown - dt);
  }
  if (typeof flags.shotAge === 'number') flags.shotAge += dt;

  updateBullets(state, dt, city || state.city);

  // Spawn health pack berkala selama belum mencapai batas.
  flags.healthPackTimer = (flags.healthPackTimer || 0) + dt;
  const pickups = ensurePickups(state);
  if (flags.healthPackTimer >= HEALTH_PACK_INTERVAL
    && pickups.length < HEALTH_PACK_MAX) {
    flags.healthPackTimer = 0;
    spawnHealthPack(state, city || state.city);
  }

  // Ambil health pack saat pemain dekat.
  const player = state.player;
  if (player) {
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      if (p.kind !== 'health') continue;
      if (dist(player.x, player.y, p.x, p.y) < PICKUP_RADIUS) {
        state.health = Math.min(MAX_HEALTH, state.health + HEALTH_PACK_HEAL);
        flags.lastPickup = { kind: 'health', x: p.x, y: p.y };
        pickups.splice(i, 1);
      }
    }
  }
}
