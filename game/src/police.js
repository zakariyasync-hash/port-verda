// police.js — Port Verda: wanted level, patroli, kejar-kejaran & bust.
//
// Wanted 0-5. Naik saat pemain mencuri mobil, menembak, atau menabrak
// pejalan kaki (semua lewat addWanted). Turun pelan bila pemain lama tidak
// berbuat kriminal dan jauh dari polisi. Mobil polisi muncul di tepi
// pandangan sesuai level wanted, mengejar dan menabrak (ram) mobil pemain.
// Kalau polisi sangat dekat dan pemain lambat selama ~3 detik, pemain
// tertangkap: state.flags.busted = true (main.js yang mengubah mode game).
// Saat wanted 0, polisi hanya berpatroli mengikuti jalan.
//
// Kontrak state yang dipakai di sini:
//   state.wanted: 0..5
//   state.player {x, y, angle, speed, onFoot, carId}
//   state.cars[] {id, x, y, angle, speed, color, model, parked,
//                 driver: 'player' | 'traffic' | 'police' | null, health}
//   state.police[] {id, x, y, angle, speed, carId,
//                   state: 'patrol' | 'chase' | 'bust', bustTimer}
//     + lapangan tambahan modul ini: _node, _from, _cruise, _disableTimer.
//   state.camera {x, y} (dipakai untuk spawn di tepi layar bila ada)
//   state.flags.lastCrimeAt / crimeIdle: penanda kejahatan terakhir.
//
// Catatan integrasi: semua angka tuning modul ini dibaca dari CFG
// (config.js) — satu sumber kebenaran, tanpa mengubah perilaku. Modul ini
// tidak mengimpor modul lain (vehicles/peds/combat mengimpor addWanted
// dari sini).
import { CFG } from './config.js';

// ---------------------------------------------------------------- tuning --
const WORLD_W = CFG.WORLD_W;
const WORLD_H = CFG.WORLD_H;

const MAX_WANTED = CFG.WANTED_MAX;
const DECAY_IDLE = CFG.DECAY_IDLE; // detik tanpa kriminal sebelum wanted luruh
const DECAY_INTERVAL = CFG.DECAY_INTERVAL; // detik per satu bintang yang luruh
const DECAY_SAFE_DIST = CFG.DECAY_SAFE_DIST; // wanted hanya luruh bila polisi sejauh ini
const BUST_TIME = CFG.BUST_TIME; // detik dekat + lambat sampai tertangkap
const BUST_DIST = CFG.BUST_DIST; // jarak polisi-pemain untuk bust (px)
const BUST_SPEED = CFG.BUST_SPEED; // kecepatan pemain maksimum agar bust jalan
const SPAWN_DIST = CFG.SPAWN_DIST; // jarak spawn dari pemain (di tepi layar)
const DESPAWN_DIST = CFG.DESPAWN_DIST; // polisi sejauh ini saat wanted 0 dihapus
const PATROL_COUNT = CFG.PATROL_COUNT; // mobil patroli saat wanted 0
const CHASE_COUNT_PER_STAR = CFG.CHASE_COUNT_PER_STAR; // mobil pengejar per bintang wanted
const MAX_CHASE_CARS = CFG.MAX_CHASE_CARS; // batas mobil polisi pengejar
const PATROL_SPEED = CFG.PATROL_SPEED; // px/s
const CHASE_SPEED_BASE = CFG.CHASE_SPEED_BASE; // px/s
const CHASE_SPEED_PER_STAR = CFG.CHASE_SPEED_PER_STAR; // px/s tambahan per bintang
const CHASE_MAX_SPEED = CFG.CHASE_MAX_SPEED; // px/s
const POLICE_TURN = CFG.POLICE_TURN; // rad/s saat mengejar
const POLICE_ACCEL = CFG.POLICE_ACCEL; // px/s^2
const RAM_DIST = CFG.RAM_DIST; // jarak tabrakan ram (px)
const RAM_DAMAGE = CFG.RAM_DAMAGE; // damage ke mobil pemain per ram
const RAM_SLOW = CFG.RAM_SLOW; // pengali kecepatan mobil pemain saat di-ram
const DISABLE_TIME = CFG.DISABLE_TIME; // detik mobil polisi rusak sebelum ditarik
const NODE_ARRIVE_DIST = CFG.NODE_ARRIVE_DIST;
const POLICE_CAR_HEALTH = CFG.POLICE_CAR_HEALTH;

