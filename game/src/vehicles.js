// vehicles.js — Port Verda: fisika mobil pemain, curi mobil, lalu lintas & parkir.
//
// Modul ini mengurus semua yang beroda di Port Verda. Mobil pemain dikendarai
// dari state.input (WASD / panah, Shift = rem tangan). Mobil lalu lintas
// mengikuti roadGraph kota, melambat di persimpangan dan menjaga jarak.
// Mobil parkir diam di tepi jalan dan bisa diambil pemain.
//
// Kontrak state yang dipakai di sini:
//   state.player {x, y, angle, speed, onFoot, carId}
//   state.cars[] {id, x, y, angle, speed, color, model, parked,
//                 driver: 'player' | 'traffic' | 'police' | null, health}
//   state.input: peta kode tombol -> truthy, atau Set / array kode tombol.
//   state.flags: dipakai untuk menandai kejahatan terakhir (lihat police.js).
//
// Catatan integrasi: semua angka tuning di bawah ini adalah konstanta lokal
// modul ini karena config.js (CFG) B1 belum ada saat modul ini ditulis.
// Nilai WORLD_W / WORLD_H mengikuti kontrak (3200 x 2400). B4 dapat
// memindahkan konstanta-konstanta ini ke CFG tanpa mengubah perilaku.

import { CFG } from './config.js';
import { addWanted } from './police.js';

// ---------------------------------------------------------------- tuning --
// Semua angka di bawah ini dibaca dari CFG (config.js) — satu sumber
// kebenaran. Nama lokal dipertahankan supaya semua pemakaian di bawah
// tidak berubah dan perilaku modul tetap sama persis seperti sebelumnya.
const WORLD_W = CFG.WORLD_W;
const WORLD_H = CFG.WORLD_H;

const ENTER_RADIUS = CFG.ENTER_RADIUS; // jarak maksimum untuk masuk mobil (px)
const EXIT_OFFSET = CFG.EXIT_OFFSET; // jarak pemain muncul di samping mobil (px)
const CAR_RADIUS = CFG.CAR_RADIUS; // radius tabrakan mobil (px)

const CAR_ACCEL = CFG.CAR_ACCEL; // px/s^2, gas maju
const CAR_REVERSE_ACCEL = CFG.CAR_REVERSE_ACCEL; // px/s^2, mundur
const CAR_BRAKE = CFG.CAR_BRAKE; // px/s^2, rem saat melaju ke arah berlawanan
const CAR_HANDBRAKE = CFG.CAR_HANDBRAKE; // px/s^2, rem tangan (Shift)
const CAR_DRAG = CFG.CAR_DRAG; // gesekan gelinding, per detik
const CAR_MAX_SPEED = CFG.CAR_MAX_SPEED; // px/s maju
const CAR_MAX_REVERSE = CFG.CAR_MAX_REVERSE; // px/s mundur
const CAR_TURN_BASE = CFG.CAR_TURN_BASE; // rad/s pada kecepatan sedang
const CAR_TURN_MIN_SPEED = CFG.CAR_TURN_MIN_SPEED; // kecepatan untuk setir penuh
const HANDBRAKE_TURN_BONUS = CFG.HANDBRAKE_TURN_BONUS; // pengali setir saat rem tangan

const TRAFFIC_COUNT = CFG.TRAFFIC_COUNT; // mobil lalu lintas yang hidup
const PARKED_COUNT = CFG.PARKED_COUNT; // mobil parkir di tepi jalan
const TRAFFIC_SPEED_MIN = CFG.TRAFFIC_SPEED_MIN; // px/s
const TRAFFIC_SPEED_MAX = CFG.TRAFFIC_SPEED_MAX; // px/s
const TRAFFIC_ACCEL = CFG.TRAFFIC_ACCEL; // px/s^2
const JUNCTION_SLOW_DIST = CFG.JUNCTION_SLOW_DIST; // mulai melambat sejauh ini dari simpang
const JUNCTION_SLOW_SPEED = CFG.JUNCTION_SLOW_SPEED; // batas kecepatan di dekat simpang
const FOLLOW_DIST = CFG.FOLLOW_DIST; // jarak mulai mengerem di belakang mobil lain
const FOLLOW_STOP_DIST = CFG.FOLLOW_STOP_DIST; // jarak berhenti penuh di belakang mobil lain
const NODE_ARRIVE_DIST = CFG.NODE_ARRIVE_DIST; // jarak dianggap sampai di node tujuan

