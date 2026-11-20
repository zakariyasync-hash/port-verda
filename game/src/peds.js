// peds.js — Port Verda: pejalan kaki di trotoar kota.
//
// Pejalan kaki berjalan menyusuri tepi jalan mengikuti roadGraph (satu ruas
// jalan per pejalan kaki, maju dari node ke node). Mereka lari ketakutan saat
// ada tembakan di dekatnya, saat mobil melaju kencang ke arah mereka, atau
// saat tertabrak mobil. Pejalan kaki yang tertabrak adalah kejahatan dan
// menaikkan wanted lewat police.js.
//
// Kontrak state yang dipakai di sini:
//   state.peds[] {id, x, y, angle, speed, state: 'walk' | 'flee' | 'idle'}
//     + lapangan tambahan modul ini: health, _edge, _t, _dir, _pause,
//       _fleeFrom {x, y}, _fleeTimer, _crimeAt, _downTimer, _seed.
//   state.cars[] dipakai untuk deteksi tabrakan.
//   state.flags.shotAge: detik sejak tembakan terakhir (diisi combat.js);
//   state.flags.lastShot {x, y}: posisi tembakan terakhir (diisi combat.js).
//
// Catatan integrasi: semua angka tuning modul ini dibaca dari CFG
// (config.js) — satu sumber kebenaran, tanpa mengubah perilaku.
import { CFG } from './config.js';
import { addWanted } from './police.js';

// ---------------------------------------------------------------- tuning --
const WORLD_W = CFG.WORLD_W;
const WORLD_H = CFG.WORLD_H;

const PED_COUNT = CFG.PED_COUNT; // jumlah pejalan kaki yang dijaga hidup
const WALK_SPEED_MIN = CFG.PED_SPEED_MIN; // px/s
const WALK_SPEED_MAX = CFG.PED_SPEED_MAX; // px/s
const FLEE_SPEED = CFG.FLEE_SPEED; // px/s saat lari ketakutan
const SIDEWALK_OFFSET = CFG.SIDEWALK_OFFSET; // jarak pejalan kaki dari garis tengah jalan
const FLEE_RADIUS = CFG.FLEE_RADIUS; // radius dengar tembakan (px)
const FLEE_TIME = CFG.FLEE_TIME; // detik lari sebelum tenang kembali
const CAR_SCARE_DIST = CFG.CAR_SCARE_DIST; // mobil secepat ini & sedekat ini bikin lari
const CAR_SCARE_SPEED = CFG.CAR_SCARE_SPEED; // px/s
const HIT_DIST = CFG.HIT_DIST; // jarak mobil-ped dianggap tabrakan (px)
const HIT_SPEED = CFG.HIT_SPEED; // kecepatan mobil minimum agar tabrakan dihitung
const HIT_DAMAGE = CFG.HIT_DAMAGE; // damage ke pejalan kaki saat tertabrak
const HIT_CRIME_COOLDOWN = CFG.HIT_CRIME_COOLDOWN; // detik antar kenaikan wanted per pejalan kaki
const PED_HEALTH = CFG.PED_HEALTH;
const DOWN_DESPAWN = CFG.DOWN_DESPAWN; // detik pejalan kaki terkapar sebelum hilang
const IDLE_CHANCE = CFG.IDLE_CHANCE; // peluang berhenti sejenak di ujung ruas
const IDLE_TIME_MIN = CFG.IDLE_TIME_MIN; // detik diam
const IDLE_TIME_MAX = CFG.IDLE_TIME_MAX; // detik diam
const RESPAWN_MIN_DIST = CFG.RESPAWN_MIN_DIST; // respawn minimal sejauh ini dari pemain

const PED_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#1abc9c', '#e67e22', '#ecf0f1', '#fd79a8', '#636e72',
];
const PED_RADIUS = CFG.PED_RADIUS;

let nextPedId = 1;