let nextPoliceId = 1;
let nextPoliceCarId = 1;

function makePoliceId() {
  return 'cop_' + (nextPoliceId++);
}

function makePoliceCarId() {
  return 'car_police_' + (nextPoliceCarId++);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function ensurePolice(state) {
  if (!Array.isArray(state.police)) state.police = [];
  return state.police;
}

function ensureCars(state) {
  if (!Array.isArray(state.cars)) state.cars = [];
  return state.cars;
}

function ensureFlags(state) {
  if (!state.flags || typeof state.flags !== 'object') state.flags = {};
  return state.flags;
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

// -------------------------------------------------------------- wanted ------
export function addWanted(state, n) {
  if (typeof state.wanted !== 'number') state.wanted = 0;
  state.wanted = clamp(state.wanted + n, 0, MAX_WANTED);
  const flags = ensureFlags(state);
  flags.crimeIdle = 0; // jam peluruhan dihitung ulang dari kejahatan ini
  flags.lastCrimeAt = typeof state.time === 'number' ? state.time : 0;
  return state.wanted;
}

export function updateWanted(state, dt) {
  if (!state) return;
  if (!(dt > 0)) return;
  if (typeof state.wanted !== 'number') state.wanted = 0;
  if (state.wanted <= 0) return;
  const flags = ensureFlags(state);
  flags.crimeIdle = (flags.crimeIdle || 0) + dt;
  if (flags.crimeIdle < DECAY_IDLE) return;
  // Wanted hanya luruh bila tidak ada polisi yang dekat.
  const police = ensurePolice(state);
  const player = state.player || { x: WORLD_W / 2, y: WORLD_H / 2 };
  for (const cop of police) {
    if (dist(cop.x, cop.y, player.x, player.y) < DECAY_SAFE_DIST) {
      flags.crimeIdle = DECAY_IDLE; // tahan: jangan luruh selagi diburu
      return;
    }
  }
  flags.decayTimer = (flags.decayTimer || 0) + dt;
  if (flags.decayTimer >= DECAY_INTERVAL) {
    flags.decayTimer = 0;
    state.wanted = Math.max(0, state.wanted - 1);
    if (state.wanted === 0) flags.crimeIdle = 0;
  }
}

// -------------------------------------------------------------- spawn -------
function nearestRoadNode(graph, x, y) {
  let best = graph.nodes[0];
  let bestD = Infinity;
  for (const node of graph.nodes) {
    const d = dist(x, y, node.x, node.y);
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best;
}

function spawnPoliceCar(state, graph) {
  const cars = ensureCars(state);
  const police = ensurePolice(state);
  const player = state.player || { x: WORLD_W / 2, y: WORLD_H / 2 };
  // Titik spawn: node jalan yang jaraknya paling dekat dengan SPAWN_DIST
  // dari pemain, supaya polisi muncul dari tepi layar, bukan di depan mata.
  let bestNode = graph.nodes[0];
  let bestScore = Infinity;
  for (const node of graph.nodes) {
    const d = dist(node.x, node.y, player.x, player.y);
    const score = Math.abs(d - SPAWN_DIST);
    if (score < bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }
  const options = neighborsOf(graph, bestNode.id);
  const nextId = options.length > 0
    ? options[Math.floor(Math.random() * options.length)] : bestNode.id;
  const next = nodeById(graph, nextId);
  const car = {
    id: makePoliceCarId(),
    x: bestNode.x,
    y: bestNode.y,
    angle: Math.atan2(next.y - bestNode.y, next.x - bestNode.x),
    speed: 0,
    color: '#1a1a2e',
    model: 'cruiser',
    parked: false,
    driver: 'police',
    health: POLICE_CAR_HEALTH,
  };
  cars.push(car);
  const cop = {
    id: makePoliceId(),
    x: car.x,
    y: car.y,
    angle: car.angle,
    speed: 0,
    carId: car.id,
    state: state.wanted > 0 ? 'chase' : 'patrol',
    bustTimer: 0,
    _node: nextId,
    _from: bestNode.id,
    _cruise: PATROL_SPEED,
    _disableTimer: 0,
  };
  police.push(cop);
  return cop;
}

function removePolice(state, cop) {
  const police = ensurePolice(state);
  const cars = ensureCars(state);
  const pi = police.indexOf(cop);
  if (pi !== -1) police.splice(pi, 1);
  for (let i = cars.length - 1; i >= 0; i--) {
    if (cars[i].id === cop.carId) cars.splice(i, 1);
  }
}

function findCar(state, id) {
  const cars = ensureCars(state);
  for (const car of cars) {
    if (car.id === id) return car;
  }
  return null;
}

function playerSpeed(state) {
  const player = state.player;
  if (!player) return 0;
  if (!player.onFoot && player.carId) {
    const car = findCar(state, player.carId);
    if (car) return Math.abs(car.speed || 0);
  }
  return Math.abs(player.speed || 0);
}

// -------------------------------------------------------------- perilaku ----
function updatePatrol(cop, car, graph, dt) {
  cop.state = 'patrol';
  const target = nodeById(graph, cop._node);
  const dx = target.x - car.x;
  const dy = target.y - car.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < NODE_ARRIVE_DIST) {
    const options = neighborsOf(graph, cop._node)
      .filter((id) => id !== cop._from);
    const pool = options.length > 0
      ? options : neighborsOf(graph, cop._node);
    cop._from = cop._node;
    cop._node = pool.length > 0
      ? pool[Math.floor(Math.random() * pool.length)] : cop._node;
    return;
  }
  const wantAngle = Math.atan2(dy, dx);
  const diff = angleDiff(wantAngle, car.angle);
  car.angle += clamp(diff, -2.4 * dt, 2.4 * dt);
  if (car.speed < PATROL_SPEED) {
    car.speed = Math.min(PATROL_SPEED, car.speed + POLICE_ACCEL * dt);
  } else {
    car.speed = Math.max(PATROL_SPEED, car.speed - POLICE_ACCEL * dt);
  }
}

function updateChase(state, cop, car, dt) {
  cop.state = 'chase';
  const player = state.player;
  if (!player) return;
  // Bidik sedikit di depan pemain supaya ram terasa mengejar, bukan membuntuti.
  const lead = 0.35;
  const tx = player.x + Math.cos(player.angle || 0)
    * (player.speed || 0) * lead;
  const ty = player.y + Math.sin(player.angle || 0)
    * (player.speed || 0) * lead;
  const wantAngle = Math.atan2(ty - car.y, tx - car.x);
  const diff = angleDiff(wantAngle, car.angle);
  car.angle += clamp(diff, -POLICE_TURN * dt, POLICE_TURN * dt);
  const wanted = typeof state.wanted === 'number' ? state.wanted : 0;
  const targetSpeed = Math.min(
    CHASE_MAX_SPEED,
    CHASE_SPEED_BASE + CHASE_SPEED_PER_STAR * wanted,
  );
  if (car.speed < targetSpeed) {
    car.speed = Math.min(targetSpeed, car.speed + POLICE_ACCEL * dt);
  } else {
    car.speed = Math.max(targetSpeed, car.speed - POLICE_ACCEL * dt);
  }
  // Ram: bersentuhan dengan pemain — dorong & perlambat mobilnya, rusak dikit.
  // Dorongan dijepit ke dalam dunia: tanpa ini, ram berulang di tepi peta
  // bisa mendorong mobil pemain ke luar batas (y < 0) dan pemain terjebak
  // di luar dunia karena semua gerak dari sana terblokir.
  const d = dist(car.x, car.y, player.x, player.y);
  if (d < RAM_DIST) {
    const pushAngle = Math.atan2(player.y - car.y, player.x - car.x);
    if (!player.onFoot && player.carId) {
      const playerCar = findCar(state, player.carId);
      if (playerCar) {
        playerCar.x = clamp(playerCar.x + Math.cos(pushAngle) * 14, 16, WORLD_W - 16);
        playerCar.y = clamp(playerCar.y + Math.sin(pushAngle) * 14, 16, WORLD_H - 16);
        playerCar.speed *= RAM_SLOW;
        playerCar.health = Math.max(0,
          (playerCar.health || 100) - RAM_DAMAGE);
      }
    }
    car.speed *= 0.7;
  }
}

function updateBust(state, cop, dt) {
  const player = state.player;
  if (!player) return;
  const d = dist(cop.x, cop.y, player.x, player.y);
  const speed = playerSpeed(state);
  if (d < BUST_DIST && speed < BUST_SPEED) {
    cop.bustTimer += dt;
    cop.state = 'bust';
    if (cop.bustTimer >= BUST_TIME) {
      ensureFlags(state).busted = true;
    }
  } else {
    cop.bustTimer = Math.max(0, cop.bustTimer - dt * 2);
    if (cop.state === 'bust') {
      cop.state = state.wanted > 0 ? 'chase' : 'patrol';
    }
  }
}

function movePoliceCar(car, city, dt) {
  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  const blocked = (x, y) => {
    if (x < 16 || y < 16 || x > WORLD_W - 16 || y > WORLD_H - 16) return true;
    if (city.pointInWater && city.pointInWater(x, y)) return true;
    return city.collidesBuilding(x, y, 16);
  };
  if (!blocked(nx, car.y)) car.x = nx;
  else car.speed *= 0.5;
  if (!blocked(car.x, ny)) car.y = ny;
  else car.speed *= 0.5;
  car.x = clamp(car.x, 16, WORLD_W - 16);
  car.y = clamp(car.y, 16, WORLD_H - 16);
}

export function updatePolice(state, dt, city) {
  if (!state) return;
  if (!(dt > 0)) return;
  if (typeof state.wanted !== 'number') state.wanted = 0;
  const police = ensurePolice(state);
  const liveCity = usableCity(city || state.city);
  const graph = liveCity.roadGraph;
  const player = state.player || { x: WORLD_W / 2, y: WORLD_H / 2 };
  const flags = ensureFlags(state);

  // Jumlah polisi yang seharusnya ada mengikuti wanted.
  const wanted = state.wanted;
  const desired = wanted === 0
    ? PATROL_COUNT
    : Math.min(MAX_CHASE_CARS, wanted * CHASE_COUNT_PER_STAR);
  while (police.length < desired) spawnPoliceCar(state, graph);
  while (police.length > desired) {
    // Buang yang terjauh dari pemain dulu.
    let far = police[0];
    let farD = -1;
    for (const cop of police) {
      const d = dist(cop.x, cop.y, player.x, player.y);
      if (d > farD) {
        farD = d;
        far = cop;
      }
    }
    removePolice(state, far);
  }

  for (let i = police.length - 1; i >= 0; i--) {
    const cop = police[i];
    const car = findCar(state, cop.carId);
    if (!car) {
      police.splice(i, 1);
      continue;
    }
    // Mobil polisi yang ditembak sampai rusak: berhenti, lalu ditarik.
    if (car.health <= 0) {
      car.speed = 0;
      cop._disableTimer += dt;
      if (cop._disableTimer > DISABLE_TIME) removePolice(state, cop);
      continue;
    }
    if (wanted > 0) updateChase(state, cop, car, dt);
    else updatePatrol(cop, car, graph, dt);
    if (Math.abs(car.speed) > 0.5) movePoliceCar(car, liveCity, dt);
    cop.x = car.x;
    cop.y = car.y;
    cop.angle = car.angle;
    cop.speed = car.speed;
    // Bust hanya masuk akal bila pemain tidak sedang kabur kencang.
    if (!flags.busted) updateBust(state, cop, dt);
    // Patroli yang tersesat jauh saat wanted 0 boleh dibubarkan.
    if (wanted === 0
      && dist(cop.x, cop.y, player.x, player.y) > DESPAWN_DIST) {
      removePolice(state, cop);
    }
  }
}