const CAR_COLORS = [
  '#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad',
  '#ecf0f1', '#2c3e50', '#e67e22', '#16a085', '#d35400',
];
const CAR_MODELS = ['sedan', 'hatch', 'van', 'pickup', 'taxi'];
const CAR_HEALTH = CFG.CAR_HEALTH;

let nextCarId = 1;

function makeCarId() {
  return 'car_' + (nextCarId++);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function keyDown(input, ...codes) {
  if (!input) return false;
  for (const code of codes) {
    // Objek input createInput() (input.js B3): baca lewat isDown().
    if (typeof input.isDown === 'function') {
      if (input.isDown(code)) return true;
    } else if (typeof input.has === 'function') {
      if (input.has(code)) return true;
    } else if (Array.isArray(input)) {
      if (input.indexOf(code) !== -1) return true;
    } else if (input[code]) {
      return true;
    }
  }
  return false;
}

function ensureCars(state) {
  if (!Array.isArray(state.cars)) state.cars = [];
  return state.cars;
}

function findCar(state, id) {
  const cars = ensureCars(state);
  for (const car of cars) {
    if (car.id === id) return car;
  }
  return null;
}

function nearestCar(state, x, y, maxDist) {
  const cars = ensureCars(state);
  let best = null;
  let bestDist = maxDist;
  for (const car of cars) {
    const dx = car.x - x;
    const dy = car.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestDist) {
      bestDist = d;
      best = car;
    }
  }
  return best;
}

// Kota darurat bila main.js memanggil sebelum city siap: seluruh peta bisa
// dilalui, tanpa bangunan dan tanpa air, dengan simpang jalan sederhana.
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

// Gerakkan mobil selangkah dengan tabrakan sumbu-terpisah: coba geser X dulu,
// lalu Y, sehingga mobil meluncur di sepanjang dinding, bukan menempel.
function moveCarWithCollision(car, city, dt) {
  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  if (!blockedAt(city, nx, car.y, CAR_RADIUS)) {
    car.x = clamp(nx, CAR_RADIUS, WORLD_W - CAR_RADIUS);
  } else {
    car.speed *= 0.55;
  }
  if (!blockedAt(city, car.x, ny, CAR_RADIUS)) {
    car.y = clamp(ny, CAR_RADIUS, WORLD_H - CAR_RADIUS);
  } else {
    car.speed *= 0.55;
  }
}

function neighborsOf(graph, nodeId) {
  const out = [];
  for (const edge of graph.edges) {
    if (edge.a === nodeId) out.push(edge.b);
    else if (edge.b === nodeId) out.push(edge.a);
  }
  return out;
}

function nodeById(graph, nodeId) {
  for (const node of graph.nodes) {
    if (node.id === nodeId) return node;
  }
  return graph.nodes[0];
}