function makePedId() {
  return 'ped_' + (nextPedId++);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function ensurePeds(state) {
  if (!Array.isArray(state.peds)) state.peds = [];
  return state.peds;
}

// Kota darurat bila main.js memanggil sebelum city siap (sama seperti di
// vehicles.js, ditulis ulang di sini agar modul ini berdiri sendiri).
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

function blockedAt(city, x, y, r) {
  if (x < r || y < r || x > WORLD_W - r || y > WORLD_H - r) return true;
  if (city.pointInWater && city.pointInWater(x, y)) return true;
  if (city.collidesBuilding(x, y, r)) return true;
  return false;
}

function nodeById(graph, nodeId) {
  for (const node of graph.nodes) {
    if (node.id === nodeId) return node;
  }
  return graph.nodes[0];
}

function neighborsOf(graph, nodeId) {
  const out = [];
  for (const edge of graph.edges) {
    if (edge.a === nodeId) out.push(edge.b);
    else if (edge.b === nodeId) out.push(edge.a);
  }
  return out;
}

function randomEdge(graph) {
  return graph.edges[Math.floor(Math.random() * graph.edges.length)];
}

// Posisi pejalan kaki di atas ruas jalan: interpolasi antar node ditambah
// geseran tegak lurus (trotoar) ke satu sisi yang tetap per pejalan kaki.
function edgePosition(graph, ped) {
  const a = nodeById(graph, ped._edge.a);
  const b = nodeById(graph, ped._edge.b);
  const t = clamp(ped._t, 0, 1);
  const mx = a.x + (b.x - a.x) * t;
  const my = a.y + (b.y - a.y) * t;
  const along = Math.atan2(b.y - a.y, b.x - a.x);
  const px = Math.cos(along + Math.PI / 2) * SIDEWALK_OFFSET * ped._side;
  const py = Math.sin(along + Math.PI / 2) * SIDEWALK_OFFSET * ped._side;
  return { x: mx + px, y: my + py, angle: along * ped._dir };
}

function makePed(graph, farFrom) {
  const edge = randomEdge(graph);
  const ped = {
    id: makePedId(),
    x: 0,
    y: 0,
    angle: 0,
    speed: WALK_SPEED_MIN + Math.random() * (WALK_SPEED_MAX - WALK_SPEED_MIN),
    state: 'walk',
    health: PED_HEALTH,
    color: PED_COLORS[Math.floor(Math.random() * PED_COLORS.length)],
    _edge: { a: edge.a, b: edge.b },
    _t: Math.random(),
    _dir: Math.random() < 0.5 ? 1 : -1,
    _side: Math.random() < 0.5 ? 1 : -1,
    _pause: 0,
    _fleeFrom: null,
    _fleeTimer: 0,
    _crimeAt: -999,
    _downTimer: 0,
    _seed: Math.random() * Math.PI * 2,
  };
  const pos = edgePosition(graph, ped);
  ped.x = pos.x;
  ped.y = pos.y;
  ped.angle = pos.angle;
  // Jangan muncul tepat di depan hidung pemain.
  if (farFrom && dist(ped.x, ped.y, farFrom.x, farFrom.y) < RESPAWN_MIN_DIST) {
    ped._t = 1 - ped._t;
    const pos2 = edgePosition(graph, ped);
    ped.x = pos2.x;
    ped.y = pos2.y;
  }
  return ped;
}

// -------------------------------------------------------------- spawn peds --
export function spawnPeds(state, city) {
  const peds = ensurePeds(state);
  const liveCity = usableCity(city || state.city);
  const graph = liveCity.roadGraph;
  const player = state.player || { x: WORLD_W / 2, y: WORLD_H / 2 };
  while (peds.length < PED_COUNT) {
    peds.push(makePed(graph, player));
  }
  return peds;
}

// ------------------------------------------------------------- perilaku -----
function startFlee(ped, fromX, fromY) {
  ped.state = 'flee';
  ped._fleeFrom = { x: fromX, y: fromY };
  ped._fleeTimer = FLEE_TIME;
  ped._pause = 0;
}

// Cari ruas jalan terdekat dari posisi pejalan kaki, lalu tempelkan lagi
// pejalan kaki ke trotoar ruas itu (dipakai setelah selesai lari).
function reattachToRoad(graph, ped) {
  let bestEdge = null;
  let bestT = 0;
  let bestD = Infinity;
  for (const edge of graph.edges) {
    const a = nodeById(graph, edge.a);
    const b = nodeById(graph, edge.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((ped.x - a.x) * dx + (ped.y - a.y) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = dist(ped.x, ped.y, px, py);
    if (d < bestD) {
      bestD = d;
      bestEdge = edge;
      bestT = t;
    }
  }
  if (bestEdge) {
    ped._edge = { a: bestEdge.a, b: bestEdge.b };
    ped._t = bestT;
    ped._dir = Math.random() < 0.5 ? 1 : -1;
  }
}

function updateWalk(ped, graph, dt) {
  if (ped._pause > 0) {
    ped._pause -= dt;
    ped.speed = 0;
    return;
  }
  const a = nodeById(graph, ped._edge.a);
  const b = nodeById(graph, ped._edge.b);
  const len = Math.max(1, dist(a.x, a.y, b.x, b.y));
  ped._t += (ped._dir * ped.speed * dt) / len;
  if (ped._t >= 1 || ped._t <= 0) {
    // Sampai di ujung ruas: belok ke ruas lain dari node itu.
    const atNode = ped._t >= 1 ? ped._edge.b : ped._edge.a;
    const options = neighborsOf(graph, atNode)
      .filter((id) => id !== ped._edge.a && id !== ped._edge.b);
    if (Math.random() < IDLE_CHANCE) {
      ped.state = 'idle';
      ped._pause = IDLE_TIME_MIN
        + Math.random() * (IDLE_TIME_MAX - IDLE_TIME_MIN);
      ped._t = clamp(ped._t, 0, 1);
      return;
    }
    if (options.length === 0) {
      // Jalan buntu: putar balik di ruas yang sama.
      ped._dir = -ped._dir;
      ped._t = clamp(ped._t, 0, 1);
    } else {
      const next = options[Math.floor(Math.random() * options.length)];
      ped._edge = { a: atNode, b: next };
      ped._t = 0;
      ped._dir = 1;
    }
  }
  const pos = edgePosition(graph, ped);
  ped.x = pos.x;
  ped.y = pos.y;
  ped.angle = pos.angle;
  if (ped.state === 'idle' && ped._pause <= 0) ped.state = 'walk';
}

function updateFlee(ped, city, dt) {
  ped._fleeTimer -= dt;
  const from = ped._fleeFrom || { x: ped.x, y: ped.y };
  const away = Math.atan2(ped.y - from.y, ped.x - from.x);
  ped.angle = away;
  ped.speed = FLEE_SPEED;
  const nx = ped.x + Math.cos(away) * FLEE_SPEED * dt;
  const ny = ped.y + Math.sin(away) * FLEE_SPEED * dt;
  // Lari tetap menghormati bangunan & air (geser per sumbu).
  if (!blockedAt(city, nx, ped.y, PED_RADIUS)) ped.x = nx;
  if (!blockedAt(city, ped.x, ny, PED_RADIUS)) ped.y = ny;
  ped.x = clamp(ped.x, PED_RADIUS, WORLD_W - PED_RADIUS);
  ped.y = clamp(ped.y, PED_RADIUS, WORLD_H - PED_RADIUS);
}

// Dorong pejalan kaki yang saling bertumpuk supaya tidak berjalan menempel
// satu sama lain di trotoar yang sama (hanya yang sedang jalan / diam).
function separatePeds(peds) {
  for (let i = 0; i < peds.length; i++) {
    const a = peds[i];
    if (a.state === 'flee' || a.state === 'down') continue;
    for (let j = i + 1; j < peds.length; j++) {
      const b = peds[j];
      if (b.state === 'flee' || b.state === 'down') continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 18 || d < 0.01) continue;
      const push = (18 - d) / 2;
      const ux = dx / d;
      const uy = dy / d;
      a.x -= ux * push;
      a.y -= uy * push;
      b.x += ux * push;
      b.y += uy * push;
    }
  }
}

function checkCarThreat(ped, state, now) {
  const cars = Array.isArray(state.cars) ? state.cars : [];
  const player = state.player || null;
  for (const car of cars) {
    const d = dist(ped.x, ped.y, car.x, car.y);
    const speed = Math.abs(car.speed || 0);
    if (d < HIT_DIST && speed > HIT_SPEED) {
      // Tabrakan hanya dihitung bila pejalan kaki memang ada DI DEPAN
      // mobil (searah lajunya), bukan saat mobil hanya lewat di samping
      // trotoar: tanpa ini, mobil yang memotong tikungan di persimpangan
      // terus-menerus "menyerempet" pejalan kaki dan wanted pemain naik
      // sendiri padahal pemain diam.
      const toPed = Math.atan2(ped.y - car.y, ped.x - car.x);
      let diff = toPed - car.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) >= 0.9) continue;
      // Tertabrak: terpental ke samping, terluka. Yang jadi KEJAHATAN
      // (wanted) hanya bila mobilnya mobil pemain — mobil lalu lintas /
      // polisi yang menabrak bukan salah pemain.
      const isPlayerCar = !!player && player.onFoot === false && car.id === player.carId;
      const away = Math.atan2(ped.y - car.y, ped.x - car.x);
      ped.x += Math.cos(away) * 26;
      ped.y += Math.sin(away) * 26;
      ped.health -= HIT_DAMAGE;
      if (isPlayerCar && now - ped._crimeAt > HIT_CRIME_COOLDOWN) {
        addWanted(state, 1);
        ped._crimeAt = now;
      }
      if (ped.health <= 0) {
        ped.state = 'down';
        ped._downTimer = DOWN_DESPAWN;
        ped.speed = 0;
        // Anggota geng yang tumbang dihitung misi 5 (missions.js membaca
        // flags.gangKills): pejalan kaki 'down' dihapus setelah beberapa
        // detik, jadi hitungannya harus menetap di flags, bukan di badan ped.
        if (ped.gang === true) {
          if (!state.flags) state.flags = {};
          state.flags.gangKills = (state.flags.gangKills || 0) + 1;
        }
      } else {
        startFlee(ped, car.x, car.y);
      }
      return;
    }
    if (d < CAR_SCARE_DIST && speed > CAR_SCARE_SPEED && ped.state !== 'flee') {
      // Mobil melaju kencang ke arah pejalan kaki: lari sebelum tertabrak.
      const toPed = Math.atan2(ped.y - car.y, ped.x - car.x);
      let diff = toPed - car.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < 0.6) startFlee(ped, car.x, car.y);
    }
  }
}