// Pilih node berikutnya untuk mobil lalu lintas: tetangga acak yang bukan
// node asal (supaya tidak bolak-balik), kecuali di jalan buntu.
function pickNextNode(graph, car) {
  const options = neighborsOf(graph, car._node);
  if (options.length === 0) return car._node;
  const forward = options.filter((id) => id !== car._from);
  const pool = forward.length > 0 ? forward : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ------------------------------------------------------------- masuk mobil --
export function enterCar(state) {
  const player = state.player;
  if (!player || !player.onFoot) return false;
  const car = nearestCar(state, player.x, player.y, ENTER_RADIUS);
  if (!car) return false;
  // Mobil polisi terkunci — tidak bisa dicuri.
  if (car.driver === 'police') return false;
  // Mengambil mobil yang sedang dikemudikan orang lain adalah pencurian.
  if (car.driver === 'traffic') {
    addWanted(state, 1);
  }
  car.driver = 'player';
  car.parked = false;
  player.onFoot = false;
  player.carId = car.id;
  player.x = car.x;
  player.y = car.y;
  player.angle = car.angle;
  player.speed = car.speed;
  return true;
}

export function exitCar(state) {
  const player = state.player;
  if (!player || player.onFoot || !player.carId) return false;
  const car = findCar(state, player.carId);
  if (!car) {
    player.onFoot = true;
    player.carId = null;
    player.speed = 0;
    return true;
  }
  // Turun di sisi mobil; pilih sisi yang tidak menabrak bangunan / air.
  const city = usableCity(state.city);
  const sideA = {
    x: car.x + Math.cos(car.angle + Math.PI / 2) * EXIT_OFFSET,
    y: car.y + Math.sin(car.angle + Math.PI / 2) * EXIT_OFFSET,
  };
  const sideB = {
    x: car.x + Math.cos(car.angle - Math.PI / 2) * EXIT_OFFSET,
    y: car.y + Math.sin(car.angle - Math.PI / 2) * EXIT_OFFSET,
  };
  const spot = blockedAt(city, sideA.x, sideA.y, 12) ? sideB : sideA;
  player.x = clamp(spot.x, 16, WORLD_W - 16);
  player.y = clamp(spot.y, 16, WORLD_H - 16);
  player.onFoot = true;
  player.carId = null;
  player.speed = 0;
  car.driver = null;
  car.parked = true;
  car.speed = 0;
  return true;
}

// ------------------------------------------------------------ spawn traffic --
function randomRoadNode(graph) {
  return graph.nodes[Math.floor(Math.random() * graph.nodes.length)];
}

function makeTrafficCar(graph) {
  const node = randomRoadNode(graph);
  const next = pickNextNode(graph, { _node: node.id, _from: -1 });
  const target = nodeById(graph, next);
  const angle = Math.atan2(target.y - node.y, target.x - node.x);
  const car = {
    id: makeCarId(),
    x: node.x,
    y: node.y,
    angle,
    speed: CFG.TRAFFIC_SPAWN_SPEED,
    color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
    model: CAR_MODELS[Math.floor(Math.random() * CAR_MODELS.length)],
    parked: false,
    driver: 'traffic',
    health: CAR_HEALTH,
    _node: next,
    _from: node.id,
    _stuck: 0,
    _cruise: TRAFFIC_SPEED_MIN
      + Math.random() * (TRAFFIC_SPEED_MAX - TRAFFIC_SPEED_MIN),
  };
  return car;
}

function makeParkedCar(graph) {
  const node = randomRoadNode(graph);
  const next = pickNextNode(graph, { _node: node.id, _from: -1 });
  const target = nodeById(graph, next);
  const along = Math.atan2(target.y - node.y, target.x - node.x);
  // Parkir di tepi jalan: geser tegak lurus dari garis tengah jalan.
  // Hanya 16-19 px: tepi jalan (13 px) + sedikit trotoar. Lebih jauh
  // mobilnya masuk ke dalam blok dan menabrak gedung (blok mulai 27 px
  // dari tengah jalan, gedung dari 31 px).
  const side = Math.random() < 0.5 ? 1 : -1;
  const off = 16 + Math.random() * 3;
  return {
    id: makeCarId(),
    x: clamp(node.x + Math.cos(along + Math.PI / 2) * off * side, 24, WORLD_W - 24),
    y: clamp(node.y + Math.sin(along + Math.PI / 2) * off * side, 24, WORLD_H - 24),
    angle: along + (Math.random() < 0.5 ? 0 : Math.PI),
    speed: 0,
    color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
    model: CAR_MODELS[Math.floor(Math.random() * CAR_MODELS.length)],
    parked: true,
    driver: null,
    health: CAR_HEALTH,
  };
}

export function spawnTraffic(state, city) {
  const cars = ensureCars(state);
  const graphCity = usableCity(city);
  const graph = graphCity.roadGraph;
  let traffic = 0;
  let parked = 0;
  for (const car of cars) {
    if (car.driver === 'traffic') traffic++;
    if (car.parked && !car.driver) parked++;
  }
  while (traffic < TRAFFIC_COUNT) {
    cars.push(makeTrafficCar(graph));
    traffic++;
  }
  while (parked < PARKED_COUNT) {
    cars.push(makeParkedCar(graph));
    parked++;
  }
  return cars;
}

// --------------------------------------------------------- fisika & update --
function drivePlayerCar(state, car, dt) {
  const input = state.input || {};
  const forward = keyDown(input, 'KeyW', 'ArrowUp', 'w', 'W');
  const back = keyDown(input, 'KeyS', 'ArrowDown', 's', 'S');
  const left = keyDown(input, 'KeyA', 'ArrowLeft', 'a', 'A');
  const right = keyDown(input, 'KeyD', 'ArrowRight', 'd', 'D');
  const handbrake = keyDown(input, 'ShiftLeft', 'ShiftRight', 'Shift');

  if (forward) {
    if (car.speed < 0) car.speed += CAR_BRAKE * dt; // rem dulu saat mundur
    else car.speed += CAR_ACCEL * dt;
  }
  if (back) {
    if (car.speed > 8) car.speed -= CAR_BRAKE * dt; // rem saat melaju
    else car.speed -= CAR_REVERSE_ACCEL * dt; // lalu mundur
  }
  if (handbrake) {
    const decel = CAR_HANDBRAKE * dt;
    if (car.speed > 0) car.speed = Math.max(0, car.speed - decel);
    else if (car.speed < 0) car.speed = Math.min(0, car.speed + decel);
  }
  // Gesekan gelinding selalu bekerja saat tidak ada gas.
  if (!forward && !back) {
    car.speed *= Math.exp(-CAR_DRAG * dt);
    if (Math.abs(car.speed) < 4) car.speed = 0;
  }
  car.speed = clamp(car.speed, -CAR_MAX_REVERSE, CAR_MAX_SPEED);

  // Setir melemah saat pelan dan saat sangat kencang; rem tangan mempertajam.
  const speedFactor = clamp(Math.abs(car.speed) / CAR_TURN_MIN_SPEED, 0, 1);
  const highSpeedCut = 1 - 0.35 * (Math.abs(car.speed) / CAR_MAX_SPEED);
  let turn = CAR_TURN_BASE * speedFactor * highSpeedCut;
  if (handbrake) turn *= HANDBRAKE_TURN_BONUS;
  const steer = (left ? -1 : 0) + (right ? 1 : 0);
  const dir = car.speed >= 0 ? 1 : -1;
  car.angle += steer * turn * dir * dt;
}

function driveTrafficCar(car, graph, cars, dt) {
  const target = nodeById(graph, car._node);
  if (!target) return;
  const dx = target.x - car.x;
  const dy = target.y - car.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < NODE_ARRIVE_DIST) {
    car._from = car._node;
    car._node = pickNextNode(graph, car);
    return;
  }
  const wantAngle = Math.atan2(dy, dx);
  const diff = angleDiff(wantAngle, car.angle);
  const maxTurn = 2.4 * dt;
  car.angle += clamp(diff, -maxTurn, maxTurn);

  // Batas kecepatan: pelan di dekat simpang, berhenti di belakang mobil lain.
  let targetSpeed = car._cruise || TRAFFIC_SPEED_MIN;
  const degree = neighborsOf(graph, car._node).length;
  if (degree > 2 && dist < JUNCTION_SLOW_DIST) {
    targetSpeed = Math.min(targetSpeed, JUNCTION_SLOW_SPEED);
  }
  const ahead = carAhead(cars, car);
  if (ahead !== null) {
    if (ahead < FOLLOW_STOP_DIST) targetSpeed = 0;
    else if (ahead < FOLLOW_DIST) {
      targetSpeed = Math.min(targetSpeed, JUNCTION_SLOW_SPEED);
    }
  }
  if (car.speed < targetSpeed) {
    car.speed = Math.min(targetSpeed, car.speed + TRAFFIC_ACCEL * dt);
  } else if (car.speed > targetSpeed) {
    car.speed = Math.max(targetSpeed, car.speed - CAR_BRAKE * dt);
  }
  // Pemulihan saat mentok (mis. jalan terhalang): bila mobil seharusnya
  // melaju tapi kecepatannya nyaris nol cukup lama, putar balik ke node asal
  // supaya tidak diam selamanya menempel halangan.
  if (targetSpeed > 50 && car.speed < 12) {
    car._stuck = (car._stuck || 0) + dt;
    if (car._stuck > 1.5) {
      const back = car._from;
      car._from = car._node;
      car._node = back;
      car._stuck = 0;
    }
  } else {
    car._stuck = 0;
  }
}