export function updatePeds(state, dt, city) {
  if (!state) return;
  if (!(dt > 0)) return;
  const peds = ensurePeds(state);
  const liveCity = usableCity(city || state.city);
  const graph = liveCity.roadGraph;
  const now = typeof state.time === 'number' ? state.time : 0;

  // Umur tembakan terakhir menua di sini bila combat.js tidak memajukannya.
  if (state.flags && typeof state.flags.shotAge === 'number') {
    state.flags.shotAge += dt;
  }
  const shot = state.flags && state.flags.lastShot;
  const shotAge = state.flags && typeof state.flags.shotAge === 'number'
    ? state.flags.shotAge : Infinity;

  for (let i = peds.length - 1; i >= 0; i--) {
    const ped = peds[i];
    if (ped.state === 'down') {
      ped._downTimer -= dt;
      if (ped._downTimer <= 0) peds.splice(i, 1);
      continue;
    }
    // Tembakan di dekat sini bikin lari.
    if (shot && shotAge < 1.5 && ped.state !== 'flee') {
      if (dist(ped.x, ped.y, shot.x, shot.y) < FLEE_RADIUS) {
        startFlee(ped, shot.x, shot.y);
      }
    }
    checkCarThreat(ped, state, now);
    if (ped.state === 'down') continue;
    if (ped.state === 'flee') {
      updateFlee(ped, liveCity, dt);
      if (ped._fleeTimer <= 0) {
        ped.state = 'walk';
        ped._fleeFrom = null;
        reattachToRoad(graph, ped);
      }
    } else {
      if (typeof ped.speed !== 'number' || ped.speed <= 0) {
        ped.speed = WALK_SPEED_MIN
          + Math.random() * (WALK_SPEED_MAX - WALK_SPEED_MIN);
      }
      updateWalk(ped, graph, dt);
    }
  }

  // Jaga jumlah pejalan kaki tetap hidup: respawn yang hilang jauh dari pemain.
  if (peds.length < PED_COUNT) {
    const player = state.player || { x: WORLD_W / 2, y: WORLD_H / 2 };
    peds.push(makePed(graph, player));
  }

  separatePeds(peds);
}