// Jarak mobil terdekat di depan (dalam kerucut ~50 derajat), atau null.
function carAhead(cars, self) {
  let best = null;
  for (const other of cars) {
    if (other === self || other.parked) continue;
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > FOLLOW_DIST || d < 1) continue;
    const toOther = Math.atan2(dy, dx);
    if (Math.abs(angleDiff(toOther, self.angle)) > 0.45) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

// Pisahkan mobil yang saling bertumpuk dan redam kecepatannya.
function separateCars(cars) {
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const min = CAR_RADIUS * 2 - 4;
      if (d >= min || d < 0.01) continue;
      const push = (min - d) / 2;
      const ux = dx / d;
      const uy = dy / d;
      a.x -= ux * push;
      a.y -= uy * push;
      b.x += ux * push;
      b.y += uy * push;
      const hard = Math.abs(a.speed - b.speed) > 220;
      a.speed *= hard ? 0.55 : 0.9;
      b.speed *= hard ? 0.55 : 0.9;
    }
  }
}

export function updateVehicles(state, dt, city) {
  if (!state || !state.player) return;
  if (!(dt > 0)) return;
  const cars = ensureCars(state);
  const liveCity = usableCity(city || state.city);
  const graph = liveCity.roadGraph;
  const player = state.player;

  const playerCar = !player.onFoot && player.carId
    ? findCar(state, player.carId) : null;

  for (const car of cars) {
    if (car === playerCar) {
      drivePlayerCar(state, car, dt);
    } else if (car.driver === 'traffic') {
      driveTrafficCar(car, graph, cars, dt);
    } else if (car.driver === 'police') {
      // Mobil polisi disetir oleh police.js (sudut & kecepatan diisi di sana);
      // di sini hanya gerak fisik + tabrakan.
      car.speed = clamp(car.speed, -CAR_MAX_REVERSE, CAR_MAX_SPEED);
    } else if (car.parked || !car.driver) {
      car.speed = 0;
    }
    if (Math.abs(car.speed) > 0.5) {
      moveCarWithCollision(car, liveCity, dt);
    }
    // Jaring pengaman: dorongan dari luar (ram polisi, separateCars) tidak
    // boleh meninggalkan mobil di luar batas dunia.
    car.x = clamp(car.x, CAR_RADIUS, WORLD_W - CAR_RADIUS);
    car.y = clamp(car.y, CAR_RADIUS, WORLD_H - CAR_RADIUS);
    if (typeof car.health !== 'number') car.health = CAR_HEALTH;
  }

  separateCars(cars);

  // Sinkronkan posisi pemain dengan mobil yang dikendarainya.
  if (playerCar) {
    player.x = playerCar.x;
    player.y = playerCar.y;
    player.angle = playerCar.angle;
    player.speed = playerCar.speed;
  }
}
